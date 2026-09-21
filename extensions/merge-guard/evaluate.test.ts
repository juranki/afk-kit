/**
 * L2 seam-integration tests for the merge guard (ticket afk-kit #23): the
 * hook-level `evaluate` against real `git` — a bare-repo fixture is the
 * remote, the clone's checked-out branch is the seam that decides
 * head-dependent pushes (code-verify standard: swap the environment, never
 * the code).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluate } from "./evaluate.ts";
import { currentBranch } from "./head.ts";

let root: string;
let work: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-guard-l2-"));
	const origin = path.join(root, "origin.git");
	work = path.join(root, "work");
	const git = (args: string[], cwd: string) =>
		spawnSync("git", args, { cwd, stdio: "ignore" });
	git(["init", "--bare", "--initial-branch=main", origin], root);
	git(["clone", origin, work], root);
	git(["config", "user.email", "guard@test"], work);
	git(["config", "user.name", "guard"], work);
	fs.writeFileSync(path.join(work, "file.txt"), "one\n");
	git(["add", "."], work);
	git(["commit", "-m", "one"], work);
	git(["branch", "issue-1-x"], work);
});

describe("evaluate — real git resolution", () => {
	test("the fixture clone is on main", async () => {
		expect(await currentBranch(work)).toBe("main");
	});

	test("a bare git push on main refuses", async () => {
		const refusal = await evaluate("git push", work);
		expect(refusal?.kind).toBe("push-to-main");
	});

	test("a bare HEAD push on main refuses", async () => {
		expect((await evaluate("git push origin HEAD", work))?.kind).toBe(
			"push-to-main",
		);
	});

	test("an explicit main push refuses without resolution", async () => {
		expect((await evaluate("git push origin main", work))?.kind).toBe(
			"push-to-main",
		);
	});

	test("the publisher path on a ticket branch passes", async () => {
		const git = (args: string[]) =>
			spawnSync("git", args, { cwd: work, stdio: "ignore" });
		git(["checkout", "issue-1-x"]);
		expect(await evaluate("git push", work)).toBeNull();
		expect(await evaluate("git push origin HEAD", work)).toBeNull();
		expect(await evaluate("git push -u origin issue-1-x", work)).toBeNull();
	});

	test("a broken cwd resolves no head and stays undecided", async () => {
		expect(await evaluate("git push", path.join(work, "nope"))).toBeNull();
	});
});

describe("evaluate — the command's own directory (#38)", () => {
	const git = (args: string[]) =>
		spawnSync("git", args, { cwd: work, stdio: "ignore" });

	test("a cd-led push is judged in the cd's directory, not the session cwd", async () => {
		git(["checkout", "main"]);
		const refusal = await evaluate(
			`cd ${work} && git push 2>&1 | tail -3`,
			root,
		);
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toContain("(current branch main)");
	});

	test("the same command passes once the clone is off main", async () => {
		git(["checkout", "issue-1-x"]);
		expect(
			await evaluate(`cd ${work} && git push 2>&1 | tail -3`, root),
		).toBeNull();
	});

	test("the cwd seam is unchanged: an unrelated non-repo cwd stays undecided", async () => {
		expect(await evaluate("git push", root)).toBeNull();
	});

	test("interior commands do not reset the directory", async () => {
		git(["checkout", "main"]);
		const refusal = await evaluate(
			`cd ${work} && git status && git push`,
			root,
		);
		expect(refusal?.kind).toBe("push-to-main");
		git(["checkout", "issue-1-x"]);
		expect(
			await evaluate(`cd ${work} && git status && git push`, root),
		).toBeNull();
	});

	test("a cd whose target is a variable stops the chain: undecided stance", async () => {
		git(["checkout", "main"]);
		expect(await evaluate("cd $WT && git push", root)).toBeNull();
	});
});
