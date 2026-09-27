/**
 * L2 seam-integration tests for `claimTicket` (ticket afk-kit #58, code-verify
 * standard): the real `git` binary runs against a local bare remote and the
 * real `gh` binary is replaced by a stub on PATH — the environment is
 * swapped, never the code.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { slugFor } from "../extensions/coordinator/slug.ts";
import { claimTicket } from "./claim.ts";
import { cleanupWorld, makeWorld } from "./test-world.ts";

const ISSUE = 7;
const TITLE = "Extract narrow Engine tracker and Git operations";
const SLUG = slugFor(TITLE);
const BRANCH = `issue-${ISSUE}-${SLUG}`;

describe("claimTicket", () => {
	test("claims end to end: branch and worktree from the fetched origin/main SHA, local main untouched", async () => {
		const world = await makeWorld(ISSUE, TITLE);
		try {
			const outcome = await claimTicket(ISSUE, world.seams);
			expect(outcome.status).toBe("claimed");
			if (outcome.status !== "claimed") return;
			expect(outcome.issue).toBe(ISSUE);
			expect(outcome.maintainer).toBe("maintainer");
			expect(outcome.slug).toBe(SLUG);
			expect(outcome.branch).toBe(BRANCH);
			expect(outcome.base).toBe(world.originMainSha);
			// The worktree exists at the convention path, on the branch.
			const wt = outcome.worktree;
			expect(wt).toBe(path.join(world.worktreeRoot, "remote", BRANCH));
			expect(fs.existsSync(wt)).toBe(true);
			const head = await world.git(["rev-parse", "--abbrev-ref", "HEAD"], wt);
			expect(head.stdout.trim()).toBe(BRANCH);
			// The branch starts exactly at the fetched origin/main SHA...
			const tip = await world.git(["rev-parse", "HEAD"], wt);
			expect(tip.stdout.trim()).toBe(world.originMainSha);
			// ...the remote still carries it...
			const bareMain = await world.git(["rev-parse", "main"], world.bare);
			expect(bareMain.stdout.trim()).toBe(world.originMainSha);
			// ...and the checkout's local main never moved.
			const localMain = await world.git(["rev-parse", "main"], world.checkout);
			expect(localMain.stdout.trim()).not.toBe(world.originMainSha);
			// Tracker writes happened, in claim order.
			const calls = world.argvLog();
			const assign = calls.indexOf("issue edit 7 --add-assignee maintainer");
			const label = calls.indexOf("issue edit 7 --add-label in-progress");
			expect(assign).toBeGreaterThan(-1);
			expect(label).toBeGreaterThan(assign);
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses an already-claimed issue without touching anything", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			{
				args: [
					"issue",
					"view",
					String(ISSUE),
					"--json",
					"number,title,url,assignees,labels",
				],
				json: {
					number: ISSUE,
					title: TITLE,
					url: `https://example.com/repo/issues/${ISSUE}`,
					assignees: [{ login: "someone-else" }],
					labels: [{ name: "ready-for-agent" }],
				},
			},
		]);
		try {
			const outcome = await claimTicket(ISSUE, world.seams);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(outcome.text).toContain("someone-else");
			expect(world.argvLog().filter((c) => c.startsWith("issue edit"))).toEqual(
				[],
			);
			expect(world.argvLog().every((c) => !c.startsWith("git"))).toBe(true);
			expect(fs.existsSync(world.worktreeRoot)).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses an issue carrying a leftover in-progress marker", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			{
				args: [
					"issue",
					"view",
					String(ISSUE),
					"--json",
					"number,title,url,assignees,labels",
				],
				json: {
					number: ISSUE,
					title: TITLE,
					url: `https://example.com/repo/issues/${ISSUE}`,
					assignees: [],
					labels: [{ name: "ready-for-agent" }, { name: "in-progress" }],
				},
			},
		]);
		try {
			const outcome = await claimTicket(ISSUE, world.seams);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(outcome.text).toContain("in-progress");
			expect(world.argvLog().filter((c) => c.startsWith("issue edit"))).toEqual(
				[],
			);
			expect(fs.existsSync(world.worktreeRoot)).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("a claim lost to a competing coordinator compensates and names the rival", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			{
				args: ["issue", "view", String(ISSUE), "--json", "assignees"],
				json: { assignees: [{ login: "maintainer" }, { login: "rival" }] },
			},
		]);
		try {
			const outcome = await claimTicket(ISSUE, world.seams);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(outcome.text).toContain("rival");
			expect(world.argvLog()).toContain(
				"issue edit 7 --remove-assignee maintainer",
			);
			expect(fs.existsSync(world.worktreeRoot)).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("an interrupted claim compensates the steps before the failure", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			{
				args: ["issue", "edit", String(ISSUE), "--add-label", "in-progress"],
				status: 1,
			},
		]);
		try {
			const outcome = await claimTicket(ISSUE, world.seams);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(outcome.text).toContain("in-progress");
			// The half-claim was rolled back: the assignee was removed.
			const calls = world.argvLog();
			expect(calls).toContain("issue edit 7 --remove-assignee maintainer");
			expect(
				calls.indexOf("issue edit 7 --add-assignee maintainer"),
			).toBeLessThan(
				calls.indexOf("issue edit 7 --remove-assignee maintainer"),
			);
			expect(fs.existsSync(world.worktreeRoot)).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("a compensation failure is named as leftover state", async () => {
		const world = await makeWorld(ISSUE, TITLE, [
			{
				args: ["issue", "edit", String(ISSUE), "--add-label", "in-progress"],
				status: 1,
			},
			{
				args: ["issue", "edit", String(ISSUE), "--remove-assignee"],
				status: 1,
			},
		]);
		try {
			const outcome = await claimTicket(ISSUE, world.seams);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(outcome.text).toContain("Leftover state");
			expect(outcome.text).toContain("assigned to maintainer");
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failed worktree creation compensates the tracker writes away", async () => {
		// Force the worktree step to fail: the worktree path is already a file.
		const world = await makeWorld(ISSUE, TITLE);
		const blocker = path.join(world.worktreeRoot, "remote", `${BRANCH}`);
		fs.mkdirSync(path.dirname(blocker), { recursive: true });
		fs.writeFileSync(blocker, "not a directory");
		try {
			const outcome = await claimTicket(ISSUE, world.seams);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(outcome.text).toContain("worktree and branch");
			const calls = world.argvLog();
			expect(calls).toContain("issue edit 7 --remove-assignee maintainer");
			expect(calls).toContain("issue edit 7 --remove-label in-progress");
		} finally {
			cleanupWorld(world);
		}
	});

	test("a fetch failure refuses before any tracker write", async () => {
		const world = await makeWorld(ISSUE, TITLE);
		await world.git(
			["remote", "set-url", "origin", "/nonexistent-remote"],
			world.checkout,
		);
		try {
			const outcome = await claimTicket(ISSUE, world.seams);
			expect(outcome.status).toBe("refused");
			if (outcome.status !== "refused") return;
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(world.argvLog().filter((c) => c.startsWith("issue edit"))).toEqual(
				[],
			);
			expect(fs.existsSync(world.worktreeRoot)).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});
});
