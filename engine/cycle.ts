/**
 * The real Implement–Review Cycle port (ticket afk-kit #62, durable spec
 * #46): one fresh confined Implementer session from the cumulative
 * worktree, the observed-fact done checks, deterministic Verify
 * execution, and the cycle's complete evidence under the Run's artifacts.
 * The Implementer's prose and structured result are claims; this port
 * judges done from Git facts and verify exit codes, and only a verified
 * cycle reaches the machine's candidate push. Reviews are later tickets:
 * an approved cycle carries no approvals yet.
 *
 * A judged failure returns `failed` with bounded feedback for the next
 * fresh Implementer; infrastructure uncertainty (confinement, Git, the
 * session factory) throws, which the driving loop turns into an
 * immediate Escalation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseBrief } from "../extensions/readiness/brief.ts";
import { verifyCommandList } from "../extensions/readiness/check.ts";
import {
	createImplementerSessionFactory,
	runImplementerSession,
	type SessionFactory,
} from "./agent-runner.ts";
import { createTaskConfinement } from "./confinement.ts";
import type { CycleOutcome, CyclePort } from "./ports.ts";
import type { ConfinementRuntimePort } from "./preflight.ts";
import {
	buildImplementerPrompt,
	parseImplementerResult,
	requireDone,
} from "./prompt.ts";
import { readRunEvents } from "./runs/events.ts";
import { foldRunEvents } from "./runs/projection.ts";
import { artifactDir, type RunHandle } from "./runs/store.ts";
import type { EngineSeams } from "./seams.ts";
import {
	formatVerifyFeedback,
	runVerifyCommands,
	type VerifyCommandEvidence,
} from "./verify.ts";

/** The Implementer's wall-clock cap (durable spec #46: 30 minutes). */
const IMPLEMENTER_CAP_MS = 30 * 60 * 1000;

/** What the Implementer's shell may reach: the package registry. */
const IMPLEMENTER_ALLOWED_DOMAINS = ["registry.npmjs.org"] as const;

interface CyclePortPorts {
	/** Scripted session factory (tests); defaults to the real SDK factory. */
	sessionFactory?: SessionFactory;
	/** The srt port the per-cycle confinement initializes; tests fake it. */
	confinementRuntime?: ConfinementRuntimePort;
	/** Resolved once per Run for the real session factory. */
	modelRuntime?: ModelRuntime;
	/** Overrides for tests; the durable spec's caps are the defaults. */
	implementerCapMs?: number;
	verifyCapMs?: number;
}

export interface CyclePortDeps {
	handle: RunHandle;
	seams: EngineSeams;
	/** The immutable brief snapshot; verify commands are read from it. */
	brief: string;
	ports?: CyclePortPorts;
}

/** One implementer launch's judged facts, persisted as cycle evidence. */
interface ImplementerEvidence {
	cycle: number;
	stop: "completed" | "aborted";
	commitCount: number | null;
	clean: boolean | null;
	parse:
		| { ok: true; result: Record<string, unknown> }
		| { ok: false; reason: string };
	resultText: string;
	durationMs: number;
}

/** The brief's verify commands, exactly as declared. */
function verifyCommandsOf(brief: string): string[] {
	return verifyCommandList(parseBrief(brief).verifyCommands.value);
}

/**
 * Prior failed cycles' bounded feedback, from the cycle results the
 * driving loop persists; the next fresh Implementer inherits them all.
 */
