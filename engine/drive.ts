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
import { RUN_EVENT_NAMES, readRunEvents } from "./runs/events.ts";
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
	/**
	 * The Run's interruption seam (ticket #65). Defaults to a fresh one;
	 * ports register their in-flight sessions on it so an interruption
	 * aborts them, and the driver races their settle against the settle cap.
	 */
	interruption?: Interruption;
	/**
	 * Install the OS signal handlers that interrupt the Run (SIGINT,
	 * SIGTERM). Defaults to the real process; tests capture the handler.
	 * Returns the uninstaller; the driver calls it when the Run finalizes.
	 */
	installSignals?: (handler: (signal: string) => void) => () => void;
	/**
	 * The Run's wall-clock deadline in milliseconds, measured from the Run
	 * started event (ticket #65: two hours). `null` disables — tests only;
	 * the durable spec's deadline is the default.
	 */
	deadlineMs?: number | null;
	/** Overrides the settle cap (durable spec: 30 seconds) — tests only. */
	settleCapMs?: number;
}

/** The Run's wall-clock deadline (durable spec #46: two hours). */
export const RUN_DEADLINE_MS = 2 * 60 * 60 * 1000;

/**
 * How long an interrupted operation may keep settling and flushing before
 * the Run finalizes (durable spec #46: 30 seconds; the agent's evidence is
 * already on disk live — the cap bounds only the wait).
 */
export const INTERRUPT_SETTLE_CAP_MS = 30_000;

/**
 * The Run interruption seam (ticket #65): human cancellation, `SIGINT`,
 * `SIGTERM`, and the two-hour Run deadline all arrive through `request`.
 * The first reason wins; a second signal changes nothing. Ports register
 * with `onRequest` to abort their in-flight agent sessions; the driver
 * waits for the aborted operation to settle, up to the settle cap, then
 * escalates the Run — an interrupted Run never continues and never resumes.
 */
export interface Interruption {
	request(reason: string): void;
	/** Register an abort listener; returns its unregister function. */
	onRequest(listener: (reason: string) => void): () => void;
	/** The pending interruption reason, or null while uninterrupted. */
	reason(): string | null;
}

