/**
 * L2 seam-integration tests for the PR-shaping operations (ticket afk-kit
 * #58, code-verify standard): the real `git` binary runs against a local
 * bare remote and the real `gh` binary is replaced by a stub on PATH — the
 * environment is swapped, never the code.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { VerifyResult } from "../extensions/coordinator/prbody.ts";
import { slugFor } from "../extensions/coordinator/slug.ts";
import { bootstrapDraftPr, handOffPr, pushCandidate } from "./pr-ops.ts";
import {
	cleanupWorld,
	type GhRule,
	makeWorld,
	type World,
} from "./test-world.ts";

const ISSUE = 7;
const TITLE = "Extract narrow Engine tracker and Git operations";
const BRANCH = `issue-${ISSUE}-${slugFor(TITLE)}`;
const PR_URL = "https://example.com/repo/pull/57";
const DRAFT_PR = {
	number: 57,
	title: `${TITLE} (#${ISSUE})`,
	url: PR_URL,
	isDraft: true,
};

/** Scratch issue brief: a full, ready-for-agent brief. */
const BRIEF_BODY = [
	"## Agent brief",
	"",
	"**Summary:** Scratch issue proving the engine PR-shaping ops end to end.",
	"",
	"**Acceptance criteria:**",
	"- [ ] The op under proof behaves per its ticket.",
	"",
	"**Verify commands:**",
	"- `exit 0`",
	"",
	"**Blocked by:** none",
	"**Blocks:** none",
	"",
	"**Touched areas:** scratch only",
	"",
	"**Out of scope:** nothing.",
	"",
	"**Open questions:** none",
	"",
].join("\n");

/** The brief-substrate rule the bootstrap and handoff ops read. */
function briefRules(): GhRule[] {
	return [
		{
			args: ["issue", "view", String(ISSUE), "--json", "title,body"],
			json: { title: TITLE, body: BRIEF_BODY },
		},
		{
			args: ["issue", "view", String(ISSUE), "--json", "body,labels"],
			json: {
				body: BRIEF_BODY,
				labels: [{ name: "ready-for-agent" }, { name: "in-progress" }],
			},
		},
	];
}

function prListRule(prs: unknown[]): GhRule {
	return {
		args: [
			"pr",
			"list",
			"--head",
			BRANCH,
			"--state",
			"open",
			"--json",
			"number,title,url,isDraft",
		],
		json: prs,
	};
}

function prCreateRule(rule: Omit<GhRule, "args"> = {}): GhRule {
	return {
		args: ["pr", "create", "--draft", "--base", "main", "--head", BRANCH],
		...rule,
	};
}

function prEditRule(rule: Omit<GhRule, "args"> = {}): GhRule {
	return { args: ["pr", "edit", "57", "--body"], ...rule };
}

function prReadyRule(rule: Omit<GhRule, "args"> = {}): GhRule {
	return { args: ["pr", "ready", "57"], ...rule };
}

/** A worktree on the issue branch, starting at the fixture's origin/main. */
async function makeWorktree(world: World): Promise<string> {
	const worktree = path.join(world.worktreeRoot, "remote", BRANCH);
	await world.git(
		["worktree", "add", "-b", BRANCH, worktree, world.originMainSha],
		world.checkout,
	);
	return worktree;
}

async function lsRemote(world: World): Promise<string> {
	const out = await world.git(["ls-remote", world.bare, BRANCH]);
	return out.stdout.trim();
}

async function commitIn(worktree: string, file: string): Promise<void> {
	await world0Sh(
		worktree,
		`echo work > ${file} && git add . && git commit -m candidate`,
	);
}

function world0Sh(cwd: string, command: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const { spawn } = require("node:child_process");
		const child = spawn("bash", ["-c", command], { cwd, stdio: "pipe" });
		child.on("error", reject);
		child.on("close", (status: number | null) => {
			if (status === 0) resolve();
			else reject(new Error(`${command} failed (exit ${status})`));
		});
	});
}

