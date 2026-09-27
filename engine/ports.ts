/**
 * The Engine's typed cycle port (ticket afk-kit #61, durable spec #46):
 * one Implement–Review Cycle — fresh confined Implementer, deterministic
 * Verify, parallel Standards and Spec Reviews — behind a single typed
 * boundary. The Engine owns the transitions and the cap; the port owns the
 * cycle's mechanics. Ticket #61 proves the loop with a scripted port; #62
 * replaces the script with real sessions and Verify execution.
 *
 * The port returns outcomes, it never throws for cycle results: a cycle
 * that failed returns `failed`, a verdict or fact that must end the Run
 * immediately returns `escalate`.
 */

import type { VerifyResult } from "../extensions/coordinator/prbody.ts";

/** One parallel Review's approval, persisted verbatim as evidence. */
export interface CycleApproval {
	/** Which Review approved: the Standards Review or the Spec Review. */
	review: "standards" | "spec";
	/** The approving verdict's structured payload, as the Review returned it. */
	verdict: Record<string, unknown>;
}

/** The structured result of one Implement–Review Cycle. */
export type CycleOutcome =
	| {
			status: "approved";
			/** The cycle that ran (1-based). */
			cycle: number;
			/**
			 * The cycle's Verify gate results, anchored to exit codes; they
			 * become the PR body's verify evidence at handoff.
			 */
			verifyResults: VerifyResult[];
			/** Both parallel Reviews' approvals — the Run's approval evidence. */
			approvals: CycleApproval[];
			/** Review notes carried into the PR body, when the Reviews left any. */
			reviewNotes?: string;
	  }
	| {
			status: "failed";
			cycle: number;
			/** What failed; routed into the next fresh Implementer. */
			reason: string;
	  }
	| {
			status: "escalate";
			cycle: number;
			/** Why the Run must stop immediately and return to the Maintainer. */
			reason: string;
	  };

/** The cycle port: run cycle `n` against the cumulative worktree. */
export type CyclePort = (cycle: number) => Promise<CycleOutcome>;
