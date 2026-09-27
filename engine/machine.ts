/**
 * The pure Engine state machine (ticket afk-kit #61, durable spec #46):
 * transitions and caps as decisions, side effects only as commands. A Run
 * progresses Claim → draft-PR bootstrap → at most three Implement–Review
 * Cycles → publish → handoff, ending in exactly one terminal outcome —
 * `refused` (no Claim survived), `escalated` (a claimed Run stopped
 * unsuccessfully), or `handed-over-to-maintainer` (the ready PR is with the
 * Maintainer at the Merge gate). The machine never merges and never acts
 * again once terminal.
 *
 * The function is total and pure: every (state, event) pair has a
 * transition, terminals absorb every further event, and nothing here
 * touches the world — the driver (drive.ts) interprets the emitted effect
 * through the side-effect adapters and persists every decision through the
 * Run event port.
 */

import type { ClaimTicketOutcome } from "./claim.ts";
import type { CycleOutcome } from "./ports.ts";
import type {
	BootstrapInput,
	BootstrapOutcome,
	CandidateInput,
	CandidatePushOutcome,
	HandOffInput,
	HandOffOutcome,
} from "./pr-ops.ts";
import type { PrRef } from "./seams.ts";

/** The Implement–Review Cycle cap: caps are code paths, not instructions. */
export const MAX_CYCLES = 3;

/** The facts a surviving Claim carries through the rest of the Run. */
export interface ClaimFacts {
	issue: number;
	branch: string;
	/** The fetched origin/main SHA the branch starts from. */
	base: string;
	worktree: string;
}

/** Run facts as they become known; the driver merges the Ticket number in. */
export interface RunFacts {
	branch?: string;
	worktree?: string;
	pr?: PrRef;
}

/** The approval evidence an approved cycle hands the Engine. */
export interface ApprovedCycle {
	cycle: number;
	/** The cycle's Verify gate results, recorded as the PR body's evidence. */
	verifyResults: { command: string; ok: boolean }[];
	/** The parallel Reviews' approvals, persisted verbatim. */
	approvals: unknown[];
	reviewNotes?: string;
}

/**
 * The Run's machine states. Non-terminals name the stage the driver is in
 * and carry exactly the facts the stage's effect needs; terminals carry the
 * evidence a status projection and Escalation need.
 */
export type MachineState =
	| { name: "claim" }
	| { name: "bootstrap"; claim: ClaimFacts }
	| { name: "cycle"; claim: ClaimFacts; pr: PrRef; cycle: number }
	| {
			name: "publish";
			claim: ClaimFacts;
			pr: PrRef;
			cycle: number;
			approved: ApprovedCycle;
	  }
	| {
			name: "handoff";
			claim: ClaimFacts;
			pr: PrRef;
			cycle: number;
			approved: ApprovedCycle;
	  }
	| { name: "refused"; reason: string }
	| {
			name: "escalated";
			reason: string;
			/** The stage the Run stopped at. */
			stage: string;
			/** The Cycle the Run stopped in, when the stage is inside one. */
			cycle: number | null;
			facts: RunFacts;
	  }
	| { name: "handed-over"; facts: RunFacts; cycle: number };

/** The outcomes the driver feeds back after executing an effect. */
export type MachineEvent =
	| { type: "claim"; outcome: ClaimTicketOutcome }
	| { type: "bootstrap"; outcome: BootstrapOutcome }
	| { type: "cycle"; outcome: CycleOutcome }
	| { type: "candidate-push"; outcome: CandidatePushOutcome }
	| { type: "handoff"; outcome: HandOffOutcome };

/**
 * The side-effect commands. Each is interpreted by the driver through one
 * narrow adapter; none merges, rewrites the immutable brief, or waits for
 * the Engine to act after the handoff.
 */
export type MachineEffect =
	| { type: "claim" }
	| { type: "bootstrap"; input: BootstrapInput }
	| { type: "cycle"; cycle: number }
	| { type: "candidate-push"; input: CandidateInput }
	| { type: "handoff"; input: HandOffInput }
	| { type: "escalate" };

/** The state the machine starts in: the Claim seam, readiness already passed. */
export function startState(): MachineState {
	return { name: "claim" };
}

