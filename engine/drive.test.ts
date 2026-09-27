/**
 * L2 scripted-port tests for the Engine's driving loop (ticket afk-kit
 * #61, code-verify standard): the complete coordination path with a
 * scripted Implement–Review Cycle port while every tracker/Git seam runs
 * for real — a local bare remote, a stub `gh` on PATH, and a real Run
 * store. The environment is swapped, never the code.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { slugFor } from "../extensions/coordinator/slug.ts";
import { driveRun } from "./drive.ts";
import type { CyclePort, ReviewPort } from "./ports.ts";
import {
	RUN_EVENT_NAMES,
	type RunEvent,
	readRunEvents,
} from "./runs/events.ts";
import { foldRunEvents, type RunSummary } from "./runs/projection.ts";
import { acquireRunLock, createRun, type RunHandle } from "./runs/store.ts";
import {
	baseRules,
	cleanupWorld,
	type GhRule,
	makeWorld,
} from "./test-world.ts";

const ISSUE = 61;
const TITLE = "Drive Claim through approved handoff with typed ports";
const BRANCH = `issue-${ISSUE}-${slugFor(TITLE)}`;

const BRIEF_BODY = [
	"## Agent brief",
	"",
	"**Summary:** Scratch issue for the drive tests.",
	"",
	"**Acceptance criteria:**",
	"- [ ] The driven loop reaches the Merge gate.",
	"",
	"**Verify commands:**",
	"- `bun test`",
	"",
	"**Blocked by:** none",
	"**Blocks:** none",
	"",
	"**Touched areas:** scratch only",
	"",
	"**Out of scope:** nothing.",
	"",
	"**Open questions:** none",
	"",
].join("\n");

interface Io {
	out: string[];
	err: string[];
}

interface Io {
	out: string[];
	err: string[];
}

function startRun(world: Awaited<ReturnType<typeof makeWorld>>): RunHandle {
	return createRun({
		stateRoot: path.join(world.root, "state"),
		owner: "test",
		repo: "repo",
		ticket: ISSUE,
		brief: BRIEF_BODY,
	});
}

function worktreeFor(world: Awaited<ReturnType<typeof makeWorld>>): string {
	return path.join(world.worktreeRoot, "remote", BRANCH);
}

function eventsOf(handle: RunHandle): RunEvent[] {
	return readRunEvents(handle.eventsPath).events;
}

function summaryOf(handle: RunHandle): RunSummary | null {
	return foldRunEvents(eventsOf(handle));
}

/** The bootstrap-phase rules: no open PR yet; creating one yields #99. */
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
			stdout: `https://example.com/repo/pull/99\n`,
		},
	];
}

/** The handoff-phase rules: draft PR #99 exists; writes succeed. */
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

/** Rules every failing path may need: label reads, comments. */
function escalationRules(): GhRule[] {
	return [
		{
			args: ["issue", "view", String(ISSUE), "--json", "labels"],
			json: { labels: [{ name: "ready-for-agent" }, { name: "in-progress" }] },
		},
		{ args: ["issue", "comment", String(ISSUE)], json: {} },
	];
}