describe("bootstrapDraftPr", () => {
	test("bootstraps end to end: empty commit, push, draft PR, ticket stays in-progress", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([]),
			prCreateRule({ stdout: `${PR_URL}\n` }),
		]);
		try {
			const worktree = await makeWorktree(world);
			const outcome = await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(outcome.status).toBe("created");
			if (outcome.status !== "created") return;
			expect(outcome.issue).toBe(ISSUE);
			expect(outcome.branch).toBe(BRANCH);
			expect(outcome.pr).toEqual({ number: 57, url: PR_URL });
			// The branch was pushed, and its head is local HEAD.
			const head = await world.git(["rev-parse", "HEAD"], worktree);
			const remote = await lsRemote(world);
			expect(remote).toContain(head.stdout.trim());
			// Exactly one commit ahead of origin/main, and it is empty.
			const ahead = await world.git(
				["rev-list", "--count", "origin/main..HEAD"],
				worktree,
			);
			expect(ahead.stdout.trim()).toBe("1");
			const diff = await world.git(["diff", "origin/main..HEAD"], worktree);
			expect(diff.stdout.trim()).toBe("");
			const parent = await world.git(["rev-parse", "HEAD~1"], worktree);
			expect(parent.stdout.trim()).toBe(world.originMainSha);
			// The PR create call: draft, title from the issue title, body from
			// the brief with pending verify entries, no reviewer request.
			const create = world.argvLog().find((c) => c.startsWith("pr create"));
			expect(create).toBeDefined();
			expect(create).toContain("--draft");
			expect(create).toContain(`--title ${TITLE} (#${ISSUE})`);
			expect(create).toContain("Closes #7");
			expect(create).toContain("The op under proof behaves per its ticket.");
			expect(create).toContain("`exit 0` — pending");
			expect(world.argvLog().some((c) => c.includes("--reviewer"))).toBe(false);
			// The ticket is untouched: no tracker writes, in-progress stays.
			expect(world.argvLog().filter((c) => c.startsWith("issue edit"))).toEqual(
				[],
			);
		} finally {
			cleanupWorld(world);
		}
	});

	test("an existing open draft PR for the branch is accepted without a push", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([DRAFT_PR]),
		]);
		try {
			const worktree = await makeWorktree(world);
			const outcome = await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(outcome.status).toBe("exists");
			if (outcome.status !== "exists") return;
			expect(outcome.pr).toEqual({ number: 57, url: PR_URL });
			expect(await lsRemote(world)).toBe("");
			expect(world.argvLog().some((c) => c.startsWith("pr create"))).toBe(
				false,
			);
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses a branch whose open PR is already ready", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([{ ...DRAFT_PR, isDraft: false }]),
		]);
		try {
			const worktree = await makeWorktree(world);
			const outcome = await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("#57");
			expect(await lsRemote(world)).toBe("");
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failed push refuses without opening a PR", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([]),
		]);
		try {
			const worktree = await makeWorktree(world);
			// Point origin at an unreachable path so the push fails.
			await world.git(
				["remote", "set-url", "origin", "/nonexistent-remote"],
				worktree,
			);
			const outcome = await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("push the branch");
			expect(world.argvLog().some((c) => c.startsWith("pr create"))).toBe(
				false,
			);
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failed PR open compensates the push away", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([]),
			prCreateRule({ status: 1 }),
		]);
		try {
			const worktree = await makeWorktree(world);
			const outcome = await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("open the draft pull request");
			expect(outcome.text).toContain("Compensated: push the branch");
			expect(await lsRemote(world)).toBe("");
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses a worktree not on the named issue branch", async () => {
		const world = await makeWorld(ISSUE, TITLE, briefRules());
		try {
			const worktree = await makeWorktree(world);
			const outcome = await bootstrapDraftPr(
				{ issue: ISSUE, branch: "issue-8-some-other-branch", worktree },
				world.seams,
			);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("issue-8-some-other-branch");
		} finally {
			cleanupWorld(world);
		}
	});
});

