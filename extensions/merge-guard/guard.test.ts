/**
 * L1 unit tests for the merge guard's decision logic (ticket afk-kit #23,
 * ADR 0011): the command-string matrix — which shell invocations the guard
 * refuses (`gh pr merge`, the pull-request merge API, `git push` targeting
 * `main`) and which pass through untouched (the legitimate publisher path).
 */

import { describe, expect, test } from "bun:test";
import { inspectCommand, needsHead, refusalText } from "./guard.ts";

describe("inspectCommand — gh pr merge", () => {
	test("refuses a plain gh pr merge", () => {
		expect(inspectCommand("gh pr merge 30 --squash")?.kind).toBe("gh-pr-merge");
	});

	test("refuses gh pr merge inside a compound command", () => {
		expect(
			inspectCommand("gh pr view 30 && gh pr merge 30 --squash")?.kind,
		).toBe("gh-pr-merge");
	});
});

describe("inspectCommand — pull-request merge API", () => {
	test("refuses the pulls/<n>/merge endpoint via gh api", () => {
		expect(
			inspectCommand(
				"gh api -X PUT repos/juranki/afk-kit/pulls/30/merge -f commit_title=x",
			)?.kind,
		).toBe("merge-api");
	});

	test("refuses the merge endpoint as a full https URL", () => {
		expect(
			inspectCommand(
				"curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge",
			)?.kind,
		).toBe("merge-api");
	});

	test("refuses the GraphQL mergePullRequest mutation through gh", () => {
		expect(
			inspectCommand(
				"gh api graphql -f query='mutation { mergePullRequest(input: {}) }'",
			)?.kind,
		).toBe("merge-api");
	});

	test("refuses the branch-merge endpoint with base=main", () => {
		expect(
			inspectCommand("gh api repos/o/r/merges -f base=main -f head=feature")
				?.kind,
		).toBe("merge-api");
	});

	test("allows reads of the pulls API", () => {
		expect(inspectCommand("gh api repos/o/r/pulls/30/files")).toBeNull();
		expect(inspectCommand("gh api repos/o/r/pulls?state=open")).toBeNull();
	});

	test("allows a graphql query without a merge mutation", () => {
		expect(
			inspectCommand("gh api graphql -f query='{ viewer { login } }'"),
		).toBeNull();
	});

	test("allows the merge-endpoint path with no network carrier (docs grep)", () => {
		expect(inspectCommand("rg 'pulls/1/merge' docs/")).toBeNull();
	});

	test("allows the branch-merge endpoint when base is not main", () => {
		expect(
			inspectCommand("gh api repos/o/r/merges -f base=feature -f head=other"),
		).toBeNull();
	});
});

describe("inspectCommand — git push targeting main", () => {
	test("refuses an explicit main refspec", () => {
		expect(inspectCommand("git push origin main")?.kind).toBe("push-to-main");
	});

	test("refuses main as destination in every spelling", () => {
		for (const refspec of [
			"main:main",
			"main:refs/heads/main",
			"HEAD:main",
			"HEAD:refs/heads/main",
			"feature:main",
			":main",
			":refs/heads/main",
			"refs/heads/main:main",
		]) {
			expect(inspectCommand(`git push origin ${refspec}`)?.kind).toBe(
				"push-to-main",
			);
		}
	});

	test("refuses force and delete variants targeting main", () => {
		for (const cmd of [
			"git push -f origin main",
			"git push --force origin main",
			"git push --force-with-lease origin main",
			"git push origin +feature:main",
			"git push --delete origin main",
			"git push -d origin main",
		]) {
			expect(inspectCommand(cmd)?.kind).toBe("push-to-main");
		}
	});

	test("refuses --all and --mirror, which carry main", () => {
		expect(inspectCommand("git push --all origin")?.kind).toBe("push-to-main");
		expect(inspectCommand("git push --mirror")?.kind).toBe("push-to-main");
	});

	test("refuses main-targeting pushes inside compound commands and with global git flags", () => {
		expect(
			inspectCommand("cd wt && git add -A && git push origin main")?.kind,
		).toBe("push-to-main");
		expect(inspectCommand("git -C ~/wt/afk-kit push origin main")?.kind).toBe(
			"push-to-main",
		);
	});

	test("refuses a quoted main refspec", () => {
		expect(inspectCommand('git push "origin" "main"')?.kind).toBe(
			"push-to-main",
		);
	});

	test("allows publisher-path pushes to issue branches", () => {
		expect(
			inspectCommand("git push -u origin issue-23-merge-guard"),
		).toBeNull();
		expect(inspectCommand("git push origin feature")).toBeNull();
		expect(inspectCommand("git push origin +feature:feature")).toBeNull();
		expect(inspectCommand("git push origin HEAD:feature")).toBeNull();
		expect(
			inspectCommand("git push --force-with-lease origin feature"),
		).toBeNull();
	});

	test("allows local git work on main and non-push network git", () => {
		expect(inspectCommand("git checkout main")).toBeNull();
		expect(inspectCommand("git merge feature")).toBeNull();
		expect(inspectCommand("git pull origin main")).toBeNull();
		expect(inspectCommand("git fetch origin main")).toBeNull();
	});

	test("a command line containing a literal main-targeting push refuses (documented false-positive class)", () => {
		expect(inspectCommand('echo "git push origin main"')?.kind).toBe(
			"push-to-main",
		);
	});
});

