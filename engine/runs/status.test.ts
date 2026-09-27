/**
 * Tests for `afk status` (ticket afk-kit #59), two layers per the
 * code-verify standard:
 *
 * - L1: origin parsing, duration formatting, and text rendering — pure.
 * - L2: the status collector against real filesystem state and the real
 *   `git` binary for origin resolution, with an injected read-only PR
 *   lookup standing in for `gh` — the environment is swapped, never the
 *   code. The hard-interruption finalization seam is proven to re-read
 *   after mutating.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUN_EVENT_NAMES, type RunEvent, type RunSummary } from "./events.ts";
import { foldRunEvents } from "./projection.ts";
import {
	collectStatus,
	formatDuration,
	parseOriginUrl,
	renderStatus,
	resolveRepository,
} from "./status.ts";
import { acquireRunLock, createRun, recordEvent } from "./store.ts";

describe("parseOriginUrl", () => {
	test("parses ssh remotes", () => {
		expect(parseOriginUrl("git@github.com:juranki/afk-kit.git")).toEqual({
			owner: "juranki",
			repo: "afk-kit",
		});
	});

	test("parses https remotes", () => {
		expect(parseOriginUrl("https://github.com/juranki/afk-kit")).toEqual({
			owner: "juranki",
			repo: "afk-kit",
		});
	});

	test("parses ssh:// scheme remotes", () => {
		expect(parseOriginUrl("ssh://git@github.com/juranki/afk-kit.git")).toEqual({
			owner: "juranki",
			repo: "afk-kit",
		});
	});

	test("refuses non-GitHub hosts", () => {
		expect(parseOriginUrl("git@gitlab.com:juranki/afk-kit.git")).toBeNull();
		expect(
			parseOriginUrl("https://example.com/juranki/afk-kit.git"),
		).toBeNull();
	});

	test("refuses malformed remotes", () => {
		expect(parseOriginUrl("not a remote")).toBeNull();
		expect(parseOriginUrl("https://github.com/only-owner")).toBeNull();
	});
});

describe("formatDuration", () => {
	test("renders minutes, hours, and days", () => {
		expect(formatDuration(0, 30_000)).toBe("<1m");
		expect(formatDuration(0, 5 * 60_000)).toBe("5m");
		expect(formatDuration(0, 2 * 3_600_000 + 13 * 60_000)).toBe("2h 13m");
		expect(formatDuration(0, 3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
	});
});

let lineSeq = 0;
function lineEvent(overrides: {
	name: string;
	payload?: Record<string, unknown>;
	ts?: string;
}): RunEvent {
	lineSeq += 1;
	return {
		v: 1,
		seq: lineSeq,
		ts: overrides.ts ?? "2026-09-27T12:00:00.000Z",
		runId: "20260927T120000Z-abc123",
		repository: "juranki/afk-kit",
		ticket: 59,
		cycle: null,
		op: null,
		name: overrides.name,
		payload: overrides.payload ?? {},
		artifacts: [],
	};
}

describe("renderStatus", () => {
	const NOW = new Date("2026-09-27T13:00:00.000Z");

	test("says when no runs exist", () => {
		const text = renderStatus({
			repository: { owner: "juranki", repo: "afk-kit" },
			ticket: undefined,
			now: NOW,
			entries: [],
			groups: {
				active: [],
				actionRequired: [],
				handedOver: [],
				recentlyMerged: [],
			},
		});
		expect(text).toContain("no runs");
		expect(text).toContain("github.com/juranki/afk-kit");
	});

	test("renders the four groups with stage, outcome, cycle, elapsed, and path", () => {
		const fold = (events: RunEvent[]): RunSummary => {
			const summary = foldRunEvents(events);
			if (summary === null) throw new Error("fixture must fold");
			return summary;
		};
		const active = fold([
			lineEvent({ name: RUN_EVENT_NAMES.started }),
			lineEvent({
				name: RUN_EVENT_NAMES.cycleStarted,
				payload: { cycle: 2 },
				ts: "2026-09-27T12:30:00.000Z",
			}),
		]);
		active.lockAlive = true;
		const escalated = fold([
			lineEvent({ name: RUN_EVENT_NAMES.started }),
			lineEvent({
				name: RUN_EVENT_NAMES.outcome,
				payload: { outcome: "escalated", reason: "cycle cap" },
				ts: "2026-09-27T12:45:00.000Z",
			}),
		]);
		escalated.lockAlive = null;
		const handedOver = fold([
			lineEvent({ name: RUN_EVENT_NAMES.started }),
			lineEvent({
				name: RUN_EVENT_NAMES.context,
				payload: {
					pr: 63,
					branch: "issue-59-runs",
					worktree: "~/wt/afk-kit/issue-59-runs",
				},
			}),
			lineEvent({
				name: RUN_EVENT_NAMES.outcome,
				payload: { outcome: "handed-over-to-maintainer" },
				ts: "2026-09-27T12:50:00.000Z",
			}),
		]);
		handedOver.lockAlive = null;

		const text = renderStatus({
			repository: { owner: "juranki", repo: "afk-kit" },
			ticket: undefined,
			now: NOW,
			entries: [
				{ dir: "/state/runs/active", summary: active },
				{ dir: "/state/runs/esc", summary: escalated },
				{ dir: "/state/runs/hand", summary: handedOver },
			],
			groups: {
				active: [active],
				actionRequired: [escalated],
				handedOver: [handedOver],
				recentlyMerged: [],
			},
		});

		expect(text).toContain("ACTIVE");
		expect(text).toContain("ACTION REQUIRED");
		expect(text).toContain("HANDED OVER");
		expect(text).toContain("#59");
		expect(text).toContain("cycle 2");
		expect(text).toContain("escalated");
		expect(text).toContain("cycle cap");
		expect(text).toContain("handed-over-to-maintainer");
		expect(text).toContain("pr #63");
		expect(text).toContain("branch issue-59-runs");
		expect(text).toContain("/state/runs/active");
		// started 12:00, last activity 12:30, now 13:00 → elapsed 1h for active
		expect(text).toContain("1h 0m");
	});

	test("marks a stream with dropped torn bytes", () => {
		const fold = (events: RunEvent[]): RunSummary => {
			const summary = foldRunEvents(events);
			if (summary === null) throw new Error("fixture must fold");
			return summary;
		};
		const summary = fold([lineEvent({ name: RUN_EVENT_NAMES.started })]);
		const text = renderStatus({
			repository: { owner: "juranki", repo: "afk-kit" },
			ticket: undefined,
			now: NOW,
			entries: [{ dir: "/state/runs/x", summary, truncated: true }],
			groups: {
				active: [summary],
				actionRequired: [],
				handedOver: [],
				recentlyMerged: [],
			},
		});
		expect(text).toContain("truncated");
	});

	test("renders an unreadable run without losing the report", () => {
		const text = renderStatus({
			repository: { owner: "juranki", repo: "afk-kit" },
			ticket: undefined,
			now: NOW,
			entries: [
				{
					dir: "/state/afk/github.com/juranki/afk-kit/issues/59/runs/broken",
					error: "boom",
				},
			],
			groups: {
				active: [],
				actionRequired: [],
				handedOver: [],
				recentlyMerged: [],
			},
		});
		expect(text).toContain("unreadable");
		expect(text).toContain("boom");
		expect(text).toContain("issues/59/runs/broken");
	});
});

function stateRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "afk-status-"));
}

function gitInit(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-repo-"));
	const env = {
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	for (const args of [
		["init", "-b", "main"],
		["remote", "add", "origin", "git@github.com:juranki/afk-kit.git"],
	]) {
		Bun.spawnSync(["git", ...args], { cwd: dir, env });
	}
	return dir;
}

describe("resolveRepository", () => {
	test("parses the origin remote of a real repository", async () => {
		const checkout = gitInit();
		const repo = await resolveRepository(checkout);
		expect(repo).toEqual({ owner: "juranki", repo: "afk-kit" });
	});

	test("refuses a repository without a GitHub origin", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-norepo-"));
		Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
		expect(resolveRepository(dir)).rejects.toThrow(/origin/);
	});
});

describe("collectStatus", () => {
	test("groups a live run, an escalated run, and filters by ticket", async () => {
		const root = stateRoot();
		const active = createRun({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			ticket: 59,
			brief: "brief",
		});
		acquireRunLock(active);
		recordEvent(active, {
			name: RUN_EVENT_NAMES.cycleStarted,
			cycle: 1,
			payload: { cycle: 1 },
		});

		const done = createRun({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			ticket: 51,
			brief: "brief",
		});
		recordEvent(done, {
			name: RUN_EVENT_NAMES.outcome,
			payload: { outcome: "escalated", reason: "cap" },
		});

		const report = await collectStatus({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			prLookup: null,
		});
		expect(report.groups.active.map((r) => r.ticket)).toEqual([59]);
		expect(report.groups.actionRequired.map((r) => r.ticket)).toEqual([51]);
		expect(report.groups.active[0]?.cycle).toBe(1);
		expect(report.groups.active[0]?.lockAlive).toBeTrue();

		const single = await collectStatus({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			ticket: 51,
			prLookup: null,
		});
		expect(single.groups.active).toHaveLength(0);
		expect(single.groups.actionRequired).toHaveLength(1);
	});

	test("a dead lock without an outcome is action-required and reaches the seam", async () => {
		const root = stateRoot();
		const crashed = createRun({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			ticket: 59,
			brief: "brief",
		});
		fs.writeFileSync(
			crashed.lockPath,
			JSON.stringify({
				pid: 2147479999,
				token: "dead",
				startedAt: "2026-09-27T12:00:00Z",
			}),
			{ mode: 0o600 },
		);

		const withoutSeam = await collectStatus({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			prLookup: null,
		});
		expect(withoutSeam.groups.actionRequired).toHaveLength(1);

		const seamDirs: string[] = [];
		const withSeam = await collectStatus({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			prLookup: null,
			// The separately specified hard-interruption finalization seam
			// (#65): mutate durable state, the collector re-reads afterwards.
			finalizeInterrupted: async (dir) => {
				seamDirs.push(dir);
				const reopened = { ...crashed, dir };
				recordEvent(reopened, {
					name: RUN_EVENT_NAMES.outcome,
					payload: { outcome: "escalated", reason: "interrupted" },
				});
			},
		});
		expect(seamDirs).toEqual([crashed.dir]);
		expect(withSeam.groups.actionRequired).toHaveLength(1);
		expect(withSeam.groups.actionRequired[0]?.outcome).toBe("escalated");
	});

	test("an unreadable run renders as an error entry, the rest survive", async () => {
		const root = stateRoot();
		createRun({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			ticket: 59,
			brief: "brief",
		});
		const brokenDir = path.join(
			root,
			"github.com",
			"juranki",
			"afk-kit",
			"issues",
			"7",
			"runs",
			"broken",
		);
		fs.mkdirSync(brokenDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(brokenDir, "events.jsonl"), '{"hello":1}\n');

		const report = await collectStatus({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			prLookup: null,
		});
		expect(report.groups.active).toHaveLength(1);
		expect(report.entries.filter((e) => e.error)).toHaveLength(1);
		expect(report.entries.find((e) => e.error)?.dir).toBe(brokenDir);
	});

	test("an empty state root is an empty report, not an error", async () => {
		const root = stateRoot();
		const report = await collectStatus({
			stateRoot: root,
			owner: "juranki",
			repo: "afk-kit",
			prLookup: null,
		});
		expect(report.entries).toEqual([]);
		expect(report.groups.active).toHaveLength(0);
	});
});