function priorFeedback(handle: RunHandle, cycle: number): string | undefined {
	const parts: string[] = [];
	for (let prior = 1; prior < cycle; prior += 1) {
		try {
			const file = path.join(
				handle.artifactsDir,
				`cycle-${String(prior)}`,
				"result.json",
			);
			const outcome = JSON.parse(fs.readFileSync(file, "utf8")) as {
				status?: string;
				reason?: string;
			};
			if (outcome.status === "failed" && outcome.reason) {
				parts.push(outcome.reason);
			}
		} catch {
			// A missing prior result is not feedback; the cycle proceeds.
		}
	}
	return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * Build the cycle port. The returned port is what the driving loop calls
 * once per Implement–Review Cycle.
 */
export function createCyclePort(deps: CyclePortDeps): CyclePort {
	const { handle, seams, brief } = deps;
	const ports = deps.ports ?? {};
	const commands = verifyCommandsOf(brief);

	return async (cycle: number): Promise<CycleOutcome> => {
		// Claim facts, as the driving loop recorded them.
		const events = readRunEvents(handle.eventsPath).events;
		const facts = foldRunEvents(events);
		const worktree = facts?.worktree;
		const branch = facts?.branch;
		if (!worktree || !branch) {
			throw new Error(
				`cycle ${String(cycle)} cannot run: the Run records no worktree yet`,
			);
		}
		const git = seams.git;
		const base = await git(["rev-parse", "HEAD"], worktree);
		if (base.exitCode !== 0) {
			throw new Error(
				`cycle ${String(cycle)} cannot read HEAD: ${base.stderr.trim()}`,
			);
		}

		// Per-cycle confinement: the session's bash is allow-only,
		// worktree-rooted, registry-networked. A confinement failure
		// throws, and the driving loop escalates it.
		const confinement = await createTaskConfinement(
			{
				worktree,
				writablePaths: ["."],
				allowedDomains: [...IMPLEMENTER_ALLOWED_DOMAINS],
			},
			ports.confinementRuntime === undefined
				? {}
				: { runtime: ports.confinementRuntime },
		);
		try {
			const implementerDir = artifactDir(
				handle,
				`cycle-${String(cycle)}`,
				"implementer",
			);
			const sessionFactory =
				ports.sessionFactory ??
				createImplementerSessionFactory({
					operations: confinement.operations,
					definitionPath: path.join(
						import.meta.dir,
						"agents",
						"implementer.md",
					),
					modelRuntime: ports.modelRuntime,
				});
			const startedMs = Date.now();
			const spawn = await runImplementerSession(
				{
					worktree,
					prompt: buildImplementerPrompt({
						issue: handle.ticket,
						branch,
						worktree,
						cycle,
						brief,
						feedback: priorFeedback(handle, cycle),
					}),
					eventsPath: path.join(implementerDir, "session-events.jsonl"),
					capMs: ports.implementerCapMs ?? IMPLEMENTER_CAP_MS,
				},
				{ createSession: sessionFactory },
			);

			// Observed facts: the report's prose cannot override these.
			const commitCount = await git(
				["rev-list", "--count", `${base.stdout.trim()}..HEAD`],
				worktree,
			);
			const status = await git(["status", "--porcelain"], worktree);
			const clean = status.exitCode === 0 && status.stdout.trim() === "";
			const parsed = parseImplementerResult(spawn.resultText);
			const evidence: ImplementerEvidence = {
				cycle,
				stop: spawn.stop,
				commitCount:
					commitCount.exitCode === 0
						? Number.parseInt(commitCount.stdout.trim(), 10)
						: null,
				clean,
				parse: parsed.ok
					? {
							ok: true,
							result: parsed.result as unknown as Record<string, unknown>,
						}
					: { ok: false, reason: parsed.reason },
				resultText: spawn.resultText,
				durationMs: Date.now() - startedMs,
			};
			fs.writeFileSync(
				path.join(implementerDir, "result.json"),
				`${JSON.stringify(evidence, null, "\t")}\n`,
				{ mode: 0o600 },
			);

			const failure = judgeCycleFailure(cycle, evidence);
			if (failure !== null) {
				return { status: "failed", cycle, reason: failure };
			}

			// The report says done and the facts agree; now the verify gate.
			const verify = await runVerifyCommands({
				commands,
				worktree,
				evidenceDir: artifactDir(handle, `cycle-${String(cycle)}`, "verify"),
				capMs: ports.verifyCapMs,
			});
			if (!verify.ok) {
				return {
					status: "failed",
					cycle,
					reason: formatVerifyFeedback(verify.results),
				};
			}
			return {
				status: "approved",
				cycle,
				verifyResults: verify.results.map(toVerifyResult),
				approvals: [],
			};
		} finally {
			await confinement.dispose();
		}
	};
}

/** The observed-fact done checks, in the durable spec's order. */
function judgeCycleFailure(
	cycle: number,
	evidence: ImplementerEvidence,
): string | null {
	if (evidence.stop !== "completed") {
		return `implementer session did not complete (${evidence.stop}); no report accepted`;
	}
	if (!evidence.parse.ok) {
		return `implementer report invalid (${evidence.parse.reason}); the final message is kept in cycle-${String(cycle)}/implementer/result.json`;
	}
	const result = evidence.parse.result as {
		status: string;
		summary?: string;
		openQuestions?: string[];
	};
	if (!requireDone(result)) {
		const questions = (result.openQuestions ?? []).join("; ");
		const parts = [`implementer reported ${result.status}`];
		if (result.summary) parts.push(result.summary);
		if (questions !== "") parts.push(`open questions: ${questions}`);
		return parts.join(" — ");
	}
	if (evidence.commitCount === null) {
		return "cannot count commits since cycle start";
	}
	if (evidence.commitCount < 1) {
		return "no new commit since cycle start";
	}
	if (evidence.clean !== true) {
		return "worktree not clean after the implementer finished";
	}
	return null;
}

function toVerifyResult(evidence: VerifyCommandEvidence): {
	command: string;
	ok: boolean;
} {
	return { command: evidence.command, ok: evidence.ok };
}