describe("pushCandidate", () => {
	test("pushes additive candidate commits and reports the identity", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([]),
			prCreateRule({ stdout: `${PR_URL}\n` }),
		]);
		try {
			const worktree = await makeWorktree(world);
			const boot = await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(boot.status).toBe("created");
			await commitIn(worktree, "change.txt");
			const outcome = await pushCandidate(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(outcome.status).toBe("pushed");
			if (outcome.status !== "pushed") return;
			expect(outcome.commits).toBe(1);
			const head = await world.git(["rev-parse", "HEAD"], worktree);
			expect(outcome.head).toBe(head.stdout.trim());
			expect(await lsRemote(world)).toContain(outcome.head);
			// pushCandidate itself is pure Git: no tracker calls beyond the
			// bootstrap's own.
			const callsAfterBootstrap = world
				.argvLog()
				.filter(
					(c) =>
						!c.startsWith("pr create") &&
						!c.startsWith("issue view") &&
						!c.startsWith("pr list"),
				);
			expect(callsAfterBootstrap).toEqual([]);
		} finally {
			cleanupWorld(world);
		}
	});

	test("a re-run with nothing to push is a current no-op", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([]),
			prCreateRule({ stdout: `${PR_URL}\n` }),
		]);
		try {
			const worktree = await makeWorktree(world);
			await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			const first = await pushCandidate(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(first.status).toBe("current");
			const head = await world.git(["rev-parse", "HEAD"], worktree);
			const before = await lsRemote(world);
			expect(before).toContain(head.stdout.trim());
			const again = await pushCandidate(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(again.status).toBe("current");
			expect(await lsRemote(world)).toBe(before);
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses a branch with no commits ahead of origin/main", async () => {
		const world = await makeWorld(ISSUE, TITLE, briefRules());
		try {
			const worktree = await makeWorktree(world);
			const outcome = await pushCandidate(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("no commits ahead of origin/main");
			expect(await lsRemote(world)).toBe("");
		} finally {
			cleanupWorld(world);
		}
	});

	test("a non-fast-forward push refuses naturally; nothing is forced", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([]),
			prCreateRule({ stdout: `${PR_URL}\n` }),
		]);
		try {
			const worktree = await makeWorktree(world);
			const boot = await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(boot.status).toBe("created");
			// A second writer advances the remote branch out of band.
			const sneak = path.join(world.root, "sneak");
			await world.git(["clone", world.bare, sneak], world.root);
			await world0Sh(
				sneak,
				"git config user.email s@example.com && git config user.name S && git checkout issue-7-extract-narrow-engine-tracker && echo sneak > sneak.txt && git add . && git commit -m sneak && git push origin issue-7-extract-narrow-engine-tracker",
			);
			// The local worktree diverges with its own candidate commit.
			await commitIn(worktree, "change.txt");
			const outcome = await pushCandidate(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("[rejected]");
			// The remote branch was not clobbered: the sneak commit still heads it.
			const sneakHead = await world.git(
				["rev-parse", "issue-7-extract-narrow-engine-tracker"],
				sneak,
			);
			expect(await lsRemote(world)).toContain(sneakHead.stdout.trim());
		} finally {
			cleanupWorld(world);
		}
	});
});