export function createInterruption(): Interruption {
	let reason: string | null = null;
	const listeners = new Set<(reason: string) => void>();
	return {
		request(next) {
			if (reason !== null) return;
			reason = next;
			for (const listener of listeners) listener(next);
		},
		onRequest(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		reason: () => reason,
	};
}

/** The default signal installation: the real process's SIGINT and SIGTERM. */
function installProcessSignals(handler: (signal: string) => void): () => void {
	const h = (signal: NodeJS.Signals) => handler(signal);
	process.on("SIGINT", h);
	process.on("SIGTERM", h);
	return () => {
		process.off("SIGINT", h);
		process.off("SIGTERM", h);
	};
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

/** The message of an unknown thrown value. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Run-scoped facts learned by a side effect that settled inside the
 * interrupt's settle window; the interrupt Escalation preserves them so
 * the status comment keeps naming the PR, branch, and worktree.
 */
function factsFromOutcome(
	effect: MachineEffect,
	outcome: OpOutcome,
): RunFacts | undefined {
	switch (effect.type) {
		case "claim":
			return outcome.status === "claimed"
				? {
						branch: outcome.branch,
						worktree: outcome.worktree,
					}
				: undefined;
		case "bootstrap":
			return outcome.status === "created" || outcome.status === "exists"
				? { pr: outcome.pr }
				: undefined;
		default:
			return undefined;
	}
}

/**
 * Keep the interruption itself as a cycle or Review evidence artifact: the
 * operation was cut off and its ordinary result never existed.
 */
function persistInterruption(
	handle: RunHandle,
	kind: "cycle" | "review",
	cycle: number,
): string[] {
	const dir = artifactDir(handle, `cycle-${cycle}`);
	const file = path.join(
		dir,
		kind === "cycle" ? "result.json" : "review-result.json",
	);
	fs.writeFileSync(
		file,
		`${JSON.stringify({ cycle, status: "interrupted" }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	return [`cycle-${cycle}/${path.basename(file)}`];
}

export async function driveRun(options: DriveOptions): Promise<DriveExit> {
	const { handle, seams, runCycle, runReviews } = options;
	const io: DriveIo = options.io ?? {
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	};
	const interruption = options.interruption ?? createInterruption();
	const settleCapMs = options.settleCapMs ?? INTERRUPT_SETTLE_CAP_MS;

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

	// The two-hour Run deadline (ticket #65): measured from the Run started
	// event, not the drive's own start. Firing interrupts the Run exactly
	// like a signal would.
	const deadlineMs =
		options.deadlineMs === undefined ? RUN_DEADLINE_MS : options.deadlineMs;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	if (deadlineMs !== null) {
		const startedMs = runStartedAtMs(handle) ?? Date.now();
		const remaining = startedMs + deadlineMs - Date.now();
		deadlineTimer = setTimeout(
			() => {
				interruption.request("the Run exceeded its two-hour deadline");
			},
			Math.max(0, remaining),
		);
		deadlineTimer.unref?.();
	}
	const uninstallSignals =
		options.installSignals === undefined
			? installProcessSignals((signal) =>
					interruption.request(`interrupted by ${signal}`),
				)
			: options.installSignals((signal) =>
					interruption.request(`interrupted by ${signal}`),
				);

	try {
		return await driveLocked(handle, seams, runCycle, runReviews, io, {
			interruption,
			settleCapMs,
		});
	} finally {
		clearTimeout(deadlineTimer);
		uninstallSignals();
		releaseRunLock(lock, handle);
	}
}

/** The Run started event's timestamp in ms, when the stream is readable. */
function runStartedAtMs(handle: RunHandle): number | null {
	const started = readRunEvents(handle.eventsPath).events.find(
		(event) =>
			event.name === RUN_EVENT_NAMES.started &&
			Number.isFinite(Date.parse(event.ts)),
	);
	return started === undefined ? null : Date.parse(started.ts);
}

async function driveLocked(
	handle: RunHandle,
	seams: EngineSeams,
	runCycle: CyclePort,
	runReviews: ReviewPort,
	io: DriveIo,
	interrupt: {
		interruption: Interruption;
		settleCapMs: number;
	},
): Promise<DriveExit> {
	const { interruption, settleCapMs } = interrupt;

	/**
	 * Record every event through the journal; a failed append breaks the
	 * evidence trail, so the Run escalates immediately (ticket #65) instead
	 * of executing side effects it can no longer journal. Failures during
	 * the final escalation itself are swallowed — the tracker comment is
	 * then the durable record.
	 */
	let journalFailure: string | null = null;
	const emit = (
		name: string,
		payload: Record<string, unknown>,
		rest: {
			cycle?: number | null;
			op?: string | null;
			artifacts?: string[];
		} = {},
	): void => {
		if (journalFailure !== null && name !== RUN_EVENT_NAMES.outcome) return;
		try {
			recordEvent(handle, {
				name,
				payload,
				cycle: rest.cycle ?? null,
				op: rest.op ?? null,
				artifacts: rest.artifacts ?? [],
			});
		} catch (error) {
			journalFailure ??= `the Run journal failed: ${messageOf(error)}`;
		}
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

	/** Whether the pending interruption has been fed to the machine. */
	let interruptHandled = false;

	while (effect !== null) {
		// A broken journal, an interrupt between operations, or a deadline
		// that fired while the driver waited: all stop the Run right here.
		// A terminal state is already resolved — its escalation effect runs.
		const terminal =
			state.name === "refused" ||
			state.name === "escalated" ||
			state.name === "handed-over";
		const stopReason = terminal
			? null
			: (journalFailure ?? (interruptHandled ? null : interruption.reason()));
		if (stopReason !== null) {
			interruptHandled = true;
			emit(RUN_EVENT_NAMES.notice, { message: stopReason });
			const next = transition(state, { type: "interrupt", reason: stopReason });
			state = next.state;
			effect = next.effect; // the escalate effect
		}

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

		// Execute the side effect, but an interruption during it stops the
		// wait: the in-flight work (an agent session) is aborted through the
		// interruption listeners and allowed up to the settle cap to flush
		// its evidence (ticket #65) before the Run finalizes.
		const execution = executeEffect(
			handle,
			effect,
			seams,
			runCycle,
			runReviews,
		).then(
			(outcome): OpOutcome => outcome,
			(error): OpOutcome =>
				outcomeFromThrow(
					effect as Exclude<MachineEffect, { type: "escalate" }>,
					error,
					handle.ticket,
				),
		);
		let settleCapTimer: ReturnType<typeof setTimeout> | undefined;
		const capFired = new Promise<false>((resolve) => {
			const off = interruption.onRequest((reason) => {
				off();
				settleCapTimer = setTimeout(() => resolve(false), settleCapMs);
				settleCapTimer.unref?.();
				void reason;
			});
		});
		const raced = await Promise.race([
			execution.then((outcome): { settled: true; outcome: OpOutcome } => ({
				settled: true,
				outcome,
			})),
			capFired.then((): { settled: false } => ({ settled: false })),
		]);
		clearTimeout(settleCapTimer);
		const interruptedNow = interruption.reason() !== null && !interruptHandled;
		let settledOutcome: OpOutcome | null = raced.settled ? raced.outcome : null;

		// Evidence persistence: a cycle's or Review's structured result is
		// written verbatim before the machine decides. A persistence failure
		// breaks the Run's evidence trail, so the Run escalates immediately
		// (ticket afk-kit #64) instead of continuing without its evidence.
		let artifacts: string[] = [];
		let evidenceRefusal: string | null = null;
		if (effect.type === "cycle" || effect.type === "review") {
			try {
				artifacts =
					settledOutcome === null
						? persistInterruption(handle, effect.type, effect.cycle)
						: effect.type === "cycle"
							? persistCycleResult(handle, effect.cycle, settledOutcome)
							: persistReviewResult(handle, effect.cycle, settledOutcome);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				evidenceRefusal = `cannot persist ${effect.type} evidence: ${message}`;
			}
		}

		const completion: Record<string, unknown> = {
			operation: intentPayload(effect).operation,
			status: settledOutcome === null ? "interrupted" : settledOutcome.status,
		};
		if (evidenceRefusal !== null) {
			completion.text = `EVIDENCE_REFUSAL: ${evidenceRefusal}`;
		} else if (settledOutcome !== null) {
			if (
				"text" in settledOutcome &&
				typeof settledOutcome.text === "string" &&
				settledOutcome.text !== ""
			) {
				completion.text = settledOutcome.text;
			}
		} else {
			completion.text = `the operation did not settle within ${Math.round(settleCapMs / 1000)} seconds after the interruption`;
		}
		emit(RUN_EVENT_NAMES.sideEffectCompleted, completion, {
			cycle: inCycle,
			op: id,
			artifacts,
		});

		// The evidence trail is broken: the machine decides the escalation
		// through its ordinary path — the Run never continues without its
		// evidence (ticket afk-kit #64, durable spec #46). An interruption
		// that fired in the same window wins; the refusal stays recorded.
		if (
			evidenceRefusal !== null &&
			settledOutcome !== null &&
			(effect.type === "cycle" || effect.type === "review")
		) {
			settledOutcome = {
				status: "escalate",
				cycle: effect.cycle,
				reason: evidenceRefusal,
			};
		}

		// Run-scoped facts become known: record them for the projection.
		if (
			settledOutcome !== null &&
			effect.type === "claim" &&
			settledOutcome.status === "claimed"
		) {
			const claimed = settledOutcome as Extract<
				ClaimTicketOutcome,
				{ status: "claimed" }
			>;
			emit(RUN_EVENT_NAMES.context, {
				branch: claimed.branch,
				worktree: claimed.worktree,
			});
		}
		if (
			settledOutcome !== null &&
			effect.type === "bootstrap" &&
			(settledOutcome.status === "created" ||
				settledOutcome.status === "exists")
		) {
			const pr = settledOutcome.pr;
			emit(RUN_EVENT_NAMES.context, {
				pr: pr.number,
			});
		}

		// Decide the machine event: an interruption wins over every settled
		// outcome except a handoff that completed within the settle window —
		// the Run never escalates a PR that is already with the Maintainer.
		const previous = state;
		if (interruptedNow && settledOutcome?.status !== "handed-off") {
			interruptHandled = true;
			const reason = interruption.reason() ?? "interrupted";
			emit(RUN_EVENT_NAMES.notice, {
				message: reason,
				...(raced.settled
					? {}
					: { settle: "cap fired before the operation settled" }),
				op: id,
			});
			const next = transition(state, {
				type: "interrupt",
				reason,
				...(settledOutcome === null
					? {}
					: { facts: factsFromOutcome(effect, settledOutcome) }),
			});
			state = next.state;
			effect = next.effect;
		} else {
			if (settledOutcome === null) {
				// Unreachable: the cap only fires once interrupted.
				throw new Error("the settle cap fired without an interruption");
			}
			const next = transition(
				state,
				eventFor(
					effect as Exclude<MachineEffect, { type: "escalate" }>,
					settledOutcome,
				),
			);
			state = next.state;
			effect = next.effect;
		}
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
