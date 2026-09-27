/**
 * L2 seam-integration tests for `escalateRun` (ticket afk-kit #58,
 * code-verify standard): the real `gh` binary is replaced by a stub on PATH;
 * Git preservation is proven against a local bare remote — the environment
 * is swapped, never the code.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { slugFor } from "../extensions/coordinator/slug.ts";
import { escalateRun } from "./escalate.ts";
import {
	cleanupWorld,
	type GhRule,
	makeWorld,
	type World,
} from "./test-world.ts";

const ISSUE = 7;
const TITLE = "Extract narrow Engine tracker and Git operations";
const BRANCH = `issue-${ISSUE}-${slugFor(TITLE)}`;
const RUN = "20260927T120000Z-abcd";
const PR_URL = "https://example.com/repo/pull/57";

function facts(overrides: Partial<Parameters<typeof escalateRun>[0]> = {}) {
	return {
		issue: ISSUE,
		run: RUN,
		stage: "implement",
		cycle: 2,
		reason: "Verify failed after the third cycle",
		pr: { number: 57, url: PR_URL },
		branch: BRANCH,
		worktree: `/tmp/wt/remote/${BRANCH}`,
		runDirectory: `/state/afk/github.com/example/repo/issues/${ISSUE}/runs/${RUN}`,
		...overrides,
	};
}

function escalationRules(extra: GhRule[] = []): GhRule[] {
	return [
		...extra,
		{
			args: ["issue", "view", String(ISSUE), "--json", "labels"],
			json: {
				labels: [
					{ name: "ready-for-agent" },
					{ name: "in-progress" },
					{ name: "in-review" },
				],
			},
		},
		{ args: ["issue", "comment", String(ISSUE), "--body"], json: {} },
		{
			args: ["issue", "edit", String(ISSUE), "--add-label", "needs-info"],
			json: {},
		},
	];
}

/** A real worktree on the issue branch with a pushed commit. */
async function makePushedWorktree(world: World): Promise<string> {
	const worktree = path.join(world.worktreeRoot, "remote", BRANCH);
	await world.git(
		["worktree", "add", "-b", BRANCH, worktree, world.originMainSha],
		world.checkout,
	);
	fs.writeFileSync(path.join(worktree, "work.txt"), "partial\n");
	await world.git(["add", "."], worktree);
	await world
		.git(["commit", "-m "], worktree)
		.catch(() => world.git(["commit", "-m", "partial work"], worktree));
	await world.git(["push", "origin", BRANCH], worktree);
	return worktree;
}

