/**
 * The coordinator ops (R7, ticket afk-kit #19): deterministic extension
 * code, separate from subagents (ADR 0006/0007). Two operations:
 *
 *   claimIssue   — atomic claim: readiness check embedded (ADR 0012, refusing
 *                  with READINESS_REFUSAL and claiming nothing on failure),
 *                  then assign the issue to the maintainer account, apply
 *                  `in-progress`, and create the worktree + branch as one
 *                  operation; failure at any step compensates the steps
 *                  before it, and a compensation failure is named in the
 *                  CLAIM_REFUSAL as leftover state.
 *
 *   publishPr    — push the worktree's branch and open the pull request
 *                  (review requested from the maintainer), flipping
 *                  `in-progress` to `in-review`; refuses an issue that
 *                  already has an open PR for the branch with
 *                  PUBLISH_REFUSAL; the same compensation discipline covers
 *                  its steps.
 *
 * Marker vocabulary per the house refusal pattern: READINESS_REFUSAL,
 * CLAIM_REFUSAL, PUBLISH_REFUSAL (canonical wording in
 * docs/conventions/issue-lifecycle.md).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseBrief } from "../readiness/brief.ts";
import { verifyCommandList } from "../readiness/check.ts";
import { type GhRunner, runReadinessCheck } from "../readiness/gh.ts";
import type { GitRunner } from "./git.ts";
import { prBodyFromIssueBody, prTitle, type VerifyResult } from "./prbody.ts";
import { projectFor, slugFor } from "./slug.ts";

export interface CoordinatorSeams {
	/** gh, bound to the primary checkout. */
	gh: GhRunner;
	git: GitRunner;
	/** The primary checkout the claim works against. */
	checkout: string;
	/** Root of the worktree convention: <root>/<project>/<branch>. */
	worktreeRoot: string;
}

export interface ClaimOutcome {
	ok: boolean;
	text: string;
	issue: number;
	maintainer?: string;
	slug?: string;
	branch?: string;
	worktree?: string;
}

interface ClaimFacts {
	maintainer: string;
	title: string;
	assignees: string[];
	labels: string[];
}

interface ClaimStep {
	name: string;
	action: () => Promise<void>;
	/** Rolls this completed step back; only completed steps are undone. */
	undo?: () => Promise<void>;
	/** What remains if the undo itself fails — named in the refusal. */
	leftover: string;
}

async function fetchClaimFacts(
	issue: number,
	seams: CoordinatorSeams,
): Promise<ClaimFacts> {
	const maintainer = await ghJson<{ login: string }>(seams.gh, [
		"api",
		"user",
	]).then((user) => user.login);
	const view = await ghJson<{
		title: string;
		assignees: { login: string }[];
		labels: { name: string }[];
	}>(seams.gh, [
		"issue",
		"view",
		String(issue),
		"--json",
		"number,title,url,assignees,labels",
	]);
	return {
		maintainer,
		title: view.title,
		assignees: view.assignees.map((a) => a.login),
		labels: view.labels.map((l) => l.name),
	};
}

async function ghJson<T>(run: GhRunner, args: string[]): Promise<T> {
	const { stdout, stderr, exitCode } = await run(args);
	if (exitCode !== 0) {
		throw new Error(
			`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`,
		);
	}
	return JSON.parse(stdout) as T;
}

