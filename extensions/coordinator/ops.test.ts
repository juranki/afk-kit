/**
 * L2 seam-integration tests for the coordinator ops (ticket afk-kit #19,
 * code-verify standard): the real `git` binary runs against a local bare
 * remote, and the real `gh` binary is replaced by a stub on PATH that
 * records argv and serves canned responses — the environment is swapped,
 * never the code.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGh } from "../readiness/gh.ts";
import { runGit } from "./git.ts";
import { type CoordinatorSeams, claimIssue, publishPr } from "./ops.ts";

/** A rule matches one exact `gh` argv; first match wins. */
interface GhRule {
	args: string[];
	status?: number;
	json?: unknown;
	stdout?: string;
}

const GH_STUB = `#!/usr/bin/env bun
import * as fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG!, JSON.stringify(args) + "\\n");
const rules: { args: string[]; status?: number; json?: unknown; stdout?: string }[] =
	JSON.parse(fs.readFileSync(process.env.GH_STUB_RULES!, "utf8"));
const rule = rules.find((r) => r.args.every((a, i) => args[i] === a));
if (!rule) {
	process.stderr.write("gh-stub: unstubbed call: " + args.join(" ") + "\\n");
	process.exit(3);
}
if (rule.json !== undefined) console.log(JSON.stringify(rule.json));
if (rule.stdout !== undefined) process.stdout.write(rule.stdout);
process.exit(rule.status ?? 0);
`;

interface World {
	root: string;
	bare: string;
	checkout: string;
	log: string;
	rulesPath: string;
	rules: GhRule[];
	worktreeRoot: string;
	seams: CoordinatorSeams;
	git: (
		args: string[],
		cwd?: string,
	) => Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
	}>;
	argvLog: () => string[];
}

function sh(cwd: string, command: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", command], { cwd, stdio: "pipe" });
		child.on("error", reject);
		child.on("close", (status) => {
			if (status === 0) resolve();
			else reject(new Error(`${command} failed in ${cwd} (exit ${status})`));
		});
	});
}

function writeRules(world: World): void {
	fs.writeFileSync(world.rulesPath, JSON.stringify(world.rules, null, 2));
}

/** Scratch issue brief: a full, ready-for-agent brief (readiness passes). */
const BRIEF_BODY = [
	"## Agent brief",
	"",
	"**Summary:** Scratch issue proving the coordinator ops end to end.",
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

/** Scratch issue title: also the slug-rule fixture (L1) expectations rely
 * on it only through the branch literal below, computed by hand. */
const TITLE = "Scratch issue proving the coordinator ops end to end";
const BRANCH = "issue-7-scratch-issue-proving-the";

/** A fixture world: bare remote + clone, stubbed gh, temp worktree root. */
async function makeWorld(
	issue: number,
	extraRules: GhRule[] = [],
): Promise<World> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-ops-"));
	const bare = path.join(root, "remote.git");
	const checkout = path.join(root, "checkout");
	const worktreeRoot = path.join(root, "wt");
	await sh(root, `git init --bare --initial-branch=main "${bare}"`);
	await sh(root, `git clone "${bare}" "${checkout}"`);
	await sh(
		checkout,
		"git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m seed && git push -u origin main",
	);
	const stubDir = path.join(root, "bin");
	fs.mkdirSync(stubDir);
	fs.writeFileSync(path.join(stubDir, "gh"), GH_STUB);
	fs.chmodSync(path.join(stubDir, "gh"), 0o755);
	process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;
	const log = path.join(root, "gh-argv.log");
	fs.writeFileSync(log, "");
	const rulesPath = path.join(root, "gh-rules.json");
	process.env.GH_STUB_LOG = log;
	process.env.GH_STUB_RULES = rulesPath;
	const title = TITLE;
	const world: World = {
		root,
		bare,
		checkout,
		log,
		rulesPath,
		rules: [
			...extraRules,
			{ args: ["api", "user"], json: { login: "maintainer" } },
			{
				args: [
					"issue",
					"view",
					String(issue),
					"--json",
					"number,title,url,assignees,labels",
				],
				json: {
					number: issue,
					title,
					url: `https://example.com/repo/issues/${issue}`,
					assignees: [],
					labels: [{ name: "ready-for-agent" }],
				},
			},
			{
				args: [
					"issue",
					"view",
					String(issue),
					"--json",
					"body,labels,blockedBy",
				],
				json: {
					body: BRIEF_BODY,
					labels: [{ name: "ready-for-agent" }],
					blockedBy: { nodes: [] },
				},
			},
			{
				args: ["issue", "edit", String(issue), "--add-assignee", "maintainer"],
				json: {},
			},
			{
				args: ["issue", "view", String(issue), "--json", "assignees"],
				json: [{ login: "maintainer" }],
			},
			{
				args: ["issue", "edit", String(issue), "--add-label", "in-progress"],
				json: {},
			},
			...extraRules,
		],
		worktreeRoot,
		seams: {
			gh: runGh(checkout),
			git: runGit(),
			checkout,
			worktreeRoot,
		},
		git: (args, cwd = checkout) => {
			const child = spawn("git", args, { cwd, stdio: "pipe" });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (c: Buffer) => {
				stdout += c;
			});
			child.stderr.on("data", (c: Buffer) => {
				stderr += c;
			});
			return new Promise((resolve) => {
				child.on("close", (code) =>
					resolve({ stdout, stderr, exitCode: code ?? 1 }),
				);
			});
		},
		argvLog: () =>
			fs
				.readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => JSON.parse(l).join(" ")),
	};
	writeRules(world);
	return world;
}

