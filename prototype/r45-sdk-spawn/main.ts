#!/usr/bin/env bun
// PROTOTYPE — throwaway (ticket #45, map #43). Not production code: no tests,
// minimal error handling. Answers: can the engine drive one confined
// implementer in-process through the pi SDK, and what survives from the
// vendored fork as libraries?

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createAgentSession,
	createBashToolDefinition,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	buildConfinedEnv,
	extractRefusals,
	materializeConfinement,
} from "../../extensions/subagent/confinement.ts";

const HERE = import.meta.dir;
const RUN = path.join(HERE, "run");
const REPO = path.join(RUN, "repo");
const WORKTREE = path.join(RUN, "worktree");
const BRANCH = "afk/demo-ticket";
const WALL_CLOCK_CAP_MS = 180_000;
const CANCEL_DRILL_MS = 4_000;

// ── tiny engine-side helpers (prototype grade) ──

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
	return execFileSync(cmd, args, {
		cwd: opts.cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function writeStep(line: string): void {
	console.log(`\n=== ${line} ===`);
	fs.appendFileSync(path.join(RUN, "engine.log"), `${new Date().toISOString()} ${line}\n`);
}

// ── 1. scratch repo + worktree ──

fs.rmSync(RUN, { recursive: true, force: true });
fs.mkdirSync(REPO, { recursive: true });
sh("git", ["init", "-b", "main", REPO]);
sh("git", ["config", "user.email", "prototype@localhost"], { cwd: REPO });
sh("git", ["config", "user.name", "prototype"], { cwd: REPO });
fs.writeFileSync(
	path.join(REPO, "calc.ts"),
	"export function add(a: number, b: number): number {\n\treturn a - b; // BUG: ticket drill\n}\n",
);
fs.writeFileSync(
	path.join(REPO, "calc.test.ts"),
	`import { describe, expect, test } from "bun:test";
import { add } from "./calc";

describe("add", () => {
	test("2 + 3 = 5", () => {
		expect(add(2, 3)).toBe(5);
	});
});
`,
);
sh("git", ["add", "."], { cwd: REPO });
sh("git", ["commit", "-m", "scratch: buggy add"], { cwd: REPO });
sh("git", ["worktree", "add", WORKTREE, "-b", BRANCH], { cwd: REPO });
writeStep(`scratch repo + worktree ready (${BRANCH})`);

// ── 2. confinement, reused from the vendored fork as a library ──

const material = materializeConfinement(path.join(RUN, "confinement"));
writeStep(
	`confinement materialized (fork library): shim=${material.shimDir} gitconfig=${material.gitconfigPath}`,
);

// ── 3. in-process session, confined bash via spawnHook ──

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("zai", "glm-5.3-flash");
if (!model) throw new Error("zai/glm-5.3-flash not found in ModelRuntime");
writeStep(`model pinned: ${model.provider}/${model.id}`);

const eventsPath = path.join(RUN, "events.jsonl");
let eventCount = 0;
const startedAt = Date.now();

const confinedBash = createBashToolDefinition(WORKTREE, {
	spawnHook: (ctx) => ({ ...ctx, env: buildConfinedEnv(ctx.env, material) }),
});

const { session } = await createAgentSession({
	cwd: WORKTREE,
	model,
	thinkingLevel: "low",
	tools: ["read", "edit", "bash"], // "bash" must stay listed: the allowlist filters custom tools by name too; the confined custom bash then overrides the built-in by name
	customTools: [confinedBash],
	sessionManager: SessionManager.inMemory(WORKTREE),
});

session.subscribe((event) => {
	eventCount++;
	fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
});

writeStep("session created (in-process; no pi subprocess)");

let bashRuns = 0;
const trackBash = (event: unknown) => {
	const e = event as { type?: string; toolName?: string };
	if (e.type === "tool_execution_start" && e.toolName === "bash") bashRuns++;
};
session.subscribe(trackBash);

// ── 4. lifecycle drill: prompt → abort → idle → prompt again ──

let abortReason: "cancel-drill" | "wall-clock-cap" | null = null;
function armAbort(ms: number, reason: "cancel-drill" | "wall-clock-cap"): NodeJS.Timeout {
	return setTimeout(() => {
		abortReason = reason;
		console.log(`   [engine] abort() firing (${reason})`);
		void session.abort();
	}, ms);
}

writeStep(`cancel drill: prompting a long bash sleep, abort in ${CANCEL_DRILL_MS / 1000}s`);
{
	const t = armAbort(CANCEL_DRILL_MS, "cancel-drill");
	const t0 = Date.now();
	try {
		await session.prompt(
			"Run exactly: sleep 90 && echo done — then report its output. Do nothing else.",
		);
		console.log("   [surprise] prompt resolved before the abort fired");
	} catch (err) {
		console.log(`   prompt rejected after abort: ${String(err).slice(0, 200)}`);
	}
	clearTimeout(t);
	await session.waitForIdle();
	writeStep(
		`cancel drill done in ${((Date.now() - t0) / 1000).toFixed(1)}s; session idle: ${!session.isStreaming}`,
	);
}

// ── 5. the real task, under a wall-clock cap ──

writeStep(`real task (cap ${WALL_CLOCK_CAP_MS / 1000}s)`);
const taskPrompt = `You are an implementer working inside a git worktree (the current directory).

TASK: calc.ts's add(a, b) is wrong — calc.test.ts expects add(2, 3) to be 5.
Fix calc.ts minimally.

DONE WHEN: \`bun test\` passes in this directory.

When the test passes, commit your change locally with git.

Then a required drill: run exactly \`git push origin ${BRANCH}\`.
It is expected to fail. Include its exact error line in your final answer.`;
const taskT0 = Date.now();
const t2 = armAbort(WALL_CLOCK_CAP_MS, "wall-clock-cap");
await session.prompt(taskPrompt);
clearTimeout(t2);
writeStep(`real task resolved in ${((Date.now() - taskT0) / 1000).toFixed(1)}s, ${eventCount} events total`);

// ── 6. trace + trust-but-verify, engine side ──

fs.writeFileSync(
	path.join(RUN, "messages.json"),
	JSON.stringify(session.messages, null, 2),
);
const lastText = session.getLastAssistantText();
const refusals = extractRefusals("", session.messages);

let testExit: number;
try {
	sh("bun", ["test"], { cwd: WORKTREE });
	testExit = 0;
} catch (e) {
	testExit = (e as { status?: number }).status ?? 1;
}
const status = sh("git", ["status", "--porcelain"], { cwd: WORKTREE });
const log = sh("git", ["log", "--oneline", "-3"], { cwd: WORKTREE });

writeStep("FINDINGS");
console.log(`run directory:            ${RUN}`);
console.log(`events captured:          ${eventCount} -> events.jsonl`);
console.log(`bash tool executions:     ${bashRuns} (confinement seam exercised)`);
console.log(`engine saw abort reason:  ${abortReason ?? "(never fired)"}`);
console.log(`verify (bun test):        exit ${testExit}`);
console.log(`worktree git status:      ${status.trim() === "" ? "clean" : status.trim()}`);
console.log(`worktree log:\n${log}`);
console.log(`refusals extracted:       ${refusals.length ? "" : "(none)"}`);
for (const r of refusals) console.log(`  - ${r}`);
console.log(`\nfinal assistant text (tail):\n${lastText.slice(-600)}`);

session.dispose();
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nPROTOTYPE COMPLETE in ${seconds}s — throwaway; see README.md`);