export async function claimIssue(
	issue: number,
	seams: CoordinatorSeams,
): Promise<ClaimOutcome> {
	const facts = await fetchClaimFacts(issue, seams);

	// A claimed issue — an assignee, or a leftover `in-progress` marker — is
	// not claimable (issue-lifecycle convention); refuse before touching
	// anything, naming the existing claim.
	if (facts.assignees.length > 0) {
		return {
			ok: false,
			issue,
			text: `CLAIM_REFUSAL: #${issue} is already claimed by ${facts.assignees.join(", ")}.`,
		};
	}
	if (facts.labels.includes("in-progress")) {
		return {
			ok: false,
			issue,
			text: `CLAIM_REFUSAL: #${issue} carries in-progress with no assignee — leftover claim state; a maintainer should clear it.`,
		};
	}

	// The embedded readiness check (ADR 0012): a failing run refuses with
	// READINESS_REFUSAL, claiming nothing.
	const readiness = await runReadinessCheck(issue, seams.gh);
	if (!readiness.ok) {
		return { ok: false, text: readiness.text, issue };
	}

	const slug = slugFor(facts.title);
	const branch = `issue-${issue}-${slug}`;

	const remote = await seams.git(
		["remote", "get-url", "origin"],
		seams.checkout,
	);
	if (remote.exitCode !== 0) {
		return {
			ok: false,
			issue,
			text: `CLAIM_REFUSAL: claim of #${issue} failed at read the origin remote: ${remote.stderr.trim()}`,
		};
	}
	const project = projectFor(remote.stdout);
	const worktree = path.join(seams.worktreeRoot, project, branch);

	const tracker = async (args: string[]): Promise<void> => {
		const r = await seams.gh(args);
		if (r.exitCode !== 0) throw new Error(r.stderr.trim());
	};

	const steps: ClaimStep[] = [
		{
			name: `assign to ${facts.maintainer}`,
			action: () =>
				tracker([
					"issue",
					"edit",
					String(issue),
					"--add-assignee",
					facts.maintainer,
				]),
			undo: () =>
				tracker([
					"issue",
					"edit",
					String(issue),
					"--remove-assignee",
					facts.maintainer,
				]),
			leftover: `assigned to ${facts.maintainer}`,
		},
		{
			name: "verify the sole claim",
			action: async () => {
				const assignees = await ghJson<{ login: string }[]>(seams.gh, [
					"issue",
					"view",
					String(issue),
					"--json",
					"assignees",
				]);
				const rivals = assignees
					.map((a) => a.login)
					.filter((login) => login !== facts.maintainer);
				if (rivals.length > 0) {
					throw new Error(`issue also assigned to ${rivals.join(", ")}`);
				}
			},
			// No undo of its own: the assign step's undo covers it.
			leftover: "",
		},
		{
			name: "apply in-progress",
			action: () =>
				tracker(["issue", "edit", String(issue), "--add-label", "in-progress"]),
			undo: () =>
				tracker([
					"issue",
					"edit",
					String(issue),
					"--remove-label",
					"in-progress",
				]),
			leftover: "labeled in-progress",
		},
		{
			name: "create the worktree and branch",
			action: async () => {
				fs.mkdirSync(path.dirname(worktree), { recursive: true });
				const r = await seams.git(
					["worktree", "add", "-b", branch, worktree, "main"],
					seams.checkout,
				);
				if (r.exitCode !== 0) throw new Error(r.stderr.trim());
			},
			undo: async () => {
				const removed = await seams.git(
					["worktree", "remove", "--force", worktree],
					seams.checkout,
				);
				if (removed.exitCode !== 0) {
					await seams.git(["worktree", "prune"], seams.checkout);
				}
				const dropped = await seams.git(
					["branch", "-D", branch],
					seams.checkout,
				);
				if (dropped.exitCode !== 0) throw new Error(dropped.stderr.trim());
				if (fs.existsSync(worktree)) {
					throw new Error(`worktree ${worktree} still present`);
				}
			},
			leftover: `worktree ${worktree} / branch ${branch}`,
		},
	];

	const done: ClaimStep[] = [];
	for (const step of steps) {
		try {
			await step.action();
			done.push(step);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const { compensated, leftovers } = await compensate([...done].reverse());
			const lines = [
				`CLAIM_REFUSAL: claim of #${issue} failed at ${step.name}: ${message}.`,
			];
			if (compensated.length > 0) {
				lines.push(`Compensated: ${compensated.join("; ")}.`);
			}
			if (leftovers.length > 0) {
				lines.push(
					`Leftover state — a maintainer should clear: ${leftovers.join("; ")}.`,
				);
			}
			return { ok: false, issue, text: lines.join("\n") };
		}
	}

	return {
		ok: true,
		text: `Claimed #${issue}: assigned ${facts.maintainer}, in-progress applied, branch ${branch} in worktree ${worktree}.`,
		issue,
		maintainer: facts.maintainer,
		slug,
		branch,
		worktree,
	};
}

