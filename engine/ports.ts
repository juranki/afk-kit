/**
 * The Engine's typed ports (ticket afk-kit #61 and #63, durable spec
 * #46): one Implement–Verify leg and one parallel Review round — together
 * an Implement–Review Cycle — behind typed boundaries. The Engine owns the
 * transitions and the cap; the ports own the mechanics. #61 proved the
 * loop with scripted ports; #62 gave the cycle port real sessions and
 * Verify execution; #63 gives the review port real parallel Reviews over
 * the pushed candidate.
 *
 * The ports return outcomes, they never throw for judged results: a leg
 * that failed returns `failed`/`changes-requested`, a verdict or fact that
 * must end the Run immediately returns `escalate`.
 */

import type { VerifyResult } from "../extensions/coordinator/prbody.ts";
import type { ReviewApproval } from "./verdict.ts";

/**
 * The structured result of one Implement–Verify leg: a `verified` cycle
 * carries no approvals — only the Review gate approves (ticket #63).
 */
export type CycleOutcome =
	| {
			status: "verified";
			/** The cycle that ran (1-based). */
			cycle: number;
			/**
			 * The cycle's Verify gate results, anchored to exit codes; they
			 * become the PR body's verify evidence at handoff.
			 */
			verifyResults: VerifyResult[];
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

/** The structured result of one parallel Review round. */
export type ReviewOutcome =
	| {
			status: "approved";
			/** The cycle the Reviews judged (1-based). */
			cycle: number;
			/** Both parallel Reviews' approvals — the Run's approval evidence. */
			approvals: ReviewApproval[];
			/** Review notes carried into the PR body, when the Reviews left any. */
			reviewNotes?: string;
	  }
	| {
			status: "changes-requested";
			cycle: number;
			/** The deterministic failed-cycle evidence: who asked, and what for. */
			reason: string;
	  }
	| {
			status: "escalate";
			cycle: number;
			/** Why the Run must stop immediately and return to the Maintainer. */
			reason: string;
	  };

/**
 * The review port: run the parallel Standards and Spec Reviews for cycle
 * `n` against the pushed `main...HEAD` diff.
 */
export type ReviewPort = (cycle: number) => Promise<ReviewOutcome>;