describe("driveRun: the approved path", () => {
	let world: Awaited<ReturnType<typeof makeWorld>>;
	let handle: RunHandle;
	let worktree: string;
	let briefBefore: Buffer;
	const launched: number[] = [];
	const reviewed: number[] = [];
	const io: Io = { out: [], err: [] };
	let exit: 0 | 1 | 2 | 3;

	beforeAll(async () => {
		world = await makeWorld(ISSUE, TITLE, [
			...bootstrapRules(),
			...escalationRules(),
		]);
		handle = startRun(world);
		worktree = worktreeFor(world);
		briefBefore = fs.readFileSync(handle.briefPath);

		const runCycle: CyclePort = async (cycle) => {
			launched.push(cycle);
			// The scripted Implementer leaves one candidate commit behind.
			fs.writeFileSync(
				path.join(worktree, "candidate.txt"),
				`cycle ${cycle}\n`,
			);
			const add = await world.git(["add", "-A"], worktree);
			if (add.exitCode !== 0) throw new Error(add.stderr);
			const commit = await world.git(
				["commit", "-m", `candidate for cycle ${cycle}`],
				worktree,
			);
			if (commit.exitCode !== 0) throw new Error(commit.stderr);
			// From here on the tracker presents the draft PR for the handoff.
			world.setRules([...handoffRules(), ...baseRules(ISSUE, TITLE)]);
			return {
				status: "verified",
				cycle,
				verifyResults: [{ command: "bun test", ok: true }],
			};
		};

		const runReviews: ReviewPort = async (cycle) => {
			reviewed.push(cycle);
			return {
				status: "approved",
				cycle,
				approvals: [
					{
						review: "standards",
						verdict: {
							verdict: "approve",
							standardsConsulted: [{ path: "AGENTS.md", hash: "a".repeat(64) }],
						},
					},
					{ review: "spec", verdict: { verdict: "approve" } },
				],
			};
		};

		exit = await driveRun({
			handle,
			seams: world.seams,
			runCycle,
			runReviews,
			io: { stdout: (t) => io.out.push(t), stderr: (t) => io.err.push(t) },
		});
	});

	test("the Run reaches handed-over-to-maintainer with exit 0", () => {
		expect(exit).toBe(0);
		const summary = summaryOf(handle);
		expect(summary?.outcome).toBe("handed-over-to-maintainer");
		expect(summary?.pr).toBe(99);
		expect(summary?.branch).toBe(BRANCH);
		expect(summary?.cycle).toBe(1);
		expect(summary?.stage).toBe("handoff");
	});

	test("exactly one fresh cycle was launched and gated", () => {
		expect(launched).toEqual([1]);
		expect(reviewed).toEqual([1]);
	});

	test("every transition stage was persisted in order", () => {
		const stages = eventsOf(handle)
			.filter((e) => e.name === RUN_EVENT_NAMES.stageEntered)
			.map((e) => e.payload.stage);
		expect(stages).toEqual([
			"claim",
			"bootstrap",
			"cycle",
			"publish",
			"review",
			"handoff",
		]);
		const cycles = eventsOf(handle)
			.filter((e) => e.name === RUN_EVENT_NAMES.cycleStarted)
			.map((e) => e.payload.cycle);
		expect(cycles).toEqual([1]);
	});

	test("every side effect has a matching intent/completed pair", () => {
		const intents = eventsOf(handle).filter(
			(e) => e.name === RUN_EVENT_NAMES.sideEffectIntent,
		);
		const completions = eventsOf(handle).filter(
			(e) => e.name === RUN_EVENT_NAMES.sideEffectCompleted,
		);
		const operations = intents.map((e) => e.payload.operation);
		expect(operations).toEqual([
			"claim",
			"bootstrap",
			"cycle",
			"candidate-push",
			"review",
			"handoff",
		]);
		expect(completions.map((e) => e.payload.operation)).toEqual(operations);
		const intentOps = intents.map((e) => e.op);
		expect(
			intentOps.every((op, i) => op !== null && op === completions[i].op),
		).toBe(true);
	});

	test("the approval evidence is persisted as a Run artifact", () => {
		const resultPath = path.join(
			handle.artifactsDir,
			"cycle-1",
			"review-result.json",
		);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
			status: string;
			approvals: { review: string }[];
		};
		expect(result.status).toBe("approved");
		expect(result.approvals.map((a) => a.review)).toEqual([
			"standards",
			"spec",
		]);
		const reviewCompleted = eventsOf(handle).find(
			(e) =>
				e.name === RUN_EVENT_NAMES.sideEffectCompleted &&
				e.payload.operation === "review",
		);
		expect(reviewCompleted?.artifacts).toContain("cycle-1/review-result.json");
	});

	test("the immutable brief is never rewritten", () => {
		const briefAfter = fs.readFileSync(handle.briefPath);
		expect(briefAfter.equals(briefBefore)).toBe(true);
		expect(() => {
			// openRun verifies the snapshot hash; tampering would refuse.
			const reopened = JSON.parse(
				fs.readFileSync(path.join(handle.dir, "brief.json"), "utf8"),
			) as { hash: string };
			expect(reopened.hash).toBe(handle.briefHash);
		}).not.toThrow();
	});

	test("the candidate commits were published additively", async () => {
		const head = await world.git(["rev-parse", "HEAD"], worktree);
		const remote = await world.git(["rev-parse", `origin/${BRANCH}`], worktree);
		expect(remote.stdout.trim()).toBe(head.stdout.trim());
		// The worktree is an independent clone (ADR 0014): the branch lives
		// there, and the pushed remote carries the cumulative candidate.
		const count = await world.git(
			["rev-list", "--count", `origin/main..origin/${BRANCH}`],
			worktree,
		);
		expect(Number(count.stdout.trim())).toBeGreaterThanOrEqual(2);
	});

	test("the Engine never merges and holds in-progress until the handoff", () => {
		const argv = world.argvLog();
		expect(argv.some((args) => args.includes("merge"))).toBe(false);
		const applied = argv.filter(
			(args) => args.includes("--add-label") && args.includes("in-progress"),
		).length;
		const removed = argv.filter(
			(args) => args.includes("--remove-label") && args.includes("in-progress"),
		).length;
		expect(applied).toBe(1);
		expect(removed).toBe(1);
		const readyAt = argv.findIndex((args) => args.includes("pr ready 99"));
		const removedAt = argv.findIndex(
			(args) => args.includes("--remove-label") && args.includes("in-progress"),
		);
		expect(removedAt).toBeGreaterThan(readyAt);
	});

	test("the handoff speaks of the Maintainer, not of another Engine turn", () => {
		expect(io.out.join("")).toContain("Maintainer");
		expect(io.out.join("")).not.toMatch(/waiting for the (Engine|engine)/);
	});

	afterAll(() => {
		cleanupWorld(world);
	});
});

