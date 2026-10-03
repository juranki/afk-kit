/**
 * The narrow Claim operation (ticket afk-kit #58): assign the issue to the
 * authenticated maintainer account, verify the sole claim, apply
 * `in-progress`, and create the Ticket worktree and branch from the freshly
 * fetched `origin/main` SHA — without touching local `main`. Readiness is a
 * separate Engine stage (the v0 spec, afk-kit #46); the claim only refuses an
 * issue that is not claimable: one with an assignee, or a leftover
 * `in-progress` marker with no assignee (issue-lifecycle convention).
 *
 * The worktree is an independent clone of the repository (ADR 0014, ticket
 * afk-kit #62): all of its git state — objects, refs, index — lives inside
 * the worktree, so a confined Implementer can commit without any write
 * surface in the primary checkout's repository, and the claim's undo is a
 * plain directory removal.
 *
 * Failure at any step compensates the steps before it, in reverse order; a
 * compensation failure is named in the CLAIM_REFUSAL as leftover state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GitResult } from "../extensions/coordinator/git.ts";
import { projectFor, slugFor } from "../extensions/coordinator/slug.ts";
import { checkTriageLabels } from "../extensions/readiness/check.ts";
import { type GhRunner, nativeBlockersOf } from "../extensions/readiness/gh.ts";
import type { EngineSeams } from "./seams.ts";

/** The authorship every Engine- and Implementer-side commit carries. */
const ENGINE_IDENTITY = {
	name: "AFK Engine",
	email: "afk-engine@users.noreply.github.com",
} as const;

export type ClaimTicketOutcome =
	| {
			status: "claimed";
			issue: number;
			maintainer: string;
			slug: string;
			branch: string;
			/** The fetched origin/main SHA the branch starts from. */
			base: string;
			worktree: string;
			text: string;
	  }
	| { status: "refused"; issue: number; text: string };

