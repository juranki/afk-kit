/**
 * The real Implement–Verify Cycle port (ticket afk-kit #62, durable spec
 * #46): one fresh confined Implementer session from the cumulative
 * worktree, the observed-fact done checks, and deterministic Verify
 * execution. The Implementer's prose and structured result are claims;
 * this port judges done from Git facts and verify exit codes. A verified
 * cycle is pushed by the machine and then faces the parallel Reviews
 * (ticket #63) — a verified cycle carries no approvals yet.
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
	runAgentSession,
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
 * Prior failed cycles' bounded feedback, aggregated from the results the
 * driving loop persists (ticket afk-kit #64): every failed Implement–Verify
 * leg and every changes-requested Review round becomes one entry — the
 * reason verbatim (already bounded: verify feedback carries a 20,000-char
 * stream tail, Review findings their structured rendering) plus the
 * evidence artifact paths, so the next fresh Implementer can read the
 * complete evidence for itself. A cycle whose results passed, or whose
 * results are missing, contributes nothing.
 */
export function priorFeedback(
	artifactsDir: string,
	cycle: number,
): string | undefined {
	const entries: string[] = [];
	for (let prior = 1; prior < cycle; prior += 1) {
		const dir = path.join(artifactsDir, `cycle-${String(prior)}`);
		for (const kind of FEEDBACK_KINDS) {
			const entry = feedbackEntry(dir, prior, kind);
			if (entry !== null) entries.push(entry);
		}
	}
	return entries.length === 0 ? undefined : entries.join("\n\n");
}

/** One persisted result's feedback role, in loop order. */
const FEEDBACK_KINDS = [
	{
		file: "result.json",
		status: "failed",
		label: (cycle: number): string => `Cycle ${String(cycle)} failed`,
		/** Sibling evidence directories worth referencing when present. */
		evidenceDirs: ["implementer", "verify"],
	},
	{
		file: "review-result.json",
		status: "changes-requested",
		label: (cycle: number): string =>
			`Cycle ${String(cycle)} review requested changes`,
		evidenceDirs: ["reviews"],
	},
] as const;

/** One persisted result's feedback entry, or null when it is none. */
function feedbackEntry(
	cycleDir: string,
	prior: number,
	kind: (typeof FEEDBACK_KINDS)[number],
): string | null {
	let outcome: { status?: string; reason?: string };
	try {
		outcome = JSON.parse(
			fs.readFileSync(path.join(cycleDir, kind.file), "utf8"),
		) as { status?: string; reason?: string };
	} catch {
		return null; // A missing prior result is not feedback; the cycle proceeds.
	}
	if (outcome.status !== kind.status || !outcome.reason) return null;
	const evidence = [path.join(cycleDir, kind.file)];
	for (const sub of kind.evidenceDirs) {
		const dir = path.join(cycleDir, sub);
		if (fs.existsSync(dir)) evidence.push(dir);
	}
	return `${kind.label(prior)}: ${outcome.reason}\nEvidence: ${evidence.join(", ")}`;
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

		// Per-cycle confinement: the session's bash is allow-only — writes
		// stay inside the worktree, network reaches only the package
		// registry, and the host's git configuration is isolated so a
		// commit never reads (or inherits) anything of the maintainer's.
		// All git state is worktree-local (claim creates an independent
		// clone), so no shared-repo write surface exists to expose.
		const confinement = await createTaskConfinement(
			{
				worktree,
				writablePaths: ["."],
				allowedDomains: [...IMPLEMENTER_ALLOWED_DOMAINS],
			},
			{
				extraEnv: {
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_TERMINAL_PROMPT: "0",
				},
				...(ports.confinementRuntime === undefined
					? {}
					: { runtime: ports.confinementRuntime }),
			},
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
			const spawn = await runAgentSession(
				{
					worktree,
					prompt: buildImplementerPrompt({
						issue: handle.ticket,
						branch,
						worktree,
						cycle,
						brief,
						feedback: priorFeedback(handle.artifactsDir, cycle),
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
				status: "verified",
				cycle,
				verifyResults: verify.results.map(toVerifyResult),
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
