/**
 * Tests for the durable start operation (ticket afk-kit #60, durable spec
 * #46): strict entry, preflight before readiness before Claim, and every
 * unsafe start refused as a durable `refused` Run that leaves no Claim and
 * no coordination side effects. L1 covers the pure pieces; L2 runs the real
 * command against the fixture world — a local bare remote, a stub `gh` on
 * PATH, a temp state root — with the confinement runtime faked at its port
 * (code-verify standard).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GitRunner, runGit } from "../extensions/coordinator/git.ts";
import { runCli } from "./cli.ts";
import { runImplement } from "./implement.ts";
import { RUN_EVENT_NAMES, readRunEvents } from "./runs/events.ts";
import { issueRunsDir, repositoryStateRoot } from "./runs/paths.ts";
import { createRun } from "./runs/store.ts";
import {
	cleanupWorld,
	type GhRule,
	makeWorld,
	type World,
} from "./test-world.ts";

const ISSUE = 60;

/** A brief that passes every readiness inspection (ADR 0012). */
const PASSING_BODY = `## Agent brief

**Summary:** Refuse unsafe Engine starts durably.

**Acceptance criteria:**
- [ ] The strict entry path exists.
- [ ] Unsafe starts are refused durably.

**Verify commands:**
- \`bun install && bun run verify\`

**Blocked by:** none

**Blocks:** none

**Touched areas:** Implement CLI, preflight, readiness library.

**Out of scope:** Claim, worktree creation, agent sessions.

**Open questions:** none
`;

/** The tracker read preflight and readiness share. */
function readinessRule(
	body: string,
	labels: string[] = ["ready-for-agent"],
): GhRule {
	return {
		args: ["issue", "view", String(ISSUE), "--json", "body,labels,blockedBy"],
		json: {
			body,
			labels: labels.map((name) => ({ name })),
			blockedBy: { nodes: [] },
		},
	};
}

/** Minimal fake of the srt runtime port: initialize/reset must be callable. */
function fakeRuntime(behavior: { failInitialize?: boolean } = {}) {
	let initialized = 0;
	let reset = 0;
	return {
		get initialized() {
			return initialized;
		},
		get reset() {
			return reset;
		},
		port: {
			initialize: async () => {
				if (behavior.failInitialize) {
					throw new Error("sandbox runtime cannot initialize on this host");
				}
				initialized += 1;
			},
			wrapWithSandbox: async (command: string) => command,
			annotateStderrWithSandboxFailures: (_id: string, output: string) =>
				output,
			cleanupAfterCommand: () => {},
			reset: async () => {
				reset += 1;
			},
		},
	};
}

/** The GitHub origin the fixture checkout presents. */
const GITHUB_URL = "https://github.com/juranki/afk-kit";

/**
 * A git port that resolves the GitHub origin's fetch to the local bare
 * remote — the environment is swapped, the argv is not (code-verify
 * standard, L2).
 */
function offlineFetchGit(world: World): GitRunner {
	const plain = runGit();
	return async (args, cwd) => {
		if (args[0] !== "fetch") return plain(args, cwd);
		const previous = {
			count: process.env.GIT_CONFIG_COUNT,
			key: process.env.GIT_CONFIG_KEY_0,
			value: process.env.GIT_CONFIG_VALUE_0,
		};
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = `url.${world.bare}.insteadOf`;
		process.env.GIT_CONFIG_VALUE_0 = GITHUB_URL;
		try {
			return await plain(args, cwd);
		} finally {
			if (previous.count === undefined) delete process.env.GIT_CONFIG_COUNT;
			else process.env.GIT_CONFIG_COUNT = previous.count;
			if (previous.key === undefined) delete process.env.GIT_CONFIG_KEY_0;
			else process.env.GIT_CONFIG_KEY_0 = previous.key;
			if (previous.value === undefined) delete process.env.GIT_CONFIG_VALUE_0;
			else process.env.GIT_CONFIG_VALUE_0 = previous.value;
		}
	};
}

/** Options a single start under the fixture can vary. */
interface RunOptions {
	body?: string;
	labels?: string[];
	env?: NodeJS.ProcessEnv;
	config?: ConfigPorts;
}

interface Fixture {
	world: World;
	xdg: string;
	out: string[];
	err: string[];
	runtime: ReturnType<typeof fakeRuntime>;
	run: (options?: RunOptions) => Promise<number>;
}

