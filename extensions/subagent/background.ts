/**
 * The wait/check background machinery (ADR 0007, R8) — afk-kit's hardening of
 * the vendored subagent example.
 *
 * Adapted from the pattern proven by the pi-subagent-tool fork (MIT, see
 * docs/research/pi-subagent-wait-check.md), with what the fork lacked added
 * here: the child-pid/pgid record kill-by-id needs, a per-task wall-clock cap
 * bounding the child's lifetime (not just the coordinator's call), hang-watchdog
 * coverage on the detached background path, and cancel (kill by id).
 *
 * Task lifecycle (persisted in <taskDir>/status.json):
 *
 *   running ──exit 0──▶ done
 *      ├──exit ≠ 0────▶ failed      (recorded by the runner wrapper, even if
 *      ├──SIGTERM──────▶ cancelled   the parent session is gone)
 *      ├──SIGKILL──────▶ killed     (hang watchdog)
 *      └──budget───────▶ timeout    (wall-clock cap)
 *
 * Call lifecycle (how long one subagent tool call blocks):
 *
 *   dispatch ──▶ polling status.json
 *                  ├─ terminal ─────▶ return final result
 *                  └─ wait cap hit ─▶ return {status:"running", subagentId}
 *   wait: 0 / background: true ─────▶ return {status:"running", subagentId} now
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

// ── Tunables (env-overridable; docs/conventions and the README document them) ──
// Read lazily on every use, never cached at module load: tests and wrappers
// retune behavior by swapping the environment, not the code.

const envMs = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const waitDefaultSeconds = () => envMs("PI_SUBAGENT_WAIT_S", 180);
export function pollIntervalMs(): number {
	return envMs("PI_SUBAGENT_POLL_MS", 500);
}
const watchdogIntervalMs = () => envMs("PI_SUBAGENT_WATCHDOG_MS", 5000);
const staleTimeoutMs = () => envMs("PI_SUBAGENT_STALE_MS", 300_000);
const taskMaxLifetimeMs = () => envMs("PI_SUBAGENT_MAX_MS", 1_800_000);
const termGraceMs = () => envMs("PI_SUBAGENT_TERM_GRACE_MS", 5000);
const TASK_TEXT_CAP = 2000;

// ── Ids and the status store ──

export type SubagentTaskStatus =
	| "running"
	| "done"
	| "failed"
	| "cancelled"
	| "timeout"
	| "killed";

export interface SubagentStatusRecord {
	subagentId: string;
	agent: string;
	agentSource: "user" | "project";
	mode: "single" | "parallel";
	step?: number;
	task: string;
	status: SubagentTaskStatus;
	startedAt: string;
	pid: number | null;
	pgid: number | null;
	exitCode: number | null;
	errorMessage: string | null;
	finishedAt: string | null;
}

export function newSubagentId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
	return `${ts}-${rand}`;
}

function subagentDir(): string {
	return process.env.PI_SUBAGENT_DIR ?? path.join(getAgentDir(), "subagents");
}

export function taskDir(id: string): string {
	return path.join(subagentDir(), id);
}

function statusPath(id: string): string {
	return path.join(taskDir(id), "status.json");
}

function atomicWriteSync(filePath: string, content: string): void {
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmp, filePath);
}

export function initialStatus(input: {
	subagentId: string;
	agent: string;
	agentSource: "user" | "project";
	mode: "single" | "parallel";
	step?: number;
	task: string;
	pid: number | null;
	pgid: number | null;
}): SubagentStatusRecord {
	return {
		subagentId: input.subagentId,
		agent: input.agent,
		agentSource: input.agentSource,
		mode: input.mode,
		...(input.step !== undefined ? { step: input.step } : {}),
		task:
			input.task.length > TASK_TEXT_CAP
				? input.task.slice(0, TASK_TEXT_CAP)
				: input.task,
		status: "running",
		startedAt: new Date().toISOString(),
		pid: input.pid,
		pgid: input.pgid,
		exitCode: null,
		errorMessage: null,
		finishedAt: null,
	};
}

export function writeStatus(record: SubagentStatusRecord): void {
	fs.mkdirSync(taskDir(record.subagentId), { recursive: true });
	atomicWriteSync(
		statusPath(record.subagentId),
		JSON.stringify(record, null, "\t"),
	);
}

export function readStatus(id: string): SubagentStatusRecord | null {
	try {
		return JSON.parse(
			fs.readFileSync(statusPath(id), "utf-8"),
		) as SubagentStatusRecord;
	} catch {
		return null;
	}
}

/**
 * Map a death signal to the exit code and signal a terminal record carries.
 * The fork's seam: SIGKILL → killed / 137. Returns null for a natural exit.
 */
