/**
 * The Review gate port (ticket afk-kit #63, durable spec #46): after the
 * candidate push, two fresh independent package-owned `glm-5.3`
 * high-thinking Reviewer sessions — Standards and Spec, both read-oriented
 * — run concurrently against the pushed `main...HEAD` diff. The Standards
 * Review judges the diff against the repository's governing guidance and
 * must name it: an approval the Engine cannot verify (empty or
 * hash-mismatched `standardsConsulted`) is not an approval. The Spec
 * Review judges the immutable brief. Verdicts parse to `approve`,
 * severity-ranked `request-changes`, or immediate `escalate`; malformed,
 * timed-out, or failed Reviews fail the cycle deterministically. Except
 * for an immediate Escalation, both Reviews finish and every finding and
 * artifact is retained — even when one requests changes. Review sessions
 * cannot merge or mutate the candidate: their tools are read-only.
 *
 * A judged gate outcome returns as a `ReviewOutcome`; infrastructure
 * uncertainty (Git, the session factories) throws, which the driving loop
 * turns into an immediate Escalation.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type AgentSpawnOutcome,
	createReviewerSessionFactory,
	runAgentSession,
	type SessionFactory,
} from "./agent-runner.ts";
import type { ReviewOutcome, ReviewPort } from "./ports.ts";
import { buildSpecReviewPrompt, buildStandardsReviewPrompt } from "./prompt.ts";
import { readRunEvents } from "./runs/events.ts";
import { foldRunEvents } from "./runs/projection.ts";
import { artifactDir, type RunHandle } from "./runs/store.ts";
import type { EngineSeams } from "./seams.ts";
import {
	type ConsultedPath,
	judgeReviews,
	parseVerdict,
	type ReviewSide,
	type ReviewVerdict,
} from "./verdict.ts";

/** One Reviewer session's wall-clock cap (durable spec #46 policy). */
const REVIEW_CAP_MS = 15 * 60 * 1000;

/** The roles of the two parallel Reviews. */
type ReviewRole = "standards" | "spec";

interface ReviewPortPorts {
	/** Scripted Standards session factory (tests); defaults to the real one. */
	standardsFactory?: SessionFactory;
	/** Scripted Spec session factory (tests); defaults to the real one. */
	specFactory?: SessionFactory;
	/** Resolved once per Run for the real session factories. */
	modelRuntime?: ModelRuntime;
	/** Overrides for tests; the durable spec's cap is the default. */
	reviewCapMs?: number;
}

export interface ReviewPortDeps {
	handle: RunHandle;
	seams: EngineSeams;
	/** The immutable brief snapshot; the Spec Review judges it. */
	brief: string;
	ports?: ReviewPortPorts;
}

/** The consult verification the Standards approval must pass. */
interface ConsultedCheck {
	ok: boolean;
	reason?: string;
	verified?: number;
}

/** One Review side's judged outcome, as both judge and evidence see it. */
interface SideRun {
	/** What the gate judgment consumes. */
	side: ReviewSide;
	/** The parse outcome, persisted verbatim as evidence. */
	parsed: { ok: true; verdict: ReviewVerdict } | { ok: false; reason: string };
	consulted?: ConsultedCheck;
}

/**
 * The Engine's verification of the Standards Review's consulted list:
 * approval requires a non-empty list whose every path exists in the
 * worktree and whose every hash matches the file's complete contents.
 */
function verifyConsulted(
	worktree: string,
	consulted: ConsultedPath[] | undefined,
): { ok: true; verified: number } | { ok: false; reason: string } {
	if (consulted === undefined || consulted.length === 0) {
		return { ok: false, reason: "standardsConsulted is missing or empty" };
	}
	for (const entry of consulted) {
		const resolved = path.resolve(worktree, entry.path);
		if (resolved !== worktree && !resolved.startsWith(worktree + path.sep)) {
			return {
				ok: false,
				reason: `standardsConsulted path escapes the worktree: ${entry.path}`,
			};
		}
		let contents: Buffer;
		try {
			contents = fs.readFileSync(resolved);
		} catch {
			return {
				ok: false,
				reason: `standardsConsulted path does not exist in the worktree: ${entry.path}`,
			};
		}
		const digest = createHash("sha256").update(contents).digest("hex");
		if (digest !== entry.hash.toLowerCase()) {
			return {
				ok: false,
				reason: `standardsConsulted hash mismatch for ${entry.path}`,
			};
		}
	}
	return { ok: true, verified: consulted.length };
}

/** Judge one side's raw spawn and consult check into a gate side. */
function judgeSide(
	spawn: AgentSpawnOutcome,
	parsed: { ok: true; verdict: ReviewVerdict } | { ok: false; reason: string },
	consulted: ConsultedCheck | undefined,
): SideRun {
	if (spawn.stop !== "completed") {
		return {
			side: {
				ok: false,
				reason: "the session did not complete (aborted); no verdict accepted",
			},
			parsed,
			...(consulted === undefined ? {} : { consulted }),
		};
	}
	if (!parsed.ok) {
		return { side: { ok: false, reason: parsed.reason }, parsed };
	}
	if (consulted !== undefined && !consulted.ok) {
		return {
			side: {
				ok: false,
				reason: `approval is not verifiable: ${consulted.reason ?? "unverified"}`,
			},
			parsed,
			consulted,
		};
	}
	return {
		side: parsed,
		parsed,
		...(consulted === undefined ? {} : { consulted }),
	};
}

