/**
 * L1 tests for the read-only Status projection (ticket afk-kit #59): the
 * event stream is authoritative, `run.json` and the rendered groups are
 * replaceable projections folded from it. Grouping is the monitoring
 * boundary's four buckets — active, action-required, handed-over, and
 * recently merged.
 */

import { describe, expect, test } from "bun:test";
import { RUN_EVENT_NAMES, type RunEvent } from "./events.ts";
import { foldRunEvents, groupRuns, type RunSummary } from "./projection.ts";

let seq = 0;
function event(overrides: {
	name: string;
	payload?: Record<string, unknown>;
	ts?: string;
	cycle?: number | null;
	op?: string | null;
}): RunEvent {
	seq += 1;
	return {
		v: 1,
		seq,
		ts: overrides.ts ?? "2026-09-27T12:00:00.000Z",
		runId: "20260927T120000Z-abc123",
		repository: "juranki/afk-kit",
		ticket: 59,
		cycle: overrides.cycle ?? null,
		op: overrides.op ?? null,
		name: overrides.name,
		payload: overrides.payload ?? {},
		artifacts: [],
	};
}

describe("foldRunEvents", () => {
	test("an empty stream folds to a null summary", () => {
		expect(foldRunEvents([])).toBeNull();
	});

	test("derives identity, start, and latest event", () => {
		const summary = foldRunEvents([
			event({
				name: RUN_EVENT_NAMES.started,
				payload: { briefHash: "sha256-x" },
			}),
			event({
				name: RUN_EVENT_NAMES.stageEntered,
				payload: { stage: "readiness" },
				ts: "2026-09-27T12:01:00.000Z",
			}),
		]);
		expect(summary?.runId).toBe("20260927T120000Z-abc123");
		expect(summary?.repository).toBe("juranki/afk-kit");
		expect(summary?.ticket).toBe(59);
		expect(summary?.startedAt).toBe("2026-09-27T12:00:00.000Z");
		expect(summary?.briefHash).toBe("sha256-x");
		expect(summary?.stage).toBe("readiness");
		expect(summary?.lastActivityAt).toBe("2026-09-27T12:01:00.000Z");
		expect(summary?.latestEvent).toEqual({
			seq: 2,
			name: "stage.entered",
			ts: "2026-09-27T12:01:00.000Z",
		});
		expect(summary?.outcome).toBeNull();
	});

	test("merges run context facts with later facts winning", () => {
		const summary = foldRunEvents([
			event({
				name: RUN_EVENT_NAMES.context,
				payload: {
					branch: "issue-59-runs",
					worktree: "~/wt/afk-kit/issue-59-runs",
				},
			}),
			event({ name: RUN_EVENT_NAMES.context, payload: { pr: 63 } }),
		]);
		expect(summary?.branch).toBe("issue-59-runs");
		expect(summary?.worktree).toBe("~/wt/afk-kit/issue-59-runs");
		expect(summary?.pr).toBe(63);
	});

	test("tracks cycle identity", () => {
		const summary = foldRunEvents([
			event({
				name: RUN_EVENT_NAMES.cycleStarted,
				payload: { cycle: 2 },
				cycle: 2,
			}),
		]);
		expect(summary?.cycle).toBe(2);
	});

	test("records the terminal outcome", () => {
		const summary = foldRunEvents([
			event({
				name: RUN_EVENT_NAMES.outcome,
				payload: { outcome: "escalated", reason: "cap" },
			}),
		]);
		expect(summary?.outcome).toBe("escalated");
		expect(summary?.reason).toBe("cap");
	});

	test("ignores unknown event names but counts them as activity", () => {
		const summary = foldRunEvents([
			event({ name: RUN_EVENT_NAMES.started, payload: {} }),
			event({
				name: "something.new.v2",
				payload: { stage: "bogus" },
				ts: "2026-09-27T12:05:00.000Z",
			}),
		]);
		expect(summary?.stage).toBeNull();
		expect(summary?.outcome).toBeNull();
		expect(summary?.latestEvent?.name).toBe("something.new.v2");
	});
});