describe("handOffPr", () => {
	const RESULTS: VerifyResult[] = [{ command: "exit 0", ok: true }];

	function handoffRules(): GhRule[] {
		return [
			...briefRules(),
			prListRule([DRAFT_PR]),
			prEditRule({ json: {} }),
			prReadyRule({ json: {} }),
		];
	}

	test("hands off end to end: evidence, ready, in-review on, in-progress off, no review request", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...handoffRules(),
			{
				args: ["issue", "edit", String(ISSUE), "--add-label", "in-review"],
				json: {},
			},
			{
				args: ["issue", "edit", String(ISSUE), "--remove-label", "in-progress"],
				json: {},
			},
		]);
		try {
			const worktree = await makeWorktree(world);
			const outcome = await handOffPr(
				{
					issue: ISSUE,
					branch: BRANCH,
					worktree,
					verifyResults: RESULTS,
					reviewNotes: "Standards and Spec reviews approved.",
				},
				world.seams,
			);
			expect(outcome.status).toBe("handed-off");
			if (outcome.status !== "handed-off") return;
			expect(outcome.pr).toEqual({ number: 57, url: PR_URL });
			// The call order is exactly the convention's: body, ready,
			// in-review applied, in-progress removed.
			const calls = world.argvLog();
			const edited = calls.findIndex((c) => c.startsWith("pr edit 57"));
			const ready = calls.indexOf("pr ready 57");
			const onReview = calls.indexOf("issue edit 7 --add-label in-review");
			const offProgress = calls.indexOf(
				"issue edit 7 --remove-label in-progress",
			);
			expect(edited).toBeGreaterThan(-1);
			expect(ready).toBeGreaterThan(edited);
			expect(onReview).toBeGreaterThan(ready);
			expect(offProgress).toBeGreaterThan(onReview);
			// The updated body carries the final evidence and the review notes.
			const edit = calls.find((c) => c.startsWith("pr edit 57"));
			expect(edit).toContain("Closes #7");
			expect(edit).toContain("`exit 0` — pass");
			expect(edit).toContain("## Review notes");
			expect(edit).toContain("Standards and Spec reviews approved.");
			// No review request, no PR creation, no close.
			expect(calls.some((c) => c.includes("--reviewer"))).toBe(false);
			expect(calls.some((c) => c.startsWith("pr create"))).toBe(false);
			expect(calls.some((c) => c.startsWith("pr close"))).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses a branch with no open pull request", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([]),
		]);
		try {
			const worktree = await makeWorktree(world);
			const outcome = await handOffPr(
				{ issue: ISSUE, branch: BRANCH, worktree, verifyResults: RESULTS },
				world.seams,
			);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("HANDOFF_REFUSAL");
			expect(outcome.text).toContain("no open pull request");
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failed label step refuses without destroying anything", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([]),
			prCreateRule({ stdout: `${PR_URL}\n` }),
		]);
		try {
			const worktree = await makeWorktree(world);
			// A real pushed branch behind the real draft PR the stub then serves.
			const boot = await bootstrapDraftPr(
				{ issue: ISSUE, branch: BRANCH, worktree },
				world.seams,
			);
			expect(boot.status).toBe("created");
			world.setRules([
				...handoffRules(),
				{
					args: ["issue", "edit", String(ISSUE), "--add-label", "in-review"],
					status: 1,
				},
			]);
			const outcome = await handOffPr(
				{ issue: ISSUE, branch: BRANCH, worktree, verifyResults: RESULTS },
				world.seams,
			);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("HANDOFF_REFUSAL");
			expect(outcome.text).toContain("apply in-review");
			expect(outcome.text).toContain("mark the PR ready");
			expect(outcome.text).toContain("Nothing was undone");
			// The PR stays open, the pushed branch stays put.
			const calls = world.argvLog();
			expect(calls.some((c) => c.startsWith("pr close"))).toBe(false);
			expect(await lsRemote(world)).not.toBe("");
		} finally {
			cleanupWorld(world);
		}
	});

	test("removes only labels the ticket actually carries", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			{
				args: ["issue", "view", String(ISSUE), "--json", "body,labels"],
				json: {
					body: BRIEF_BODY,
					labels: [{ name: "ready-for-agent" }],
				},
			},
			prListRule([DRAFT_PR]),
			prEditRule({ json: {} }),
			prReadyRule({ json: {} }),
		]);
		try {
			const worktree = await makeWorktree(world);
			const outcome = await handOffPr(
				{ issue: ISSUE, branch: BRANCH, worktree, verifyResults: RESULTS },
				world.seams,
			);
			expect(outcome.status).toBe("handed-off");
			const calls = world.argvLog();
			expect(
				calls.some((c) => c.startsWith("issue edit 7 --remove-label")),
			).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("accepts an already-ready PR and still records the handoff", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			...briefRules(),
			prListRule([{ ...DRAFT_PR, isDraft: false }]),
			prEditRule({ json: {} }),
			prReadyRule({ json: {} }),
		]);
		try {
			const worktree = await makeWorktree(world);
			const outcome = await handOffPr(
				{ issue: ISSUE, branch: BRANCH, worktree, verifyResults: RESULTS },
				world.seams,
			);
			expect(outcome.status).toBe("handed-off");
			expect(world.argvLog()).toContain("pr ready 57");
		} finally {
			cleanupWorld(world);
		}
	});
});
