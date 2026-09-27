/**
 * L2 seam-integration tests for the real Implement–Review Cycle port
 * (ticket afk-kit #62, durable spec #46): one fresh confined Implementer
 * session, the observed-fact done checks, deterministic Verify execution,
 * complete cycle evidence, and the approved cycle feeding the additive
 * candidate push. The tracker/Git seams run for real — a local bare
 * remote, a stub `gh` on PATH — the confinement runtime is a fake at its
 * library port, and the SDK session is scripted behind its factory seam
 * (code-verify standard).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { slugFor } from "../extensions/coordinator/slug.ts";
import { createCyclePort } from "./cycle.ts";
import { driveRun } from "./drive.ts";
import { type RunEvent, readRunEvents } from "./runs/events.ts";
import { foldRunEvents } from "./runs/projection.ts";
import { createRun, type RunHandle } from "./runs/store.ts";
import {
	baseRules,
	cleanupWorld,
	type GhRule,
	makeWorld,
} from "./test-world.ts";

const ISSUE = 62;
const TITLE = "Run one confined Implementer and deterministic Verify";
const BRANCH = `issue-${ISSUE}-${slugFor(TITLE)}`;

const BRIEF_BODY = [
	"## Agent brief",
	"",
	"**Summary:** Scratch issue for the cycle tests.",
	"",
	"**Acceptance criteria:**",
	"- [ ] The implementer's feature lands and verifies.",
	"",
	"**Verify commands:**",
	"- `git rev-parse --is-inside-work-tree`",
	"- `test -f src/feature.txt`",
	"",
	"**Blocked by:** none",
	"**Blocks:** none",
	"",
	"**Touched areas:** src",
	"",
	"**Out of scope:** nothing.",
	"",
	"**Open questions:** none",
	"",
].join("\n");

interface LaunchedSession {
	cycle: number;
	prompt: string;
}

interface StartedWorld {
	world: Awaited<ReturnType<typeof makeWorld>>;
	handle: RunHandle;
	worktree: string;
	launched: LaunchedSession[];
	behavior: (
		cycle: number,
		worktree: string,
		git: Awaited<ReturnType<typeof makeWorld>>["git"],
	) => Promise<void>;
}

async function implementFeature(
	worktree: string,
	git: Awaited<ReturnType<typeof makeWorld>>["git"],
): Promise<void> {
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
	fs.writeFileSync(path.join(worktree, "src", "feature.txt"), "done\n");
	const add = await git(["add", "-A"], worktree);
	if (add.exitCode !== 0) throw new Error(add.stderr);
	const commit = await git(["commit", "-m", "implement the feature"], worktree);
	if (commit.exitCode !== 0) throw new Error(commit.stderr);
}

function doneReport(summary: string): string {
	return [
		"Work complete.",
		"```json",
		JSON.stringify({ status: "done", summary }),
		"```",
	].join("\n");
}

function bootstrapRules(): GhRule[] {
	return [
		{
			args: ["issue", "view", String(ISSUE), "--json", "title,body"],
			json: { title: TITLE, body: BRIEF_BODY },
		},
		{
			args: [
				"pr",
				"list",
				"--head",
				BRANCH,
				"--state",
				"open",
				"--json",
				"number,title,url,isDraft",
			],
			json: [],
		},
		{
			args: ["pr", "create", "--draft"],
			stdout: "https://example.com/repo/pull/99\n",
		},
	];
}

function handoffRules(): GhRule[] {
	return [
		{
			args: [
				"pr",
				"list",
				"--head",
				BRANCH,
				"--state",
				"open",
				"--json",
				"number,title,url,isDraft",
			],
			json: [
				{
					number: 99,
					title: `${TITLE} (#${ISSUE})`,
					url: "https://example.com/repo/pull/99",
					isDraft: true,
				},
			],
		},
		{
			args: ["issue", "view", String(ISSUE), "--json", "body,labels"],
			json: {
				body: BRIEF_BODY,
				labels: [{ name: "ready-for-agent" }, { name: "in-progress" }],
			},
		},
		{ args: ["pr", "edit", "99"], json: {} },
		{ args: ["pr", "ready", "99"], json: {} },
	];
}

function escalationRules(): GhRule[] {
	return [
		{
			args: ["issue", "view", String(ISSUE), "--json", "labels"],
			json: { labels: [{ name: "ready-for-agent" }, { name: "in-progress" }] },
		},
		{ args: ["issue", "comment", String(ISSUE)], json: {} },
	];
}

/**
 * Start a world whose scripted Implementer sessions record their prompt
 * and produce the default behavior's report; tests override `behavior`.
 */
