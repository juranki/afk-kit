/**
 * Tests for the wait/check background machinery (R8) — ticket afk-kit #16.
 *
 * L1: the decision logic (wait caps, staleness, wall-clock, status mapping,
 * runner recording, cancel guards) runs offline against temp directories.
 * L2: the process-group kill and runner recording run as real subprocesses.
 *
 * The seams follow docs/conventions/code-verify.md: tests swap the
 * environment (PI_SUBAGENT_DIR), never the code.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import {
	buildSubagentArgs,
	cancelGuard,
	checkSubagentText,
	computeWaitMs,
	finalizeScript,
	finalizeStatus,
	initialStatus,
	isStale,
	isWallClockExpired,
	killTaskGroup,
	newSubagentId,
	readRefusals,
	readStatus,
	taskDir,
	terminalFromSignal,
	writeRunner,
	writeStatus,
} from "./background.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-bg-test-"));
	process.env.PI_SUBAGENT_DIR = path.join(tmpRoot, "subagents");
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("task ids", () => {
	test("are timestamp-random and unique", () => {
		const a = newSubagentId();
		const b = newSubagentId();
		expect(a).toMatch(/^[a-z0-9]+-[a-z0-9]{6}$/);
		expect(a).not.toBe(b);
	});
});

describe("the status store", () => {
	test("writes and reads a running record with pid and pgid", () => {
		const id = newSubagentId();
		const record = initialStatus({
			subagentId: id,
			agent: "implementer",
			mode: "single",
			task: "do the thing",
			pid: 4242,
			pgid: 4242,
		});
		writeStatus(record);

		const read = readStatus(id);
		expect(read).not.toBeNull();
		expect(read?.status).toBe("running");
		expect(read?.pid).toBe(4242);
		expect(read?.pgid).toBe(4242);
		expect(read?.task).toBe("do the thing");
		expect(read?.finishedAt).toBeNull();
	});

	test("caps the task text recorded in the status file", () => {
		const id = newSubagentId();
		const record = initialStatus({
			subagentId: id,
			agent: "a",
			mode: "single",
			task: "x".repeat(5000),
			pid: 1,
			pgid: 1,
		});
		expect(record.task.length).toBe(2000);
	});

	test("reading a missing task yields null instead of throwing", () => {
		expect(readStatus("nope-doesnotexist")).toBeNull();
	});

	test("terminal mapping: signal kills resolve to non-success statuses", () => {
		// The fork's seam: SIGKILL -> killed / 137. afk-kit's deliberate
		// terminations carry their own status names.
		expect(terminalFromSignal("SIGKILL")).toEqual({
			exitCode: 137,
			signal: "SIGKILL",
		});
		expect(terminalFromSignal("SIGTERM")).toEqual({
			exitCode: 143,
			signal: "SIGTERM",
		});
		expect(terminalFromSignal(null)).toBeNull();
	});

	test("finalize only claims running tasks — a watchdog kill is not clobbered", () => {
		const id = newSubagentId();
		writeStatus(
			initialStatus({
				subagentId: id,
				agent: "a",
				mode: "single",
				task: "t",
				pid: 1,
				pgid: 1,
			}),
		);
		finalizeStatus(id, {
			status: "killed",
			exitCode: 137,
			errorMessage: "hung",
		});

		// The runner wrapper comes back late reporting exit 1 (failed).
		const applied = finalizeStatus(id, { status: "failed", exitCode: 1 });
		expect(applied).toBe(false);

		const read = readStatus(id);
		expect(read?.status).toBe("killed");
		expect(read?.errorMessage).toBe("hung");
	});

	test("finalize transitions running to done and stamps finishedAt", () => {
		const id = newSubagentId();
		writeStatus(
			initialStatus({
				subagentId: id,
				agent: "a",
				mode: "single",
				task: "t",
				pid: 1,
				pgid: 1,
			}),
		);
		const applied = finalizeStatus(id, { status: "done", exitCode: 0 });
		expect(applied).toBe(true);
		const read = readStatus(id);
		expect(read?.status).toBe("done");
		expect(read?.finishedAt).not.toBeNull();
	});
});

describe("the wait cap", () => {
	test("defaults to 180s of blocking", () => {
		expect(computeWaitMs(undefined)).toEqual({
			kind: "deadline",
			ms: 180_000,
		});
	});
	test("zero means pure background", () => {
		expect(computeWaitMs(0)).toEqual({ kind: "background" });
	});
	test("negative means wait forever", () => {
		expect(computeWaitMs(-1)).toEqual({ kind: "forever" });
	});
	test("a positive value is the per-call cap in seconds", () => {
		expect(computeWaitMs(5)).toEqual({ kind: "deadline", ms: 5_000 });
	});
});

describe("the watchdog decisions", () => {
	test("wall-clock: a task past its budget expires", () => {
		const startedAt = new Date(Date.now() - 10_000).toISOString();
		expect(isWallClockExpired(startedAt, Date.now(), 5_000)).toBe(true);
		expect(isWallClockExpired(startedAt, Date.now(), 60_000)).toBe(false);
	});

	test("staleness: unchanged size and mtime past the threshold is stale", () => {
		const stat = { size: 100, mtimeMs: 1_000 };
		expect(isStale(stat, stat, 1_000 + 300_000, 300_000)).toBe(true);
		expect(isStale(stat, stat, 1_000 + 299_000, 300_000)).toBe(false);
		// New output resets the clock even before mtime granularity notices.
		expect(
			isStale(stat, { size: 200, mtimeMs: 1_000 }, 1_000 + 400_000, 300_000),
		).toBe(false);
	});
});

describe("cancel guards", () => {
	test("only running tasks can be cancelled", () => {
		expect(cancelGuard("running")).toBeNull();
		const refusal = cancelGuard("done");
		expect(refusal).toContain("done");
		const missing = cancelGuard(null);
		expect(missing).toContain("No subagent task found");
	});
});

describe("the runner wrapper", () => {
	test("records done on exit 0 and failed on nonzero exit (subprocess)", async () => {
		for (const [exitCode, expected] of [
			[0, "done"],
			[3, "failed"],
		] as const) {
			const id = newSubagentId();
			writeStatus(
				initialStatus({
					subagentId: id,
					agent: "a",
					mode: "single",
					task: "t",
					pid: 1,
					pgid: 1,
				}),
			);
			const dir = taskDir(id);
			// The wrapper records via finalize.mjs, exactly as spawnBackgroundTask lays it out.
			fs.writeFileSync(path.join(dir, "finalize.mjs"), finalizeScript(), {
				mode: 0o600,
			});
			// Run the wrapper with a command whose exit code we control.
			const script = exitCode === 0 ? "true" : "sh -c 'exit 3'";
			const runner = writeRunner(id, script, process.execPath);

			await new Promise<void>((resolve) => {
				const proc = spawn("bash", [runner], { stdio: "ignore" });
				proc.on("close", () => resolve());
			});

			const read = readStatus(id);
			expect(read?.status).toBe(expected);
			expect(read?.finishedAt).not.toBeNull();
			expect(dir).toContain(id);
		}
	});

	test("killTaskGroup kills the whole detached group (subprocess)", async () => {
		const proc = spawn("bash", ["-c", "sleep 30 & wait"], {
			detached: true,
			stdio: "ignore",
		});
		proc.unref();
		if (!proc.pid) throw new Error("spawn failed");
		const pgid = proc.pid;

		await killTaskGroup(pgid, 50);

		let alive = true;
		try {
			process.kill(-pgid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	});
});

describe("argv assembly (R2 per-agent thinking)", () => {
	const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({
		name: "a",
		description: "d",
		systemPrompt: "",
		source: "user",
		filePath: "/x/a.md",
		...over,
	});

	test("base argv pins json prompt mode with no session", () => {
		expect(buildSubagentArgs(agent(), {})).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
		]);
	});

	test("a per-agent thinking field wins over the dispatch level", () => {
		const args = buildSubagentArgs(agent({ thinking: "high" }), {
			thinkingLevel: "low",
		});
		expect(args).toContain("--thinking");
		expect(args[args.indexOf("--thinking") + 1]).toBe("high");
	});

	test("the dispatch level is the fallback when the agent inherits the dispatch model", () => {
		const args = buildSubagentArgs(agent(), { thinkingLevel: "medium" });
		expect(args[args.indexOf("--thinking") + 1]).toBe("medium");
	});

	test("the dispatch level is NOT inherited when the agent pins its own model", () => {
		const args = buildSubagentArgs(agent({ model: "zai/glm-5.3" }), {
			thinkingLevel: "medium",
		});
		expect(args).not.toContain("--thinking");
		expect(args).toContain("--model");
	});

	test("a per-agent model passes through", () => {
		const args = buildSubagentArgs(agent({ model: "zai/glm-5.3-flash" }), {});
		expect(args[args.indexOf("--model") + 1]).toBe("zai/glm-5.3-flash");
	});

	test("the tools allowlist passes through the --tools argv", () => {
		const args = buildSubagentArgs(agent({ tools: ["read", "bash"] }), {});
		expect(args[args.indexOf("--tools") + 1]).toBe("read,bash");
	});
});

describe("refusal surfacing (R5, #17)", () => {
	test("readRefusals extracts the CONFINEMENT_REFUSAL lines from the task's stderr", () => {
		const id = newSubagentId();
		fs.mkdirSync(taskDir(id), { recursive: true });
		fs.writeFileSync(
			path.join(taskDir(id), "stderr.log"),
			"noise\nCONFINEMENT_REFUSAL gh: 'gh api user' — no access (R5).\nmore noise\nCONFINEMENT_REFUSAL git: 'git push' refused.\n",
		);
		expect(readRefusals(id)).toEqual([
			"CONFINEMENT_REFUSAL gh: 'gh api user' — no access (R5).",
			"CONFINEMENT_REFUSAL git: 'git push' refused.",
		]);
	});

	test("a refused subprocess surfaces from the work history, not the child's stderr", () => {
		// L3 finding (#17): a shim-refused command reaches the child as a bash
		// tool result; the child process's own stderr stays empty.
		const id = newSubagentId();
		fs.mkdirSync(taskDir(id), { recursive: true });
		const toolResult = {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				content: [
					{
						type: "text",
						text: "CONFINEMENT_REFUSAL git: 'git push' is a publish verb (R5).\n\nCommand exited with code 126",
					},
				],
			},
		};
		fs.writeFileSync(
			path.join(taskDir(id), "stdout.jsonl"),
			`${JSON.stringify(toolResult)}\n`,
		);
		expect(readRefusals(id)).toEqual([
			"CONFINEMENT_REFUSAL git: 'git push' is a publish verb (R5).",
		]);
	});

	test("readRefusals is empty without a stderr log", () => {
		expect(readRefusals(newSubagentId())).toEqual([]);
	});

	test("the check text reports refusals as report lines, not errors", () => {
		const id = newSubagentId();
		fs.mkdirSync(taskDir(id), { recursive: true });
		fs.writeFileSync(
			path.join(taskDir(id), "stderr.log"),
			"CONFINEMENT_REFUSAL git: 'git push' is a publish verb (R5).\n",
		);
		const record = initialStatus({
			subagentId: id,
			agent: "implementer",
			agentSource: "user",
			mode: "single",
			task: "t",
			pid: null,
			pgid: null,
		});
		record.status = "done";
		record.exitCode = 0;
		writeStatus(record);
		const { text } = checkSubagentText(id, false);
		expect(text).toContain("Refusals");
		expect(text).toContain(
			"CONFINEMENT_REFUSAL git: 'git push' is a publish verb (R5).",
		);
	});
});
