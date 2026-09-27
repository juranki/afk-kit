/**
 * L2 seam-integration tests for the crash reconciler (ticket afk-kit #65,
 * code-verify standard): a Run whose process died with an unfinished lock
 * converges to one durable, inspectable result — uncertain side effects
 * are classified against the real tracker and Git state, the interruption
 * Escalation is materialized idempotently, and nothing is ever duplicated
 * or resumed. The tracker seam is a stub `gh` on PATH, Git runs against a
 * local bare remote; the environment is swapped, never the code.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { slugFor } from "../../extensions/coordinator/slug.ts";
import { cleanupWorld, type GhRule, makeWorld } from "../test-world.ts";
import { RUN_EVENT_NAMES, type RunEvent, readRunEvents } from "./events.ts";
import { finalizeInterruptedRun, unmatchedIntents } from "./reconcile.ts";
import {
	createRun,
	type RunHandle,
	readRunLock,
	recordEvent,
} from "./store.ts";

const ISSUE = 65;
const TITLE = "Reconcile interrupted Runs and uncertain side effects";
const BRANCH = `issue-${ISSUE}-${slugFor(TITLE)}`;
const OWNER = "test";
const REPO = "repo";

function stateRoot(world: Awaited<ReturnType<typeof makeWorld>>): string {
	return path.join(world.root, "state");
}

function createRunIn(world: Awaited<ReturnType<typeof makeWorld>>): RunHandle {
	return createRun({
		stateRoot: stateRoot(world),
		owner: OWNER,
		repo: REPO,
		ticket: ISSUE,
		brief: "brief",
	});
}

/** A lock held by a process that is certainly dead. */
function deadLock(handle: RunHandle): void {
	fs.writeFileSync(
		handle.lockPath,
		JSON.stringify({
			pid: 2147479999,
			token: "dead",
			startedAt: "2026-09-27T12:00:00Z",
		}),
		{ mode: 0o600 },
	);
}

function eventsOf(handle: RunHandle): RunEvent[] {
	return readRunEvents(handle.eventsPath).events;
}

function commentCount(world: Awaited<ReturnType<typeof makeWorld>>): number {
	return world.argvLog().filter((args) => args.startsWith("issue comment"))
		.length;
}

/** Seed the journal the way an interrupted drive leaves it. */
function seedInterruptedRun(handle: RunHandle, opIds: string[]): void {
	recordEvent(handle, {
		name: RUN_EVENT_NAMES.stageEntered,
		payload: { stage: "cycle" },
	});
	recordEvent(handle, {
		name: RUN_EVENT_NAMES.cycleStarted,
		payload: { cycle: 1 },
		cycle: 1,
	});
	recordEvent(handle, {
		name: RUN_EVENT_NAMES.context,
		payload: { branch: BRANCH, worktree: `/tmp/wt/${REPO}/${BRANCH}` },
	});
	for (const op of opIds) {
		const operation = op.split(":")[0];
		recordEvent(handle, {
			name: RUN_EVENT_NAMES.sideEffectIntent,
			payload: {
				operation,
				// The tracker/Git ops name their branch in the intent.
				...(operation === "claim" || operation === "escalate"
					? {}
					: { branch: BRANCH }),
			},
			op,
			cycle: operation === "cycle" || operation === "review" ? 1 : null,
		});
	}
}

/** The tracker rules a claimable-but-claimed issue presents. */
function issueRules(extra: GhRule[] = []): GhRule[] {
	return [
		// A test's overrides shadow the defaults: earlier stub rules win.
		...extra,
		{
			args: ["issue", "view", String(ISSUE), "--json", "assignees,labels"],
			json: {
				assignees: [{ login: "maintainer" }],
				labels: [{ name: "ready-for-agent" }, { name: "in-progress" }],
			},
		},
		{
			args: ["issue", "view", String(ISSUE), "--json", "labels"],
			json: { labels: [{ name: "ready-for-agent" }, { name: "in-progress" }] },
		},
		{ args: ["issue", "comment", String(ISSUE)], json: {} },
		{
			args: ["issue", "edit", String(ISSUE), "--add-label", "needs-info"],
			json: {},
		},
	];
}

describe("unmatchedIntents (L1)", () => {
	test("an intent without a matching completed is uncertain", () => {
		const events: RunEvent[] = [
			{
				...blankEvent(1),
				name: RUN_EVENT_NAMES.sideEffectIntent,
				op: "claim:65",
				payload: { operation: "claim" },
			},
			{
				...blankEvent(2),
				name: RUN_EVENT_NAMES.sideEffectCompleted,
				op: "claim:65",
				payload: { operation: "claim", status: "claimed" },
			},
			{
				...blankEvent(3),
				name: RUN_EVENT_NAMES.sideEffectIntent,
				op: "bootstrap:65",
				payload: { operation: "bootstrap", branch: BRANCH },
			},
		];
		const unmatched = unmatchedIntents(events);
		expect(unmatched.map((op) => op.op)).toEqual(["bootstrap:65"]);
	});

	test("every matched pair is dropped", () => {
		const events: RunEvent[] = [
			{
				...blankEvent(1),
				name: RUN_EVENT_NAMES.sideEffectIntent,
				op: "claim:65",
				payload: {},
			},
			{
				...blankEvent(2),
				name: RUN_EVENT_NAMES.sideEffectCompleted,
				op: "claim:65",
				payload: {},
			},
		];
		expect(unmatchedIntents(events)).toEqual([]);
	});
});

