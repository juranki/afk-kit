/**
 * The crash reconciler (ticket afk-kit #65): a Run whose process died with
 * an unfinished lock converges to one durable, inspectable result. The
 * next `afk status` or `afk implement` finalizes the hard interruption —
 * it never resumes the work.
 *
 * Convergence, in order:
 *
 *   1. Uncertain side effects — `side-effect.intent` events without a
 *      matching completion — are classified against the real tracker and
 *      Git state: exact expected state is accepted, absent state is left
 *      absent (a dead Run's work is never created, pushed, or resumed),
 *      and conflicting or unverifiable state becomes a finding.
 *   2. The interruption Escalation is materialized idempotently — exactly
 *      one status comment, `needs-info` applied, workflow labels removed,
 *      every artifact preserved — with the findings named in the reason.
 *   3. The terminal outcome is recorded only once the tracker escalation
 *      succeeded, so a failed materialization stays unfinished and a later
 *      invocation retries it.
 *
 * A corrupt journal cannot be appended to, so there the tracker comment is
 * the only durable record. The reconciler never throws: a caller treats a
 * failure to finalize as "still unfinished" and a later invocation retries.
 */

import * as path from "node:path";
import type { GhRunner } from "../../extensions/readiness/gh.ts";
import { type EscalationFacts, escalateRun } from "../escalate.ts";
import type { EngineSeams } from "../seams.ts";
import { RUN_EVENT_NAMES, type RunEvent, readRunEvents } from "./events.ts";
import { foldRunEvents } from "./projection.ts";
import {
	acquireRunLock,
	pidAlive,
	type RunHandle,
	readRunLock,
	recordEvent,
	releaseRunLock,
} from "./store.ts";

export interface ReconcileDeps {
	seams: EngineSeams;
}

/** An intent whose completion never arrived: the operation is uncertain. */
export interface UncertainOp {
	op: string;
	operation: string;
	cycle: number | null;
	payload: Record<string, unknown>;
}

/**
 * Pair the journal's intents with their completions by deterministic
 * operation identity; an intent with no completion is the signature of an
 * operation the process died inside.
 */
export function unmatchedIntents(events: RunEvent[]): UncertainOp[] {
	const completed = new Set(
		events
			.filter(
				(e) => e.name === RUN_EVENT_NAMES.sideEffectCompleted && e.op !== null,
			)
			.map((e) => e.op),
	);
	return events
		.filter(
			(e) =>
				e.name === RUN_EVENT_NAMES.sideEffectIntent &&
				e.op !== null &&
				!completed.has(e.op),
		)
		.map((e) => ({
			op: e.op ?? "",
			operation: String(e.payload.operation ?? ""),
			cycle: e.cycle,
			payload: e.payload,
		}));
}

/** The Run identity the canonical state-hierarchy path carries. */
interface RunPathIdentity {
	owner: string;
	repo: string;
	ticket: number;
	runId: string;
}

function identityFromPath(dir: string): RunPathIdentity | null {
	const parts = dir.split(path.sep);
	const markerIndex = parts.indexOf("github.com");
	if (markerIndex < 0) return null;
	const owner = parts[markerIndex + 1];
	const repo = parts[markerIndex + 2];
	const ticket = Number(parts[markerIndex + 4]);
	const runId = parts[markerIndex + 6];
	if (!owner || !repo || !Number.isInteger(ticket) || ticket <= 0 || !runId) {
		return null;
	}
	return { owner, repo, ticket, runId };
}

/**
 * The handle shape the store's recorder needs. The immutable brief is not
 * read: a tampered or unreadable snapshot must not stop the Escalation,
 * which lives in the tracker, not in the Run directory.
 */
function handleFrom(identity: RunPathIdentity, dir: string): RunHandle {
	return {
		runId: identity.runId,
		owner: identity.owner,
		repo: identity.repo,
		ticket: identity.ticket,
		dir,
		eventsPath: path.join(dir, "events.jsonl"),
		briefPath: path.join(dir, "brief.md"),
		briefHash: "",
		projectionPath: path.join(dir, "run.json"),
		lockPath: path.join(dir, "lock"),
		artifactsDir: path.join(dir, "artifacts"),
	};
}

/** How an uncertain operation judged against the world. */
type Verdict =
	| { state: "settled" | "absent" | "interrupted"; status: string }
	| { state: "uncertain"; finding: string };