async function fixture(
	extraRules: GhRule[] = [],
	runtime = fakeRuntime(),
): Promise<Fixture> {
	const world = await makeWorld(
		ISSUE,
		"Refuse unsafe Engine starts durably",
		extraRules,
	);
	await world.git(["remote", "set-url", "origin", GITHUB_URL]);
	const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "afk-implement-"));
	const out: string[] = [];
	const err: string[] = [];
	return {
		world,
		xdg,
		out,
		err,
		runtime,
		run: (options: RunOptions = {}) =>
			runImplement({
				ticket: ISSUE,
				cwd: world.checkout,
				env: { XDG_STATE_HOME: xdg, ...options.env },
				io: {
					stdout: (text) => out.push(text),
					stderr: (text) => err.push(text),
				},
				ports: {
					confinementRuntime: runtime.port,
					git: offlineFetchGit(world),
					...(options.config ? { config: options.config } : {}),
				},
			}),
	};
}

function runsDir(xdg: string): string {
	return issueRunsDir(
		repositoryStateRoot(path.join(xdg, "afk"), "juranki", "afk-kit"),
		ISSUE,
	);
}

function onlyRun(xdg: string): string {
	const ids = fs.readdirSync(runsDir(xdg));
	expect(ids).toHaveLength(1);
	return path.join(runsDir(xdg), ids[0] ?? "");
}