function cleanupWorld(world: World): void {
	delete process.env.GH_STUB_LOG;
	delete process.env.GH_STUB_RULES;
	process.env.PATH = process.env.PATH
		? process.env.PATH.split(path.delimiter)
				.filter((p) => fs.existsSync(p) && p !== path.join(world.root, "bin"))
				.join(path.delimiter)
		: process.env.PATH;
	fs.rmSync(world.root, { recursive: true, force: true });
}

describe("claimIssue", () => {
	test("claims end to end: assign, in-progress, worktree on a branch from main", async () => {
		const world = await makeWorld(7);
		try {
			const outcome = await claimIssue(7, world.seams);
			expect(outcome.ok).toBe(true);
			expect(outcome.text).toContain("Claimed #7");
			expect(outcome.maintainer).toBe("maintainer");
			expect(outcome.slug).toBe("scratch-issue-proving-the");
			expect(outcome.branch).toBe("issue-7-scratch-issue-proving-the");
			const branch = outcome.branch ?? "";
			const wt = outcome.worktree ?? "";
			expect(wt).toBe(path.join(world.worktreeRoot, "remote", branch));
			// The worktree exists, is on the branch, branched from main's tip.
			expect(fs.existsSync(wt)).toBe(true);
			const head = await world.git(["rev-parse", "--abbrev-ref", "HEAD"], wt);
			expect(head.stdout.trim()).toBe(branch);
			const tip = await world.git(["rev-parse", "HEAD"], wt);
			const main = await world.git(["rev-parse", "main"], world.checkout);
			expect(tip.stdout.trim()).toBe(main.stdout.trim());
			// Tracker writes happened, in claim order.
			const calls = world.argvLog();
			const assign = calls.indexOf(`issue edit 7 --add-assignee maintainer`);
			const label = calls.indexOf(`issue edit 7 --add-label in-progress`);
			expect(assign).toBeGreaterThan(-1);
			expect(label).toBeGreaterThan(assign);
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses an already-claimed issue without touching state", async () => {
		const world = await makeWorld(7, [
			{
				args: [
					"issue",
					"view",
					"7",
					"--json",
					"number,title,url,assignees,labels",
				],
				json: {
					number: 7,
					title: TITLE,
					url: "https://example.com/repo/issues/7",
					assignees: [{ login: "someone-else" }],
					labels: [{ name: "ready-for-agent" }],
				},
			},
		]);
		try {
			const outcome = await claimIssue(7, world.seams);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(outcome.text).toContain("someone-else");
			expect(world.argvLog().filter((c) => c.startsWith("issue edit"))).toEqual(
				[],
			);
			expect(fs.existsSync(world.worktreeRoot)).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("an interrupted claim compensates the steps before the failure", async () => {
		const world = await makeWorld(7, [
			{
				args: ["issue", "edit", "7", "--add-label", "in-progress"],
				status: 1,
			},
			{
				args: ["issue", "edit", "7", "--remove-assignee", "maintainer"],
				json: {},
			},
		]);
		try {
			const outcome = await claimIssue(7, world.seams);
			expect(outcome.ok).toBe(false);
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
		const world = await makeWorld(7, [
			{
				args: ["issue", "edit", "7", "--add-label", "in-progress"],
				status: 1,
			},
			{
				args: ["issue", "edit", "7", "--remove-assignee", "maintainer"],
				status: 1,
			},
		]);
		try {
			const outcome = await claimIssue(7, world.seams);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("CLAIM_REFUSAL");
			expect(outcome.text).toContain("Leftover state");
			expect(outcome.text).toContain("assigned to maintainer");
		} finally {
			cleanupWorld(world);
		}
	});

	test("a claim lost to a competing coordinator compensates and names the rival", async () => {
		const world = await makeWorld(7, [
			{
				args: ["issue", "view", "7", "--json", "assignees"],
				json: [{ login: "maintainer" }, { login: "rival" }],
			},
			{
				args: ["issue", "edit", "7", "--remove-assignee", "maintainer"],
				json: {},
			},
		]);
		try {
			const outcome = await claimIssue(7, world.seams);
			expect(outcome.ok).toBe(false);
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

	test("refuses on a failing readiness check, claiming nothing", async () => {
		const world = await makeWorld(7, [
			{
				args: ["issue", "view", "7", "--json", "body,labels,blockedBy"],
				json: {
					body: "A question, not a ticket.",
					labels: [{ name: "needs-triage" }],
					blockedBy: { nodes: [] },
				},
			},
		]);
		try {
			const outcome = await claimIssue(7, world.seams);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("READINESS_REFUSAL");
			expect(outcome.text).toContain("brief-fields");
			expect(world.argvLog().filter((c) => c.startsWith("issue edit"))).toEqual(
				[],
			);
			expect(fs.existsSync(world.worktreeRoot)).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses an issue carrying a leftover in-progress marker", async () => {
		const world = await makeWorld(7, [
			{
				args: [
					"issue",
					"view",
					"7",
					"--json",
					"number,title,url,assignees,labels",
				],
				json: {
					number: 7,
					title: TITLE,
					url: "https://example.com/repo/issues/7",
					assignees: [],
					labels: [{ name: "ready-for-agent" }, { name: "in-progress" }],
				},
			},
		]);
		try {
			const outcome = await claimIssue(7, world.seams);
			expect(outcome.ok).toBe(false);
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
});

describe("publishPr", () => {
	const SUMMARY = "Prove the publish op";
	const PR_URL = "https://example.com/repo/pull/57";

	/** A worktree on an issue branch with one commit, per the claim op's shape. */
	async function makeWorktree(world: World, branch: string): Promise<string> {
		const worktree = path.join(world.worktreeRoot, "remote", branch);
		await world.git(["worktree", "add", "-b", branch, worktree, "main"]);
		fs.writeFileSync(path.join(worktree, "change.txt"), "work\n");
		await world.git(["add", "."], worktree);
		await world.git(["commit", "-m", "Work the ticket"], worktree);
		return worktree;
	}

	function baseRules(body = BRIEF_BODY): GhRule[] {
		return [
			{ args: ["api", "user"], json: { login: "maintainer" } },
			{
				args: [
					"pr",
					"list",
					"--head",
					BRANCH,
					"--state",
					"open",
					"--json",
					"number,title,url",
				],
				json: [],
			},
			{
				args: ["issue", "view", "7", "--json", "number,title,body,url,labels"],
				json: {
					number: 7,
					title: TITLE,
					url: "https://example.com/repo/issues/7",
					body,
					labels: [{ name: "ready-for-agent" }, { name: "in-progress" }],
				},
			},
		];
	}

	function prCreateRule(rule: Omit<GhRule, "args"> = {}): GhRule {
		return {
			args: ["pr", "create", "--base", "main", "--head", BRANCH],
			...rule,
		};
	}

	async function lsRemote(world: World): Promise<string> {
		return new Promise((resolve) => {
			const child = spawn("git", ["ls-remote", world.bare, BRANCH]);
			let out = "";
			child.stdout.on("data", (c: Buffer) => {
				out += c;
			});
			child.on("close", () => resolve(out.trim()));
		});
	}

	test("publishes end to end: verify, push, PR with brief body, label flip", async () => {
		const world = await makeWorld(7, [
			...baseRules(),
			prCreateRule({ stdout: `${PR_URL}\n` }),
			{ args: ["issue", "edit", "7", "--add-label", "in-review"], json: {} },
			{
				args: ["issue", "edit", "7", "--remove-label", "in-progress"],
				json: {},
			},
		]);
		try {
			const worktree = await makeWorktree(world, BRANCH);
			const outcome = await publishPr(
				{ worktree, summary: SUMMARY },
				world.seams,
			);
			expect(outcome.ok).toBe(true);
			expect(outcome.issue).toBe(7);
			expect(outcome.branch).toBe(BRANCH);
			expect(outcome.pr?.number).toBe(57);
			expect(outcome.pr?.url).toBe(PR_URL);
			expect(outcome.text).toContain(`PR #57`);
			// The branch was pushed to the remote.
			expect(await lsRemote(world)).toContain(BRANCH);
			// The PR create call: title, body per the convention, reviewer.
			const create = world.argvLog().find((c) => c.startsWith("pr create"));
			expect(create).toBeDefined();
			expect(create).toContain(`--title Prove the publish op (#7)`);
			expect(create).toContain("--reviewer maintainer");
			expect(create).toContain("Closes #7");
			expect(create).toContain("The op under proof behaves per its ticket.");
			expect(create).toContain("`exit 0` — pass");
			// Label flip after the PR: in-review on, in-progress off.
			const calls = world.argvLog();
			const opened = calls.findIndex((c) => c.startsWith("pr create"));
			const onReview = calls.indexOf("issue edit 7 --add-label in-review");
			const offProgress = calls.indexOf(
				"issue edit 7 --remove-label in-progress",
			);
			expect(onReview).toBeGreaterThan(opened);
			expect(offProgress).toBeGreaterThan(onReview);
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failing verify command refuses before anything is pushed", async () => {
		const failing = BRIEF_BODY.replace("`exit 0`", "`exit 3`");
		const world = await makeWorld(7, baseRules(failing));
		try {
			const worktree = await makeWorktree(world, BRANCH);
			const outcome = await publishPr(
				{ worktree, summary: SUMMARY },
				world.seams,
			);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("exit 3");
			expect(await lsRemote(world)).toBe("");
			expect(world.argvLog().some((c) => c.startsWith("pr create"))).toBe(
				false,
			);
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses an issue whose branch already has an open PR", async () => {
		const world = await makeWorld(7, [
			{
				args: [
					"pr",
					"list",
					"--head",
					BRANCH,
					"--state",
					"open",
					"--json",
					"number,title,url",
				],
				json: [{ number: 57, title: "Old PR", url: PR_URL }],
			},
			...baseRules(),
		]);
		try {
			const worktree = await makeWorktree(world, BRANCH);
			const outcome = await publishPr(
				{ worktree, summary: SUMMARY },
				world.seams,
			);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("#57");
			expect(outcome.text).toContain("Old PR");
			expect(await lsRemote(world)).toBe("");
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failed PR open compensates the push away", async () => {
		const world = await makeWorld(7, [
			...baseRules(),
			prCreateRule({ status: 1 }),
		]);
		try {
			const worktree = await makeWorktree(world, BRANCH);
			const outcome = await publishPr(
				{ worktree, summary: SUMMARY },
				world.seams,
			);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("open the pull request");
			expect(outcome.text).toContain("Compensated: push the branch");
			expect(await lsRemote(world)).toBe("");
			expect(world.argvLog().some((c) => c.startsWith("pr close"))).toBe(false);
		} finally {
			cleanupWorld(world);
		}
	});

	test("a failed label flip compensates: PR closed, remote branch deleted", async () => {
		const world = await makeWorld(7, [
			...baseRules(),
			prCreateRule({ stdout: `${PR_URL}\n` }),
			{ args: ["issue", "edit", "7", "--add-label", "in-review"], status: 1 },
			{ args: ["pr", "close", "57"], json: {} },
		]);
		try {
			const worktree = await makeWorktree(world, BRANCH);
			const outcome = await publishPr(
				{ worktree, summary: SUMMARY },
				world.seams,
			);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("apply in-review");
			expect(world.argvLog().some((c) => c.startsWith("pr close 57"))).toBe(
				true,
			);
			expect(await lsRemote(world)).toBe("");
		} finally {
			cleanupWorld(world);
		}
	});

	test("refuses a worktree not on an issue branch", async () => {
		const world = await makeWorld(7, [
			{ args: ["api", "user"], json: { login: "maintainer" } },
		]);
		try {
			const worktree = await makeWorktree(world, "feature-stray");
			const outcome = await publishPr(
				{ worktree, summary: SUMMARY },
				world.seams,
			);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("PUBLISH_REFUSAL");
			expect(outcome.text).toContain("feature-stray");
		} finally {
			cleanupWorld(world);
		}
	});
});
