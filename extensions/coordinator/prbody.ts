/**
 * Pull-request title and body assembly for the publish op (ticket afk-kit
 * #19). The body's shape and section order are canonical:
 * docs/conventions/branching-and-prs.md — `Closes #<n>`, the brief's
 * acceptance criteria as a checklist, touched areas, and the verify commands
 * with their latest results (the op re-runs them in the worktree before
 * pushing; a failing command refuses the publish). Review-round notes are
 * appended by later rounds, not at open time. Pure logic, L1-verified.
 */

import { type ParsedBrief, parseBrief } from "../readiness/brief.ts";

export interface VerifyResult {
	command: string;
	ok: boolean;
}

export function prTitle(summary: string, issue: number): string {
	return `${summary} (#${issue})`;
}

export function prBody(
	brief: ParsedBrief,
	issue: number,
	verifyResults: VerifyResult[],
): string {
	const lines: string[] = [`Closes #${issue}`, ""];

	const criteria = brief.acceptanceCriteria.value;
	lines.push("## Acceptance criteria", "", criteria, "");

	lines.push("## Touched areas", "", brief.touchedAreas.value, "");

	lines.push("## Verify commands", "");
	for (const result of verifyResults) {
		lines.push(`- \`${result.command}\` — ${result.ok ? "pass" : "FAIL"}`);
	}

	return lines.join("\n").replace(/\n+$/, "\n");
}

/** Convenience wrapper the publish op calls with the raw issue body. */
export function prBodyFromIssueBody(
	issueBody: string,
	issue: number,
	verifyResults: VerifyResult[],
): string {
	return prBody(parseBrief(issueBody), issue, verifyResults);
}
