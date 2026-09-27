/**
 * L2 seam-integration tests for the deterministic Verify runner (ticket
 * afk-kit #62, durable spec #46): every command runs sequentially through
 * `bash -lc` in the worktree, stops at the first failure or its 15-minute
 * cap, executes without GitHub credentials, and stores complete stdout,
 * stderr, command metadata, exit status, and timeout evidence. The
 * environment is swapped, never the code — these are real bash
 * subprocesses (code-verify standard, L2).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FEEDBACK_TAIL_CHARS,
	formatVerifyFeedback,
	runVerifyCommands,
	type VerifyCommandEvidence,
} from "./verify.ts";

function scratchWorktree(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "afk-verify-"));
}

describe("runVerifyCommands", () => {
	test("runs every command sequentially and stops at the first failure", async () => {
		const worktree = scratchWorktree();
		const evidence = path.join(worktree, "..", "verify-evidence");
		const outcome = await runVerifyCommands({
			commands: [
				"echo one > ran-1",
				"test -f ran-1 && echo two > ran-2",
				"exit 3",
				"echo three > ran-3",
			],
			worktree,
			evidenceDir: evidence,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.results).toHaveLength(3);
		expect(outcome.results.map((r) => r.ok)).toEqual([true, true, false]);
		expect(fs.existsSync(path.join(worktree, "ran-3"))).toBe(false);
		// Sequential: ran-2 exists only because ran-1 ran first.
		expect(fs.existsSync(path.join(worktree, "ran-2"))).toBe(true);
	});

	test("stores complete streams, metadata, exit status, and timeout facts", async () => {
		const worktree = scratchWorktree();
		const evidence = path.join(worktree, "..", "verify-evidence");
		const outcome = await runVerifyCommands({
			commands: ["printf 'out-1\\nout-2\\n'; printf 'err-1\\n' >&2"],
			worktree,
			evidenceDir: evidence,
		});
		expect(outcome.ok).toBe(true);
		const result = outcome.results[0];
		if (!result) throw new Error("missing result");
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.stdout).toBe("out-1\nout-2\n");
		expect(result.stderr).toBe("err-1\n");
		const dir = result.evidenceDir;
		expect(fs.readFileSync(path.join(dir, "stdout"), "utf8")).toBe(
			"out-1\nout-2\n",
		);
		expect(fs.readFileSync(path.join(dir, "stderr"), "utf8")).toBe("err-1\n");
		const meta = JSON.parse(
			fs.readFileSync(path.join(dir, "command.json"), "utf8"),
		) as Record<string, unknown>;
		expect(meta).toMatchObject({
			command: result.command,
			ok: true,
			exitCode: 0,
			timedOut: false,
		});
	});

	test("runs without GitHub credentials and with a working PATH", async () => {
		const worktree = scratchWorktree();
		const parent = {
			...process.env,
			GH_TOKEN: "secret-gh",
			GITHUB_TOKEN: "secret-github",
		} as NodeJS.ProcessEnv;
		const outcome = await runVerifyCommands({
			commands: [
				'test -z "$GH_TOKEN"',
				'test -z "$GITHUB_TOKEN"',
				"command -v bun >/dev/null",
			],
			worktree,
			evidenceDir: path.join(worktree, "..", "verify-evidence"),
			env: parent,
		});
		expect(outcome.ok).toBe(true);
	});

	test("a command past its cap is killed, recorded as a timeout, and stops the run", async () => {
		const worktree = scratchWorktree();
		const outcome = await runVerifyCommands({
			commands: ["sleep 30", "echo never > ran-2"],
			worktree,
			evidenceDir: path.join(worktree, "..", "verify-evidence"),
			capMs: 150,
		});
		expect(outcome.ok).toBe(false);
		const result = outcome.results[0];
		if (!result) throw new Error("missing result");
		expect(result.timedOut).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBeNull();
		expect(result.durationMs).toBeLessThan(10_000);
		expect(fs.existsSync(path.join(worktree, "ran-2"))).toBe(false);
	});

	test("evidence directories are numbered in execution order", async () => {
		const worktree = scratchWorktree();
		const outcome = await runVerifyCommands({
			commands: ["true", "false"],
			worktree,
			evidenceDir: path.join(worktree, "..", "verify-evidence"),
		});
		expect(outcome.results[0]?.evidenceDir.endsWith("01-true")).toBe(true);
		expect(outcome.results[1]?.evidenceDir.endsWith("02-false")).toBe(true);
	});
});

describe("formatVerifyFeedback (pure)", () => {
	const longOutput = `HEAD-${"x".repeat(FEEDBACK_TAIL_CHARS + 500)}-TAIL`;

	function evidence(
		overrides: Partial<VerifyCommandEvidence> = {},
	): VerifyCommandEvidence {
		return {
			command: "bun test",
			ok: false,
			exitCode: 1,
			timedOut: false,
			startedAt: "2026-09-27T00:00:00.000Z",
			durationMs: 1_234,
			stdout: "",
			stderr: "",
			evidenceDir: "/tmp/evidence/01-bun-test",
			...overrides,
		};
	}

	test("carries the command metadata and the final tail of each stream", () => {
		const feedback = formatVerifyFeedback([
			evidence({
				stdout: longOutput,
				stderr: `${"e".repeat(FEEDBACK_TAIL_CHARS + 10)}ERRTAIL`,
			}),
		]);
		expect(feedback).toContain("`bun test`");
		expect(feedback).toContain("exit 1");
		expect(feedback).toContain("0 timeouts");
		expect(feedback).toContain("-TAIL");
		expect(feedback).toContain("ERRTAIL");
		expect(feedback).not.toContain("HEAD-");
	});

	test("a timeout is named in the feedback", () => {
		const feedback = formatVerifyFeedback([
			evidence({ timedOut: true, exitCode: null, ok: false }),
		]);
		expect(feedback).toContain("timed out");
	});

	test("passing commands are listed but contribute no streams", () => {
		const feedback = formatVerifyFeedback([
			evidence({ ok: true, exitCode: 0 }),
		]);
		expect(feedback).toContain("pass");
		expect(feedback).not.toContain("--- stdout");
	});
});
