/**
 * Tests for the `afk` CLI (ticket afk-kit #59): strict argument parsing
 * (L1) and the `afk status` path end-to-end against a real temp state root
 * and a real repository checkout (L2). Exit codes follow the durable spec's
 * CLI contract; status success is 0 and usage errors take 2 (a code status
 * can never collide with: 1 is a pre-Claim refusal, 2 is a claimed Run
 * Escalated, 3 is durable-failure — none reachable from status).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseStatusArgs, runCli } from "./cli.ts";
import { RUN_EVENT_NAMES } from "./runs/events.ts";
import { afkStateRoot } from "./runs/paths.ts";
import { createRun, recordEvent } from "./runs/store.ts";

describe("parseStatusArgs", () => {
	test("accepts no argument — every Run for the repository", () => {
		expect(parseStatusArgs([])).toEqual({});
	});

	test("accepts one bare positive integer", () => {
		expect(parseStatusArgs(["59"])).toEqual({ ticket: 59 });
	});

	test("rejects hashes, URLs, signs, ranges, and extra arguments", () => {
		expect(parseStatusArgs(["#59"])).toBeNull();
		expect(
			parseStatusArgs(["https://github.com/juranki/afk-kit/issues/59"]),
		).toBeNull();
		expect(parseStatusArgs(["-1"])).toBeNull();
		expect(parseStatusArgs(["+59"])).toBeNull();
		expect(parseStatusArgs(["59..60"])).toBeNull();
		expect(parseStatusArgs(["0"])).toBeNull();
		expect(parseStatusArgs(["059"])).toBeNull();
		expect(parseStatusArgs(["59", "60"])).toBeNull();
		expect(parseStatusArgs(["--json"])).toBeNull();
	});
});

function stateRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "afk-cli-"));
}

function checkout(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-cli-repo-"));
	Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
	Bun.spawnSync(
		["git", "remote", "add", "origin", "https://github.com/juranki/afk-kit"],
		{
			cwd: dir,
		},
	);
	return dir;
}

function io(cwd: string, env: NodeJS.ProcessEnv = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		io: {
			cwd,
			env: { ...env },
			stdout: (s: string) => out.push(s),
			stderr: (s: string) => err.push(s),
		},
	};
}

describe("runCli status", () => {
	test("renders every Run for the current repository", async () => {
		const xdg = stateRoot();
		const cwd = checkout();
		const run = createRun({
			stateRoot: afkStateRoot({ XDG_STATE_HOME: xdg }),
			owner: "juranki",
			repo: "afk-kit",
			ticket: 59,
			brief: "brief",
		});
		acquireHeld(run);

		const { io: cliIo, out } = io(cwd, { XDG_STATE_HOME: xdg });
		const exit = await runCli(["status"], cliIo);
		expect(exit).toBe(0);
		const text = out.join("");
		expect(text).toContain("ACTIVE");
		expect(text).toContain("#59");
		expect(text).toContain("github.com/juranki/afk-kit");
	});

	test("renders one Ticket when given its number", async () => {
		const xdg = stateRoot();
		const cwd = checkout();
		const repoState = afkStateRoot({ XDG_STATE_HOME: xdg });
		createRun({
			stateRoot: repoState,
			owner: "juranki",
			repo: "afk-kit",
			ticket: 59,
			brief: "b",
		});
		createRun({
			stateRoot: repoState,
			owner: "juranki",
			repo: "afk-kit",
			ticket: 51,
			brief: "b",
		});

		const { io: cliIo, out } = io(cwd, { XDG_STATE_HOME: xdg });
		const exit = await runCli(["status", "51"], cliIo);
		expect(exit).toBe(0);
		const text = out.join("");
		expect(text).toContain("ticket 51");
		expect(text).toContain("#51");
		expect(text).not.toContain("#59");
	});

	test("usage errors exit 2 with help on stderr", async () => {
		const cwd = checkout();
		const bad = io(cwd);
		expect(await runCli(["status", "abc"], bad.io)).toBe(2);
		expect(bad.err.join("")).toContain("usage");

		const unknown = io(cwd);
		expect(await runCli(["implement"], unknown.io)).toBe(2);
		expect(unknown.err.join("")).toContain("usage");

		const none = io(cwd);
		expect(await runCli([], none.io)).toBe(2);
	});

	test("help exits 0 and prints usage", async () => {
		const { io: cliIo, out } = io(checkout());
		expect(await runCli(["help"], cliIo)).toBe(0);
		expect(out.join("")).toContain("usage");
	});

	test("an empty state root still renders, exit 0", async () => {
		const root = stateRoot();
		const { io: cliIo, out } = io(checkout(), { XDG_STATE_HOME: root });
		const exit = await runCli(["status"], cliIo);
		expect(exit).toBe(0);
		expect(out.join("")).toContain("no runs");
	});

	test("a checkout without GitHub origin fails with a diagnostic, exit 3", async () => {
		const xdg = stateRoot();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-cli-nogit-"));
		const { io: cliIo, err } = io(dir, { XDG_STATE_HOME: xdg });
		const exit = await runCli(["status"], cliIo);
		expect(exit).toBe(3);
		expect(err.join("")).toContain("origin");
	});
});

/** Hold a lock from this live process so the run counts as active. */
function acquireHeld(handle: Parameters<typeof recordEvent>[0]): void {
	// direct write keeps the test independent of lock plumbing details
	fs.writeFileSync(
		handle.lockPath,
		JSON.stringify({
			pid: process.pid,
			token: "held",
			startedAt: "2026-09-27T12:00:00Z",
		}),
		{ mode: 0o600 },
	);
	recordEvent(handle, {
		name: RUN_EVENT_NAMES.cycleStarted,
		payload: { cycle: 1 },
		cycle: 1,
	});
}