async function startWorld(
	behavior: StartedWorld["behavior"],
): Promise<StartedWorld> {
	const world = await makeWorld(ISSUE, TITLE, [
		...bootstrapRules(),
		...escalationRules(),
	]);
	const handle = createRun({
		stateRoot: path.join(world.root, "state"),
		owner: "test",
		repo: "repo",
		ticket: ISSUE,
		brief: BRIEF_BODY,
	});
	const worktree = path.join(world.worktreeRoot, "remote", BRANCH);
	return {
		world,
		handle,
		worktree,
		launched: [],
		behavior: async (cycle, wt) => {
			// From the cycle on, the tracker presents the draft PR so the
			// candidate push and handoff find it; the Escalation rules stay
			// so a cap escalation can still comment.
			world.setRules([
				...handoffRules(),
				...escalationRules(),
				...baseRules(ISSUE, TITLE),
			]);
			await (
				behavior ??
				(async (_c, w, g) => {
					await implementFeature(w, g);
				})
			)(cycle, wt, world.git);
		},
	};
}

/** The scripted session the cycle port receives instead of the SDK's. */
function scriptedSessionFactory(
	started: StartedWorld,
	options: { hang?: boolean; finalReport?: string } = {},
) {
	return async (request: {
		worktree: string;
		prompt: string;
		eventsPath: string;
		capMs: number;
	}) => {
		let listener: ((event: unknown) => void) | null = null;
		let finalText = "";
		let resolvePrompt: (() => void) | null = null;
		return {
			subscribe: (l: (event: unknown) => void) => {
				listener = l;
				return () => {};
			},
			prompt: async (text: string) => {
				started.launched.push({
					cycle: started.launched.length + 1,
					prompt: text,
				});
				listener?.({ type: "agent_start" });
				if (options.hang === true) {
					// The SDK contract: abort() resolves the pending prompt.
					await new Promise<void>((resolve) => {
						resolvePrompt = resolve;
					});
					return;
				}
				await started.behavior(started.launched.length, request.worktree);
				finalText = options.finalReport ?? doneReport("implemented");
				listener?.({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: finalText }],
					},
				});
				listener?.({ type: "agent_end" });
			},
			abort: async () => {
				resolvePrompt?.();
			},
			dispose: () => {},
			getLastAssistantText: () => finalText,
		};
	};
}

interface RunResult {
	exit: 0 | 1 | 2 | 3;
	started: StartedWorld;
	events: RunEvent[];
	stderr: string;
}

interface RunDrivenOptions {
	behavior?: StartedWorld["behavior"];
	confinementRuntime?: unknown;
	/** The session hangs until its abort; models the wall-clock cap. */
	hangSession?: boolean;
	/** Per-cycle Implementer cap override (tests); default 30 minutes. */
	implementerCapMs?: number;
	/** The scripted session's final text; default the done report. */
	report?: string;
}

async function runDrivenWorld(
	options: RunDrivenOptions = {},
): Promise<RunResult> {
	const started = await startWorld(options.behavior ?? (async () => {}));
	const port = createCyclePort({
		handle: started.handle,
		seams: started.world.seams,
		brief: BRIEF_BODY,
		ports: {
			sessionFactory: scriptedSessionFactory(started, {
				hang: options.hangSession === true,
				finalReport: options.report,
			}),
			...(options.confinementRuntime === undefined
				? {}
				: { confinementRuntime: options.confinementRuntime }),
			...(options.implementerCapMs === undefined
				? {}
				: { implementerCapMs: options.implementerCapMs }),
		},
	});
	const stderrLines: string[] = [];
	const exit = await driveRun({
		handle: started.handle,
		seams: started.world.seams,
		runCycle: port,
		io: {
			stdout: () => {},
			stderr: (t) => {
				stderrLines.push(t);
			},
		},
	});
	const events = readRunEvents(started.handle.eventsPath).events;
	return { exit, started, events, stderr: stderrLines.join("") };
}

