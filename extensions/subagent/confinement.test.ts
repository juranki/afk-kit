/**
 * Tests for implementer confinement (R5) — ticket afk-kit #17.
 *
 * L1: the decision logic — the env allowlist build, the git publish-verb
 * rule the shim implements, the pinned gitconfig text, and the refusal
 * marker scan — runs offline with no git and no network.
 * L2: the shim's allow/refuse matrix runs as real subprocess tests against
 * the materialized shim (see the matrix describe block).
 *
 * The seams follow docs/conventions/code-verify.md: tests swap the
 * environment, never the code.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	buildConfinedEnv,
	extractRefusals,
	isRefusedGitCommand,
	materializeConfinement,
	renderPinnedGitconfig,
} from "./confinement.ts";

const material = {
	shimDir: "/tmp/confinement-test/shim.d",
	gitconfigPath: "/tmp/confinement-test/gitconfig",
};

describe("buildConfinedEnv", () => {
	test("keeps only the allowlist; credential and injection vars are gone", () => {
		const env = buildConfinedEnv(
			{
				PATH: "/usr/bin:/bin",
				HOME: "/home/u",
				TERM: "xterm-256color",
				LANG: "C.UTF-8",
				TMPDIR: "/tmp",
				HTTPS_PROXY: "http://proxy:3128",
				GH_TOKEN: "gho_secret",
				GITHUB_TOKEN: "ghp_secret",
				AWS_SECRET_ACCESS_KEY: "aws_secret",
				ANTHROPIC_API_KEY: "sk_secret",
				NODE_OPTIONS: "--require /evil.js",
				BASH_ENV: "/evil.sh",
				GIT_ASKPASS: "/evil-askpass",
				SSH_AUTH_SOCK: "/agent-sock",
				GIT_CONFIG_COUNT: "1",
			},
			material,
		);
		expect(env.PATH?.endsWith(":/usr/bin:/bin")).toBe(true);
		expect(env.HOME).toBe("/home/u");
		expect(env.TERM).toBe("xterm-256color");
		expect(env.LANG).toBe("C.UTF-8");
		expect(env.TMPDIR).toBe("/tmp");
		// Network egress ride-through: the child must reach its model API.
		expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
		// No credentials and no injection vectors survive.
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.NODE_OPTIONS).toBeUndefined();
		expect(env.BASH_ENV).toBeUndefined();
		expect(env.GIT_ASKPASS).toBeUndefined();
		expect(env.SSH_AUTH_SOCK).toBeUndefined();
		expect(env.GIT_CONFIG_COUNT).toBeUndefined();
	});

	test("prepends the shim dir to PATH", () => {
		const env = buildConfinedEnv({ PATH: "/usr/bin:/bin" }, material);
		expect(env.PATH).toBe(`${material.shimDir}:/usr/bin:/bin`);
	});

	test("a parent without PATH gets the shim dir alone (no empty element)", () => {
		const env = buildConfinedEnv({ HOME: "/home/u" }, material);
		expect(env.PATH).toBe(material.shimDir);
	});

	test("pins git: global config file, no system config, no prompts", () => {
		const env = buildConfinedEnv({ PATH: "/bin" }, material);
		expect(env.GIT_CONFIG_GLOBAL).toBe(material.gitconfigPath);
		expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	test("an allowlisted var absent from the parent stays absent", () => {
		const env = buildConfinedEnv({ PATH: "/bin" }, material);
		expect(env.TMPDIR).toBeUndefined();
		expect(env.HTTPS_PROXY).toBeUndefined();
	});
});

describe("the git publish-verb rule", () => {
	test("push is refused", () => {
		expect(isRefusedGitCommand(["push"])).toBe(true);
		expect(isRefusedGitCommand(["push", "--force", "origin"])).toBe(true);
	});

	test("local work verbs pass", () => {
		for (const verb of [
			"commit",
			"status",
			"add",
			"diff",
			"log",
			"init",
			"checkout",
			"stash",
		]) {
			expect(isRefusedGitCommand([verb])).toBe(false);
		}
	});

	test("flags before the verb do not hide a push", () => {
		expect(isRefusedGitCommand(["-C", "/repo", "push"])).toBe(true);
		expect(isRefusedGitCommand(["--git-dir=/repo/.git", "push"])).toBe(true);
		expect(isRefusedGitCommand(["-c", "credential.helper=!evil", "push"])).toBe(
			true,
		);
	});

	test("no verb means no refusal", () => {
		expect(isRefusedGitCommand([])).toBe(false);
		expect(isRefusedGitCommand(["--version"])).toBe(false);
	});
});

describe("renderPinnedGitconfig", () => {
	const text = renderPinnedGitconfig({
		name: "Test Implementer",
		email: "impl@test",
	});

	test("carries the identity in", () => {
		expect(text).toContain("name = Test Implementer");
		expect(text).toContain("email = impl@test");
	});

	test("carries credential helpers out", () => {
		const credential = text.slice(text.indexOf("[credential]"));
		expect(credential).toContain("helper =");
		expect(credential).not.toMatch(/helper\s*=\s*\S/);
	});

	test("commits land on main by default", () => {
		expect(text).toContain("defaultBranch = main");
	});
});

describe("extractRefusals", () => {
	test("returns the full CONFINEMENT_REFUSAL lines in order", () => {
		const stderr = [
			"resolving host gh…",
			"CONFINEMENT_REFUSAL gh: 'gh pr create' — implementers have no GitHub access (R5).",
			"fatal: not a git repository",
			"CONFINEMENT_REFUSAL git: 'git push' is a publish verb (R5).",
		].join("\n");
		expect(extractRefusals(stderr)).toEqual([
			"CONFINEMENT_REFUSAL gh: 'gh pr create' — implementers have no GitHub access (R5).",
			"CONFINEMENT_REFUSAL git: 'git push' is a publish verb (R5).",
		]);
	});

	test("no markers means no refusals", () => {
		expect(extractRefusals("")).toEqual([]);
		expect(extractRefusals("normal stderr\nfatal: bad object")).toEqual([]);
	});

	test("refusals surface from the child's message stream, not just its process stderr", () => {
		// A real pi child's refused subprocess lands in its tool results, not
		// in the child process's own stderr (proven by the L3 smoke, #17).
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "c1",
				content: [
					{
						type: "text",
						text: "CONFINEMENT_REFUSAL git: 'git push' is a publish verb (R5).\n\nCommand exited with code 126",
					},
				],
			},
		] as unknown as Message[];
		expect(extractRefusals("", messages)).toEqual([
			"CONFINEMENT_REFUSAL git: 'git push' is a publish verb (R5).",
		]);
	});

	test("a child narrating its refusals does not duplicate them", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "c1",
				content: [
					{
						type: "text",
						text: "CONFINEMENT_REFUSAL gh: 'gh api user' — refused.",
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Refusal seen:\n`CONFINEMENT_REFUSAL gh: 'gh api user' — refused.`",
					},
				],
			},
		] as unknown as Message[];
		expect(extractRefusals("", messages)).toEqual([
			"CONFINEMENT_REFUSAL gh: 'gh api user' — refused.",
		]);
	});
});

describe("the shim matrix, as subprocesses (L2)", () => {
	let root: string;
	let repo: string;
	let env: NodeJS.ProcessEnv;

	// A confined child's world: allowlisted env + materialized shim, running
	// in a scratch repo. This is the spawn seam's payload, exercised for real.
	const run = (cmd: string[]): ReturnType<typeof spawnSync> =>
		spawnSync(cmd[0] as string, cmd.slice(1), {
			cwd: repo,
			env,
			encoding: "utf8",
		});

	let material: ReturnType<typeof materializeConfinement>;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "confinement-matrix-"));
		material = materializeConfinement(root);
		env = buildConfinedEnv(
			{ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
			material,
		);
		repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		// Parent-side init (the child's first commit must land in its cwd —
		// the pinned gitconfig supplies identity, since HOME has none).
		const init = spawnSync("git", ["init", "-b", "main", repo], {
			encoding: "utf8",
		});
		if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
		fs.writeFileSync(path.join(repo, "work.txt"), "local work\n");
	});

	test("gh is refused in full — no API, no tracker writes", () => {
		for (const argv of [
			["gh", "api", "user"],
			["gh", "issue", "create", "--title", "x"],
			["gh", "pr", "create"],
		]) {
			const result = run(argv);
			expect(result.status).toBe(126);
			expect(result.stderr).toContain("CONFINEMENT_REFUSAL");
		}
	});

	test("git push is refused with a marker", () => {
		const result = run(["git", "push"]);
		expect(result.status).toBe(126);
		expect(result.stderr).toContain("CONFINEMENT_REFUSAL");
	});

	test("a commit lands in the child's cwd", () => {
		expect(run(["git", "add", "."]).status).toBe(0);
		const commit = run(["git", "commit", "-m", "local work only"]);
		expect(commit.status).toBe(0);
		const log = run(["git", "log", "--oneline"]);
		expect(log.stdout).toContain("local work only");
		// The commit was authored through the pin (HOME has no gitconfig of
		// its own): an identity exists and it is whatever the coordinator
		// user's global config names — or the implementer fallback.
		const author = run(["git", "log", "-1", "--format=%an <%ae>"]);
		expect(author.stdout?.trim()).toMatch(/^.+ <.+>$/m);
	});

	test("every refusal the matrix provoked is extractable from stderr", () => {
		const stderr = [run(["gh", "api", "user"]), run(["git", "push"])]
			.map((r) => r.stderr ?? "")
			.join("");
		expect(extractRefusals(stderr)).toHaveLength(2);
	});
});
