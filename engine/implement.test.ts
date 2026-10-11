/**
 * Tests for the durable start operation (ticket afk-kit #60, durable spec
 * #46): strict entry, preflight before readiness before Claim, and every
 * unsafe start refused as a durable `refused` Run that leaves no Claim and
 * no coordination side effects. Safe starts now reach the Engine's Claim
 * operation (#66); this preflight fixture presents an existing Claim there.
 * L1 covers the pure pieces; L2 runs the real
 * command against the fixture world — a local bare remote, a stub `gh` on
 * PATH, a temp state root — with the confinement runtime faked at its port
 * (code-verify standard).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GitRunner, runGit } from "../extensions/coordinator/git.ts";
import { runCli } from "./cli.ts";
import type { ConfigPorts } from "./config.ts";
import { runImplement } from "./implement.ts";
import { RUN_EVENT_NAMES, readRunEvents } from "./runs/events.ts";
import { issueRunsDir, repositoryStateRoot } from "./runs/paths.ts";
import { createRun, recordEvent } from "./runs/store.ts";
import {
	cleanupWorld,
	type GhRule,
	makeWorld,
	readyAssessmentFor,
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
		args: [
			"issue",
			"view",
			String(ISSUE),
			"--json",
			"body,labels,blockedBy,title,url,author,state,number",
		],
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
	assessmentOutput?: string;
	assessmentCapMs?: number;
	git?: GitRunner;
}

/**
 * A hermetic installed-skills directory: the three pinned implementation
 * skills (ADR 0015), deterministic content so tests can assert hashes.
 */
function skillBodies(): Record<string, string> {
	return {
		implement: "---\nname: implement\n---\nImplement the work.\n",
		tdd: "---\nname: tdd\n---\nRed, then green.\n",
		"codebase-design": "---\nname: codebase-design\n---\nDeep modules.\n",
	};
}

function installSkills(): { root: string; sha256: Record<string, string> } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "afk-skills-"));
	const sha256: Record<string, string> = {};
	for (const [name, body] of Object.entries(skillBodies())) {
		fs.mkdirSync(path.join(root, name), { recursive: true });
		fs.writeFileSync(path.join(root, name, "SKILL.md"), body);
		sha256[name] = createHash("sha256").update(body).digest("hex");
	}
	return { root, sha256 };
}

interface Fixture {
	world: World;
	xdg: string;
	out: string[];
	err: string[];
	runtime: ReturnType<typeof fakeRuntime>;
	/** The hermetic installed-skills root and its content hashes. */
	skills: { root: string; sha256: Record<string, string> };
	run: (options?: RunOptions) => Promise<number>;
}