async function ghJson<T>(run: GhRunner, args: string[]): Promise<T> {
	const { stdout, stderr, exitCode } = await run(args);
	if (exitCode !== 0) {
		throw new Error(
			`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`,
		);
	}
	return JSON.parse(stdout) as T;
}

async function reconcileClaim(
	ticket: number,
	seams: EngineSeams,
): Promise<Verdict> {
	const view = await ghJson<{
		assignees: { login: string }[];
		labels: { name: string }[];
	}>(seams.gh, ["issue", "view", String(ticket), "--json", "assignees,labels"]);
	const assigned = view.assignees.length > 0;
	const inProgress = view.labels.some((l) => l.name === "in-progress");
	if (assigned && inProgress) {
		return { state: "settled", status: "settled" };
	}
	if (!assigned && !inProgress) {
		return { state: "absent", status: "absent" };
	}
	const names = view.assignees.map((a) => a.login).join(", ");
	return {
		state: "uncertain",
		finding: `claim of #${ticket} is partial: ${assigned ? `assigned to ${names}` : "unassigned"}, ${inProgress ? "in-progress applied" : "no in-progress label"}`,
	};
}

/** The open PRs for a branch, or a throw the caller turns into a finding. */
async function openPrs(
	branch: string,
	seams: EngineSeams,
): Promise<{ number: number; isDraft: boolean }[]> {
	return ghJson(seams.gh, [
		"pr",
		"list",
		"--head",
		branch,
		"--state",
		"open",
		"--json",
		"number,isDraft",
	]);
}

async function reconcileBootstrap(
	branch: string,
	seams: EngineSeams,
): Promise<Verdict> {
	const prs = await openPrs(branch, seams);
	if (prs.length === 1 && prs[0].isDraft) {
		return { state: "settled", status: "settled" };
	}
	if (prs.length === 0) {
		return { state: "absent", status: "absent" };
	}
	if (prs.length === 1) {
		return {
			state: "uncertain",
			finding: `open PR #${prs[0].number} for ${branch} is not a draft, where the bootstrap intended a draft`,
		};
	}
	return {
		state: "uncertain",
		finding: `${prs.length} open PRs for ${branch}, where the bootstrap intended at most one draft`,
	};
}

async function reconcileCandidatePush(
	branch: string,
	seams: EngineSeams,
): Promise<Verdict> {
	const remote = await seams.git(
		["ls-remote", "origin", `refs/heads/${branch}`],
		seams.checkout,
	);
	if (remote.exitCode !== 0) {
		throw new Error(
			`git ls-remote origin ${branch} failed: ${remote.stderr.trim()}`,
		);
	}
	if (remote.stdout.trim() !== "") {
		return { state: "settled", status: "settled" };
	}
	return { state: "absent", status: "absent" };
}

async function reconcileHandoff(
	branch: string,
	seams: EngineSeams,
): Promise<Verdict> {
	const prs = await openPrs(branch, seams);
	if (prs.length === 1 && !prs[0].isDraft) {
		return { state: "settled", status: "settled" };
	}
	if (prs.length <= 1) {
		return { state: "absent", status: "absent" };
	}
	return {
		state: "uncertain",
		finding: `${prs.length} open PRs for ${branch}, where the handoff intended exactly one ready PR`,
	};
}

