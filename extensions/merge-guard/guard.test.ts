/**
 * L1 unit tests for the merge guard's decision logic (ticket afk-kit #23,
 * ADR 0011): the command-string matrix — which shell invocations the guard
 * refuses (`gh pr merge`, the pull-request merge API, `git push` targeting
 * `main`) and which pass through untouched (the legitimate publisher path).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { inspectCommand, needsHead, refusalText } from "./guard.ts";

/** Parse the flag spellings out of a `gh … --help` screen: a flag line
 * starts with a short and/or long spelling; the flag takes a value iff a
 * type word follows it on the help line, before the description column. */
function parseHelpFlags(help: string): { spelling: string; value: boolean }[] {
	const flags = new Map<string, boolean>();
	for (const raw of help.split("\n")) {
		const match =
			/^(--?[A-Za-z][A-Za-z0-9-]*)(?:,\s*(--?[A-Za-z][A-Za-z0-9-]*))?(?:\s+(\S+))?(?:\s{2,}|$)/.exec(
				raw.trim(),
			);
		if (!match) continue;
		for (const spelling of [match[1], match[2]]) {
			if (spelling !== undefined) {
				flags.set(spelling, flags.get(spelling) ?? match[3] !== undefined);
			}
		}
	}
	return [...flags].map(([spelling, value]) => ({ spelling, value }));
}

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

describe("inspectCommand — flag payloads are data, not commands", () => {
	test("a tracker write whose --body quotes the trigger patterns passes", () => {
		const body = "never run gh pr merge 30 --squash, nor mergePullRequest";
		expect(inspectCommand(`gh issue comment 30 --body "${body}"`)).toBeNull();
		expect(
			inspectCommand(`gh issue create --title t --body "${body}"`),
		).toBeNull();
	});

	test("a URL in a tracker-write payload does not fire the endpoint patterns", () => {
		expect(
			inspectCommand(
				'gh issue comment 30 --body "see https://api.github.com/repos/o/r/pulls/12/merge"',
			),
		).toBeNull();
	});

	test("an inline script whose text merely contains the patterns passes", () => {
		expect(
			inspectCommand(`node -e 'console.log("gh pr merge 30 --squash")'`),
		).toBeNull();
		expect(
			inspectCommand(`bun -e "console.log('mutation { mergePullRequest }')"`),
		).toBeNull();
	});

	test("a non-gh segment whose payload quotes a full gh api merge invocation still refuses (documented residue of the string-level class)", () => {
		expect(
			inspectCommand(
				`node -e 'console.log("gh api repos/o/r/pulls/12/merge -X PUT")'`,
			)?.kind,
		).toBe("merge-api");
	});

	test("gh pr merge still refuses past gh global flags, env prefixes, and wrappers", () => {
		expect(inspectCommand("gh -R o/r pr merge 30 --squash")?.kind).toBe(
			"gh-pr-merge",
		);
		expect(inspectCommand("GH_TOKEN=x gh pr merge 30 --squash")?.kind).toBe(
			"gh-pr-merge",
		);
		expect(
			inspectCommand("sudo gh api repos/o/r/pulls/12/merge -X PUT")?.kind,
		).toBe("merge-api");
	});
});

describe("inspectCommand — composed command positions refuse (#36)", () => {
	test("the loop body after do is a command position", () => {
		expect(
			inspectCommand("for pr in 1 2 3; do gh pr merge $pr --squash; done")
				?.kind,
		).toBe("gh-pr-merge");
	});

	test("xargs trailing arguments are a command position", () => {
		expect(inspectCommand("gh pr list | xargs -n1 gh pr merge")?.kind).toBe(
			"gh-pr-merge",
		);
	});

	test("xargs with a non-gh command keeps its arguments as payload", () => {
		expect(
			inspectCommand("gh pr list | xargs -n1 echo 'gh pr merge'"),
		).toBeNull();
	});

	test("command substitution spans are command text, whatever leads the segment", () => {
		for (const cmd of [
			"RESULT=$(gh pr merge 30 --squash)",
			"echo $(gh pr merge 30)",
			"echo `gh pr merge 30`",
		]) {
			expect(inspectCommand(cmd)?.kind).toBe("gh-pr-merge");
		}
	});

	test("a substitution span carrying a read stays a read", () => {
		expect(inspectCommand('echo "$(gh pr list)"')).toBeNull();
	});

	test("sh -c and bash -c bodies are command text", () => {
		expect(inspectCommand('sh -c "gh pr merge 30 --squash"')?.kind).toBe(
			"gh-pr-merge",
		);
		expect(inspectCommand("bash -c 'gh pr merge 30'")?.kind).toBe(
			"gh-pr-merge",
		);
	});

	test("flag-consuming wrappers resolve to their command", () => {
		for (const cmd of [
			"nice -n 5 gh pr merge 30",
			"env -u X gh pr merge 30",
			"sudo -u root gh pr merge 30",
			"nohup gh pr merge 30",
			"timeout 10 gh pr merge 30",
		]) {
			expect(inspectCommand(cmd)?.kind).toBe("gh-pr-merge");
		}
	});

	test("every wrapper value-flag table row resolves to its command", () => {
		for (const cmd of [
			"exec -a merged gh pr merge 30",
			"doas -u root gh pr merge 30",
			"time -o log gh pr merge 30",
		]) {
			expect(inspectCommand(cmd)?.kind).toBe("gh-pr-merge");
		}
	});

	test("every shell interpreter's -c body is command text", () => {
		for (const shell of ["zsh", "dash", "ksh"]) {
			expect(inspectCommand(`${shell} -c 'gh pr merge 30'`)?.kind).toBe(
				"gh-pr-merge",
			);
		}
	});
});

