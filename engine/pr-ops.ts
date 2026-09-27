/**
 * The narrow PR-shaping operations (ticket afk-kit #58): the three side
 * effects a deterministic Engine composes after Claim —
 *
 *   bootstrapDraftPr — reconcile the Ticket's draft pull request: skip an
 *       existing open draft PR, refuse a ready one, else push the branch and
 *       open a draft PR titled from the Issue title. A local empty bootstrap
 *       commit makes the branch pushable; the Ticket stays `in-progress`.
 *
 *   pushCandidate — push the worktree's new commits additively to the
 *       already-pushed branch. Plain push only: a non-fast-forward remote
 *       refuses naturally, nothing is ever forced.
 *
 *   handOffPr — record the final evidence in the PR body, mark the draft
 *       ready, apply `in-review`, remove `in-progress`, and never request a
 *       review from the PR author — the ready PR is the handoff signal. A
 *       failed handoff compensates nothing destructively: the Run escalates
 *       and the Escalation preserves the PR, branch, and worktree.
 *
 * Refusals use the house marker pattern: PUBLISH_REFUSAL for bootstrap and
 * candidate pushes (the publish mechanics reshaped), HANDOFF_REFUSAL for
 * handoff (canonical wording in docs/conventions/issue-lifecycle.md).
 */

import { spawn } from "node:child_process";
import { prBody, type VerifyResult } from "../extensions/coordinator/prbody.ts";
import { parseBrief } from "../extensions/readiness/brief.ts";
import { verifyCommandList } from "../extensions/readiness/check.ts";
import type { EngineSeams, PrRef } from "./seams.ts";

const ISSUE_BRANCH = /^issue-(\d+)-/;

export interface BootstrapInput {
	issue: number;
	branch: string;
	worktree: string;
}

export type BootstrapOutcome =
	| {
			status: "created";
			issue: number;
			branch: string;
			pr: PrRef;
			text: string;
	  }
	| { status: "exists"; issue: number; branch: string; pr: PrRef; text: string }
	| {
			status: "refused";
			issue?: number;
			branch?: string;
			text: string;
	  };

export interface CandidateInput {
	issue: number;
	branch: string;
	worktree: string;
}

export type CandidatePushOutcome =
	| {
			status: "pushed";
			issue: number;
			branch: string;
			commits: number;
			head: string;
			text: string;
	  }
	| {
			status: "current";
			issue: number;
			branch: string;
			head: string;
			text: string;
	  }
	| {
			status: "refused";
			issue?: number;
			branch?: string;
			text: string;
	  };

export interface HandOffInput {
	issue: number;
	branch: string;
	worktree: string;
	/** The Engine's final verify run, recorded as the PR body's evidence. */
	verifyResults: VerifyResult[];
	/** Review-round notes, appended to the body when present. */
	reviewNotes?: string;
}

export type HandOffOutcome =
	| {
			status: "handed-off";
			issue: number;
			branch: string;
			pr: PrRef;
			text: string;
	  }
	| {
			status: "refused";
			issue?: number;
			branch?: string;
			text: string;
	  };

interface GhResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function gitOut(args: string[], cwd: string): Promise<GhResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, stdio: "pipe" });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk;
		});
		child.on("error", (error) =>
			resolve({ stdout, stderr: String(error), exitCode: 127 }),
		);
		child.on("close", (exitCode) =>
			resolve({ stdout, stderr, exitCode: exitCode ?? 1 }),
		);
	});
}