/** Classify one uncertain operation against the world. */
async function reconcileOp(
	op: UncertainOp,
	ticket: number,
	seams: EngineSeams,
): Promise<Verdict> {
	try {
		switch (op.operation) {
			case "claim":
				return await reconcileClaim(ticket, seams);
			case "bootstrap":
				return await reconcileBootstrap(String(op.payload.branch ?? ""), seams);
			case "candidate-push":
				return await reconcileCandidatePush(
					String(op.payload.branch ?? ""),
					seams,
				);
			case "handoff":
				return await reconcileHandoff(String(op.payload.branch ?? ""), seams);
			case "cycle":
			case "review":
				// Agent sessions carry no external side effects: the evidence
				// lives in the Run directory and was flushed live.
				return { state: "interrupted", status: "interrupted" };
			default:
				return {
					state: "uncertain",
					finding: `unknown operation "${op.operation}" (${op.op})`,
				};
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			state: "uncertain",
			finding: `${op.operation} (${op.op}) could not be verified: ${message}`,
		};
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Finalize one hard-interrupted Run: classify its uncertain side effects,
 * materialize the interruption Escalation, record the terminal outcome.
 * Idempotent — a terminal Run is a no-op — and never throws.
 */
export async function finalizeInterruptedRun(
	dir: string,
	deps: ReconcileDeps,
): Promise<void> {
	try {
		const identity = identityFromPath(dir);
		if (identity === null) return;
		const handle = handleFrom(identity, dir);

		// Only a dead lock is an interruption: a live lock means the Run is
		// working, and no lock at all means the Run never started working —
		// an unfinished, lock-less Run stays for a maintainer to clear.
		const existingLock = readRunLock(handle);
		if (existingLock === null || pidAlive(existingLock.pid)) return;

		let lock: ReturnType<typeof acquireRunLock>;
		try {
			lock = acquireRunLock(handle, { stealStale: true });
		} catch {
			// Lost the takeover race; another reconciler is finalizing.
			return;
		}
		try {
			let events: RunEvent[];
			try {
				events = readRunEvents(handle.eventsPath).events;
			} catch (error) {
				// Interior corruption: the journal cannot be trusted or
				// appended to — the tracker comment is the durable record.
				await escalateRun(
					{
						issue: identity.ticket,
						run: identity.runId,
						stage: "unknown",
						reason: `interrupted: the Run's event stream is corrupt (${messageOf(error)})`,
						runDirectory: dir,
					},
					deps.seams,
				);
				return;
			}

			const fold = foldRunEvents(events);
			if (fold?.outcome !== null && fold?.outcome !== undefined) {
				return; // Already terminal: repeated reconciliation is a no-op.
			}

			// Classify every uncertain operation before escalating: the
			// Escalation changes tracker state the classification reads.
			const findings: string[] = [];
			for (const op of unmatchedIntents(events)) {
				if (op.operation === "escalate") continue; // handled below
				const verdict = await reconcileOp(op, identity.ticket, deps.seams);
				if (verdict.state === "uncertain") findings.push(verdict.finding);
				recordEvent(handle, {
					name: RUN_EVENT_NAMES.sideEffectCompleted,
					payload: {
						operation: op.operation,
						status:
							verdict.state === "uncertain" ? "uncertain" : verdict.status,
						...(verdict.state === "uncertain" ? { text: verdict.finding } : {}),
					},
					cycle: op.cycle,
					op: op.op,
				});
			}

			const reason = findings.length
				? `interrupted: the Run's process died before finalizing; uncertain side effects: ${findings.join("; ")}`
				: `interrupted: the Run's process died before finalizing`;
			const facts: EscalationFacts = {
				issue: identity.ticket,
				run: identity.runId,
				stage: fold?.stage ?? "unknown",
				...(fold?.cycle !== null && fold?.cycle !== undefined
					? { cycle: fold.cycle }
					: {}),
				reason,
				...(fold?.pr !== null && fold?.pr !== undefined
					? {
							pr: {
								number: fold.pr,
								url: `https://github.com/${identity.owner}/${identity.repo}/pull/${fold.pr}`,
							},
						}
					: {}),
				...(fold?.branch ? { branch: fold.branch } : {}),
				...(fold?.worktree ? { worktree: fold.worktree } : {}),
				runDirectory: dir,
			};

			const escalateOp = `escalate:${identity.ticket}`;
			recordEvent(handle, {
				name: RUN_EVENT_NAMES.sideEffectIntent,
				payload: { operation: "escalate" },
				op: escalateOp,
			});
			const outcome = await escalateRun(facts, deps.seams);
			recordEvent(handle, {
				name: RUN_EVENT_NAMES.sideEffectCompleted,
				payload: {
					operation: "escalate",
					status: outcome.status,
					text: outcome.text,
				},
				op: escalateOp,
			});
			if (outcome.status === "escalated") {
				// Only a successful materialization terminates the Run: a
				// failed one stays unfinished so a later invocation retries.
				recordEvent(handle, {
					name: RUN_EVENT_NAMES.outcome,
					payload: {
						outcome: "escalated",
						reason,
						stage: facts.stage,
						cycle: fold?.cycle ?? null,
						pr: fold?.pr ?? null,
					},
				});
			} else {
				recordEvent(handle, {
					name: RUN_EVENT_NAMES.notice,
					payload: { message: outcome.text },
				});
			}
		} finally {
			releaseRunLock(lock, handle);
		}
	} catch {
		// Never throw: an unfinished Run is re-materialized by the next
		// status or implement invocation.
	}
}
