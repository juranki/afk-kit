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

describe("evaluate — real git resolution", () => {
	let work: string;

	beforeAll(() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-guard-l2-"));
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

	test("an ambiguous bare push defers to the real branch", async () => {
		const git = (args: string[]) =>
			spawnSync("git", args, { cwd: work, stdio: "ignore" });
		git(["checkout", "main"]);
		expect((await evaluate("git --unknown x push", work))?.matched).toBe(
			"git push behind unrecognized flags",
		);
		git(["checkout", "issue-1-x"]);
		expect(await evaluate("git --unknown x push", work)).toBeNull();
	});

	test("a broken cwd resolves no head and stays undecided", async () => {
		expect(await evaluate("git push", path.join(work, "nope"))).toBeNull();
	});
});
