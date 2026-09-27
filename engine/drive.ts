/**
 * The Engine's driving loop (ticket afk-kit #61, durable spec #46): the
 * interpreter that carries one claimed Run from the Claim seam to a
 * terminal outcome. The pure state machine (machine.ts) owns every
 * transition and the cycle cap; this loop owns only mechanics — executing
 * each effect through its narrow adapter (claim, bootstrap, cycle,
 * candidate push, handoff, escalate) and persisting every transition and
 * side-effect decision through the Run event port as stage, cycle,
 * context, and intent/completed events.
 *
 * The Engine never merges, never rewrites the immutable brief snapshot,
 * and never acts again after the handoff: a handed-over Run is terminal,
 * and the ready PR is the handoff signal to the Maintainer at the Merge
 * gate.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaimTicketOutcome, claimTicket } from "./claim.ts";
import { escalateRun } from "./escalate.ts";
import {
	type MachineEffect,
	type MachineEvent,
	type MachineState,
	startState,
	transition,
} from "./machine.ts";
import type { CycleOutcome, CyclePort, ReviewPort } from "./ports.ts";
import {
	type BootstrapOutcome,
	bootstrapDraftPr,
	type CandidatePushOutcome,
	type HandOffOutcome,
	handOffPr,
	pushCandidate,
} from "./pr-ops.ts";
import { RUN_EVENT_NAMES } from "./runs/events.ts";
import {
	acquireRunLock,
	artifactDir,
	type RunHandle,
	type RunLock,
	RunStoreError,
	recordEvent,
	releaseRunLock,
} from "./runs/store.ts";
import type { EngineSeams } from "./seams.ts";

/** The output seams of the driving loop; injectable for tests. */
interface DriveIo {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

export interface DriveOptions {
	/** The Run to drive; its immutable brief snapshot is never touched. */
	handle: RunHandle;
	seams: EngineSeams;
	/** The Implement–Verify port (scripted in #61, real in #62). */
	runCycle: CyclePort;
	/** The parallel Standards/Spec Review port over the pushed diff (#63). */
	runReviews: ReviewPort;
	io?: DriveIo;
}

/**
 * Precondition: the caller has passed preflight and readiness on the Run's
 * immutable brief snapshot — a Claim happens only after the readiness check
 * passes (ontology invariant; today `runImplement`, the CLI in #62).
 */

/** The exit-code contract of the durable spec (CLI section). */
export type DriveExit = 0 | 1 | 2 | 3;

/**
 * A side-effect outcome, exactly as the adapters return them. A thrown
 * adapter collapses into the same shapes via `outcomeFromThrow`, so the
 * machine sees one vocabulary.
 */
type OpOutcome =
	| ClaimTicketOutcome
	| BootstrapOutcome
	| CycleOutcome
	| CandidatePushOutcome
	| ReviewOutcome
	| HandOffOutcome;

/** Which side effect an intent/completed pair names. */
const OP_NAMES = {
	claim: "claim",
	bootstrap: "bootstrap",
	cycle: "cycle",
	"candidate-push": "candidate-push",
	review: "review",
	handoff: "handoff",
	escalate: "escalate",
} as const;

/**
 * Deterministic operation identity: intent/completed pairs share it so a
 * killed process's intents reconcile against reality (durable spec #46).
 */
function opId(effect: MachineEffect, ticket: number): string {
	switch (effect.type) {
		case "claim":
			return `${OP_NAMES.claim}:${ticket}`;
		case "bootstrap":
			return `${OP_NAMES.bootstrap}:${ticket}`;
		case "cycle":
			return `${OP_NAMES.cycle}:${ticket}:${effect.cycle}`;
		case "candidate-push":
			return `${OP_NAMES["candidate-push"]}:${ticket}`;
		case "review":
			return `${OP_NAMES.review}:${ticket}:${effect.cycle}`;
		case "handoff":
			return `${OP_NAMES.handoff}:${ticket}`;
		case "escalate":
			return `${OP_NAMES.escalate}:${ticket}`;
	}
}

/** The payload an intent carries, naming exactly what is about to happen. */
function intentPayload(effect: MachineEffect): Record<string, unknown> {
	switch (effect.type) {
		case "claim":
			return { operation: OP_NAMES.claim };
		case "bootstrap":
			return {
				operation: OP_NAMES.bootstrap,
				issue: effect.input.issue,
				branch: effect.input.branch,
			};
		case "cycle":
			return { operation: OP_NAMES.cycle, cycle: effect.cycle };
		case "candidate-push":
			return {
				operation: OP_NAMES["candidate-push"],
				issue: effect.input.issue,
				branch: effect.input.branch,
			};
		case "review":
			return { operation: OP_NAMES.review, cycle: effect.cycle };
		case "handoff":
			return {
				operation: OP_NAMES.handoff,
				issue: effect.input.issue,
				branch: effect.input.branch,
			};
		case "escalate":
			return { operation: OP_NAMES.escalate };
	}
}

/**
 * A thrown adapter is a side-effect refusal for the tracker/Git ops (their
 * contract returns refusals; a throw means an unhandled seam read failed)
 * and an immediate Escalation for the cycle port — infrastructure
 * uncertainty never continues silently (durable spec #46). The refusal
 * shapes match the adapters' own, so the machine sees one vocabulary.
 */
function outcomeFromThrow(
	effect: Exclude<MachineEffect, { type: "escalate" }>,
	error: unknown,
	ticket: number,
): OpOutcome {
	const message = error instanceof Error ? error.message : String(error);
	switch (effect.type) {
		case "claim":
			return {
				status: "refused",
				issue: ticket,
				text: `CLAIM_REFUSAL: reading the ticket failed: ${message}`,
			};
		case "bootstrap":
			return {
				status: "refused",
				issue: ticket,
				text: `PUBLISH_REFUSAL: bootstrap failed: ${message}`,
			};
		case "cycle":
			return { status: "escalate", cycle: effect.cycle, reason: message };
		case "candidate-push":
			return {
				status: "refused",
				issue: ticket,
				text: `PUBLISH_REFUSAL: candidate push failed: ${message}`,
			};
		case "review":
			return {
				status: "escalate",
				cycle: effect.cycle,
				reason: message,
			};
		case "handoff":
			return {
				status: "refused",
				issue: ticket,
				text: `HANDOFF_REFUSAL: handoff failed: ${message}`,
			};
	}
}

/** Feed an executed outcome back into the machine as its event. */
function eventFor(
	effect: Exclude<MachineEffect, { type: "escalate" }>,
	outcome: OpOutcome,
): MachineEvent {
	switch (effect.type) {
		case "claim":
			return { type: "claim", outcome: outcome as ClaimTicketOutcome };
		case "bootstrap":
			return { type: "bootstrap", outcome: outcome as BootstrapOutcome };
		case "cycle":
			return { type: "cycle", outcome: outcome as CycleOutcome };
		case "candidate-push":
			return {
				type: "candidate-push",
				outcome: outcome as CandidatePushOutcome,
			};
		case "review":
			return { type: "review", outcome: outcome as ReviewOutcome };
		case "handoff":
			return { type: "handoff", outcome: outcome as HandOffOutcome };
	}
}

/** The stage a state sits in; terminals have none. */
function stageOf(state: MachineState): string | null {
	switch (state.name) {
		case "refused":
		case "escalated":
		case "handed-over":
			return null;
		default:
			return state.name;
	}
}

export async function driveRun(options: DriveOptions): Promise<DriveExit> {
	const { handle, seams, runCycle, runReviews } = options;
	const io: DriveIo = options.io ?? {
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	};

	let lock: RunLock;
	try {
		lock = acquireRunLock(handle);
	} catch (error) {
		if (error instanceof RunStoreError) {
			io.stderr(`afk: cannot drive run ${handle.runId}: ${error.message}\n`);
			return 3;
		}
		throw error;
	}

	try {
		return await driveLocked(handle, seams, runCycle, runReviews, io);
	} finally {
		releaseRunLock(lock, handle);
	}
}

async function driveLocked(
	handle: RunHandle,
	seams: EngineSeams,
	runCycle: CyclePort,
	runReviews: ReviewPort,
	io: DriveIo,
): Promise<DriveExit> {
	const emit = (
		name: string,
		payload: Record<string, unknown>,
		rest: {
			cycle?: number | null;
			op?: string | null;
			artifacts?: string[];
		} = {},
	): void => {
		recordEvent(handle, {
			name,
			payload,
			cycle: rest.cycle ?? null,
			op: rest.op ?? null,
			artifacts: rest.artifacts ?? [],
		});
	};

	/** Record every stage and cycle boundary the machine walks through. */
	const enterStage = (next: MachineState, previous: MachineState): void => {
		const stage = stageOf(next);
		if (stage === null) return; // Terminals record their outcome, not a stage.
		if (stage !== stageOf(previous)) {
			emit(RUN_EVENT_NAMES.stageEntered, { stage });
		}
		if (
			next.name === "cycle" &&
			(previous.name !== "cycle" || previous.cycle !== next.cycle)
		) {
			emit(
				RUN_EVENT_NAMES.cycleStarted,
				{ cycle: next.cycle },
				{
					cycle: next.cycle,
				},
			);
		}
	};

	let state: MachineState = startState();
	let effect: MachineEffect | null = { type: "claim" };
	emit(RUN_EVENT_NAMES.stageEntered, { stage: state.name });

	while (effect !== null) {
		// The Escalation effect: the terminal decision is already made; the
		// Escalator posts one status comment, applies needs-info, and
		// preserves the assignee, PR, branch, worktree, and evidence. One-way,
		// never compensated.
		if (effect.type === "escalate") {
			const escalated = state as Extract<MachineState, { name: "escalated" }>;
			const ok = await executeEscalation(handle, escalated, seams, emit);
			emit(RUN_EVENT_NAMES.outcome, {
				outcome: "escalated",
				reason: escalated.reason,
				stage: escalated.stage,
				cycle: escalated.cycle,
				pr: escalated.facts.pr?.number,
			});
			io.stderr(
				`afk: run ${handle.runId} escalated from ${escalated.stage}${escalated.cycle === null ? "" : `, cycle ${escalated.cycle}`}: ${escalated.reason}\n  ${handle.dir}\n`,
			);
			if (!ok) {
				io.stderr(
					`afk: the Escalation itself could not complete — inspect ${handle.dir}\n`,
				);
				return 3;
			}
			return 2;
		}

		const inCycle =
			state.name === "cycle" ||
			state.name === "publish" ||
			state.name === "review" ||
			state.name === "handoff"
				? state.cycle
				: null;
		const id = opId(effect, handle.ticket);
		emit(RUN_EVENT_NAMES.sideEffectIntent, intentPayload(effect), {
			cycle: inCycle,
			op: id,
		});

		let outcome: OpOutcome;
		try {
			outcome = await executeEffect(
				handle,
				effect,
				seams,
				runCycle,
				runReviews,
			);
		} catch (error) {
			outcome = outcomeFromThrow(effect, error, handle.ticket);
		}

		const completion: Record<string, unknown> = {
			operation: intentPayload(effect).operation,
			status: outcome.status,
		};
		if (
			"text" in outcome &&
			typeof outcome.text === "string" &&
			outcome.text !== ""
		) {
			completion.text = outcome.text;
		}
		const artifacts =
			effect.type === "cycle"
				? persistCycleResult(handle, effect.cycle, outcome)
				: effect.type === "review"
					? persistReviewResult(handle, effect.cycle, outcome)
					: [];
		emit(RUN_EVENT_NAMES.sideEffectCompleted, completion, {
			cycle: inCycle,
			op: id,
			artifacts,
		});

		// Run-scoped facts become known: record them for the projection.
		if (effect.type === "claim" && outcome.status === "claimed") {
			const claimed = outcome as Extract<
				ClaimTicketOutcome,
				{ status: "claimed" }
			>;
			emit(RUN_EVENT_NAMES.context, {
				branch: claimed.branch,
				worktree: claimed.worktree,
			});
		}
		if (
			effect.type === "bootstrap" &&
			(outcome.status === "created" || outcome.status === "exists")
		) {
			emit(RUN_EVENT_NAMES.context, {
				pr: outcome.pr.number,
			});
		}

		const previous = state;
		const next = transition(state, eventFor(effect, outcome));
		state = next.state;
		effect = next.effect;
		enterStage(state, previous);
	}

	// effect === null: the refused or handed-over terminal.
	if (state.name === "refused") {
		emit(RUN_EVENT_NAMES.outcome, {
			outcome: "refused",
			reason: state.reason,
		});
		io.stderr(`afk: run ${handle.runId} refused: ${state.reason}\n`);
		return 1;
	}
	if (state.name === "handed-over") {
		emit(RUN_EVENT_NAMES.outcome, {
			outcome: "handed-over-to-maintainer",
			pr: state.facts.pr?.number,
		});
		io.stdout(
			`afk: run ${handle.runId} handed over to the Maintainer at the Merge gate: PR #${state.facts.pr?.number} ${state.facts.pr?.url}\n  ${handle.dir}\n`,
		);
		return 0;
	}
	// Unreachable: every terminal is handled above.
	return 3;
}

async function executeEffect(
	handle: RunHandle,
	effect: Exclude<MachineEffect, { type: "escalate" }>,
	seams: EngineSeams,
	runCycle: CyclePort,
	runReviews: ReviewPort,
): Promise<OpOutcome> {
	switch (effect.type) {
		case "claim":
			return claimTicket(handle.ticket, seams);
		case "bootstrap":
			return bootstrapDraftPr(effect.input, seams);
		case "cycle":
			return runCycle(effect.cycle);
		case "candidate-push":
			return pushCandidate(effect.input, seams);
		case "review":
			return runReviews(effect.cycle);
		case "handoff":
			return handOffPr(effect.input, seams);
	}
}

/**
 * Persist the cycle's structured result verbatim — verified evidence,
 * failure feedback, or the escalate verdict — as a Run artifact; nothing
 * about a cycle is ever discarded.
 */
function persistCycleResult(
	handle: RunHandle,
	cycle: number,
	outcome: OpOutcome,
): string[] {
	const dir = artifactDir(handle, `cycle-${cycle}`);
	fs.writeFileSync(
		path.join(dir, "result.json"),
		`${JSON.stringify({ cycle, ...outcome }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	return [`cycle-${cycle}/result.json`];
}

/**
 * Persist the Review gate's structured outcome verbatim — the dual
 * approval, the requested changes, or the escalate verdict — as a Run
 * artifact beside the cycle's own (ticket #63); nothing about a Review
 * round is ever discarded.
 */
function persistReviewResult(
	handle: RunHandle,
	cycle: number,
	outcome: OpOutcome,
): string[] {
	const dir = artifactDir(handle, `cycle-${cycle}`);
	fs.writeFileSync(
		path.join(dir, "review-result.json"),
		`${JSON.stringify({ cycle, ...outcome }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	return [`cycle-${cycle}/review-result.json`];
}

async function executeEscalation(
	handle: RunHandle,
	state: Extract<MachineState, { name: "escalated" }>,
	seams: EngineSeams,
	emit: (
		name: string,
		payload: Record<string, unknown>,
		rest?: { cycle?: number | null; op?: string | null; artifacts?: string[] },
	) => void,
): Promise<boolean> {
	const id = opId({ type: "escalate" }, handle.ticket);
	emit(
		RUN_EVENT_NAMES.sideEffectIntent,
		{ operation: OP_NAMES.escalate },
		{
			cycle: state.cycle,
			op: id,
		},
	);
	const outcome = await escalateRun(
		{
			issue: handle.ticket,
			run: handle.runId,
			stage: state.stage,
			...(state.cycle === null ? {} : { cycle: state.cycle }),
			reason: state.reason,
			...(state.facts.pr === undefined ? {} : { pr: state.facts.pr }),
			...(state.facts.branch === undefined
				? {}
				: { branch: state.facts.branch }),
			...(state.facts.worktree === undefined
				? {}
				: { worktree: state.facts.worktree }),
			runDirectory: handle.dir,
		},
		seams,
	);
	emit(
		RUN_EVENT_NAMES.sideEffectCompleted,
		{
			operation: OP_NAMES.escalate,
			status: outcome.status,
			text: outcome.text,
		},
		{ cycle: state.cycle, op: id },
	);
	return outcome.status === "escalated";
}
