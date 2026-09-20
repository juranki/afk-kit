/**
 * Coordinator mechanics (R7, ticket afk-kit #19): the deterministic
 * coordinator-side operations as registered tools — the same mechanism as
 * the subagent tool, the readiness check, and the merge guard (ADR 0006):
 *
 *   claim_issue  — the atomic claim: embeds the readiness check (refusing
 *                  with READINESS_REFUSAL and claiming nothing on failure),
 *                  refuses an already-claimed issue with CLAIM_REFUSAL, then
 *                  assigns the maintainer, applies `in-progress`, and
 *                  creates the worktree + branch from main. Failure at any
 *                  step compensates the steps before it; a compensation
 *                  failure is named as leftover state.
 *
 *   publish_pr   — runs the brief's verify commands in the worktree (a
 *                  failing command refuses with PUBLISH_REFUSAL, nothing
 *                  pushed), pushes the branch, opens the PR titled
 *                  `<summary> (#<n>)` with the brief's checklist, touched
 *                  areas, and verify results, requests the maintainer's
 *                  review, and flips `in-progress` to `in-review`. Refuses a
 *                  branch that already has an open PR; the same compensation
 *                  discipline covers its steps.
 *
 * Judgment stays prompt-side (the coordinator skill): which ticket, whether
 * to push now — these tools only do the mechanics identically every time.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runGh } from "../readiness/gh.ts";
import { runGit } from "./git.ts";
import { claimIssue, publishPr } from "./ops.ts";

export default function (pi: ExtensionAPI) {
	// The coordinator session runs at the primary checkout: gh and git
	// default to it, and worktrees land under ~/wt/<project>/<branch>.
	const seams = {
		gh: runGh(process.cwd()),
		git: runGit(),
		checkout: process.cwd(),
		worktreeRoot: path.join(os.homedir(), "wt"),
	};

	pi.registerTool({
		name: "claim_issue",
		label: "Claim issue",
		description: [
			"Atomically claim an issue for a coordinator (R7, ADR 0012): re-runs the readiness check and refuses — claiming nothing — with READINESS_REFUSAL on failure;",
			"refuses an already-claimed issue (an assignee or a leftover in-progress marker) with CLAIM_REFUSAL naming the existing claim;",
			"otherwise assigns the issue to the maintainer account (the authenticated gh user), applies in-progress, and creates worktree ~/wt/<project>/issue-<n>-<slug> with branch issue-<n>-<slug> from main in one operation.",
			"Failure at any step compensates the steps before it; a compensation failure is named in the CLAIM_REFUSAL as leftover state.",
			"Only a coordinator claims, and only on a maintainer's command.",
		].join(" "),
		parameters: Type.Object({
			issue: Type.Number({ description: "The issue number to claim." }),
		}),

		async execute(_toolCallId, params) {
			try {
				const outcome = await claimIssue(params.issue, seams);
				return {
					content: [{ type: "text", text: outcome.text }],
					details: {
						ok: outcome.ok,
						issue: outcome.issue,
						branch: outcome.branch,
						worktree: outcome.worktree,
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Claim of #${params.issue} could not run: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { ok: false, issue: params.issue },
				};
			}
		},
	});

	pi.registerTool({
		name: "publish_pr",
		label: "Publish PR",
		description: [
			"Publish a claimed ticket's worktree as a pull request (R7): runs the brief's verify commands in the worktree first (a failing command refuses with PUBLISH_REFUSAL — nothing is pushed),",
			"pushes the branch, opens the PR titled '<summary> (#<n>)' with the brief's acceptance criteria as a checklist, touched areas, and verify-command results, requests the maintainer's review,",
			"then applies in-review and removes in-progress. Refuses a branch that already has an open PR, naming it.",
			"Failure at any step compensates the steps before it (PR closed, remote branch deleted); a compensation failure is named in the PUBLISH_REFUSAL as leftover state.",
		].join(" "),
		parameters: Type.Object({
			worktree: Type.String({
				description:
					"Path to the ticket's worktree; the issue-<n>-<slug> branch checked out there carries the change.",
			}),
			summary: Type.String({
				description: "Imperative summary for the PR title: '<summary> (#<n>)'.",
			}),
		}),

		async execute(_toolCallId, params) {
			try {
				const outcome = await publishPr(params, seams);
				return {
					content: [{ type: "text", text: outcome.text }],
					details: {
						ok: outcome.ok,
						issue: outcome.issue,
						branch: outcome.branch,
						pr: outcome.pr,
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Publish of ${params.worktree} could not run: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { ok: false },
				};
			}
		},
	});
}