describe("inspectCommand — head-dependent pushes", () => {
	test("refuses a bare git push when the current branch is main", () => {
		const refusal = inspectCommand("git push", "main");
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toContain("current branch main");
	});

	test("refuses a repository-only push when the current branch is main", () => {
		expect(inspectCommand("git push origin", "main")?.kind).toBe(
			"push-to-main",
		);
	});

	test("refuses a bare HEAD refspec when the current branch is main", () => {
		expect(inspectCommand("git push origin HEAD", "main")?.kind).toBe(
			"push-to-main",
		);
	});

	test("lets the same pushes through on a ticket branch", () => {
		expect(inspectCommand("git push", "issue-23-merge-guard")).toBeNull();
		expect(
			inspectCommand("git push origin", "issue-23-merge-guard"),
		).toBeNull();
		expect(
			inspectCommand("git push origin HEAD", "issue-23-merge-guard"),
		).toBeNull();
	});

	test("is undecided without a resolved head", () => {
		expect(inspectCommand("git push")).toBeNull();
	});
});

describe("inspectCommand — redirection stripping (#38)", () => {
	test("a bare push disguised by redirections refuses as a bare push on main", () => {
		const refusal = inspectCommand("git push --quiet >build.log 2>&1", "main");
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toBe("git push (current branch main)");
	});

	test("redirections around a bare push keep the head split clean", () => {
		const refused = inspectCommand("git push >out.log 2>&1", "main");
		expect(refused?.kind).toBe("push-to-main");
		expect(refused?.matched).toBe("git push (current branch main)");
		expect(inspectCommand("git push >out.log 2>&1", "issue-1-x")).toBeNull();
		expect(inspectCommand("git push 2>&1", "main")?.kind).toBe("push-to-main");
		expect(inspectCommand("git push 2>&1", "issue-1-x")).toBeNull();
	});

	test("a redirection does not launder an explicit main refspec", () => {
		const refusal = inspectCommand("git push origin main >log", "main");
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toBe("main");
	});

	test("strip then judge: a read-shaped bare push still follows bare-push semantics", () => {
		const refusal = inspectCommand(
			"git push --porcelain >result.txt 2>&1",
			"main",
		);
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toBe("git push (current branch main)");
	});

	test("an operator-shaped token inside a quoted argument is stripped (documented residue) without changing the push verdict", () => {
		const withFilter =
			"jq 'select(.size > 1)' out.json && git push origin main";
		const refusal = inspectCommand(withFilter, "main");
		expect(refusal?.kind).toBe("push-to-main");
		expect(refusal?.matched).toBe(
			inspectCommand("git push origin main", "main")?.matched,
		);
		expect(inspectCommand("jq 'select(.size > 1)' out.json")).toBeNull();
	});

	test("redirection-disguised bare pushes still need a head", () => {
		expect(needsHead("git push 2>&1")).toBe(true);
		expect(needsHead("git push --quiet >build.log 2>&1")).toBe(true);
	});
});

describe("needsHead", () => {
	test("flags bare, repository-only, and bare-HEAD pushes", () => {
		expect(needsHead("git push")).toBe(true);
		expect(needsHead("git push origin")).toBe(true);
		expect(needsHead("git push origin HEAD")).toBe(true);
	});

	test("explicit refspecs and non-push commands need no resolution", () => {
		expect(needsHead("git push origin main")).toBe(false);
		expect(needsHead("git push -u origin issue-23-merge-guard")).toBe(false);
		expect(needsHead("git status")).toBe(false);
		expect(needsHead("gh pr merge 30")).toBe(false);
	});
});

describe("refusalText", () => {
	test("leads with the marker and names the matched fragment", () => {
		const refusal = inspectCommand("gh pr merge 30 --squash");
		if (!refusal) throw new Error("expected a refusal");
		const text = refusalText(refusal);
		expect(text.startsWith("MERGE_GATE_REFUSAL gh-pr-merge:")).toBe(true);
		expect(text).toContain("gh pr merge");
	});

	test("names the merge gate and its ADRs", () => {
		const refusal = inspectCommand("git push origin main");
		if (!refusal) throw new Error("expected a refusal");
		const text = refusalText(refusal);
		expect(text).toContain("maintainer-only");
		expect(text).toContain("ADR 0002");
		expect(text).toContain("ADR 0011");
	});

	test("instructs stop-and-report per the escalation convention", () => {
		const refusal = inspectCommand("git push origin main");
		if (!refusal) throw new Error("expected a refusal");
		const text = refusalText(refusal);
		expect(text).toContain("status comment");
		expect(text).toContain("preserve the worktree");
		expect(text).toContain("stop");
	});
});