describe("escalateRun", () => {
	test("escalates end to end: status comment, needs-info, workflow labels off, artifacts preserved", async () => {
		const world = await makeWorld(ISSUE, TITLE, escalationRules());
		try {
			const worktree = await makePushedWorktree(world);
			const outcome = await escalateRun(facts({ worktree }), world.seams);
			expect(outcome.status).toBe("escalated");
			if (outcome.status !== "escalated") return;
			expect(outcome.issue).toBe(ISSUE);
			const calls = world.argvLog();
			// Order: comment first, then needs-info applied, then the workflow
			// labels removed (never momentarily unlabeled).
			const comment = calls.findIndex((c) => c.startsWith("issue comment 7"));
			const needsInfo = calls.indexOf("issue edit 7 --add-label needs-info");
			const offProgress = calls.indexOf(
				"issue edit 7 --remove-label in-progress",
			);
			const offReview = calls.indexOf("issue edit 7 --remove-label in-review");
			expect(comment).toBeGreaterThan(-1);
			expect(needsInfo).toBeGreaterThan(comment);
			expect(offProgress).toBeGreaterThan(needsInfo);
			expect(offReview).toBeGreaterThan(offProgress);
			// The status comment names everything a maintainer needs.
			const body = calls[comment];
			expect(body).toContain(`Run ${RUN}`);
			expect(body).toContain("implement");
			expect(body).toContain("cycle 2");
			expect(body).toContain("Verify failed after the third cycle");
			expect(body).toContain("#57");
			expect(body).toContain(BRANCH);
			expect(body).toContain(worktree);
			expect(body).toContain(`runs/${RUN}`);
			// The assignee is preserved: no assignee writes at all.
			expect(calls.some((c) => c.includes("--remove-assignee"))).toBe(false);
			expect(calls.some((c) => c.includes("--add-assignee"))).toBe(false);
			// The worktree and the pushed branch are preserved.
			expect(fs.existsSync(worktree)).toBe(true);
			const head = await world.git(["rev-parse", "HEAD"], worktree);
			const remote = await world.git(["ls-remote", world.bare, BRANCH]);
			expect(remote.stdout).toContain(head.stdout.trim());
		} finally {
			cleanupWorld(world);
		}
	});

	test("removes only the workflow labels the ticket actually carries", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			{
				args: ["issue", "view", String(ISSUE), "--json", "labels"],
				json: { labels: [{ name: "ready-for-agent" }] },
			},
			{ args: ["issue", "comment", String(ISSUE), "--body"], json: {} },
			{
				args: ["issue", "edit", String(ISSUE), "--add-label", "needs-info"],
				json: {},
			},
		]);
		try {
			const outcome = await escalateRun(facts(), world.seams);
			expect(outcome.status).toBe("escalated");
			const calls = world.argvLog();
			expect(
				calls.some((c) => c.startsWith("issue edit 7 --remove-label")),
			).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failed needs-info step reports ESCALATION_FAILURE but still removes the workflow labels", async () => {
		const world = await makeWorld(
			ISSUE,
			TITLE,
			escalationRules([
				{
					args: ["issue", "edit", String(ISSUE), "--add-label", "needs-info"],
					status: 1,
				},
			]),
		);
		try {
			const outcome = await escalateRun(facts(), world.seams);
			expect(outcome.status).toBe("failed");
			if (outcome.status !== "failed") return;
			expect(outcome.text).toContain("ESCALATION_FAILURE");
			expect(outcome.text).toContain("apply needs-info");
			expect(outcome.failures).toContain("apply needs-info");
			const calls = world.argvLog();
			expect(calls.some((c) => c.startsWith("issue comment 7"))).toBe(true);
			expect(
				calls.some((c) => c === "issue edit 7 --remove-label in-progress"),
			).toBe(true);
			expect(
				calls.some((c) => c === "issue edit 7 --remove-label in-review"),
			).toBe(true);
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failed status comment still corrects the labels", async () => {
		const world = await makeWorld(
			ISSUE,
			TITLE,
			escalationRules([
				{ args: ["issue", "comment", String(ISSUE), "--body"], status: 1 },
			]),
		);
		try {
			const outcome = await escalateRun(facts(), world.seams);
			expect(outcome.status).toBe("failed");
			if (outcome.status !== "failed") return;
			expect(outcome.text).toContain("ESCALATION_FAILURE");
			expect(outcome.text).toContain("post the status comment");
			const calls = world.argvLog();
			expect(calls).toContain("issue edit 7 --add-label needs-info");
			expect(
				calls.some((c) => c === "issue edit 7 --remove-label in-progress"),
			).toBe(true);
		} finally {
			cleanupWorld(world);
		}
	});

	test("omits the lines for facts a stopped Run does not have", async () => {
		const world = await makeWorld(ISSUE, TITLE, escalationRules());
		try {
			const outcome = await escalateRun(
				facts({
					pr: undefined,
					branch: undefined,
					worktree: undefined,
					runDirectory: undefined,
					cycle: undefined,
				}),
				world.seams,
			);
			expect(outcome.status).toBe("escalated");
			const comment = world
				.argvLog()
				.find((c) => c.startsWith("issue comment 7"));
			expect(comment).toContain(`Run ${RUN}`);
			expect(comment).not.toContain(", cycle");
			expect(comment).not.toContain("#57");
			expect(comment).not.toContain("Branch:");
			expect(comment).not.toContain("Worktree:");
			expect(comment).not.toContain("Run directory:");
		} finally {
			cleanupWorld(world);
		}
	});
});