async function gitExpect(
	args: string[],
	cwd: string,
	what: string,
): Promise<string> {
	const result = await gitOut(args, cwd);
	if (result.exitCode !== 0) {
		throw new Error(`${what}: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

async function ghJson<T>(seams: EngineSeams, args: string[]): Promise<T> {
	const { stdout, stderr, exitCode } = await seams.gh(args);
	if (exitCode !== 0) {
		throw new Error(
			`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`,
		);
	}
	return JSON.parse(stdout) as T;
}

interface PrListEntry {
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
}

async function openPrForBranch(
	seams: EngineSeams,
	branch: string,
): Promise<PrListEntry[]> {
	return ghJson<PrListEntry[]>(seams, [
		"pr",
		"list",
		"--head",
		branch,
		"--state",
		"open",
		"--json",
		"number,title,url,isDraft",
	]);
}

/** The branch names the ticket and the worktree must be on it. */
async function checkBranch(input: {
	issue: number;
	branch: string;
	worktree: string;
}): Promise<string | undefined> {
	const head = await gitOut(
		["rev-parse", "--abbrev-ref", "HEAD"],
		input.worktree,
	);
	if (head.exitCode !== 0) {
		return `read the worktree branch: ${head.stderr.trim()}`;
	}
	const current = head.stdout.trim();
	if (current !== input.branch) {
		return `the worktree is on ${current}, expected ${input.branch}`;
	}
	const match = ISSUE_BRANCH.exec(input.branch);
	if (!match) {
		return `${input.branch} is not an issue branch (expected issue-<n>-<slug>)`;
	}
	if (Number(match[1]) !== input.issue) {
		return `${input.branch} names issue #${match[1]}, not #${input.issue}`;
	}
	return undefined;
}

function refused(
	text: string,
	issue: number,
	branch: string,
): {
	status: "refused";
	issue: number;
	branch: string;
	text: string;
} {
	return { status: "refused", issue, branch, text };
}

/** The draft body: the convention's shape with verify commands pending.
 * Exported for its L1 tests. */
export function draftPrBody(issueBody: string, issue: number): string {
	const brief = parseBrief(issueBody);
	const lines: string[] = [
		`Closes #${issue}`,
		"",
		"## Acceptance criteria",
		"",
		brief.acceptanceCriteria.value,
		"",
		"## Touched areas",
		"",
		brief.touchedAreas.value,
		"",
		"## Verify commands",
		"",
	];
	for (const command of verifyCommandList(brief.verifyCommands.value)) {
		lines.push(`- \`${command}\` — pending`);
	}
	return lines.join("\n").replace(/\n+$/, "\n");
}

function prUrlFrom(stdout: string): PrRef {
	const url = stdout.trim().split("\n").pop() ?? "";
	const match = /\/pull\/(\d+)\s*$/.exec(url);
	if (!match) throw new Error(`could not read the PR URL from: ${url}`);
	return { number: Number(match[1]), url };
}

export async function bootstrapDraftPr(
	input: BootstrapInput,
	seams: EngineSeams,
): Promise<BootstrapOutcome> {
	const { issue, branch, worktree } = input;

	const branchProblem = await checkBranch(input);
	if (branchProblem) {
		return refused(
			`PUBLISH_REFUSAL: bootstrap of ${branch} refused: ${branchProblem}.`,
			issue,
			branch,
		);
	}

	let view: { title: string; body: string };
	try {
		view = await ghJson<{ title: string; body: string }>(seams, [
			"issue",
			"view",
			String(issue),
			"--json",
			"title,body",
		]);
	} catch (error) {
		return refused(
			`PUBLISH_REFUSAL: bootstrap of ${branch} failed at read the issue: ${error instanceof Error ? error.message : String(error)}.`,
			issue,
			branch,
		);
	}

	// Deterministic identity: one open PR per branch. An existing open draft
	// is the expected state; a ready one is a conflict.
	let existing: PrListEntry[];
	try {
		existing = await openPrForBranch(seams, branch);
	} catch (error) {
		return refused(
			`PUBLISH_REFUSAL: bootstrap of ${branch} failed at list the open pull requests: ${error instanceof Error ? error.message : String(error)}.`,
			issue,
			branch,
		);
	}
	if (existing.length > 0) {
		const pr = existing[0];
		if (pr.isDraft) {
			return {
				status: "exists",
				issue,
				branch,
				pr: { number: pr.number, url: pr.url },
				text: `${branch} already has open draft PR #${pr.number} ${pr.url}; nothing to bootstrap.`,
			};
		}
		return refused(
			`PUBLISH_REFUSAL: bootstrap of ${branch} refused: the branch already has a ready pull request: #${pr.number} "${pr.title}" ${pr.url}.`,
			issue,
			branch,
		);
	}

	let ahead: string;
	try {
		ahead = await gitExpect(
			["rev-list", "--count", "origin/main..HEAD"],
			worktree,
			"count the commits ahead of origin/main",
		);
	} catch (error) {
		return refused(
			`PUBLISH_REFUSAL: bootstrap of ${branch} failed: ${error instanceof Error ? error.message : String(error)}.`,
			issue,
			branch,
		);
	}

	const title = `${view.title} (#${issue})`;
	const body = draftPrBody(view.body, issue);
	let openedPr: PrRef | undefined;

	const steps: {
		name: string;
		action: () => Promise<void>;
		undo?: () => Promise<void>;
		leftover: string | (() => string);
	}[] = [
		// The local empty commit makes the branch pushable; it is never
		// rewound — a re-run skips it by the ahead-count check above.
		...(ahead === "0"
			? [
					{
						name: "create the bootstrap commit",
						action: async () => {
							await gitExpect(
								[
									"commit",
									"--allow-empty",
									"-m",
									`afk: bootstrap draft PR for #${issue}`,
								],
								worktree,
								"git commit --allow-empty",
							);
						},
						leftover: `local bootstrap commit on ${branch}`,
					},
				]
			: []),
		{
			name: "push the branch",
			action: async () => {
				await gitExpect(
					["push", "origin", branch],
					worktree,
					`git push origin ${branch}`,
				);
			},
			undo: async () => {
				await gitExpect(
					["push", "origin", "--delete", branch],
					worktree,
					`git push origin --delete ${branch}`,
				);
			},
			leftover: `remote branch ${branch}`,
		},
		{
			name: "open the draft pull request",
			action: async () => {
				const { stdout } = await seams.gh([
					"pr",
					"create",
					"--draft",
					"--base",
					"main",
					"--head",
					branch,
					"--title",
					title,
					"--body",
					body,
				]);
				openedPr = prUrlFrom(stdout);
			},
			undo: async () => {
				if (!openedPr) return;
				await seams.gh([
					"pr",
					"close",
					String(openedPr.number),
					"--comment",
					"Closed automatically: a later bootstrap step failed.",
				]);
			},
			leftover: () =>
				openedPr
					? `open PR #${openedPr.number} ${openedPr.url}`
					: "an open pull request",
		},
	];

	const completed: string[] = [];
	for (const step of steps) {
		try {
			await step.action();
			completed.push(step.name);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const compensated: string[] = [];
			const leftovers: string[] = [];
			for (const done of [...completed].reverse()) {
				const target = steps.find((s) => s.name === done);
				if (!target?.undo) continue;
				try {
					await target.undo();
					compensated.push(done);
				} catch {
					leftovers.push(
						typeof target.leftover === "function"
							? target.leftover()
							: target.leftover,
					);
				}
			}
			const lines = [
				`PUBLISH_REFUSAL: bootstrap of ${branch} failed at ${step.name}: ${message}.`,
			];
			if (compensated.length > 0) {
				lines.push(`Compensated: ${compensated.join("; ")}.`);
			}
			if (leftovers.length > 0) {
				lines.push(
					`Leftover state — a maintainer should clear: ${leftovers.join("; ")}.`,
				);
			}
			return refused(lines.join("\n"), issue, branch);
		}
	}

	if (!openedPr) {
		return refused(
			`PUBLISH_REFUSAL: bootstrap of ${branch} did not open a pull request.`,
			issue,
			branch,
		);
	}
	return {
		status: "created",
		issue,
		branch,
		pr: openedPr,
		text: `Bootstrapped ${branch}: empty bootstrap commit pushed, draft PR #${openedPr.number} ${openedPr.url} opened; the ticket stays in-progress.`,
	};
}

export async function pushCandidate(
	input: CandidateInput,
	// Uniform operation signature: the Engine passes the same seams bundle to
	// every operation, even one that is pure Git today.
	// biome-ignore lint/correctness/noUnusedFunctionParameters: uniform op signature
	seams: EngineSeams,
): Promise<CandidatePushOutcome> {
	const { issue, branch, worktree } = input;

	const branchProblem = await checkBranch(input);
	if (branchProblem) {
		return refused(
			`PUBLISH_REFUSAL: candidate push of ${branch} refused: ${branchProblem}.`,
			issue,
			branch,
		);
	}

	try {
		const ahead = await gitExpect(
			["rev-list", "--count", "origin/main..HEAD"],
			worktree,
			"count the commits ahead of origin/main",
		);
		if (ahead === "0") {
			return refused(
				`PUBLISH_REFUSAL: candidate push of ${branch} refused: no commits ahead of origin/main — nothing to publish.`,
				issue,
				branch,
			);
		}
		const head = await gitExpect(["rev-parse", "HEAD"], worktree, "read HEAD");
		const remote = await gitOut(["rev-parse", `origin/${branch}`], worktree);
		const remoteHead = remote.exitCode === 0 ? remote.stdout.trim() : "";
		if (remoteHead === head) {
			return {
				status: "current",
				issue,
				branch,
				head,
				text: `${branch} is already pushed at ${head.slice(0, 12)}; nothing to push.`,
			};
		}
		const commits = remoteHead
			? Number(
					await gitExpect(
						["rev-list", "--count", `${remoteHead}..HEAD`],
						worktree,
						"count the candidate commits",
					),
				)
			: Number(ahead);
		await gitExpect(
			["push", "origin", branch],
			worktree,
			`git push origin ${branch} (additive only; nothing is ever forced)`,
		);
		const pushed = await gitExpect(
			["rev-parse", `origin/${branch}`],
			worktree,
			`read origin/${branch}`,
		);
		if (pushed !== head) {
			return refused(
				`PUBLISH_REFUSAL: candidate push of ${branch} failed: origin/${branch} is at ${pushed.slice(0, 12)}, expected ${head.slice(0, 12)}.`,
				issue,
				branch,
			);
		}
		return {
			status: "pushed",
			issue,
			branch,
			commits,
			head,
			text: `Pushed ${commits} candidate commit${commits === 1 ? "" : "s"} to ${branch} at ${head.slice(0, 12)}.`,
		};
	} catch (error) {
		return refused(
			`PUBLISH_REFUSAL: candidate push of ${branch} failed: ${error instanceof Error ? error.message : String(error)}.`,
			issue,
			branch,
		);
	}
}

export async function handOffPr(
	input: HandOffInput,
	seams: EngineSeams,
): Promise<HandOffOutcome> {
	const { issue, branch, verifyResults, reviewNotes } = input;

	const branchProblem = await checkBranch(input);
	if (branchProblem) {
		return refused(
			`HANDOFF_REFUSAL: handoff of ${branch} refused: ${branchProblem}.`,
			issue,
			branch,
		);
	}

	let pr: PrListEntry;
	try {
		const prs = await openPrForBranch(seams, branch);
		if (prs.length === 0) {
			return refused(
				`HANDOFF_REFUSAL: handoff of ${branch} refused: no open pull request for the branch — nothing to hand off.`,
				issue,
				branch,
			);
		}
		pr = prs[0];
	} catch (error) {
		return refused(
			`HANDOFF_REFUSAL: handoff of ${branch} failed at list the open pull requests: ${error instanceof Error ? error.message : String(error)}.`,
			issue,
			branch,
		);
	}

	let labels: string[];
	let body: string;
	try {
		const view = await ghJson<{ body: string; labels: { name: string }[] }>(
			seams,
			["issue", "view", String(issue), "--json", "body,labels"],
		);
		labels = view.labels.map((l) => l.name);
		body = prBody(parseBrief(view.body), issue, verifyResults);
		if (reviewNotes?.trim()) {
			body = `${body.replace(/\n+$/, "\n")}\n\n## Review notes\n\n${reviewNotes.trim()}\n`;
		}
	} catch (error) {
		return refused(
			`HANDOFF_REFUSAL: handoff of ${branch} failed at read the issue: ${error instanceof Error ? error.message : String(error)}.`,
			issue,
			branch,
		);
	}

	// Ordered, non-destructive steps: the apply-first/remove-second discipline
	// keeps the ticket never momentarily unlabeled while the PR is open, and a
	// failure is reported as it stands — the Run escalates, and the Escalation
	// preserves the PR, branch, and worktree.
	let bodyRecorded = false;
	let ready = pr.isDraft === false;
	let inReviewApplied = false;
	let inProgressRemoved = false;
	const wasDraft = pr.isDraft;
	const hadInProgress = labels.includes("in-progress");

	const steps: { name: string; action: () => Promise<void> }[] = [
		{
			name: "update the PR body",
			action: async () => {
				const r = await seams.gh([
					"pr",
					"edit",
					String(pr.number),
					"--body",
					body,
				]);
				if (r.exitCode !== 0) throw new Error(r.stderr.trim());
				bodyRecorded = true;
			},
		},
		{
			name: "mark the PR ready",
			action: async () => {
				const r = await seams.gh(["pr", "ready", String(pr.number)]);
				if (r.exitCode !== 0) throw new Error(r.stderr.trim());
				ready = true;
			},
		},
		{
			name: "apply in-review",
			action: async () => {
				const r = await seams.gh([
					"issue",
					"edit",
					String(issue),
					"--add-label",
					"in-review",
				]);
				if (r.exitCode !== 0) throw new Error(r.stderr.trim());
				inReviewApplied = true;
			},
		},
		...(hadInProgress
			? [
					{
						name: "remove in-progress",
						action: async () => {
							const r = await seams.gh([
								"issue",
								"edit",
								String(issue),
								"--remove-label",
								"in-progress",
							]);
							if (r.exitCode !== 0) throw new Error(r.stderr.trim());
							inProgressRemoved = true;
						},
					},
				]
			: []),
	];

	for (const step of steps) {
		try {
			await step.action();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const lines = [
				`HANDOFF_REFUSAL: handoff of ${branch} failed at ${step.name}: ${message}.`,
			];
			const completed: string[] = [];
			if (bodyRecorded) completed.push("update the PR body");
			if (ready) completed.push("mark the PR ready");
			if (inReviewApplied) completed.push("apply in-review");
			if (completed.length > 0) {
				lines.push(`Completed before failure: ${completed.join("; ")}.`);
			}
			lines.push(
				`Nothing was undone: PR #${pr.number} ${pr.url} stays open (${ready ? "ready" : "draft"}), in-review ${inReviewApplied ? "applied" : "not applied"}, in-progress ${hadInProgress && !inProgressRemoved ? "still applied" : "absent"}; the Run escalates, and the Escalation preserves the PR, branch, and worktree.`,
			);
			return refused(lines.join("\n"), issue, branch);
		}
	}

	return {
		status: "handed-off",
		issue,
		branch,
		pr: { number: pr.number, url: pr.url },
		text: `Handed off PR #${pr.number} ${pr.url}: final evidence recorded, the PR is ready for the Maintainer at the Merge gate${wasDraft ? " (draft marked ready)" : ""}, in-review applied, in-progress removed.`,
	};
}
