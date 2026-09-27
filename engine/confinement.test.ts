import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	compileConfinementConfig,
	createTaskConfinement,
} from "./confinement.ts";

function scratchWorktree(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "afk-confinement-"));
}

describe("compileConfinementConfig", () => {
	test("compiles task write paths and domains into an allow-only policy", () => {
		const worktree = scratchWorktree();
		fs.mkdirSync(path.join(worktree, "src"));
		fs.mkdirSync(path.join(worktree, "tests"));

		const config = compileConfinementConfig({
			worktree,
			writablePaths: ["src", "tests"],
			allowedDomains: ["registry.npmjs.org", "api.github.com"],
		});

		expect(config.filesystem.allowWrite).toEqual([
			path.join(worktree, "src"),
			path.join(worktree, "tests"),
		]);
		expect(config.network).toMatchObject({
			allowedDomains: ["registry.npmjs.org", "api.github.com"],
			deniedDomains: [],
			strictAllowlist: true,
		});
		expect(config.filesystem.denyRead).toContain(
			path.join(os.homedir(), ".ssh"),
		);
		expect(config.filesystem.denyRead).toContain(path.join(worktree, ".env"));
	});

	test("deduplicates allowlists without broadening them", () => {
		const worktree = scratchWorktree();
		const config = compileConfinementConfig({
			worktree,
			writablePaths: [".", "."],
			allowedDomains: ["api.github.com", "api.github.com"],
		});

		expect(config.filesystem.allowWrite).toEqual([worktree]);
		expect(config.network.allowedDomains).toEqual(["api.github.com"]);
	});

	test("rejects write access outside the task worktree", () => {
		const worktree = scratchWorktree();
		expect(() =>
			compileConfinementConfig({
				worktree,
				writablePaths: ["../escape"],
				allowedDomains: [],
			}),
		).toThrow("inside the worktree");
		expect(() =>
			compileConfinementConfig({
				worktree,
				writablePaths: ["/tmp/escape"],
				allowedDomains: [],
			}),
		).toThrow("relative");
	});

	test("fails closed on invalid domain patterns", () => {
		const worktree = scratchWorktree();
		expect(() =>
			compileConfinementConfig({
				worktree,
				writablePaths: ["."],
				allowedDomains: ["https://api.github.com/path"],
			}),
		).toThrow("Invalid confinement needs");
	});
});

interface RuntimeCall {
	command: string;
	customConfig: unknown;
	commandId: string | undefined;
}

function fakeRuntime() {
	const calls: RuntimeCall[] = [];
	let initializedWith: unknown;
	let reset = false;
	return {
		calls,
		get initializedWith() {
			return initializedWith;
		},
		get reset() {
			return reset;
		},
		port: {
			initialize: async (config: unknown, _ask: unknown, monitor: boolean) => {
				expect(monitor).toBe(true);
				initializedWith = config;
			},
			wrapWithSandbox: async (
				command: string,
				_shell: string | undefined,
				customConfig: unknown,
				_signal: AbortSignal | undefined,
				options: { commandId?: string } | undefined,
			) => {
				calls.push({ command, customConfig, commandId: options?.commandId });
				return command;
			},
			annotateStderrWithSandboxFailures: (_id: string, output: string) =>
				output,
			cleanupAfterCommand: () => {},
			reset: async () => {
				reset = true;
			},
		},
	};
}

describe("task confinement at the process seam (L2)", () => {
	test("initializes once and wraps every real shell spawn", async () => {
		const worktree = scratchWorktree();
		const runtime = fakeRuntime();
		const confinement = await createTaskConfinement(
			{
				worktree,
				writablePaths: ["."],
				allowedDomains: [],
			},
			{ runtime: runtime.port },
		);

		let output = "";
		const result = await confinement.operations.exec(
			"printf first && printf second > spawned.txt",
			worktree,
			{
				onData: (chunk) => {
					output += chunk.toString();
				},
				env: { ...process.env, GH_TOKEN: "must-not-reach-child" },
			},
		);

		expect(result.exitCode).toBe(0);
		expect(output).toBe("first");
		expect(fs.readFileSync(path.join(worktree, "spawned.txt"), "utf8")).toBe(
			"second",
		);
		expect(runtime.initializedWith).toEqual(confinement.config);
		expect(runtime.calls).toHaveLength(1);
		expect(runtime.calls[0]?.command).toContain("printf first");
		expect(runtime.calls[0]?.customConfig).toBeUndefined();
		expect(runtime.calls[0]?.commandId).toMatch(/^afk-bash-1-/);

		await confinement.dispose();
		expect(runtime.reset).toBe(true);
	});

	test("strips credentials from the wrapped process environment", async () => {
		const worktree = scratchWorktree();
		const runtime = fakeRuntime();
		let delegatedEnv: NodeJS.ProcessEnv | undefined;
		const delegate: BashOperations = {
			exec: async (_command, _cwd, options) => {
				delegatedEnv = options.env;
				return { exitCode: 0 };
			},
		};
		const confinement = await createTaskConfinement(
			{
				worktree,
				writablePaths: ["."],
				allowedDomains: [],
			},
			{ runtime: runtime.port, delegate },
		);

		await confinement.operations.exec("true", worktree, {
			onData: () => {},
			env: {
				PATH: "/usr/bin:/bin",
				HOME: "/home/test",
				LANG: "C.UTF-8",
				GH_TOKEN: "secret",
				GITHUB_TOKEN: "secret",
				ANTHROPIC_API_KEY: "secret",
				SSH_AUTH_SOCK: "/tmp/agent.sock",
				BASH_ENV: "/tmp/inject.sh",
			},
		});

		expect(delegatedEnv).toMatchObject({
			PATH: "/usr/bin:/bin",
			HOME: "/home/test",
			LANG: "C.UTF-8",
		});
		expect(delegatedEnv?.GH_TOKEN).toBeUndefined();
		expect(delegatedEnv?.GITHUB_TOKEN).toBeUndefined();
		expect(delegatedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(delegatedEnv?.SSH_AUTH_SOCK).toBeUndefined();
		expect(delegatedEnv?.BASH_ENV).toBeUndefined();
	});

	test("refuses a spawn whose cwd escapes the worktree before wrapping it", async () => {
		const worktree = scratchWorktree();
		const runtime = fakeRuntime();
		const confinement = await createTaskConfinement(
			{
				worktree,
				writablePaths: ["."],
				allowedDomains: [],
			},
			{ runtime: runtime.port },
		);

		await expect(
			confinement.operations.exec("true", path.dirname(worktree), {
				onData: () => {},
			}),
		).rejects.toThrow("outside the task worktree");
		expect(runtime.calls).toHaveLength(0);
	});
});