interface Scenario {
	world: Awaited<ReturnType<typeof makeWorld>>;
	handle: RunHandle;
	worktree: string;
	exit: 0 | 1 | 2 | 3;
	out: string[];
	err: string[];
	launched: number[];
	reviewed: number[];
}

/** The review port no scenario expects unless it says otherwise. */
function neverReviews(): ReviewPort {
	return async () => {
		throw new Error("the review port must never launch in this scenario");
	};
}

async function scenario(
	rules: GhRule[],
	runCycle: CyclePort,
	runReviews: ReviewPort = neverReviews(),
): Promise<Scenario> {
	const world = await makeWorld(ISSUE, TITLE, rules);
	const handle = startRun(world);
	const launched: number[] = [];
	const reviewed: number[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const exit = await driveRun({
		handle,
		seams: world.seams,
		runCycle: async (cycle) => {
			launched.push(cycle);
			return runCycle(cycle);
		},
		runReviews: async (cycle) => {
			reviewed.push(cycle);
			return runReviews(cycle);
		},
		io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
	});
	return {
		world,
		handle,
		worktree: worktreeFor(world),
		exit,
		out,
		err,
		launched,
		reviewed,
	};
}

function outcomeEvent(handle: RunHandle): RunEvent | undefined {
	return eventsOf(handle).find((e) => e.name === RUN_EVENT_NAMES.outcome);
}

describe("driveRun: a refused Claim", () => {
	let s: Scenario;
	beforeAll(async () => {
		s = await scenario(
			[
				{
					args: [
						"issue",
						"view",
						String(ISSUE),
						"--json",
						"number,title,url,assignees,labels",
					],
					json: {
						number: ISSUE,
						title: TITLE,
						url: `https://example.com/repo/issues/${ISSUE}`,
						assignees: [{ login: "someone-else" }],
						labels: [{ name: "ready-for-agent" }],
					},
				},
			],
			async () => {
				throw new Error("the cycle port must never launch on a refused claim");
			},
		);
	});
	afterAll(() => cleanupWorld(s.world));

	test("the Run is a durable refusal with exit 1", () => {
		expect(s.exit).toBe(1);
		expect(summaryOf(s.handle)?.outcome).toBe("refused");
		expect(outcomeEvent(s.handle)?.payload.reason).toContain(
			"already claimed by someone-else",
		);
	});

	test("no Claim side effects and no cycle happened", () => {
		const argv = s.world.argvLog();
		expect(argv.some((args) => args.includes("--add-assignee"))).toBe(false);
		expect(fs.existsSync(s.worktree)).toBe(false);
		expect(s.launched).toEqual([]);
	});
});

describe("driveRun: a refused bootstrap escalates", () => {
	let s: Scenario;
	beforeAll(async () => {
		s = await scenario(
			[
				{
					args: ["pr", "create", "--draft"],
					status: 1,
					stderr: "server rejected the pull request",
				},
				...bootstrapRules().filter((r) => r.args[1] !== "create"),
				...escalationRules(),
			],
			async () => {
				throw new Error("the cycle port must never launch without a draft PR");
			},
		);
	});
	afterAll(() => cleanupWorld(s.world));

	test("the Run escalates with exit 2, naming the bootstrap stage", () => {
		expect(s.exit).toBe(2);
		const outcome = outcomeEvent(s.handle);
		expect(outcome?.payload.outcome).toBe("escalated");
		expect(outcome?.payload.stage).toBe("bootstrap");
		expect(summaryOf(s.handle)?.outcome).toBe("escalated");
	});

	test("the Escalation posts the status comment, needs-info, and clears in-progress", () => {
		const argv = s.world.argvLog();
		const comment = argv.find((args) => args.includes("issue comment"));
		expect(comment).toContain("ESCALATION:");
		expect(argv.some((args) => args.includes("needs-info"))).toBe(true);
		expect(
			argv.some(
				(args) =>
					args.includes("--remove-label") && args.includes("in-progress"),
			),
		).toBe(true);
	});

	test("the compensation removed the remote branch", async () => {
		const ref = await s.world.git(
			["rev-parse", `refs/heads/${BRANCH}`],
			s.world.bare,
		);
		expect(ref.exitCode).not.toBe(0);
		expect(s.launched).toEqual([]);
	});
});

describe("driveRun: three failed cycles exhaust the cap", () => {
	let s: Scenario;
	beforeAll(async () => {
		s = await scenario(
			[...bootstrapRules(), ...escalationRules()],
			async (cycle) => ({
				status: "failed",
				cycle,
				reason: `cycle ${cycle} verify failed`,
			}),
		);
	});
	afterAll(() => cleanupWorld(s.world));

	test("exactly three cycles ran, then the Run escalated with exit 2", () => {
		expect(s.exit).toBe(2);
		expect(s.launched).toEqual([1, 2, 3]);
		const outcome = outcomeEvent(s.handle);
		expect(outcome?.payload.outcome).toBe("escalated");
		expect(outcome?.payload.stage).toBe("cycle");
		expect(outcome?.payload.cycle).toBe(3);
		expect(summaryOf(s.handle)?.cycle).toBe(3);
	});

	test("each cycle's failure evidence is persisted", () => {
		const cycleIntents = eventsOf(s.handle).filter(
			(e) =>
				e.name === RUN_EVENT_NAMES.sideEffectIntent &&
				e.payload.operation === "cycle",
		);
		expect(cycleIntents.map((e) => e.payload.cycle)).toEqual([1, 2, 3]);
		for (const cycle of [1, 2, 3]) {
			const result = JSON.parse(
				fs.readFileSync(
					path.join(s.handle.artifactsDir, `cycle-${cycle}`, "result.json"),
					"utf8",
				),
			) as { status: string; reason: string };
			expect(result.status).toBe("failed");
			expect(result.reason).toBe(`cycle ${cycle} verify failed`);
		}
	});

	test("the Escalation returned the Ticket to the Maintainer", () => {
		const argv = s.world.argvLog();
		const comment = argv.find((args) => args.includes("issue comment"));
		expect(comment).toContain("cycle 3");
	});

	test("the Escalation posts exactly one status comment", () => {
		const comments = s.world
			.argvLog()
			.filter((args) => args.includes("issue comment"));
		expect(comments).toHaveLength(1);
	});
});

describe("driveRun: the Review gate routes findings into the next cycle", () => {
	let world: Awaited<ReturnType<typeof makeWorld>>;
	let handle: RunHandle;
	const launched: number[] = [];
	const reviewed: number[] = [];
	let exit: 0 | 1 | 2 | 3;

	beforeAll(async () => {
		world = await makeWorld(ISSUE, TITLE, [
			...bootstrapRules(),
			...escalationRules(),
		]);
		handle = startRun(world);
		const wt = worktreeFor(world);
		const runCycle: CyclePort = async (cycle) => {
			launched.push(cycle);
			// The scripted Implementer leaves one candidate commit behind.
			fs.writeFileSync(path.join(wt, "candidate.txt"), `cycle ${cycle}\n`);
			const add = await world.git(["add", "-A"], wt);
			if (add.exitCode !== 0) throw new Error(add.stderr);
			const commit = await world.git(
				["commit", "-m", `candidate for cycle ${cycle}`],
				wt,
			);
			if (commit.exitCode !== 0) throw new Error(commit.stderr);
			// From here on the tracker presents the draft PR for the pushes.
			world.setRules([...handoffRules(), ...baseRules(ISSUE, TITLE)]);
			return {
				status: "verified",
				cycle,
				verifyResults: [{ command: "bun test", ok: true }],
			};
		};
		const runReviews: ReviewPort = async (cycle) => {
			reviewed.push(cycle);
			return cycle === 1
				? {
						status: "changes-requested",
						cycle,
						reason: "standards review requests changes: no tests for the gate",
					}
				: {
						status: "approved",
						cycle,
						approvals: [
							{ review: "standards", verdict: { verdict: "approve" } },
							{ review: "spec", verdict: { verdict: "approve" } },
						],
					};
		};
		exit = await driveRun({
			handle,
			seams: world.seams,
			runCycle,
			runReviews,
			io: { stdout: () => {}, stderr: () => {} },
		});
	});

	afterAll(() => cleanupWorld(world));

	test("both cycles ran and both were gated", () => {
		expect(exit).toBe(0);
		expect(launched).toEqual([1, 2]);
		expect(reviewed).toEqual([1, 2]);
	});

	test("cycle 1's requested changes are retained as evidence", () => {
		const result = JSON.parse(
			fs.readFileSync(
				path.join(handle.artifactsDir, "cycle-1", "review-result.json"),
				"utf8",
			),
		) as { status: string; reason: string };
		expect(result.status).toBe("changes-requested");
		expect(result.reason).toContain("no tests for the gate");
	});

	test("cycle 2's dual approval handed the Run over", () => {
		const summary = summaryOf(handle);
		expect(summary?.outcome).toBe("handed-over-to-maintainer");
		expect(summary?.cycle).toBe(2);
		const stages = eventsOf(handle)
			.filter((e) => e.name === RUN_EVENT_NAMES.stageEntered)
			.map((e) => e.payload.stage);
		expect(stages).toEqual([
			"claim",
			"bootstrap",
			"cycle",
			"publish",
			"review",
			"cycle",
			"publish",
			"review",
			"handoff",
		]);
	});
});

describe("driveRun: an escalate verdict from the Review gate ends the Run", () => {
	let world: Awaited<ReturnType<typeof makeWorld>>;
	let handle: RunHandle;
	let exit: 0 | 1 | 2 | 3;

	beforeAll(async () => {
		world = await makeWorld(ISSUE, TITLE, [
			...bootstrapRules(),
			...escalationRules(),
		]);
		handle = startRun(world);
		const wt = worktreeFor(world);
		const runCycle: CyclePort = async (cycle) => {
			fs.writeFileSync(path.join(wt, "candidate.txt"), `cycle ${cycle}\n`);
			await world.git(["add", "-A"], wt);
			await world.git(["commit", "-m", `candidate for cycle ${cycle}`], wt);
			// From here on the tracker presents the draft PR; the Escalation
			// rules stay so the gate's escalation can still comment.
			world.setRules([
				...handoffRules(),
				...escalationRules(),
				...baseRules(ISSUE, TITLE),
			]);
			return {
				status: "verified",
				cycle,
				verifyResults: [{ command: "bun test", ok: true }],
			};
		};
		exit = await driveRun({
			handle,
			seams: world.seams,
			runCycle,
			runReviews: async (cycle) => ({
				status: "escalate",
				cycle,
				reason: "spec review escalated: the brief contradicts the ADR",
			}),
			io: { stdout: () => {}, stderr: () => {} },
		});
	});

	afterAll(() => cleanupWorld(world));

	test("one gated cycle, then escalation with exit 2 — no further cycles", () => {
		expect(exit).toBe(2);
		const outcome = outcomeEvent(handle);
		expect(outcome?.payload.outcome).toBe("escalated");
		expect(outcome?.payload.stage).toBe("review");
		expect(outcome?.payload.cycle).toBe(1);
		expect(outcome?.payload.reason).toContain("contradicts the ADR");
	});

	test("the escalate verdict is retained as evidence", () => {
		const result = JSON.parse(
			fs.readFileSync(
				path.join(handle.artifactsDir, "cycle-1", "review-result.json"),
				"utf8",
			),
		) as { status: string };
		expect(result.status).toBe("escalate");
	});

	test("the Escalation comment names the review stage and cycle", () => {
		const comment = world
			.argvLog()
			.find((args) => args.includes("issue comment"));
		expect(comment).toContain("stopped at review, cycle 1");
	});
});

describe("driveRun: an escalate verdict ends the Run immediately", () => {
	let s: Scenario;
	beforeAll(async () => {
		s = await scenario(
			[...bootstrapRules(), ...escalationRules()],
			async (cycle) => ({
				status: "escalate",
				cycle,
				reason: "the Spec Review found an unsafe continuation",
			}),
		);
	});
	afterAll(() => cleanupWorld(s.world));

	test("one cycle, then escalation with exit 2 — no further cycles", () => {
		expect(s.exit).toBe(2);
		expect(s.launched).toEqual([1]);
		const outcome = outcomeEvent(s.handle);
		expect(outcome?.payload.outcome).toBe("escalated");
		expect(outcome?.payload.cycle).toBe(1);
		expect(outcomeEvent(s.handle)?.payload.reason).toContain(
			"unsafe continuation",
		);
	});
});

describe("driveRun: a failed Escalation is an internal failure", () => {
	let s: Scenario;
	beforeAll(async () => {
		s = await scenario(
			[
				{
					args: ["issue", "comment", String(ISSUE)],
					status: 1,
					stderr: "tracker down",
				},
				...bootstrapRules(),
				...escalationRules(),
			],
			async (cycle) => ({
				status: "failed",
				cycle,
				reason: `cycle ${cycle} verify failed`,
			}),
		);
	});
	afterAll(() => cleanupWorld(s.world));

	test("the Run still records escalated durably, but exits 3", () => {
		expect(s.exit).toBe(3);
		const outcome = outcomeEvent(s.handle);
		expect(outcome?.payload.outcome).toBe("escalated");
		const escalateCompleted = eventsOf(s.handle).find(
			(e) =>
				e.name === RUN_EVENT_NAMES.sideEffectCompleted &&
				e.payload.operation === "escalate",
		);
		expect(escalateCompleted?.payload.status).toBe("failed");
		expect(s.err.join("")).toContain("could not complete");
	});
});

describe("driveRun: a live lock refuses the drive", () => {
	let s: Scenario;
	beforeAll(async () => {
		s = await scenario(
			[...bootstrapRules(), ...escalationRules()],
			async () => {
				throw new Error("never launched");
			},
		);
		// A live process (this test's own pid) holds the lock.
		acquireRunLock(s.handle);
	});
	afterAll(() => cleanupWorld(s.world));

	test("the drive is refused with exit 3 and no side effects", async () => {
		const outcomesBefore = eventsOf(s.handle).filter(
			(e) => e.name === RUN_EVENT_NAMES.outcome,
		).length;
		const out: string[] = [];
		const err: string[] = [];
		const exit = await driveRun({
			handle: s.handle,
			seams: s.world.seams,
			runCycle: async () => {
				throw new Error("never launched");
			},
			runReviews: neverReviews(),
			io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
		});
		expect(exit).toBe(3);
		expect(err.join("")).toContain("locked by live process");
		// The refused drive added no evidence: the Run is untouched.
		const outcomesAfter = eventsOf(s.handle).filter(
			(e) => e.name === RUN_EVENT_NAMES.outcome,
		).length;
		expect(outcomesAfter).toBe(outcomesBefore);
	});
});

describe("driveRun: an evidence-persistence failure escalates immediately", () => {
	let world: Awaited<ReturnType<typeof makeWorld>>;
	let handle: RunHandle;
	const launched: number[] = [];
	let exit: 0 | 1 | 2 | 3;

	beforeAll(async () => {
		world = await makeWorld(ISSUE, TITLE, [
			...bootstrapRules(),
			...escalationRules(),
		]);
		handle = startRun(world);
		// Sabotage the cycle-evidence directory: a plain file sits where the
		// cycle-1 evidence directory must be created.
		fs.writeFileSync(
			path.join(handle.artifactsDir, "cycle-1"),
			"not a directory\n",
		);
		const wt = worktreeFor(world);
		exit = await driveRun({
			handle,
			seams: world.seams,
			runCycle: async (cycle) => {
				launched.push(cycle);
				fs.writeFileSync(path.join(wt, "candidate.txt"), `cycle ${cycle}\n`);
				const add = await world.git(["add", "-A"], wt);
				if (add.exitCode !== 0) throw new Error(add.stderr);
				const commit = await world.git(
					["commit", "-m", `candidate for cycle ${cycle}`],
					wt,
				);
				if (commit.exitCode !== 0) throw new Error(commit.stderr);
				world.setRules([
					...handoffRules(),
					...escalationRules(),
					...baseRules(ISSUE, TITLE),
				]);
				return {
					status: "verified",
					cycle,
					verifyResults: [{ command: "bun test", ok: true }],
				};
			},
			runReviews: neverReviews(),
			io: { stdout: () => {}, stderr: () => {} },
		});
	});

	afterAll(() => cleanupWorld(world));

	test("the Run escalates with exit 2 instead of crashing", () => {
		expect(exit).toBe(2);
		const outcome = outcomeEvent(handle);
		expect(outcome?.payload.outcome).toBe("escalated");
		expect(outcome?.payload.stage).toBe("cycle");
		expect(outcome?.payload.cycle).toBe(1);
		expect(outcome?.payload.reason).toContain("cannot persist cycle evidence");
	});

	test("no further cycle launched — the evidence trail is broken", () => {
		expect(launched).toEqual([1]);
	});

	test("the completed cycle operation records the evidence refusal", () => {
		const completed = eventsOf(handle).find(
			(e) =>
				e.name === RUN_EVENT_NAMES.sideEffectCompleted &&
				e.payload.operation === "cycle",
		);
		expect(completed?.payload.status).toBe("verified");
		expect(completed?.payload.text).toContain(
			"EVIDENCE_REFUSAL: cannot persist cycle evidence",
		);
	});

	test("the Escalation comment names the persistence failure — exactly once", () => {
		const comments = world
			.argvLog()
			.filter((args) => args.includes("issue comment"));
		expect(comments).toHaveLength(1);
		expect(comments[0]).toContain("cannot persist cycle evidence");
	});
});