function blankEvent(seq: number): RunEvent {
	return {
		v: 1,
		seq,
		ts: "2026-09-27T12:00:00Z",
		runId: "r",
		repository: `${OWNER}/${REPO}`,
		ticket: ISSUE,
		cycle: null,
		op: null,
		name: "run.notice",
		payload: {},
		artifacts: [],
	};
}

describe("finalizeInterruptedRun: the dead-lock Run converges (ticket #65)", () => {
	test("an exact-expected claim is accepted, the Escalation materialized once", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			const events = eventsOf(handle);
			// The uncertain claim was settled against the tracker state.
			const completed = events.find(
				(e) =>
					e.name === RUN_EVENT_NAMES.sideEffectCompleted &&
					e.op === `claim:${ISSUE}`,
			);
			expect(completed?.payload.status).toBe("settled");
			// The interruption Escalation: one comment, needs-info on,
			// in-progress off, terminal outcome recorded.
			expect(commentCount(world)).toBe(1);
			expect(world.argvLog().some((c) => c.includes("needs-info"))).toBe(true);
			expect(
				world
					.argvLog()
					.some(
						(c) => c.includes("--remove-label") && c.includes("in-progress"),
					),
			).toBe(true);
			const outcome = events.find((e) => e.name === RUN_EVENT_NAMES.outcome);
			expect(outcome?.payload.outcome).toBe("escalated");
			expect(String(outcome?.payload.reason)).toContain("interrupted");
			// The escalation speaks through its own intent/completed pair.
			expect(
				events.some(
					(e) =>
						e.name === RUN_EVENT_NAMES.sideEffectCompleted &&
						e.op === `escalate:${ISSUE}`,
				),
			).toBe(true);
			// The lock was taken over and released.
			expect(readRunLock(handle)).toBeNull();
		} finally {
			await cleanupWorld(world);
		}
	});

	test("an absent claim is left absent — no state is created for a dead Run", async () => {
		const world = await makeWorld(
			ISSUE,
			TITLE,
			issueRules([
				{
					args: ["issue", "view", String(ISSUE), "--json", "assignees,labels"],
					json: {
						assignees: [],
						labels: [{ name: "ready-for-agent" }],
					},
				},
			]),
		);
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			const completed = eventsOf(handle).find(
				(e) =>
					e.name === RUN_EVENT_NAMES.sideEffectCompleted &&
					e.op === `claim:${ISSUE}`,
			);
			expect(completed?.payload.status).toBe("absent");
			// Nothing was claimed on the dead Run's behalf.
			expect(world.argvLog().some((c) => c.includes("--add-assignee"))).toBe(
				false,
			);
			expect(commentCount(world)).toBe(1);
		} finally {
			await cleanupWorld(world);
		}
	});

	test("a conflicting tracker state is Escalated as uncertain, not mutated", async () => {
		const world = await makeWorld(
			ISSUE,
			TITLE,
			issueRules([
				{
					args: ["issue", "view", String(ISSUE), "--json", "assignees,labels"],
					json: {
						// Assigned to someone else with no in-progress marker: the
						// claim's expected state matches neither branch.
						assignees: [{ login: "someone-else" }],
						labels: [{ name: "ready-for-agent" }],
					},
				},
			]),
		);
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			const outcome = eventsOf(handle).find(
				(e) => e.name === RUN_EVENT_NAMES.outcome,
			);
			expect(String(outcome?.payload.reason)).toContain("someone-else");
			// The conflicting state was left exactly as found.
			expect(world.argvLog().some((c) => c.includes("--remove-assignee"))).toBe(
				false,
			);
		} finally {
			await cleanupWorld(world);
		}
	});

	test("an absent draft PR is not created; the absent push is not pushed", async () => {
		const world = await makeWorld(
			ISSUE,
			TITLE,
			issueRules([
				{
					args: [
						"pr",
						"list",
						"--head",
						BRANCH,
						"--state",
						"open",
						"--json",
						"number,isDraft",
					],
					json: [],
				},
			]),
		);
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [
				`bootstrap:${ISSUE}`,
				`candidate-push:${ISSUE}`,
			]);
			// The candidate branch does not exist on the remote either: the
			// bare remote's heads stay untouched.

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			const events = eventsOf(handle);
			const bootstrap = events.find(
				(e) =>
					e.op === `bootstrap:${ISSUE}` &&
					e.name === RUN_EVENT_NAMES.sideEffectCompleted,
			);
			const push = events.find(
				(e) =>
					e.op === `candidate-push:${ISSUE}` &&
					e.name === RUN_EVENT_NAMES.sideEffectCompleted,
			);
			expect(bootstrap?.payload.status).toBe("absent");
			expect(push?.payload.status).toBe("absent");
			expect(world.argvLog().some((c) => c.startsWith("pr create"))).toBe(
				false,
			);
		} finally {
			await cleanupWorld(world);
		}
	});

	test("a settled candidate push is accepted without pushing again", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`candidate-push:${ISSUE}`]);
			// The push did happen: the branch is on the remote.
			const worktree = path.join(world.worktreeRoot, "remote", BRANCH);
			await world.git(
				["worktree", "add", "-b", BRANCH, worktree, world.originMainSha],
				world.checkout,
			);
			fs.writeFileSync(path.join(worktree, "work.txt"), "work\n");
			await world.git(["add", "-A"], worktree);
			await world.git(["commit", "-m", "candidate"], worktree);
			await world.git(["push", "origin", BRANCH], worktree);
			const headsBefore = await world.git(["ls-remote", world.bare]);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			const push = eventsOf(handle).find(
				(e) =>
					e.op === `candidate-push:${ISSUE}` &&
					e.name === RUN_EVENT_NAMES.sideEffectCompleted,
			);
			expect(push?.payload.status).toBe("settled");
			const headsAfter = await world.git(["ls-remote", world.bare]);
			expect(headsAfter.stdout).toBe(headsBefore.stdout);
		} finally {
			await cleanupWorld(world);
		}
	});

	test("a cut-off cycle session carries no external side effects to reconcile", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`cycle:${ISSUE}:1`]);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			const completed = eventsOf(handle).find(
				(e) =>
					e.op === `cycle:${ISSUE}:1` &&
					e.name === RUN_EVENT_NAMES.sideEffectCompleted,
			);
			expect(completed?.payload.status).toBe("interrupted");
		} finally {
			await cleanupWorld(world);
		}
	});

	test("an already-terminal Run is a no-op — nothing is re-escalated", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);
			recordEvent(handle, {
				name: RUN_EVENT_NAMES.outcome,
				payload: { outcome: "escalated", reason: "earlier materialization" },
			});
			const before = eventsOf(handle);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			expect(eventsOf(handle)).toHaveLength(before.length);
			expect(commentCount(world)).toBe(0);
		} finally {
			await cleanupWorld(world);
		}
	});

	test("a lock-less unfinished Run is untouched — a maintainer clears it", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);
			const before = eventsOf(handle);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			expect(eventsOf(handle)).toHaveLength(before.length);
			expect(commentCount(world)).toBe(0);
		} finally {
			await cleanupWorld(world);
		}
	});

	test("a live lock is untouched — an active Run is not interrupted", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);
			fs.writeFileSync(
				handle.lockPath,
				JSON.stringify({ pid: process.pid, token: "live", startedAt: "x" }),
				{ mode: 0o600 },
			);
			const before = eventsOf(handle);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			expect(eventsOf(handle)).toHaveLength(before.length);
			expect(commentCount(world)).toBe(0);
			expect(readRunLock(handle)?.token).toBe("live");
		} finally {
			await cleanupWorld(world);
		}
	});

	test("repeated reconciliation materializes exactly one comment and one outcome", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });
			const afterFirst = eventsOf(handle);
			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			expect(eventsOf(handle)).toHaveLength(afterFirst.length);
			expect(commentCount(world)).toBe(1);
		} finally {
			await cleanupWorld(world);
		}
	});

	test("a corrupt journal still escalates in the tracker — the comment is the record", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);
			// Interior corruption: parseable JSON that is not an event.
			fs.appendFileSync(handle.eventsPath, '{"broken": true}\n');

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			expect(commentCount(world)).toBe(1);
			const comment = world
				.argvLog()
				.find((c) => c.startsWith("issue comment"));
			expect(comment).toContain("corrupt");
			expect(world.argvLog().some((c) => c.includes("needs-info"))).toBe(true);
		} finally {
			await cleanupWorld(world);
		}
	});

	test("the Escalation preserves the Run facts the journal learned", async () => {
		const world = await makeWorld(ISSUE, TITLE, issueRules());
		try {
			const handle = createRunIn(world);
			deadLock(handle);
			seedInterruptedRun(handle, [`claim:${ISSUE}`]);
			recordEvent(handle, {
				name: RUN_EVENT_NAMES.context,
				payload: { pr: 99 },
			});

			await finalizeInterruptedRun(handle.dir, { seams: world.seams });

			const comment = world
				.argvLog()
				.find((c) => c.startsWith("issue comment"));
			expect(comment).toContain(BRANCH);
			expect(comment).toContain(`/tmp/wt/${REPO}/${BRANCH}`);
			expect(comment).toContain("#99");
			expect(comment).toContain(handle.dir);
		} finally {
			await cleanupWorld(world);
		}
	});
});
