/**
 * The narrow Escalation operation (ticket afk-kit #58): return a Ticket to
 * the Maintainer when a Run cannot proceed. One status comment naming the
 * Run, stage, reason, PR, branch, worktree, and run directory; `needs-info`
 * applied and the workflow labels removed; the assignee, PR, branch,
 * worktree, and all evidence preserved — a maintainer cleans or archives
 * them and restores `ready-for-agent` before another Run (review-and-
 * escalation convention, v0 spec in afk-kit #46).
 *
 * Every step is attempted even after an earlier one fails; an incomplete
 * escalation is an ESCALATION_FAILURE that names what stuck (the CLI's exit-3
 * internal failure). There is no compensation: escalation is one-way and
 * preserving.
 */

import type { EngineSeams, PrRef } from "./seams.ts";

export interface EscalationFacts {
	issue: number;
	/** The Run's deterministic identity (run id). */
	run: string;
	/** Where the Run stopped, e.g. `implement` or `handoff`. */
	stage: string;
	/** The Implement–Review Cycle, when the stage is inside one. */
	cycle?: number;
	reason: string;
	pr?: PrRef;
	branch?: string;
	worktree?: string;
	runDirectory?: string;
}

export type EscalationOutcome =
	| { status: "escalated"; issue: number; text: string }
	| { status: "failed"; issue: number; text: string; failures: string[] };

export function statusComment(facts: EscalationFacts): string {
	const lines = [
		`ESCALATION: Run ${facts.run} on #${facts.issue} stopped at ${facts.stage}${facts.cycle === undefined ? "" : `, cycle ${facts.cycle}`}: ${facts.reason}`,
		"",
	];
	if (facts.pr) lines.push(`- PR: #${facts.pr.number} ${facts.pr.url}`);
	if (facts.branch) lines.push(`- Branch: ${facts.branch}`);
	if (facts.worktree) lines.push(`- Worktree: ${facts.worktree}`);
	if (facts.runDirectory) lines.push(`- Run directory: ${facts.runDirectory}`);
	if (facts.pr || facts.branch || facts.worktree || facts.runDirectory) {
		lines.push("");
	}
	lines.push(
		"The assignee, pull request, branch, worktree, and run evidence are preserved for inspection. A maintainer must review them, clean or archive what is stale, and restore `ready-for-agent` before another Run.",
	);
	return lines.join("\n");
}

export async function escalateRun(
	facts: EscalationFacts,
	seams: EngineSeams,
): Promise<EscalationOutcome> {
	const { issue } = facts;

	// Which workflow labels the ticket carries: only present ones are
	// removed, so a re-materialized escalation stays idempotent.
	let labels: string[];
	try {
		const { stdout, stderr, exitCode } = await seams.gh([
			"issue",
			"view",
			String(issue),
			"--json",
			"labels",
		]);
		if (exitCode !== 0) {
			return {
				status: "failed",
				issue,
				failures: ["read the issue's labels"],
				text: `ESCALATION_FAILURE: escalation of #${issue} could not read the issue's labels: ${stderr.trim()}. Nothing was written.`,
			};
		}
		labels = (JSON.parse(stdout) as { labels: { name: string }[] }).labels.map(
			(l) => l.name,
		);
	} catch (error) {
		return {
			status: "failed",
			issue,
			failures: ["read the issue's labels"],
			text: `ESCALATION_FAILURE: escalation of #${issue} could not read the issue's labels: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`,
		};
	}

	// Idempotency (ticket #65): if this Run's escalation comment already
	// exists — a crash between the post and the Run's outcome record — the
	// comment is never posted twice. Any other read failure degrades to
	// posting, which duplicates at worst one comment; skipping a needed
	// post would leave the Ticket without its status comment.
	let commentPosted = true;
	try {
		const { stdout } = await seams.gh([
			"issue",
			"view",
			String(issue),
			"--json",
			"comments",
		]);
		const comments = (
			JSON.parse(stdout) as {
				comments?: { body?: string }[];
			}
		).comments?.map((c) => c.body ?? "");
		commentPosted = !comments?.some((body) =>
			body.includes(`ESCALATION: Run ${facts.run} `),
		);
	} catch {
		commentPosted = true;
	}

	const tracker = async (args: string[]): Promise<void> => {
		const r = await seams.gh(args);
		if (r.exitCode !== 0) throw new Error(r.stderr.trim());
	};

	const steps: { name: string; action: () => Promise<void> }[] = [
		...(commentPosted
			? [
					{
						name: "post the status comment" as const,
						action: () =>
							tracker([
								"issue",
								"comment",
								String(issue),
								"--body",
								statusComment(facts),
							]),
					},
				]
			: []),
		{
			name: "apply needs-info",
			action: () =>
				tracker(["issue", "edit", String(issue), "--add-label", "needs-info"]),
		},
		...(labels.includes("in-progress")
			? [
					{
						name: "remove in-progress",
						action: () =>
							tracker([
								"issue",
								"edit",
								String(issue),
								"--remove-label",
								"in-progress",
							]),
					},
				]
			: []),
		...(labels.includes("in-review")
			? [
					{
						name: "remove in-review",
						action: () =>
							tracker([
								"issue",
								"edit",
								String(issue),
								"--remove-label",
								"in-review",
							]),
					},
				]
			: []),
	];

	const failed: { name: string; message: string }[] = [];
	for (const step of steps) {
		try {
			await step.action();
		} catch (error) {
			failed.push({
				name: step.name,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (failed.length > 0) {
		const failures = failed.map((f) => f.name);
		const completed = steps
			.map((s) => s.name)
			.filter((name) => !failures.includes(name));
		const lines = [
			`ESCALATION_FAILURE: escalation of #${issue} did not complete: ${failed
				.map((f) => `${f.name} (${f.message})`)
				.join("; ")}.`,
		];
		if (completed.length > 0) {
			lines.push(`Completed: ${completed.join("; ")}.`);
		}
		lines.push(
			"The preserved artifacts are untouched; a maintainer should reconcile the ticket state by hand.",
		);
		return { status: "failed", issue, text: lines.join("\n"), failures };
	}

	return {
		status: "escalated",
		issue,
		text: `Escalated #${issue}: status comment posted, needs-info applied, workflow labels removed; the assignee, PR, branch, worktree, and run evidence are preserved.`,
	};
}