describe("inspectCommand — unrecognized flags fail closed", () => {
	test("a spaced value flag before the subcommand words still refuses", () => {
		expect(inspectCommand("gh --color always pr merge 30")?.kind).toBe(
			"gh-pr-merge",
		);
		expect(inspectCommand("gh -t tpl pr merge 30")?.kind).toBe("gh-pr-merge");
	});

	test("a spaced value flag at the subcommand level still refuses", () => {
		expect(inspectCommand("gh pr --color always merge 30")?.kind).toBe(
			"gh-pr-merge",
		);
	});

	test("flag-decorated api invocations still hit the endpoint patterns", () => {
		expect(
			inspectCommand("gh --color always api repos/o/r/pulls/12/merge -X PUT")
				?.kind,
		).toBe("merge-api");
		expect(
			inspectCommand("gh -t tpl api repos/o/r/pulls/12/merge -X PUT")?.kind,
		).toBe("merge-api");
	});

	test("matched names the ambiguous zone for evidence-based refusals", () => {
		expect(inspectCommand("gh -t tpl pr merge 30")?.matched).toBe(
			"pr merge behind unrecognized flags",
		);
	});

	test("an unrecognized global flag cannot hide a push to main", () => {
		expect(inspectCommand("git --unknown x push origin main")?.kind).toBe(
			"push-to-main",
		);
	});

	test("an ambiguous bare push defers to the resolved current branch", () => {
		expect(inspectCommand("git --unknown x push", "main")?.matched).toBe(
			"git push behind unrecognized flags",
		);
		expect(inspectCommand("git --unknown x push", "issue-1-x")).toBeNull();
		expect(inspectCommand("git --unknown x push")).toBeNull();
	});

	test("an ambiguous issue-branch push passes once the head agrees", () => {
		expect(
			inspectCommand("git --unknown x push origin issue-1", "issue-1"),
		).toBeNull();
	});

	test("wrapper flag-walk ambiguity falls back to the fragment scan", () => {
		expect(inspectCommand("sudo --unknown x gh pr merge 30")?.kind).toBe(
			"gh-pr-merge",
		);
		expect(inspectCommand("sudo -u root gh pr view 30")).toBeNull();
	});

	test("reads under unrecognized flags stay reads", () => {
		expect(inspectCommand("gh --paginate pr list")).toBeNull();
		expect(inspectCommand("gh --unknownflag x pr view 30")).toBeNull();
	});

	test("a grep carrying trigger patterns is still a grep, not a call", () => {
		expect(inspectCommand("grep -c 'gh pr merge' README.md")).toBeNull();
		expect(
			inspectCommand("grep -E 'repos/o/r/pulls/12/merge' docs/adr/*.md"),
		).toBeNull();
	});
});

describe("inspectCommand — matched names the invoked fragment", () => {
	test("the plain invocation", () => {
		expect(inspectCommand("gh pr merge 30 --squash")?.matched).toBe(
			"gh pr merge",
		);
	});

	test("global flags between gh and the subcommand are included", () => {
		expect(inspectCommand("gh -R o/r pr merge 30")?.matched).toBe(
			"gh -R o/r pr merge",
		);
	});

	test("wrappers before gh are not part of the fragment", () => {
		expect(inspectCommand("env -u X gh pr merge 30")?.matched).toBe(
			"gh pr merge",
		);
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

	test("flags an ambiguous git push whose verdict cannot be parsed", () => {
		expect(needsHead("git --unknown x push")).toBe(true);
		expect(needsHead("git --unknown x push origin issue-1")).toBe(true);
	});

	test("an ambiguous push with main evidence needs no resolution", () => {
		expect(needsHead("git --unknown x push origin main")).toBe(false);
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

describe("inspectCommand — rot-proof flag matrix from real gh", () => {
	test("every flag gh documents keeps a decorated merge refusing and a decorated read passing", () => {
		const help = spawnSync("gh", ["pr", "view", "--help"], {
			encoding: "utf8",
		});
		if (help.error !== undefined || !help.stdout) return; // gh absent
		const flags = parseHelpFlags(help.stdout);
		if (flags.length === 0) return; // unparseable help output
		expect(flags.length).toBeGreaterThan(5);
		const failures: string[] = [];
		for (const { spelling, value } of flags) {
			const decorated = value ? `${spelling} x` : spelling;
			const merge = inspectCommand(`gh ${decorated} pr merge 30`);
			if (merge?.kind !== "gh-pr-merge") {
				failures.push(
					`${decorated}: merge form passed (${merge?.kind ?? "null"})`,
				);
			}
			const read = inspectCommand(`gh ${decorated} pr list`);
			if (read !== null) {
				failures.push(`${decorated}: read form refused (${read.kind})`);
			}
		}
		expect(failures).toEqual([]);
	});
});