interface Step {
	name: string;
	action: () => Promise<void>;
	/** Rolls this completed step back; only completed steps are undone. */
	undo?: () => Promise<void>;
	/** What remains if the undo itself fails — named in the refusal. */
	leftover: string;
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

function gitOk(result: GitResult, what: string): void {
	if (result.exitCode !== 0) {
		throw new Error(`${what}: ${result.stderr.trim()}`);
	}
}

export async function claimTicket(
	issue: number,
	seams: EngineSeams,
): Promise<ClaimTicketOutcome> {
	const facts = await ghJson<{
		title: string;
		assignees: { login: string }[];
		labels: { name: string }[];
	}>(seams.gh, [
		"issue",
		"view",
		String(issue),
		"--json",
		"number,title,url,assignees,labels",
	]).then(
		(view) => ({
			title: view.title,
			assignees: view.assignees.map((a) => a.login),
			labels: view.labels.map((l) => l.name),
		}),
		(error: unknown) => {
			throw new Error(
				`CLAIM_REFUSAL: reading #${issue} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		},
	);

	// A claimed issue — an assignee, or a leftover `in-progress` marker — is
	// not claimable (issue-lifecycle convention); refuse before touching
	// anything, naming the existing claim.
	if (facts.assignees.length > 0) {
		return {
			status: "refused",
			issue,
			text: `CLAIM_REFUSAL: #${issue} is already claimed by ${facts.assignees.join(", ")}.`,
		};
	}
	if (facts.labels.includes("in-progress")) {
		return {
			status: "refused",
			issue,
			text: `CLAIM_REFUSAL: #${issue} carries in-progress with no assignee — leftover claim state; a maintainer should clear it.`,
		};
	}

	// Live coordination facts, not discussion freshness. Ready never bypasses these.
	const live = await ghJson<{
		state: string;
		labels: { name: string }[];
		blockedBy: {
			nodes: { number: number; state: string }[];
			totalCount?: number;
		};
	}>(seams.gh, [
		"issue",
		"view",
		String(issue),
		"--json",
		"state,labels,blockedBy",
	]);
	const triage = checkTriageLabels(live.labels.map((l) => l.name));
	const blockers = (
		await nativeBlockersOf(issue, live.blockedBy, seams.gh)
	).filter((b) => b.state === "OPEN");
	if (live.state !== "OPEN" || !triage.pass || blockers.length) {
		return {
			status: "refused",
			issue,
			text: `CLAIM_REFUSAL: #${issue} is not live Claimable: state ${live.state}; ${triage.detail}; open blockers ${blockers.map((b) => `#${b.number}`).join(", ") || "none"}.`,
		};
	}

	// Fresh origin/main: the branch starts from the fetched SHA, and local
	// `main` is never consulted or moved (v0 spec, afk-kit #46).
	const fetched = await seams.git(["fetch", "origin"], seams.checkout);
	if (fetched.exitCode !== 0) {
		return {
			status: "refused",
			issue,
			text: `CLAIM_REFUSAL: claim of #${issue} failed at fetch origin: ${fetched.stderr.trim()}.`,
		};
	}
	const baseOut = await seams.git(["rev-parse", "origin/main"], seams.checkout);
	if (baseOut.exitCode !== 0) {
		return {
			status: "refused",
			issue,
			text: `CLAIM_REFUSAL: claim of #${issue} failed at resolve origin/main: ${baseOut.stderr.trim()}.`,
		};
	}
	const base = baseOut.stdout.trim();

	const maintainer = await ghJson<{ login: string }>(seams.gh, ["api", "user"])
		.then((user) => user.login)
		.catch((error: unknown) => {
			throw new Error(
				`CLAIM_REFUSAL: reading the authenticated user failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});

	const slug = slugFor(facts.title);
	const branch = `issue-${issue}-${slug}`;
	const remote = await seams.git(
		["remote", "get-url", "origin"],
		seams.checkout,
	);
	if (remote.exitCode !== 0) {
		return {
			status: "refused",
			issue,
			text: `CLAIM_REFUSAL: claim of #${issue} failed at read the origin remote: ${remote.stderr.trim()}.`,
		};
	}
	const project = projectFor(remote.stdout);
	const worktree = path.join(seams.worktreeRoot, project, branch);

	const tracker = async (args: string[]): Promise<void> => {
		const r = await seams.gh(args);
		if (r.exitCode !== 0) throw new Error(r.stderr.trim());
	};

	const steps: Step[] = [
		{
			name: `assign to ${maintainer}`,
			action: () =>
				tracker(["issue", "edit", String(issue), "--add-assignee", maintainer]),
			undo: () =>
				tracker([
					"issue",
					"edit",
					String(issue),
					"--remove-assignee",
					maintainer,
				]),
			leftover: `assigned to ${maintainer}`,
		},
		{
			name: "verify the sole claim",
			action: async () => {
				const view = await ghJson<{ assignees: { login: string }[] }>(
					seams.gh,
					["issue", "view", String(issue), "--json", "assignees"],
				);
				const rivals = view.assignees
					.map((a) => a.login)
					.filter((login) => login !== maintainer);
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
				gitOk(
					await seams.git(
						[
							"clone",
							"--no-checkout",
							"--no-hardlinks",
							remote.stdout.trim(),
							worktree,
						],
						seams.checkout,
					),
					`git clone ${remote.stdout.trim()} ${worktree}`,
				);
				gitOk(
					await seams.git(["checkout", "-b", branch, base], worktree),
					`git checkout -b ${branch} ${base}`,
				);
				// The clone carries no host identity; the Engine pins its own
				// so every Engine- and Implementer-side commit is deterministic
				// and never inherits the maintainer's git configuration.
				gitOk(
					await seams.git(
						["config", "user.name", ENGINE_IDENTITY.name],
						worktree,
					),
					"git config user.name",
				);
				gitOk(
					await seams.git(
						["config", "user.email", ENGINE_IDENTITY.email],
						worktree,
					),
					"git config user.email",
				);
			},
			undo: async () => {
				// The worktree is an independent clone: its branch and objects
				// are entirely inside it, so removing the directory is the
				// whole undo — the primary checkout's refs were never touched.
				fs.rmSync(worktree, { recursive: true, force: true });
				if (fs.existsSync(worktree)) {
					throw new Error(`worktree ${worktree} still present`);
				}
			},
			leftover: `worktree ${worktree} / branch ${branch}`,
		},
	];

	const done: Step[] = [];
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
			return { status: "refused", issue, text: lines.join("\n") };
		}
	}

	return {
		status: "claimed",
		issue,
		maintainer,
		slug,
		branch,
		base,
		worktree,
		text: `Claimed #${issue}: assigned ${maintainer}, in-progress applied, branch ${branch} at ${base.slice(0, 12)} in worktree ${worktree}.`,
	};
}

async function compensate(steps: Step[]): Promise<{
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