async function compensate(steps: ClaimStep[]): Promise<{
	compensated: string[];
	leftovers: string[];
}> {
	const compensated: string[] = [];
	const leftovers: string[] = [];
	for (const step of steps) {
		if (!step.undo) continue;
		try {
			await step.undo();
			compensated.push(step.name);
		} catch {
			leftovers.push(step.leftover);
		}
	}
	return { compensated, leftovers };
}

export interface PublishInput {
	/** The claimed ticket's worktree; the branch it is on carries the change. */
	worktree: string;
	/** Imperative summary for the PR title: `<summary> (#<n>)`. */
	summary: string;
}

export interface PublishOutcome {
	ok: boolean;
	text: string;
	issue?: number;
	branch?: string;
	pr?: { number: number; url: string };
}

type PublishStep = ClaimStep;

function runShell(
	command: string,
	cwd: string,
): Promise<VerifyResult & { exitCode: number | null }> {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, cwd });
		child.on("error", () => resolve({ command, ok: false, exitCode: 127 }));
		child.on("close", (code) =>
			resolve({ command, ok: code === 0, exitCode: code }),
		);
	});
}

export async function publishPr(
	input: PublishInput,
	seams: CoordinatorSeams,
): Promise<PublishOutcome> {
	const { worktree, summary } = input;

	// The branch names the ticket: issue-<n>-<slug>.
	const head = await seams.git(["rev-parse", "--abbrev-ref", "HEAD"], worktree);
	if (head.exitCode !== 0) {
		return publishRefusal(
			worktree,
			`read the worktree branch: ${head.stderr.trim()}`,
		);
	}
	const branch = head.stdout.trim();
	const match = /^issue-(\d+)-/.exec(branch);
	if (!match) {
		return publishRefusal(
			worktree,
			`${branch} is not an issue branch (expected issue-<n>-<slug>)`,
		);
	}
	const issue = Number(match[1]);

	const maintainer = await ghJson<{ login: string }>(seams.gh, [
		"api",
		"user",
	]).then((u) => u.login);

	// One PR per branch: an open PR refuses the publish.
	const open = await ghJson<{ number: number; title: string; url: string }[]>(
		seams.gh,
		[
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"number,title,url",
		],
	);
	if (open.length > 0) {
		const existing = open[0];
		return {
			ok: false,
			issue,
			branch,
			text: `PUBLISH_REFUSAL: ${branch} already has an open PR: #${existing.number} "${existing.title}" ${existing.url}.`,
		};
	}

	// The brief supplies the PR body's checklist, touched areas, and verify
	// commands; the labels tell whether in-progress is on to flip off.
	const view = await ghJson<{
		body: string;
		labels: { name: string }[];
	}>(seams.gh, [
		"issue",
		"view",
		String(issue),
		"--json",
		"number,title,body,url,labels",
	]);
	const labels = view.labels.map((l) => l.name);

	// Verify in the worktree before anything is published: the PR body
	// carries the results, and a failing command refuses the publish.
	const commands = verifyCommandList(
		parseBrief(view.body).verifyCommands.value,
	);
	if (commands.length === 0) {
		return publishRefusal(
			worktree,
			`the brief of #${issue} names no verify commands`,
			issue,
			branch,
		);
	}
	const results: (VerifyResult & { exitCode: number | null })[] = [];
	for (const command of commands) {
		const result = await runShell(command, worktree);
		results.push(result);
	}
	const failed = results.filter((r) => !r.ok);
	if (failed.length > 0) {
		return publishRefusal(
			worktree,
			`verify commands failed in the worktree: ${failed
				.map((r) => `\`${r.command}\` (exit ${r.exitCode})`)
				.join(", ")}`,
			issue,
			branch,
		);
	}

	const body = prBodyFromIssueBody(view.body, issue, results);
	const title = prTitle(summary, issue);
	let openedPr: { number: number; url: string } | undefined;

	const gh = async (args: string[]): Promise<string> => {
		const r = await seams.gh(args);
		if (r.exitCode !== 0) throw new Error(r.stderr.trim());
		return r.stdout;
	};
	const gitIn = async (...args: string[]): Promise<void> => {
		const r = await seams.git(args, worktree);
		if (r.exitCode !== 0) throw new Error(r.stderr.trim());
	};

	const steps: PublishStep[] = [
		{
			name: "push the branch",
			action: () => gitIn("push", "origin", branch),
			undo: () => gitIn("push", "origin", "--delete", branch),
			leftover: `remote branch ${branch}`,
		},
		{
			name: "open the pull request",
			action: async () => {
				const out = await gh([
					"pr",
					"create",
					"--base",
					"main",
					"--head",
					branch,
					"--title",
					title,
					"--body",
					body,
					"--reviewer",
					maintainer,
				]);
				const url = out.trim().split("\n").pop() ?? "";
				const m = /\/pull\/(\d+)\s*$/.exec(url);
				if (!m) throw new Error(`could not read the PR URL from: ${url}`);
				openedPr = { number: Number(m[1]), url };
			},
			undo: async () => {
				if (!openedPr) return;
				await gh([
					"pr",
					"close",
					String(openedPr.number),
					"--comment",
					"Closed automatically: a later publish step failed.",
				]);
			},
			leftover: () =>
				openedPr
					? `open PR #${openedPr.number} ${openedPr.url}`
					: "an open pull request",
		},
		{
			name: "apply in-review",
			action: () =>
				gh(["issue", "edit", String(issue), "--add-label", "in-review"]),
			undo: () =>
				gh(["issue", "edit", String(issue), "--remove-label", "in-review"]),
			leftover: "labeled in-review",
		},
		...(labels.includes("in-progress")
			? [
					{
						name: "retire in-progress",
						action: () =>
							gh([
								"issue",
								"edit",
								String(issue),
								"--remove-label",
								"in-progress",
							]),
						undo: () =>
							gh([
								"issue",
								"edit",
								String(issue),
								"--add-label",
								"in-progress",
							]),
						leftover: "in-progress label absent",
					},
				]
			: []),
	];

	const done: PublishStep[] = [];
	for (const step of steps) {
		try {
			await step.action();
			done.push(step);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const { compensated, leftovers } = await compensate([...done].reverse());
			const lines = [
				`PUBLISH_REFUSAL: publish of ${branch} failed at ${step.name}: ${message}.`,
			];
			if (compensated.length > 0) {
				lines.push(`Compensated: ${compensated.join("; ")}.`);
			}
			if (leftovers.length > 0) {
				lines.push(
					`Leftover state — a maintainer should clear: ${leftovers.join("; ")}.`,
				);
			}
			return { ok: false, issue, branch, text: lines.join("\n") };
		}
	}

	return {
		ok: true,
		issue,
		branch,
		pr: openedPr,
		text: `Published ${branch} as PR #${openedPr?.number} ${openedPr?.url}: verify passed (${results.length} command${results.length === 1 ? "" : "s"}), review requested from ${maintainer}, in-review applied.`,
	};
}

function publishRefusal(
	worktree: string,
	detail: string,
	issue?: number,
	branch?: string,
): PublishOutcome {
	return {
		ok: false,
		issue,
		branch,
		text: `PUBLISH_REFUSAL: publish of ${worktree} refused: ${detail}.`,
	};
}