describe("createCyclePort: the approved path", () => {
	let result: RunResult;

	beforeAll(async () => {
		result = await runDrivenWorld({
			behavior: async (_cycle, worktree, git) => {
				fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
				fs.writeFileSync(path.join(worktree, "src", "feature.txt"), "done\n");
				await implementFeature(worktree, git);
			},
		});
	});

	afterAll(() => {
		cleanupWorld(result.started.world);
	});

	test("the Run reaches handed-over-to-maintainer with exit 0", () => {
		expect(result.exit).toBe(0);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("handed-over-to-maintainer");
		expect(summary?.cycle).toBe(1);
	});

	test("the verified candidate commits were pushed additively", async () => {
		const local = await result.started.world.git(
			["rev-parse", "HEAD"],
			result.started.worktree,
		);
		const remote = await result.started.world.git(
			["rev-parse", `origin/${BRANCH}`],
			result.started.worktree,
		);
		expect(remote.stdout.trim()).toBe(local.stdout.trim());
	});

	test("the complete session event stream and structured result are stored", () => {
		const dir = path.join(
			result.started.handle.artifactsDir,
			"cycle-1",
			"implementer",
		);
		const stream = fs
			.readFileSync(path.join(dir, "session-events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(stream.map((e) => e.type)).toEqual([
			"agent_start",
			"message_end",
			"agent_end",
		]);
		const sessionResult = JSON.parse(
			fs.readFileSync(path.join(dir, "result.json"), "utf8"),
		) as Record<string, unknown>;
		expect(sessionResult).toMatchObject({
			stop: "completed",
			commitCount: 1,
			clean: true,
		});
		expect(sessionResult.parse).toMatchObject({ ok: true });
	});

	test("verify evidence carries metadata, exit status, and full streams", () => {
		const verifyDir = path.join(
			result.started.handle.artifactsDir,
			"cycle-1",
			"verify",
		);
		const first = path.join(verifyDir, "01-git-rev-parse-is-inside-work-tree");
		const meta = JSON.parse(
			fs.readFileSync(path.join(first, "command.json"), "utf8"),
		) as Record<string, unknown>;
		expect(meta).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
		expect(fs.readFileSync(path.join(first, "stdout"), "utf8").trim()).toBe(
			"true",
		);
		expect(
			fs.existsSync(path.join(verifyDir, "02-test-f-src-feature-txt")),
		).toBe(true);
	});

	test("the approved cycle carried both verify results into the machine", () => {
		const cycleResult = JSON.parse(
			fs.readFileSync(
				path.join(result.started.handle.artifactsDir, "cycle-1", "result.json"),
				"utf8",
			),
		) as { status: string; verifyResults: { command: string; ok: boolean }[] };
		expect(cycleResult.status).toBe("approved");
		expect(cycleResult.verifyResults).toEqual([
			{ command: "git rev-parse --is-inside-work-tree", ok: true },
			{ command: "test -f src/feature.txt", ok: true },
		]);
	});

	test("the fresh session got the full prompt with brief and done contract", () => {
		expect(result.started.launched).toHaveLength(1);
		const prompt = result.started.launched[0]?.prompt ?? "";
		expect(prompt).toContain(BRIEF_BODY);
		expect(prompt).toContain(BRANCH);
		expect(prompt).toContain("openQuestions");
	});
});

function fakeRuntime() {
	let initialized = 0;
	let reset = 0;
	return {
		get initializedCount() {
			return initialized;
		},
		get resetCount() {
			return reset;
		},
		port: {
			initialize: async () => {
				initialized += 1;
			},
			wrapWithSandbox: async (command: string) => command,
			annotateStderrWithSandboxFailures: (_id: string, out: string) => out,
			cleanupAfterCommand: () => {},
			reset: async () => {
				reset += 1;
			},
		},
	};
}

