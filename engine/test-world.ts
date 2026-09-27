/**
 * L2 fixture world for the engine operations (ticket afk-kit #58, code-verify
 * standard): a bare remote and its clone — with origin/main deliberately
 * ahead of the clone's local `main` — a stub `gh` on PATH that records argv
 * and serves canned rules, and a temp worktree root. The environment is
 * swapped, never the code.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGit } from "../extensions/coordinator/git.ts";
import { runGh } from "../extensions/readiness/gh.ts";
import type { EngineSeams } from "./seams.ts";

/** A rule matches one `gh` argv by prefix; first match wins. */
export interface GhRule {
	args: string[];
	status?: number;
	json?: unknown;
	stdout?: string;
	/** How long the stub stalls before answering — in-flight windows for interruption tests. */
	delayMs?: number;
}

const GH_STUB = `#!/usr/bin/env bun
import * as fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG!, JSON.stringify(args) + "\\n");
const rules: { args: string[]; status?: number; json?: unknown; stdout?: string; delayMs?: number }[] =
	JSON.parse(fs.readFileSync(process.env.GH_STUB_RULES!, "utf8"));
const rule = rules.find((r) => r.args.every((a, i) => args[i] === a));
if (!rule) {
	process.stderr.write("gh-stub: unstubbed call: " + args.join(" ") + "\\n");
	process.exit(3);
}
if (rule.delayMs) await Bun.sleep(rule.delayMs);
if (rule.json !== undefined) console.log(JSON.stringify(rule.json));
if (rule.stdout !== undefined) process.stdout.write(rule.stdout);
process.exit(rule.status ?? 0);
`;

export interface World {
	root: string;
	bare: string;
	checkout: string;
	worktreeRoot: string;
	/** origin/main's SHA as the fixture leaves it — one ahead of local main. */
	originMainSha: string;
	seams: EngineSeams;
	git: (
		args: string[],
		cwd?: string,
	) => Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
	}>;
	argvLog: () => string[];
	setRules: (rules: GhRule[]) => void;
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

/**
 * A fixture world: bare remote + clone (origin/main one commit ahead of the
 * clone's local `main`), stubbed gh, temp worktree root. `baseRules` apply
 * after any rules the caller passes — earlier rules win, so callers override
 * by prepending.
 */
export async function makeWorld(
	issue: number,
	title: string,
	extraRules: GhRule[] = [],
): Promise<World> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-ops-"));
	const bare = path.join(root, "remote.git");
	const checkout = path.join(root, "checkout");
	const worktreeRoot = path.join(root, "wt");
	await sh(root, `git init --bare --initial-branch=main "${bare}"`);
	await sh(root, `git clone "${bare}" "${checkout}"`);
	await sh(
		checkout,
		"git config user.email test@example.com && git config user.name Test",
	);
	// Seed the remote two commits deep, then move the clone's local main back
	// one: a claim must branch from the freshly fetched origin/main SHA, so
	// the fixture has to be able to tell them apart.
	await sh(
		checkout,
		"git commit --allow-empty -m seed && git push -u origin main",
	);
	await sh(
		checkout,
		"git commit --allow-empty -m remote-ahead && git push origin main",
	);
	const originMainSha = (
		await gitOut(checkout, ["rev-parse", "origin/main"])
	).stdout.trim();
	await sh(checkout, "git reset --hard HEAD~1");

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

	const world: World = {
		root,
		bare,
		checkout,
		worktreeRoot,
		originMainSha,
		seams: {
			gh: runGh(checkout),
			git: runGit(),
			checkout,
			worktreeRoot,
		},
		git: (args, cwd = checkout) => gitOut(cwd, args),
		argvLog: () =>
			fs
				.readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => JSON.parse(l).join(" ")),
		setRules: (rules: GhRule[]) => {
			fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
		},
	};
	world.setRules([...extraRules, ...baseRules(issue, title)]);
	return world;
}

/** Rules every world can fall back to: an authenticated maintainer, a clean
 * claimable issue, and successful tracker writes. Drivers that swap rules
 * mid-flight (drive.ts tests) recompose with these. */
export function baseRules(issue: number, title: string): GhRule[] {
	return [
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
			args: ["issue", "view", String(issue), "--json", "assignees"],
			json: { assignees: [{ login: "maintainer" }] },
		},
		{
			args: ["issue", "edit", String(issue), "--add-assignee", "maintainer"],
			json: {},
		},
		{
			args: ["issue", "edit", String(issue), "--remove-assignee"],
			json: {},
		},
		{ args: ["issue", "edit", String(issue), "--add-label"], json: {} },
		{ args: ["issue", "edit", String(issue), "--remove-label"], json: {} },
	];
}

export function cleanupWorld(world: World): void {
	delete process.env.GH_STUB_LOG;
	delete process.env.GH_STUB_RULES;
	process.env.PATH = process.env.PATH
		? process.env.PATH.split(path.delimiter)
				.filter((p) => fs.existsSync(p) && p !== path.join(world.root, "bin"))
				.join(path.delimiter)
		: process.env.PATH;
	fs.rmSync(world.root, { recursive: true, force: true });
}

function gitOut(
	cwd: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, stdio: "pipe" });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => {
			stdout += c;
		});
		child.stderr.on("data", (c: Buffer) => {
			stderr += c;
		});
		child.on("close", (code) =>
			resolve({ stdout, stderr, exitCode: code ?? 1 }),
		);
	});
}