export function terminalFromSignal(
	signal: string | null,
): { exitCode: number; signal: string } | null {
	if (!signal) return null;
	const num = (os.constants.signals as Record<string, number>)[signal] ?? 15;
	return { exitCode: 128 + num, signal };
}

/**
 * Record a terminal state. Only a task still `running` is claimed, so a
 * watchdog kill or a coordinator cancel is never clobbered by the runner
 * wrapper reporting the killed child's exit code afterwards.
 */
export function finalizeStatus(
	id: string,
	terminal: {
		status: SubagentTaskStatus;
		exitCode: number;
		errorMessage?: string;
	},
): boolean {
	const record = readStatus(id);
	if (record?.status !== "running") return false;
	record.status = terminal.status;
	record.exitCode = terminal.exitCode;
	if (terminal.errorMessage) record.errorMessage = terminal.errorMessage;
	record.finishedAt = new Date().toISOString();
	writeStatus(record);
	return true;
}

// ── The call's wait cap ──

export type WaitPlan =
	| { kind: "background" }
	| { kind: "forever" }
	| { kind: "deadline"; ms: number };

export function computeWaitMs(wait: number | undefined): WaitPlan {
	if (wait === undefined)
		return { kind: "deadline", ms: waitDefaultSeconds() * 1000 };
	if (wait <= 0)
		return wait === 0 ? { kind: "background" } : { kind: "forever" };
	return { kind: "deadline", ms: wait * 1000 };
}

// ── The watchdog's decisions (pure; the interval loop only executes them) ──

export function isWallClockExpired(
	startedAt: string,
	now: number,
	maxMs: number,
): boolean {
	const start = Date.parse(startedAt);
	if (Number.isNaN(start)) return false;
	return now - start >= maxMs;
}

export interface OutputStat {
	size: number;
	mtimeMs: number;
}

export function isStale(
	stat: OutputStat,
	last: OutputStat,
	now: number,
	staleMs: number,
): boolean {
	if (stat.size !== last.size || stat.mtimeMs !== last.mtimeMs) return false;
	return now - stat.mtimeMs >= staleMs;
}