/** One transition: the next state and the single side effect to execute. */
export function transition(
	state: MachineState,
	event: MachineEvent,
): { state: MachineState; effect: MachineEffect | null } {
	// Terminals absorb: a finished Run never acts again.
	if (
		state.name === "refused" ||
		state.name === "escalated" ||
		state.name === "handed-over"
	) {
		return { state, effect: null };
	}

	switch (state.name) {
		case "bootstrap": {
			if (event.type !== "bootstrap") break;
			if (event.outcome.status === "refused") {
				return {
					state: {
						name: "escalated",
						reason: event.outcome.text,
						stage: "bootstrap",
						cycle: null,
						facts: {
							branch: state.claim.branch,
							worktree: state.claim.worktree,
						},
					},
					effect: { type: "escalate" },
				};
			}
			return {
				state: {
					name: "cycle",
					claim: state.claim,
					pr: event.outcome.pr,
					cycle: 1,
				},
				effect: { type: "cycle", cycle: 1 },
			};
		}
		case "cycle": {
			if (event.type !== "cycle") break;
			const facts: RunFacts = {
				branch: state.claim.branch,
				worktree: state.claim.worktree,
				pr: state.pr,
			};
			if (event.outcome.status === "approved") {
				const approved: ApprovedCycle = {
					cycle: event.outcome.cycle,
					verifyResults: event.outcome.verifyResults,
					approvals: event.outcome.approvals,
					...(event.outcome.reviewNotes === undefined
						? {}
						: { reviewNotes: event.outcome.reviewNotes }),
				};
				return {
					state: {
						name: "publish",
						claim: state.claim,
						pr: state.pr,
						cycle: state.cycle,
						approved,
					},
					effect: {
						type: "candidate-push",
						input: {
							issue: state.claim.issue,
							branch: state.claim.branch,
							worktree: state.claim.worktree,
						},
					},
				};
			}
			if (event.outcome.status === "escalate" || state.cycle >= MAX_CYCLES) {
				return {
					state: {
						name: "escalated",
						reason: event.outcome.reason,
						stage: "cycle",
						cycle: state.cycle,
						facts,
					},
					effect: { type: "escalate" },
				};
			}
			return {
				state: { ...state, cycle: state.cycle + 1 },
				effect: { type: "cycle", cycle: state.cycle + 1 },
			};
		}
		case "publish": {
			if (event.type !== "candidate-push") break;
			const facts: RunFacts = {
				branch: state.claim.branch,
				worktree: state.claim.worktree,
				pr: state.pr,
			};
			if (event.outcome.status === "refused") {
				return {
					state: {
						name: "escalated",
						reason: event.outcome.text,
						stage: "publish",
						cycle: state.cycle,
						facts,
					},
					effect: { type: "escalate" },
				};
			}
			return {
				state: {
					name: "handoff",
					claim: state.claim,
					pr: state.pr,
					cycle: state.cycle,
					approved: state.approved,
				},
				effect: {
					type: "handoff",
					input: {
						issue: state.claim.issue,
						branch: state.claim.branch,
						worktree: state.claim.worktree,
						verifyResults: state.approved.verifyResults,
						...(state.approved.reviewNotes === undefined
							? {}
							: { reviewNotes: state.approved.reviewNotes }),
					},
				},
			};
		}
		case "handoff": {
			if (event.type !== "handoff") break;
			const facts: RunFacts = {
				branch: state.claim.branch,
				worktree: state.claim.worktree,
				pr: state.pr,
			};
			if (event.outcome.status === "handed-off") {
				return {
					state: { name: "handed-over", facts, cycle: state.cycle },
					effect: null,
				};
			}
			return {
				state: {
					name: "escalated",
					reason: event.outcome.text,
					stage: "handoff",
					cycle: state.cycle,
					facts,
				},
				effect: { type: "escalate" },
			};
		}
		case "claim": {
			if (event.type !== "claim") break;
			if (event.outcome.status === "claimed") {
				const claim: ClaimFacts = {
					issue: event.outcome.issue,
					branch: event.outcome.branch,
					base: event.outcome.base,
					worktree: event.outcome.worktree,
				};
				return {
					state: { name: "bootstrap", claim },
					effect: {
						type: "bootstrap",
						input: {
							issue: claim.issue,
							branch: claim.branch,
							worktree: claim.worktree,
						},
					},
				};
			}
			return {
				state: { name: "refused", reason: event.outcome.text },
				effect: null,
			};
		}
	}
	return { state, effect: null };
}