describe("groupRuns", () => {
	const NOW = new Date("2026-09-27T18:00:00.000Z");

	function summary(overrides: Partial<RunSummary>): RunSummary {
		return {
			runId: "r1",
			repository: "juranki/afk-kit",
			ticket: 59,
			startedAt: "2026-09-27T12:00:00.000Z",
			lastActivityAt: "2026-09-27T12:30:00.000Z",
			stage: null,
			cycle: null,
			outcome: null,
			outcomeAt: null,
			reason: null,
			pr: null,
			branch: null,
			worktree: null,
			briefHash: null,
			latestEvent: null,
			eventCount: 1,
			lockAlive: null,
			...overrides,
		};
	}

	test("live runs without an outcome are active", () => {
		const groups = groupRuns([summary({ lockAlive: true })], {
			now: NOW,
			mergedWindowDays: 30,
			mergedPrs: {},
		});
		expect(groups.active).toHaveLength(1);
		expect(groups.actionRequired).toHaveLength(0);
	});

	test("runs with a live lock but unknown liveness stay active", () => {
		const groups = groupRuns([summary({ lockAlive: null })], {
			now: NOW,
			mergedWindowDays: 30,
			mergedPrs: {},
		});
		expect(groups.active).toHaveLength(1);
	});

	test("refused and escalated runs need action", () => {
		const groups = groupRuns(
			[
				summary({ runId: "ref", outcome: "refused" }),
				summary({ runId: "esc", outcome: "escalated", reason: "cap" }),
			],
			{ now: NOW, mergedWindowDays: 30, mergedPrs: {} },
		);
		expect(groups.actionRequired.map((r) => r.runId).sort()).toEqual([
			"esc",
			"ref",
		]);
	});

	test("a dead lock without an outcome is interrupted — action required", () => {
		const groups = groupRuns([summary({ lockAlive: false })], {
			now: NOW,
			mergedWindowDays: 30,
			mergedPrs: {},
		});
		expect(groups.actionRequired).toHaveLength(1);
		expect(groups.active).toHaveLength(0);
	});

	test("handed-over runs await the maintainer", () => {
		const groups = groupRuns(
			[summary({ outcome: "handed-over-to-maintainer", pr: 63 })],
			{ now: NOW, mergedWindowDays: 30, mergedPrs: {} },
		);
		expect(groups.handedOver).toHaveLength(1);
		expect(groups.recentlyMerged).toHaveLength(0);
	});

	test("a handed-over PR merged inside the window is recently merged", () => {
		const groups = groupRuns(
			[summary({ outcome: "handed-over-to-maintainer", pr: 63 })],
			{
				now: NOW,
				mergedWindowDays: 30,
				mergedPrs: { 63: "2026-09-20T10:00:00.000Z" },
			},
		);
		expect(groups.recentlyMerged).toHaveLength(1);
		expect(groups.handedOver).toHaveLength(0);
	});

	test("a PR merged outside the window stays handed-over", () => {
		const groups = groupRuns(
			[summary({ outcome: "handed-over-to-maintainer", pr: 63 })],
			{
				now: NOW,
				mergedWindowDays: 30,
				mergedPrs: { 63: "2026-08-01T10:00:00.000Z" },
			},
		);
		expect(groups.handedOver).toHaveLength(1);
	});

	test("each group sorts by most recent activity", () => {
		const groups = groupRuns(
			[
				summary({ runId: "old", lastActivityAt: "2026-09-27T12:00:00.000Z" }),
				summary({ runId: "new", lastActivityAt: "2026-09-27T17:00:00.000Z" }),
			],
			{ now: NOW, mergedWindowDays: 30, mergedPrs: {} },
		);
		expect(groups.active.map((r) => r.runId)).toEqual(["new", "old"]);
	});
});