/**
 * Build the review port. The returned port is what the driving loop calls
 * once per cycle, after the machine's candidate push.
 */
export function createReviewPort(deps: ReviewPortDeps): ReviewPort {
	const { handle, seams, brief } = deps;
	const ports = deps.ports ?? {};

	const factoryFor = (role: ReviewRole): SessionFactory => {
		if (role === "standards" && ports.standardsFactory !== undefined) {
			return ports.standardsFactory;
		}
		if (role === "spec" && ports.specFactory !== undefined) {
			return ports.specFactory;
		}
		return createReviewerSessionFactory({
			definitionPath: path.join(
				import.meta.dir,
				"agents",
				role === "standards" ? "standards-reviewer.md" : "spec-reviewer.md",
			),
			modelRuntime: ports.modelRuntime,
		});
	};

	const runSide = async (
		role: ReviewRole,
		cycle: number,
		facts: { worktree: string; branch: string; diffPath: string },
	): Promise<SideRun> => {
		const { worktree, branch, diffPath } = facts;

		const prompt =
			role === "standards"
				? buildStandardsReviewPrompt({
						issue: handle.ticket,
						cycle,
						branch,
						worktree,
						diffPath,
					})
				: buildSpecReviewPrompt({
						issue: handle.ticket,
						cycle,
						branch,
						worktree,
						diffPath,
						brief,
					});

		const sideDir = artifactDir(
			handle,
			`cycle-${String(cycle)}`,
			"reviews",
			role,
		);
		const startedMs = Date.now();
		const spawn = await runAgentSession(
			{
				worktree,
				prompt,
				eventsPath: path.join(sideDir, "session-events.jsonl"),
				capMs: ports.reviewCapMs ?? REVIEW_CAP_MS,
			},
			{ createSession: factoryFor(role) },
		);
		const durationMs = Date.now() - startedMs;

		const parsed = parseVerdict(spawn.resultText);
		let consulted: ConsultedCheck | undefined;
		if (
			spawn.stop === "completed" &&
			parsed.ok &&
			role === "standards" &&
			parsed.verdict.verdict === "approve"
		) {
			const checked = verifyConsulted(
				worktree,
				parsed.verdict.standardsConsulted,
			);
			consulted = checked.ok
				? { ok: true, verified: checked.verified }
				: { ok: false, reason: checked.reason, verified: 0 };
		}
		const judged = judgeSide(spawn, parsed, consulted);

		const evidence = {
			role,
			cycle,
			stop: spawn.stop,
			durationMs,
			verdict: judged.parsed,
			...(judged.consulted === undefined
				? {}
				: { consulted: judged.consulted }),
			resultText: spawn.resultText,
		};
		fs.writeFileSync(
			path.join(sideDir, "result.json"),
			`${JSON.stringify(evidence, null, "\t")}\n`,
			{ mode: 0o600 },
		);
		return judged;
	};

	return async (cycle: number): Promise<ReviewOutcome> => {
		// Claim facts, as the driving loop recorded them.
		const events = readRunEvents(handle.eventsPath).events;
		const facts = foldRunEvents(events);
		const worktree = facts?.worktree;
		const branch = facts?.branch;
		if (!worktree || !branch) {
			throw new Error(
				`review ${String(cycle)} cannot run: the Run records no worktree yet`,
			);
		}

		// The complete pushed main...HEAD diff, computed once in the worktree
		// and kept verbatim as evidence — the artifact both Reviews judge.
		const diff = await seams.git(["diff", "main...HEAD"], worktree);
		if (diff.exitCode !== 0) {
			throw new Error(
				`review ${String(cycle)} cannot read the candidate diff: ${diff.stderr.trim()}`,
			);
		}
		const reviewsDir = artifactDir(handle, `cycle-${String(cycle)}`, "reviews");
		const diffPath = path.join(reviewsDir, "diff.patch");
		fs.writeFileSync(diffPath, diff.stdout, { mode: 0o600 });

		// Both Reviews run concurrently; allSettled lets both finish even
		// when one throws, so no evidence or sibling session is abandoned.
		const settled = await Promise.allSettled([
			runSide("standards", cycle, { worktree, branch, diffPath }),
			runSide("spec", cycle, { worktree, branch, diffPath }),
		]);
		for (const outcome of settled) {
			if (outcome.status === "rejected") {
				throw outcome.reason;
			}
		}
		const standards = (settled[0] as PromiseFulfilledResult<SideRun>).value;
		const spec = (settled[1] as PromiseFulfilledResult<SideRun>).value;
		const judged = judgeReviews(standards.side, spec.side);
		switch (judged.status) {
			case "approved":
				return {
					status: "approved",
					cycle,
					approvals: judged.approvals,
					...(judged.reviewNotes === undefined
						? {}
						: { reviewNotes: judged.reviewNotes }),
				};
			case "escalate":
				return { status: "escalate", cycle, reason: judged.reason };
			default:
				return { status: "changes-requested", cycle, reason: judged.reason };
		}
	};
}