async function fixture(
	extraRules: GhRule[] = [],
	runtime = fakeRuntime(),
): Promise<Fixture> {
	const world = await makeWorld(ISSUE, "Refuse unsafe Engine starts durably", [
		...extraRules,
		{
			args: [
				"api",
				"repos/juranki/afk-kit/issues/60/comments?per_page=100&page=1",
			],
			json: [
				{
					id: 123,
					body: "Conclusion: carry this bounded change; verify with bun test.",
					user: { login: "maintainer" },
				},
			],
		},
		{
			args: [
				"issue",
				"view",
				String(ISSUE),
				"--json",
				"number,title,url,assignees,labels",
			],
			json: {
				title: "Already claimed",
				assignees: [{ login: "another-coordinator" }],
				labels: [{ name: "ready-for-agent" }],
			},
		},
	]);
	await world.git(["remote", "set-url", "origin", GITHUB_URL]);
	const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "afk-implement-"));
	const skills = installSkills();
	const out: string[] = [];
	const err: string[] = [];
	return {
		world,
		xdg,
		out,
		err,
		runtime,
		skills,
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
					git: options.git ?? offlineFetchGit(world),
					config: { skillsRoot: skills.root, ...options.config },
					assessment: {
						capMs: options.assessmentCapMs,
						sessionFactory: async () => ({
							subscribe: () => () => {},
							prompt: async () => {},
							abort: () => {},
							dispose: () => {},
							getLastAssistantText: () =>
								options.assessmentOutput ??
								JSON.stringify(
									readyAssessmentFor(
										["issue:juranki/afk-kit#60", "comments:juranki/afk-kit#60"],
										{
											command: "bun test",
											verifies: "Requested behavior",
											refs: ["comments:juranki/afk-kit#60"],
										},
										{
											intent: {
												text: "Carry the settled intent",
												refs: ["comments:juranki/afk-kit#60"],
											},
											scope: [
												{
													text: "Bounded change",
													refs: ["issue:juranki/afk-kit#60"],
												},
											],
											exclusions: [
												{
													text: "Unrelated work",
													refs: ["issue:juranki/afk-kit#60"],
												},
											],
											acceptanceCriteria: [
												{
													text: "Settled behavior works",
													refs: ["comments:juranki/afk-kit#60"],
												},
											],
											decisions: [],
											repositoryContext: [],
											guidance: [],
										},
									),
								),
						}),
					},
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
	test("a narrow Issue with 70 unrelated instruction directories prepares a brief before live Claim", async () => {
		const f = await fixture([
			readinessRule("Please carry the change discussed below."),
		]);
		try {
			await f.world.git(["reset", "--hard", "origin/main"]);
			for (let i = 0; i < 70; i++) {
				const directory = path.join(f.world.checkout, `unrelated-${i}`);
				fs.mkdirSync(directory);
				fs.writeFileSync(path.join(directory, "AGENTS.md"), "Unrelated rules");
			}
			for (const file of [
				"AGENTS.md",
				"package.json",
				"README.md",
				"docs/README.md",
			]) {
				fs.mkdirSync(path.dirname(path.join(f.world.checkout, file)), {
					recursive: true,
				});
				fs.writeFileSync(
					path.join(f.world.checkout, file),
					file === "package.json"
						? '{"scripts":{"test":"bun test"}}'
						: "Root readiness context",
				);
			}
			await f.world.git(["add", "."]);
			await f.world.git(["commit", "-m", "large repository"]);
			expect(
				(await f.world.git(["push", f.world.bare, "HEAD:main"])).exitCode,
			).toBe(0);
			expect(await f.run()).toBe(1);
			const dir = onlyRun(f.xdg);
			const captured = JSON.parse(
				fs.readFileSync(
					path.join(dir, "artifacts/readiness/sources.json"),
					"utf8",
				),
			);
			expect(captured.sources.map((s: { id: string }) => s.id)).toEqual([
				"issue:juranki/afk-kit#60",
				"comments:juranki/afk-kit#60",
				"repo:AGENTS.md",
				"repo:README.md",
				"repo:docs/README.md",
				"repo:package.json",
			]);
			const events = readRunEvents(path.join(dir, "events.jsonl")).events;
			expect(
				events
					.filter((e) => e.name === RUN_EVENT_NAMES.stageEntered)
					.map((e) => e.payload.stage),
			).toEqual(["preflight", "readiness", "claim"]);
			expect(
				fs.readFileSync(
					path.join(dir, "artifacts/readiness/prepared-brief.md"),
					"utf8",
				),
			).toContain("Conclusion: carry this bounded change");
			expect(events.some((e) => e.name === RUN_EVENT_NAMES.cycleStarted)).toBe(
				false,
			);
			expect(f.world.argvLog().join("\n")).not.toContain("edit");
		} finally {
			cleanupWorld(f.world);
		}
	});
	test("Run start retains the validated repository confinement declaration outside delegated writes", async () => {
		const f = await fixture([readinessRule(PASSING_BODY)]);
		try {
			const declaration = {
				dependencyHosts: ["proxy.golang.org"],
				nonSecretExamples: [],
			};
			fs.mkdirSync(path.join(f.world.checkout, ".afk"));
			fs.writeFileSync(
				path.join(f.world.checkout, ".afk/confinement.json"),
				JSON.stringify(declaration),
			);
			expect(await f.run()).toBe(1);
			fs.writeFileSync(
				path.join(f.world.checkout, ".afk/confinement.json"),
				"{}",
			);
			const report = JSON.parse(
				fs.readFileSync(
					path.join(onlyRun(f.xdg), "artifacts/preflight/report.json"),
					"utf8",
				),
			);
			expect(report.confinementPolicy).toEqual(declaration);
		} finally {
			cleanupWorld(f.world);
		}
	});

	test("a safe start reaches Claim and durably refuses an existing Claim", async () => {
		const runtime = fakeRuntime();
		const f = await fixture([readinessRule(PASSING_BODY)], runtime);
		const exit = await f.run();

		expect(exit).toBe(1);
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
			"claim",
		]);
		const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
		expect(outcome?.payload.outcome).toBe("refused");
		expect(String(outcome?.payload.reason)).toContain("already claimed");

		// The existing Claim is refused without tracker writes.
		const argv = f.world.argvLog().join("\n");
		expect(argv).not.toContain("edit");

		// The lock is released after the terminal refusal.
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

	test("unresolved intent refuses on the captured discussion, distinctly from assessment failure", async () => {
		const body = PASSING_BODY.replace(
			"**Open questions:** none",
			"**Open questions:** which slice first?",
		);
		const f = await fixture([readinessRule(body)]);
		const exit = await f.run({
			assessmentOutput: JSON.stringify({
				status: "needs-clarification",
				questions: [
					{ text: "Which slice first?", refs: ["issue:juranki/afk-kit#60"] },
				],
			}),
		});

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
		expect(String(outcome?.payload.reason)).toContain("needs-clarification");

		cleanupWorld(f.world);
	});

	test("malformed output, unavailable relevant evidence and exhausted budget refuse without Claim or cycles", async () => {
		for (const failure of [
			"malformed",
			"unavailable",
			"timeout",
			"instructions",
		]) {
			const f = await fixture([
				readinessRule("Clear intent discussed in comments"),
				...(failure === "unavailable"
					? [
							{
								args: [
									"api",
									"repos/juranki/afk-kit/issues/60/comments?per_page=100&page=1",
								],
								status: 4,
							},
						]
					: []),
			]);
			try {
				if (failure === "instructions") {
					await f.world.git(["reset", "--hard", "origin/main"]);
					fs.mkdirSync(path.join(f.world.checkout, "docs"));
					fs.writeFileSync(
						path.join(f.world.checkout, "docs/AGENTS.md"),
						"Required instructions",
					);
					fs.writeFileSync(
						path.join(f.world.checkout, "docs/README.md"),
						"Relevant entry point",
					);
					await f.world.git(["add", "."]);
					await f.world.git(["commit", "-m", "scoped entry point"]);
					expect(
						(await f.world.git(["push", f.world.bare, "HEAD:main"])).exitCode,
					).toBe(0);
				}
				const git = offlineFetchGit(f.world);
				expect(
					await f.run({
						assessmentOutput:
							failure === "instructions" ? undefined : "not JSON",
						git: (args, cwd, signal) =>
							failure === "instructions" &&
							args[0] === "show" &&
							args[1]?.endsWith(":docs/AGENTS.md")
								? Promise.resolve({
										stdout: "",
										stderr: "object unavailable",
										exitCode: 1,
									})
								: git(args, cwd, signal),
						assessmentCapMs: failure === "timeout" ? 1 : undefined,
					}),
				).toBe(1);
				const dir = onlyRun(f.xdg);
				const events = readRunEvents(path.join(dir, "events.jsonl")).events;
				expect(
					String(
						events.find((e) => e.name === RUN_EVENT_NAMES.outcome)?.payload
							.reason,
					),
				).toContain("assessment-failure");
				expect(
					events.some(
						(e) =>
							e.payload.stage === "claim" ||
							e.name === RUN_EVENT_NAMES.cycleStarted,
					),
				).toBe(false);
				expect(f.world.argvLog().join("\n")).not.toContain("edit");
				if (failure === "instructions") {
					const captured = JSON.parse(
						fs.readFileSync(
							path.join(dir, "artifacts/readiness/sources.json"),
							"utf8",
						),
					);
					expect(captured.failures.join(";")).toContain("docs/AGENTS.md");
					expect(captured.sources.map((s: { id: string }) => s.id)).toEqual([
						"issue:juranki/afk-kit#60",
						"comments:juranki/afk-kit#60",
					]);
				}
				expect(
					fs.readFileSync(
						path.join(dir, "artifacts/readiness/assessment.json"),
						"utf8",
					),
				).toContain(
					failure === "malformed"
						? "malformed-output"
						: failure === "timeout"
							? "assessment-timeout"
							: "unavailable-evidence",
				);
			} finally {
				cleanupWorld(f.world);
			}
		}
	});

	test("an unreadable ticket refuses durably on a placeholder snapshot", async () => {
		const f = await fixture([
			{
				args: [
					"issue",
					"view",
					String(ISSUE),
					"--json",
					"body,labels,blockedBy,title,url,author,state,number",
				],
				status: 4,
			},
		]);
		const exit = await f.run();

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		// The immutable slot pins the fact that no brief was available.
		expect(fs.readFileSync(path.join(dir, "brief.md"), "utf8")).toContain(
			"could not be read",
		);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
		expect(String(outcome?.payload.reason)).toContain("ticket-readable");
		// Readiness never ran without a brief.
		expect(
			events.some(
				(e) =>
					e.name === RUN_EVENT_NAMES.stageEntered &&
					e.payload.stage === "readiness",
			),
		).toBe(false);

		cleanupWorld(f.world);
	});

	test("a dirty primary checkout is diagnostic, not blocking", async () => {
		const f = await fixture([readinessRule(PASSING_BODY)]);
		fs.writeFileSync(path.join(f.world.checkout, "uncommitted.txt"), "wip\n");
		const exit = await f.run();

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const notice = events.find((e) => e.name === RUN_EVENT_NAMES.notice);
		expect(String(notice?.payload.message)).toContain("dirty");
		expect(
			events.find((e) => e.name === RUN_EVENT_NAMES.outcome)?.payload.outcome,
		).toBe("refused");

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

	test("a dead-lock prior Run's interruption is materialized, then the start proceeds", async () => {
		const f = await fixture([
			readinessRule(PASSING_BODY),
			{
				args: ["issue", "view", String(ISSUE), "--json", "labels"],
				json: { labels: [{ name: "ready-for-agent" }] },
			},
			{
				args: ["issue", "view", String(ISSUE), "--json", "comments"],
				json: { comments: [] },
			},
			{ args: ["issue", "comment", String(ISSUE)], json: {} },
			{
				args: ["issue", "edit", String(ISSUE), "--add-label", "needs-info"],
				json: {},
			},
		]);
		// A prior Run whose process died mid-drive: a dead active PID and an
		// uncertain cycle operation in the journal.
		const prior = createRun({
			stateRoot: path.join(f.xdg, "afk"),
			owner: "juranki",
			repo: "afk-kit",
			ticket: ISSUE,
			brief: "an interrupted attempt",
		});
		fs.writeFileSync(
			prior.lockPath,
			JSON.stringify({
				pid: 2147479999,
				token: "dead",
				startedAt: "2026-09-27T12:00:00Z",
			}),
			{ mode: 0o600 },
		);
		recordEvent(prior, {
			name: RUN_EVENT_NAMES.sideEffectIntent,
			payload: { operation: "cycle", cycle: 1 },
			op: `cycle:${ISSUE}:1`,
			cycle: 1,
		});

		const exit = await f.run();

		// Reconciliation cleared the prior Run; the new start reaches Claim
		// and refuses the fixture's existing Claim, not the prior Run.
		expect(exit).toBe(1);
		// Exactly one interruption status comment was posted.
		const comments = f.world
			.argvLog()
			.filter((c) => c.startsWith("issue comment"));
		expect(comments).toHaveLength(1);
		// Both Runs are terminal.
		const priorOutcome = readRunEvents(prior.eventsPath).events.find(
			(e) => e.name === RUN_EVENT_NAMES.outcome,
		);
		expect(priorOutcome?.payload.outcome).toBe("escalated");
		const newRunDir = fs
			.readdirSync(runsDir(f.xdg))
			.map((id) => path.join(runsDir(f.xdg), id))
			.find((dir) => dir !== prior.dir);
		expect(newRunDir).toBeDefined();
		expect(fs.existsSync(path.join(newRunDir ?? "", "lock"))).toBe(false);

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

	test("a safe start records the pinned implementation skills' hashes as Run evidence", async () => {
		const f = await fixture([readinessRule(PASSING_BODY)]);
		const exit = await f.run();

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const recorded = events.find(
			(e) => e.name === RUN_EVENT_NAMES.implementationSkills,
		);
		expect(recorded).toBeDefined();
		const skills = recorded?.payload.skills as Array<{
			name: string;
			path: string;
			sha256: string;
		}>;
		expect(skills.map((s) => s.name)).toEqual([
			"implement",
			"tdd",
			"codebase-design",
		]);
		for (const skill of skills) {
			expect(skill.path).toBe(path.join(f.skills.root, skill.name, "SKILL.md"));
			expect(skill.sha256).toBe(f.skills.sha256[skill.name]);
		}

		cleanupWorld(f.world);
	});

	test("a missing implementation skill refuses durably, naming the skill", async () => {
		const f = await fixture([readinessRule(PASSING_BODY)]);
		fs.rmSync(path.join(f.skills.root, "tdd"), {
			recursive: true,
			force: true,
		});
		const exit = await f.run();

		expect(exit).toBe(1);
		const dir = onlyRun(f.xdg);
		const { events } = readRunEvents(path.join(dir, "events.jsonl"));
		const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
		expect(outcome?.payload.outcome).toBe("refused");
		expect(String(outcome?.payload.reason)).toContain("implementation-skills");
		const report = JSON.parse(
			fs.readFileSync(
				path.join(dir, "artifacts", "preflight", "report.json"),
				"utf8",
			),
		) as { checks: { name: string; detail: string }[] };
		const failed = report.checks.find(
			(c) => c.name === "implementation-skills",
		);
		expect(failed?.detail).toContain("tdd");

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