function statOutput(filePath: string): OutputStat | null {
	try {
		const st = fs.statSync(filePath);
		return { size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	}
}

// ── Cancel ──

/** Guard for kill-by-id: only a live task can be cancelled. */
export function cancelGuard(status: SubagentTaskStatus | null): string | null {
	if (status === null)
		return `No subagent task found for that id (status file missing).`;
	if (status !== "running")
		return `Task already finished with status "${status}"; nothing to cancel.`;
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill a detached task's whole process group: SIGTERM first, SIGKILL for
 * survivors after the grace period. The child leads its own group (detached
 * spawn), so this reaches both the runner wrapper and the pi grandchild.
 */
export async function killTaskGroup(
	pgid: number,
	graceMs = termGraceMs(),
): Promise<void> {
	try {
		process.kill(-pgid, "SIGTERM");
	} catch {
		return; // group already gone
	}
	await sleep(graceMs);
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

// ── The runner wrapper: completion recorded even if the parent is gone ──

function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * The bash wrapper around the child invocation. On exit it records done/failed
 * via finalize.mjs (written by spawnBackgroundTask), guarded so it never
 * clobbers a terminal status the watchdog or a cancel already wrote.
 */
function runnerScript(id: string, inner: string, runtime: string): string {
	const dir = taskDir(id);
	return [
		"#!/usr/bin/env bash",
		inner,
		"code=$?",
		`"${runtime}" "${path.join(dir, "finalize.mjs")}" "${id}" "$code" "${dir}" >> "${path.join(dir, "finalize.log")}" 2>&1`,
		"exit $code",
		"",
	].join("\n");
}

export function writeRunner(
	id: string,
	inner: string,
	runtime: string,
): string {
	const dir = taskDir(id);
	fs.mkdirSync(dir, { recursive: true });
	const runner = path.join(dir, "runner.sh");
	fs.writeFileSync(runner, runnerScript(id, inner, runtime), { mode: 0o755 });
	return runner;
}

export function finalizeScript(): string {
	return [
		`import { readFileSync, renameSync, writeFileSync } from "node:fs";`,
		`const statusPath = process.argv[4] + "/status.json";`,
		`try {`,
		`  const rec = JSON.parse(readFileSync(statusPath, "utf8"));`,
		`  if (rec.status !== "running") process.exit(0);`,
		`  const code = Number(process.argv[3]);`,
		`  rec.status = code === 0 ? "done" : "failed";`,
		`  rec.exitCode = code;`,
		`  rec.finishedAt = new Date().toISOString();`,
		`  const tmp = statusPath + ".tmp";`,
		`  writeFileSync(tmp, JSON.stringify(rec, null, "\\t"));`,
		`  renameSync(tmp, statusPath);`,
		`} catch {}`,
		"",
	].join("\n");
}

// ── Argv assembly, shared by the foreground (chain) and background paths ──

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Assemble the child pi argv. R2: a `thinking` frontmatter field wins;
 * the dispatch-level thinking level stays the fallback, inherited only when
 * the agent also inherits the dispatch model (a pinned model may not support
 * the dispatch session's thinking level).
 */
export function buildSubagentArgs(
	agent: AgentConfig,
	defaults: DispatchDefaults,
): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? defaults.model;
	if (model) args.push("--model", model);
	const thinking =
		agent.thinking ??
		(inheritsDispatchConfig ? defaults.thinkingLevel : undefined);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools && agent.tools.length > 0)
		args.push("--tools", agent.tools.join(","));
	return args;
}

/** Resolve how to invoke pi from inside this process (vendored logic). */
export function getPiInvocation(args: string[]): {
	command: string;
	args: string[];
} {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ── Spawning a detached background task ──

interface TrackedTask {
	id: string;
	pgid: number;
	startedAt: string;
	stdoutPath: string;
	stderrPath: string;
	agent: string;
	lastStat: OutputStat | null;
}

const tracked = new Map<string, TrackedTask>();
// Ids being deliberately terminated (cancel, wall-clock, watchdog). The
// spawned proc's exit handler must not claim these — the killer records
// the terminal status itself (cancelled / timeout / killed).
const deliberateKills = new Set<string>();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let notifier: ((text: string) => void) | null = null;

export function setCompletionNotifier(fn: (text: string) => void): void {
	notifier = fn;
}

function notify(text: string): void {
	try {
		notifier?.(text);
	} catch {
		/* the UI is best-effort */
	}
}

function untrackAndNotify(id: string, record: SubagentStatusRecord): void {
	tracked.delete(id);
	notify(`Subagent "${record.agent}" (${id}) finished: ${record.status}`);
}

async function expireTask(
	task: TrackedTask,
	status: SubagentTaskStatus,
	errorMessage: string,
	exitCode: number,
) {
	deliberateKills.add(task.id);
	await killTaskGroup(task.pgid);
	finalizeStatus(task.id, { status, exitCode, errorMessage });
	deliberateKills.delete(task.id);
	const record = readStatus(task.id);
	if (record) untrackAndNotify(task.id, record);
	else tracked.delete(task.id);
}

function watchTick(): void {
	const now = Date.now();
	for (const task of Array.from(tracked.values())) {
		const record = readStatus(task.id);
		if (!record) continue;
		if (record.status !== "running") {
			untrackAndNotify(task.id, record);
			continue;
		}
		// Wall-clock cap: bounds the task's lifetime, not just a call's wait.
		if (isWallClockExpired(record.startedAt, now, taskMaxLifetimeMs())) {
			void expireTask(
				task,
				"timeout",
				`wall-clock cap of ${Math.round(taskMaxLifetimeMs() / 1000)}s exceeded, killed by watchdog`,
				terminalFromSignal("SIGTERM")?.exitCode ?? 143,
			);
			continue;
		}
		// Hang watchdog on the detached background path: no new child output
		// (stdout.jsonl size/mtime) for STALE_TIMEOUT_MS → SIGKILL the group.
		const stat = statOutput(task.stdoutPath);
		if (!stat) continue;
		if (task.lastStat && isStale(stat, task.lastStat, now, staleTimeoutMs())) {
			void expireTask(
				task,
				"killed",
				`subagent hung: no output for ${Math.round(staleTimeoutMs() / 1000)}s, killed by watchdog`,
				terminalFromSignal("SIGKILL")?.exitCode ?? 137,
			);
			continue;
		}
		task.lastStat = stat;
	}
}

function ensureWatchdog(): void {
	if (watchdogTimer) return;
	watchdogTimer = setInterval(() => {
		watchTick();
		if (tracked.size === 0) {
			clearInterval(watchdogTimer);
			watchdogTimer = null;
		}
	}, watchdogIntervalMs());
	watchdogTimer.unref?.();
}

export interface SpawnBackgroundInput {
	agent: AgentConfig;
	dispatchDefaults: DispatchDefaults;
	mode: "single" | "parallel";
	step?: number;
	task: string;
	cwd: string;
}

export interface SpawnedTask {
	id: string;
	pgid: number;
	record: SubagentStatusRecord;
}

/**
 * Spawn one detached background task: a bash runner wrapping the child pi
 * process. The child leads its own process group (detached), so a later
 * cancel can kill the wrapper and the pi grandchild together. The task's
 * dir keeps the full record: status.json, stdout.jsonl, stderr.log,
 * prompt.md, system-prompt.md, runner.sh, finalize.log.
 */
export function spawnBackgroundTask(input: SpawnBackgroundInput): SpawnedTask {
	const { agent } = input;
	const id = newSubagentId();
	const dir = taskDir(id);
	fs.mkdirSync(dir, { recursive: true });

	// The task record: prompt and (when present) the agent's system prompt.
	fs.writeFileSync(path.join(dir, "prompt.md"), input.task, { mode: 0o600 });

	const args = buildSubagentArgs(agent, input.dispatchDefaults);
	if (agent.systemPrompt.trim()) {
		const systemPromptPath = path.join(dir, "system-prompt.md");
		fs.writeFileSync(systemPromptPath, agent.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", systemPromptPath);
	}
	args.push(`Task: ${input.task}`);

	const stdoutPath = path.join(dir, "stdout.jsonl");
	const stderrPath = path.join(dir, "stderr.log");

	let record = initialStatus({
		subagentId: id,
		agent: agent.name,
		agentSource: agent.source,
		mode: input.mode,
		...(input.step !== undefined ? { step: input.step } : {}),
		task: input.task,
		pid: null,
		pgid: null,
	});
	writeStatus(record);

	const invocation = getPiInvocation(args);
	const runner = writeRunner(
		id,
		[invocation.command, ...invocation.args].map(shellQuote).join(" "),
		process.execPath,
	);
	fs.writeFileSync(path.join(dir, "finalize.mjs"), finalizeScript(), {
		mode: 0o600,
	});

	const stdoutFd = fs.openSync(stdoutPath, "a");
	const stderrFd = fs.openSync(stderrPath, "a");
	let proc: ReturnType<typeof spawn>;
	try {
		proc = spawn("bash", [runner], {
			cwd: input.cwd,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
		});
	} finally {
		fs.closeSync(stdoutFd);
		fs.closeSync(stderrFd);
	}
	proc.unref();

	// The child-pid/pgid record any kill-by-id needs (the fork omits it).
	// Detached ⇒ the child is its own group leader, so pgid === pid.
	record = { ...record, pid: proc.pid ?? null, pgid: proc.pid ?? null };
	writeStatus(record);

	// Redundant finalize seam: if the runner itself died without recording,
	// map the signal to a terminal status (SIGKILL → killed/137 and friends).
	proc.on("exit", (code, signalTerm) => {
		if (deliberateKills.has(id)) return;
		const current = readStatus(id);
		if (current?.status !== "running") return;
		const fromSignal = terminalFromSignal(signalTerm);
		if (fromSignal) {
			finalizeStatus(id, {
				status: "killed",
				exitCode: fromSignal.exitCode,
				errorMessage: `terminated by ${fromSignal.signal}`,
			});
		} else {
			finalizeStatus(id, {
				status: code === 0 ? "done" : "failed",
				exitCode: code ?? 1,
			});
		}
	});

	const trackedTask: TrackedTask = {
		id,
		pgid: proc.pid ?? 0,
		startedAt: record.startedAt,
		stdoutPath,
		stderrPath,
		agent: agent.name,
		lastStat: null,
	};
	tracked.set(id, trackedTask);
	ensureWatchdog();

	return { id, pgid: proc.pid ?? 0, record };
}

// ── Waiting, checking, cancelling ──

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitOutcome {
	record: SubagentStatusRecord | null;
	timedOut: boolean;
	elapsedMs: number;
}

/**
 * Poll the status file until terminal or the call's wait cap is hit. The cap
 * bounds this call's blocking time; the task keeps running past it.
 */
export async function waitForSubagent(
	id: string,
	plan: WaitPlan,
	onProgress?: (elapsedMs: number) => void,
): Promise<WaitOutcome> {
	const start = Date.now();
	if (plan.kind === "background") {
		return { record: readStatus(id), timedOut: true, elapsedMs: 0 };
	}
	for (;;) {
		const record = readStatus(id);
		const elapsed = Date.now() - start;
		if (record && record.status !== "running")
			return { record, timedOut: false, elapsedMs: elapsed };
		if (plan.kind === "deadline" && elapsed >= plan.ms)
			return { record, timedOut: true, elapsedMs: elapsed };
		onProgress?.(elapsed);
		const nextPoll =
			plan.kind === "deadline"
				? Math.min(pollIntervalMs(), plan.ms - elapsed)
				: pollIntervalMs();
		if (nextPoll > 0) await sleepMs(nextPoll);
	}
}

// ── Work history: replaying the child's JSON stream ──

export interface WorkHistory {
	messages: Message[];
}

function parseEvent(line: string): { message?: Message } | null {
	if (!line.trim()) return null;
	try {
		const event = JSON.parse(line) as { type?: string; message?: Message };
		if (
			(event.type === "message_end" || event.type === "tool_result_end") &&
			event.message
		) {
			return { message: event.message };
		}
		return null;
	} catch {
		return null;
	}
}

/** Reconstruct the child's message stream from its stdout.jsonl. */
export function readWorkHistory(stdoutPath: string): WorkHistory {
	const messages: Message[] = [];
	try {
		const content = fs.readFileSync(stdoutPath, "utf-8");
		for (const line of content.split("\n")) {
			const event = parseEvent(line);
			if (event?.message) messages.push(event.message);
		}
	} catch {
		/* no output yet */
	}
	return { messages };
}

/** Fold a message stream into the usage/model/stop-reason summary. */
export function summarizeMessages(messages: Message[]): {
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
} {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		usage.turns++;
		if (msg.usage) {
			usage.input += msg.usage.input || 0;
			usage.output += msg.usage.output || 0;
			usage.cacheRead += msg.usage.cacheRead || 0;
			usage.cacheWrite += msg.usage.cacheWrite || 0;
			usage.cost += msg.usage.cost?.total || 0;
			usage.contextTokens = msg.usage.totalTokens || 0;
		}
		if (msg.model && !model) model = msg.model;
		if (msg.stopReason) stopReason = msg.stopReason;
		if (msg.errorMessage) errorMessage = msg.errorMessage;
	}
	return {
		usage,
		...(model ? { model } : {}),
		...(stopReason ? { stopReason } : {}),
		...(errorMessage ? { errorMessage } : {}),
	};
}

// ── Check and cancel tool modes ──

export function formatElapsedMs(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

function elapsedString(record: SubagentStatusRecord): string {
	const start = Date.parse(record.startedAt);
	const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
	return formatElapsedMs(end - start);
}

function tail(filePath: string, maxBytes: number): string {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return content.length > maxBytes ? `…${content.slice(-maxBytes)}` : content;
	} catch {
		return "";
	}
}

export function readStderrTail(id: string, maxBytes = 2000): string {
	return tail(path.join(taskDir(id), "stderr.log"), maxBytes);
}

export function checkSubagentText(
	id: string,
	historyFull: boolean,
): { text: string; record: SubagentStatusRecord | null } {
	const record = readStatus(id);
	if (!record) {
		return {
			text: `No subagent task found for id "${id}" (status file missing).`,
			record: null,
		};
	}
	const { messages } = readWorkHistory(path.join(taskDir(id), "stdout.jsonl"));
	const lines: string[] = [];
	lines.push(`subagent "${record.agent}" (${id}): ${record.status}`);
	if (record.errorMessage) lines.push(`Error: ${record.errorMessage}`);
	lines.push(`Elapsed: ${elapsedString(record)}`);
	if (record.exitCode !== null) lines.push(`Exit code: ${record.exitCode}`);
	if (messages.length > 0) {
		const last = [...messages].reverse().find((m) => m.role === "assistant");
		if (last) {
			for (const part of last.content) {
				if (part.type === "text") {
					lines.push(
						`Last output: ${historyFull ? part.text : part.text.slice(0, 2000)}`,
					);
					break;
				}
			}
		}
		if (historyFull) {
			lines.push(`Messages (${messages.length}):`);
			for (const msg of messages) {
				const role = msg.role;
				const textParts = msg.content.filter((p) => p.type === "text");
				const text = textParts
					.map((p) => (p.type === "text" ? p.text : ""))
					.join(" ")
					.slice(0, 500);
				lines.push(`  - ${role}: ${text}`);
			}
		}
	} else {
		lines.push("No output yet.");
	}
	const stderr = tail(path.join(taskDir(id), "stderr.log"), 2000);
	if (stderr.trim()) lines.push(`Stderr (tail):\n${stderr}`);
	lines.push(`Cancel with subagent({ cancel: "${id}" }).`);
	return { text: lines.join("\n"), record };
}

export async function cancelSubagent(
	id: string,
): Promise<{ text: string; record: SubagentStatusRecord | null }> {
	const record = readStatus(id);
	const refusal = cancelGuard(record?.status ?? null);
	if (refusal) return { text: refusal, record };
	const pgid = record?.pgid ?? null;
	if (pgid) {
		deliberateKills.add(id);
		await killTaskGroup(pgid);
		deliberateKills.delete(id);
	}
	finalizeStatus(id, {
		status: "cancelled",
		exitCode: terminalFromSignal("SIGTERM")?.exitCode ?? 143,
		errorMessage: "cancelled by coordinator",
	});
	const updated = readStatus(id);
	tracked.delete(id);
	return {
		text: `Cancelled subagent task "${id}" (${record?.agent ?? "unknown agent"}).`,
		record: updated,
	};
}
