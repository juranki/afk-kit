/**
 * The deterministic Verify runner (ticket afk-kit #62, durable spec #46):
 * the brief's verify commands are the only currency of done, so they run
 * exactly as declared — independently and sequentially through `bash -lc`
 * in the worktree, stopping at the first failure or the 15-minute cap,
 * without GitHub credentials in the environment. Every run stores complete
 * stdout, stderr, command metadata, exit status, and timeout evidence;
 * nothing about a verify command is ever discarded or summarized away.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** One verify command's wall-clock cap (durable spec #46). */
const VERIFY_COMMAND_CAP_MS = 15 * 60 * 1000;

/** How much of each stream the bounded failed-cycle feedback carries. */
export const FEEDBACK_TAIL_CHARS = 20_000;

/** The environment one verify command may see — no GitHub credentials. */
const VERIFY_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	"TERM",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
] as const;

/** Complete evidence for one verify command's execution. */
export interface VerifyCommandEvidence {
	command: string;
	ok: boolean;
	/** Process exit status; null when the command was killed at its cap. */
	exitCode: number | null;
	timedOut: boolean;
	/** ISO 8601 UTC timestamp of the command's start. */
	startedAt: string;
	durationMs: number;
	/** Complete stream contents, as executed. */
	stdout: string;
	stderr: string;
	/** Directory holding command.json, stdout, and stderr. */
	evidenceDir: string;
}

export interface VerifyRunOutcome {
	/** True only when every executed command passed. */
	ok: boolean;
	/** Evidence in execution order; stops at the first failure. */
	results: VerifyCommandEvidence[];
}

export interface RunVerifyCommandsOptions {
	commands: string[];
	/** The worktree the commands run in. */
	worktree: string;
	/** Directory the per-command evidence directories are created under. */
	evidenceDir: string;
	/** Per-command cap; defaults to the durable spec's 15 minutes. */
	capMs?: number;
	/** Parent environment to scrub; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
}

/** Credential-free environment for one verify command. */
function verifyEnvironment(
	parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of VERIFY_ENV_ALLOWLIST) {
		const value = parent[name];
		if (value !== undefined && value !== "") env[name] = value;
	}
	return env;
}

/** A filesystem-safe slug for one command, stable and bounded. */
function slugFor(command: string): string {
	const slug = command
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug === "" ? "command" : slug;
}

/** Single-quote a value for safe interpolation into a shell wrapper. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runOne(options: {
	command: string;
	index: number;
	worktree: string;
	evidenceDir: string;
	capMs: number;
	env: NodeJS.ProcessEnv;
}): Promise<VerifyCommandEvidence> {
	const { command, index, worktree, evidenceDir, capMs, env } = options;
	const dir = path.join(
		evidenceDir,
		`${String(index).padStart(2, "0")}-${slugFor(command)}`,
	);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

	const startedAt = new Date();
	const started = startedAt.toISOString();
	const startedMs = startedAt.getTime();

	const child = spawn(
		"bash",
		// Login shells re-run profile init, which resets PATH on many hosts;
		// pin the scrubbed PATH before the declared command, which runs
		// verbatim after it.
		["-lc", `PATH=${shellQuote(env.PATH ?? "")}; export PATH; ${command}`],
		{
			cwd: worktree,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let exitCode: number | null = null;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, capMs);
	try {
		[child.stdout, child.stderr].forEach((stream, which) => {
			stream.on("data", (chunk: Buffer) => {
				if (which === 0) stdout += chunk.toString();
				else stderr += chunk.toString();
			});
		});
		exitCode = await new Promise<number | null>((resolve) => {
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});
	} finally {
		clearTimeout(timer);
	}
	const durationMs = Date.now() - startedMs;
	if (timedOut) exitCode = null;

	const evidence: VerifyCommandEvidence = {
		command,
		ok: !timedOut && exitCode === 0,
		exitCode,
		timedOut,
		startedAt: started,
		durationMs,
		stdout,
		stderr,
		evidenceDir: dir,
	};
	writeEvidence(evidence);
	return evidence;
}

function writeEvidence(evidence: VerifyCommandEvidence): void {
	fs.writeFileSync(path.join(evidence.evidenceDir, "stdout"), evidence.stdout, {
		mode: 0o600,
	});
	fs.writeFileSync(path.join(evidence.evidenceDir, "stderr"), evidence.stderr, {
		mode: 0o600,
	});
	const meta = {
		command: evidence.command,
		ok: evidence.ok,
		exitCode: evidence.exitCode,
		timedOut: evidence.timedOut,
		startedAt: evidence.startedAt,
		durationMs: evidence.durationMs,
	};
	fs.writeFileSync(
		path.join(evidence.evidenceDir, "command.json"),
		`${JSON.stringify(meta, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

/**
 * Run the verify commands sequentially through `bash -lc`, stopping at the
 * first failure or cap. Each executed command's complete evidence lands
 * under the evidence directory, numbered in execution order.
 */
export async function runVerifyCommands(
	options: RunVerifyCommandsOptions,
): Promise<VerifyRunOutcome> {
	const capMs = options.capMs ?? VERIFY_COMMAND_CAP_MS;
	const env = verifyEnvironment(options.env);
	fs.mkdirSync(options.evidenceDir, { recursive: true, mode: 0o700 });
	const results: VerifyCommandEvidence[] = [];
	for (const [index, command] of options.commands.entries()) {
		const evidence = await runOne({
			command,
			index: index + 1,
			worktree: options.worktree,
			evidenceDir: options.evidenceDir,
			capMs,
			env,
		});
		results.push(evidence);
		if (!evidence.ok) break;
	}
	return { ok: results.every((r) => r.ok), results };
}

function tail(text: string): string {
	return text.length > FEEDBACK_TAIL_CHARS
		? text.slice(-FEEDBACK_TAIL_CHARS)
		: text;
}

function streamSection(label: string, text: string): string {
	return [`--- ${label} (last ${FEEDBACK_TAIL_CHARS} chars) ---`, tail(text)];
}

/**
 * Bounded failed-cycle feedback: command metadata plus the final 20,000
 * characters of each stream, per executed command. This is what the next
 * fresh Implementer sees of a failed verify — never the full streams.
 */
export function formatVerifyFeedback(results: VerifyCommandEvidence[]): string {
	const lines: string[] = [];
	for (const result of results) {
		const how = result.timedOut
			? `timed out after ${String(result.durationMs)}ms, 1 timeout`
			: `exit ${String(result.exitCode)}, 0 timeouts`;
		lines.push(
			`Verify command \`${result.command}\` ${result.ok ? "pass" : "failed"} (${how}).`,
			`Evidence: ${result.evidenceDir}`,
		);
		if (result.ok) continue;
		lines.push(...streamSection("stdout", result.stdout));
		lines.push(...streamSection("stderr", result.stderr));
	}
	return lines.join("\n");
}