describe("createCyclePort: failed cycles", () => {
	test("a verify failure fails the cycle and rides into the next prompt", async () => {
		const result = await runDrivenWorld({
			behavior: async (cycle, worktree, git) => {
				if (cycle === 1) {
					// Something to commit that does not satisfy the verify.
					fs.writeFileSync(
						path.join(worktree, "notes.txt"),
						"work in progress\n",
					);
					await git(["add", "-A"], worktree);
					await git(["commit", "-m", "start the work"], worktree);
					return;
				}
				fs.mkdirSync(path.join(worktree, "src"), {
					recursive: true,
				});
				fs.writeFileSync(path.join(worktree, "src", "feature.txt"), "done\n");
				await implementFeature(worktree, git);
			},
		});
		expect(result.exit).toBe(0);
		expect(result.started.launched).toHaveLength(2);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("handed-over-to-maintainer");
		// Cycle 1 failed at verify; cycle 2 inherited the bounded feedback.
		const prompt2 = result.started.launched[1]?.prompt ?? "";
		expect(prompt2).toContain(
			"Verify command `test -f src/feature.txt` failed (exit 1, 0 timeouts)",
		);
		expect(prompt2).toContain("--- stdout (last 20000 chars) ---");
		// Cycle evidence exists for both cycles; the first shows the failure.
		const first = JSON.parse(
			fs.readFileSync(
				path.join(result.started.handle.artifactsDir, "cycle-1", "result.json"),
				"utf8",
			),
		) as { status: string };
		expect(first.status).toBe("failed");
		expect(
			fs.existsSync(
				path.join(
					result.started.handle.artifactsDir,
					"cycle-1",
					"verify",
					"02-test-f-src-feature-txt",
				),
			),
		).toBe(true);
	});

	test("a done report with no commit is refused by the facts, to the cap", async () => {
		const result = await runDrivenWorld({
			behavior: async () => {},
		});
		expect(result.exit).toBe(2);
		expect(result.started.launched).toHaveLength(3);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("escalated");
		expect(summary?.reason).toContain("no new commit since cycle start");
	});

	test("an uncommitted worktree is a failed cycle even with a done report", async () => {
		const result = await runDrivenWorld({
			behavior: async (cycle, worktree, git) => {
				await implementFeature(worktree, git);
				// Unique content per cycle: the previous stray gets committed
				// by the next add -A, and a new one is left behind.
				fs.writeFileSync(
					path.join(worktree, "stray.txt"),
					`left behind in cycle ${String(cycle)}\n`,
				);
			},
		});
		expect(result.exit).toBe(2);
		expect(foldRunEvents(result.events)?.reason).toContain(
			"worktree not clean",
		);
	});

	test("a blocked report with open questions fails the cycle honestly", async () => {
		const result = await runDrivenWorld({
			behavior: async (cycle, worktree, git) => {
				fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
				fs.writeFileSync(
					path.join(worktree, "src", "feature.txt"),
					`work from cycle ${String(cycle)}\n`,
				);
				await git(["add", "-A"], worktree);
				await git(
					["commit", "-m", `work from cycle ${String(cycle)}`],
					worktree,
				);
			},
			report: [
				"I cannot proceed.",
				"```json",
				JSON.stringify({
					status: "blocked",
					summary: "The brief contradicts itself.",
					openQuestions: ["Which timestamp is authoritative?"],
				}),
				"```",
			].join("\n"),
		});
		expect(result.exit).toBe(2);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("escalated");
		expect(summary?.reason).toContain("implementer reported blocked");
		expect(summary?.reason).toContain("Which timestamp is authoritative?");
		// The blocked report was persisted verbatim as evidence.
		const evidence = JSON.parse(
			fs.readFileSync(
				path.join(
					result.started.handle.artifactsDir,
					"cycle-1",
					"implementer",
					"result.json",
				),
				"utf8",
			),
		) as { parse: { ok: boolean; result: { status: string } } };
		expect(evidence.parse.ok).toBe(true);
		expect(evidence.parse.result.status).toBe("blocked");
	});

	test("an aborted session is a failed cycle with no report accepted", async () => {
		const result = await runDrivenWorld({
			hangSession: true,
			implementerCapMs: 100,
		});
		expect(result.exit).toBe(2);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("escalated");
		expect(summary?.reason).toContain("did not complete (aborted)");
		// The cap is per-cycle: three fresh sessions were launched, none
		// re-prompted.
		expect(result.started.launched).toHaveLength(3);
		const first = JSON.parse(
			fs.readFileSync(
				path.join(
					result.started.handle.artifactsDir,
					"cycle-1",
					"implementer",
					"result.json",
				),
				"utf8",
			),
		) as { stop: string };
		expect(first.stop).toBe("aborted");
	});

	test("a confinement failure escalates immediately", async () => {
		const runtime = fakeRuntime();
		runtime.port.initialize = async () => {
			throw new Error("sandbox runtime cannot initialize: test fault");
		};
		const result = await runDrivenWorld({
			confinementRuntime: runtime.port,
		});
		expect(result.exit).toBe(2);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("escalated");
		expect(summary?.reason).toContain("sandbox runtime cannot initialize");
		// No Implementer session was ever launched.
		expect(result.started.launched).toHaveLength(0);
	});
});