describe("runImplement (L2)", () => {
	test("a safe start passes preflight and readiness, records both stages, and claims nothing", async () => {
		const runtime = fakeRuntime();
		const f = await fixture([readinessRule(PASSING_BODY)], runtime);
		const exit = await f.run();

		expect(exit).toBe(0);
		const dir = onlyRun(f.xdg);

		// The immutable brief snapshot is the body the tracker served.
		expect(fs.readFileSync(path.join(dir, "brief.md"), "utf8")).toBe(
			PASSING_BODY,
		);

		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const names = events.map((e) => e.name);
		expect(names).toContain(RUN_EVENT_NAMES.started);
		const stages = events.filter(
			(e) => e.name === RUN_EVENT_NAMES.stageEntered,
		);
		expect(stages.map((e) => e.payload.stage)).toEqual([
			"preflight",
			"readiness",
		]);
		expect(names).not.toContain(RUN_EVENT_NAMES.outcome);

		// Read-only tracker access: a refused-free start claims nothing.
		const argv = f.world.argvLog().join("\n");
		expect(argv).not.toContain("edit");

		// The lock is released; the Run waits at the Claim seam.
		expect(fs.existsSync(path.join(dir, "lock"))).toBe(false);

		// Evidence of every check is retained under artifacts/.
		expect(fs.existsSync(path.join(dir, "artifacts", "preflight"))).toBe(true);

		// The confinement capability probe really initialized and reset.
		expect(runtime.initialized).toBe(1);
		expect(runtime.reset).toBe(1);

		cleanupWorld(f.world);
	});

	test("a missing required label refuses durably, claims nothing, and status identifies the check", async () => {
		const f = await fixture([readinessRule(PASSING_BODY, ["needs-triage"])]);
		const exit = await f.run();

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));

		const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
		expect(outcome?.payload.outcome).toBe("refused");
		expect(String(outcome?.payload.reason)).toContain("required-labels");
		// Preflight refused before readiness ever ran.
		expect(
			events.some(
				(e) =>
					e.name === RUN_EVENT_NAMES.stageEntered &&
					e.payload.stage === "readiness",
			),
		).toBe(false);

		// No coordination side effects: the tracker was only read.
		expect(f.world.argvLog().join("\n")).not.toContain("edit");

		// The retained evidence names the failed check with its detail.
		const report = JSON.parse(
			fs.readFileSync(
				path.join(dir, "artifacts", "preflight", "report.json"),
				"utf8",
			),
		) as { checks: { name: string; pass: boolean; detail: string }[] };
		const failed = report.checks.find((c) => c.name === "required-labels");
		expect(failed?.pass).toBe(false);
		expect(failed?.detail).toContain("ready-for-agent");

		// afk status renders the refusal, the failed check, and the artifact
		// path — the Run is inspectable without transcripts.
		const out: string[] = [];
		const statusExit = await runCli(["status", String(ISSUE)], {
			cwd: f.world.checkout,
			env: { XDG_STATE_HOME: f.xdg },
			stdout: (text) => out.push(text),
			stderr: () => {},
		});
		expect(statusExit).toBe(0);
		const rendered = out.join("");
		expect(rendered).toContain("refused");
		expect(rendered).toContain("required-labels");
		expect(rendered).toContain(dir);

		cleanupWorld(f.world);
	});

	test("a readiness failure refuses on the immutable snapshot", async () => {
		const body = PASSING_BODY.replace(
			"**Open questions:** none",
			"**Open questions:** which slice first?",
		);
		const f = await fixture([readinessRule(body)]);
		const exit = await f.run();

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		// The snapshot readiness judged is the Run's own brief.
		expect(fs.readFileSync(path.join(dir, "brief.md"), "utf8")).toBe(body);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const stages = events
			.filter((e) => e.name === RUN_EVENT_NAMES.stageEntered)
			.map((e) => e.payload.stage);
		expect(stages).toEqual(["preflight", "readiness"]);
		const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
		expect(outcome?.payload.outcome).toBe("refused");
		expect(String(outcome?.payload.reason)).toContain("open-questions");

		cleanupWorld(f.world);
	});

	test("a dirty primary checkout is diagnostic, not blocking", async () => {
		const f = await fixture([readinessRule(PASSING_BODY)]);
		fs.writeFileSync(path.join(f.world.checkout, "uncommitted.txt"), "wip\n");
		const exit = await f.run();

		expect(exit).toBe(0);
		const dir = onlyRun(f.xdg);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const notice = events.find((e) => e.name === RUN_EVENT_NAMES.notice);
		expect(String(notice?.payload.message)).toContain("dirty");
		expect(events.some((e) => e.name === RUN_EVENT_NAMES.outcome)).toBe(false);

		cleanupWorld(f.world);
	});

	test("an uncleared prior Run refuses a new start", async () => {
		const f = await fixture([readinessRule(PASSING_BODY)]);
		createRun({
			stateRoot: path.join(f.xdg, "afk"),
			owner: "juranki",
			repo: "afk-kit",
			ticket: ISSUE,
			brief: "an earlier, unfinished attempt",
		});
		const exit = await f.run();

		expect(exit).toBe(1);
		// Both Runs remain: the prior one untouched, the new one refused.
		const dirs = fs
			.readdirSync(runsDir(f.xdg))
			.map((id) => path.join(runsDir(f.xdg), id));
		expect(dirs).toHaveLength(2);
		const outcomes = dirs.map((dir) =>
			readRunEvents(path.join(dir, "events.jsonl")).events.find(
				(e) => e.name === RUN_EVENT_NAMES.outcome,
			),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
		expect(String(outcomes.find(Boolean)?.payload.reason)).toContain(
			"prior-runs",
		);

		cleanupWorld(f.world);
	});

	test("a failing GitHub identity refuses with the named check", async () => {
		const f = await fixture([
			{ args: ["api", "user"], status: 5 },
			readinessRule(PASSING_BODY),
		]);
		const exit = await f.run();

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
		expect(String(outcome?.payload.reason)).toContain("github-identity");

		cleanupWorld(f.world);
	});

	test("a pinned-configuration failure refuses before readiness", async () => {
		const f = await fixture([readinessRule(PASSING_BODY)]);
		const exit = await f.run({ config: { pathEnv: "/nonexistent-bin" } });

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
		expect(String(outcome?.payload.reason)).toContain("engine-config");

		cleanupWorld(f.world);
	});

	test("a confinement capability failure refuses", async () => {
		const f = await fixture(
			[readinessRule(PASSING_BODY)],
			fakeRuntime({ failInitialize: true }),
		);
		const exit = await f.run();

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
		expect(String(outcome?.payload.reason)).toContain("confinement");

		cleanupWorld(f.world);
	});

	test("a state root that cannot hold evidence exits 3", async () => {
		const f = await fixture([readinessRule(PASSING_BODY)]);
		// XDG_STATE_HOME under a regular file: no Run evidence can exist.
		const file = path.join(f.xdg, "not-a-dir");
		fs.writeFileSync(file, "");
		const exit = await f.run({
			env: { XDG_STATE_HOME: path.join(file, "state") },
		});

		expect(exit).toBe(3);
		expect(f.err.join("")).toContain("cannot persist");
		expect(fs.existsSync(runsDir(f.xdg))).toBe(false);

		cleanupWorld(f.world);
	});

	test("a checkout without a GitHub origin exits 3 — no state to key evidence on", async () => {
		const bare = fs.mkdtempSync(path.join(os.tmpdir(), "afk-nogit-"));
		const exit = await runImplement({
			ticket: ISSUE,
			cwd: bare,
			env: { XDG_STATE_HOME: bare },
			io: { stdout: () => {}, stderr: () => {} },
		});
		expect(exit).toBe(3);
		fs.rmSync(bare, { recursive: true, force: true });
	});
});
