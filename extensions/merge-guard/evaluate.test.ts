/**
 * L2 seam-integration tests for the merge guard (ticket afk-kit #23): the
 * hook-level `evaluate` against real `git` — a bare-repo fixture is the
 * remote, the clone's checked-out branch is the seam that decides
 * head-dependent pushes (code-verify standard: swap the environment, never
 * the code). Every case clones its own checkout, so no test depends on
 * another's branch state: any test passes alone.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluate } from "./evaluate.ts";
import { currentBranch } from "./head.ts";

let root: string;
let seq = 0;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-guard-l2-"));
	const origin = path.join(root, "origin.git");
	const seed = path.join(root, "seed");
	const git = (args: string[], cwd: string) =>
		spawnSync("git", args, { cwd, stdio: "ignore" });
	git(["init", "--bare", "--initial-branch=main", origin], root);
	git(["clone", origin, seed], root);
	git(["config", "user.email", "guard@test"], seed);
	git(["config", "user.name", "guard"], seed);
	fs.writeFileSync(path.join(seed, "file.txt"), "one\n");
	git(["add", "."], seed);
	git(["commit", "-m", "one"], seed);
	git(["push", "origin", "main"], seed);
});

/**
 * A fresh clone of the fixture remote, on `main` or on a local ticket
 * branch — one per test, so cases never share a checkout's branch state.
 */
function clone(branch: "main" | "issue-1-x"): string {
	const dir = path.join(root, `clone-${++seq}`);
	spawnSync("git", ["clone", path.join(root, "origin.git"), dir], {
		cwd: root,
		stdio: "ignore",
	});
	const git = (args: string[]) =>
		spawnSync("git", args, { cwd: dir, stdio: "ignore" });
	git(["config", "user.email", "guard@test"]);
	git(["config", "user.name", "guard"]);
	if (branch !== "main") git(["checkout", "-b", branch]);
	return dir;
}

describe("evaluate — real git resolution", () => {
	test("a fresh clone of the fixture is on main", async () => {
		expect(await currentBranch(clone("main"))).toBe("main");
	});

	test("a bare git push on main refuses", async () => {
		const refusal = await evaluate("git push", clone("main"));
		expect(refusal?.kind).toBe("push-to-main");
	});

	test("a bare HEAD push on main refuses", async () => {
		expect((await evaluate("git push origin HEAD", clone("main")))?.kind).toBe(
			"push-to-main",
		);
	});

	test("an explicit main push refuses without resolution", async () => {
		expect((await evaluate("git push origin main", clone("main")))?.kind).toBe(
			"push-to-main",
		);
	});

	test("the publisher path on a ticket branch passes", async () => {
		const work = clone("issue-1-x");
		expect(await evaluate("git push", work)).toBeNull();
		expect(await evaluate("git push origin HEAD", work)).toBeNull();
		expect(await evaluate("git push -u origin issue-1-x", work)).toBeNull();
	});

	test("a broken cwd resolves no head and stays undecided", async () => {
		expect(
			await evaluate("git push", path.join(clone("main"), "nope")),
		).toBeNull();
	});
});

describe("evaluate — the command's own directory (#38)", () => {
	test("a cd-led push is judged in the cd's directory, not the session cwd", async () => {
		const work = clone("main");
		const refusal = await evaluate(
			`cd ${work} && git push 2>&1 | tail -3`,
			root,
		);
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toContain("(current branch main)");
	});

	test("the same command passes once the clone is off main", async () => {
		const work = clone("issue-1-x");
		expect(
			await evaluate(`cd ${work} && git push 2>&1 | tail -3`, root),
		).toBeNull();
	});

	test("the cwd seam is unchanged: an unrelated non-repo cwd stays undecided", async () => {
		expect(await evaluate("git push", root)).toBeNull();
	});

	test("interior commands do not reset the directory", async () => {
		const refusal = await evaluate(
			`cd ${clone("main")} && git status && git push`,
			root,
		);
		expect(refusal?.kind).toBe("push-to-main");
		expect(
			await evaluate(
				`cd ${clone("issue-1-x")} && git status && git push`,
				root,
			),
		).toBeNull();
	});

	test("a leading cd joined by ; is still consumed: decides in the cd target", async () => {
		const refusal = await evaluate(`cd ${clone("main")}; git push`, root);
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toContain("(current branch main)");
	});

	test("a leading cd joined by a newline is still consumed", async () => {
		const refusal = await evaluate(`cd ${clone("main")}\ngit push`, root);
		expect(refusal?.kind).toBe("push-to-main");
	});

	test("a leading cd joined by | is not consumed: the pipeline's push leg runs in the session directory", async () => {
		// Each pipeline element runs in a subshell, so the cd never leaves its
		// own element: the push leg really runs in the session checkout.
		const work = clone("issue-1-x");
		const session = clone("main");
		const refusal = await evaluate(`cd ${work} | git push 2>&1`, session);
		expect(refusal?.kind).toBe("push-to-main");
	});

	test("a leading cd joined by || is not consumed: the session directory decides", async () => {
		// The push leg runs only when the cd failed — and then in the
		// directory the walk stands in. When the cd succeeds the push never
		// runs, so this refusal from a main checkout is the documented
		// over-refusal residue.
		const work = clone("issue-1-x");
		const session = clone("main");
		const refusal = await evaluate(`cd ${work} || git push`, session);
		expect(refusal?.kind).toBe("push-to-main");
	});

	test("a cd whose target is a variable at an || join stays a pass from a non-repo cwd", async () => {
		// The walk stopped at the || before reading the cd; the session
		// directory decides, and from a non-main session the verdict passes.
		expect(await evaluate("cd $NOPE || git push", root)).toBeNull();
	});

	test("cd-led pushes joined by ; and && still carry the walk: pass from a main-checkout session into a worktree", async () => {
		const work = clone("issue-1-x");
		const session = clone("main");
		expect(await evaluate(`cd ${work} ; git push`, session)).toBeNull();
		expect(await evaluate(`cd ${work} && git push`, session)).toBeNull();
	});

	test("a cd-led push into a main checkout joined by ; refuses from a ticket-branch session cwd", async () => {
		const mainCheckout = clone("main");
		const session = clone("issue-1-x");
		const refusal = await evaluate(`cd ${mainCheckout} ; git push`, session);
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toContain("(current branch main)");
	});

	test("a cd whose target is a variable keeps the undecided stance from a main checkout", async () => {
		// The shell would run the push wherever $WT points — never the
		// session checkout — so the head must not be resolved from it.
		expect(await evaluate("cd $WT && git push", clone("main"))).toBeNull();
	});

	test("a cd whose target is a variable keeps the undecided stance from a non-repo cwd", async () => {
		expect(await evaluate("cd $WT && git push", root)).toBeNull();
	});

	test("residue: an untracked cd after a real command false-refuses a worktree push from a main session", async () => {
		const session = clone("main");
		const worktree = clone("issue-1-x");
		const refusal = await evaluate(
			`git status && cd ${worktree} && git push`,
			session,
		);
		expect(refusal?.kind).toBe("push-to-main");
	});

	test("residue: an untracked cd after a real command false-passes a push into a main checkout from a ticket-branch session", async () => {
		const session = clone("issue-1-x");
		const mainCheckout = clone("main");
		expect(
			await evaluate(`git status && cd ${mainCheckout} && git push`, session),
		).toBeNull();
	});
});
