/**
 * L2 seam-integration tests for the Run store (ticket afk-kit #59): real
 * filesystem in a temp XDG state home — owner-only permissions, the
 * immutable brief snapshot and its hash, the per-Run lock (live, held, and
 * stale), the artifact layout that retains all evidence, and the
 * replaceable `run.json` projection that trails the authoritative events.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUN_EVENT_NAMES, readRunEvents } from "./events.ts";
import {
	acquireRunLock,
	artifactDir,
	createRun,
	openRun,
	pidAlive,
	type RunHandle,
	RunStoreError,
	readRunLock,
	recordEvent,
	releaseRunLock,
	runIdFor,
} from "./store.ts";

function stateRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "afk-state-"));
}

function makeRun(root = stateRoot()): { root: string; handle: RunHandle } {
	const handle = createRun({
		stateRoot: root,
		owner: "juranki",
		repo: "afk-kit",
		ticket: 59,
		brief: "# Agent brief\n\nSummary: persist runs.\n",
		now: () => new Date("2026-09-27T12:00:00Z"),
	});
	return { root, handle };
}

describe("runIdFor", () => {
	test("is sortable UTC timestamp plus random suffix", () => {
		const id = runIdFor(
			() => new Date("2026-09-27T12:00:00Z"),
			() => "a1b2c3",
		);
		expect(id).toBe("20260927T120000Z-a1b2c3");
	});
});

describe("createRun", () => {
	test("creates the XDG hierarchy with owner-only permissions", () => {
		const { root, handle } = makeRun();
		const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		expect(handle.dir).toMatch(
			new RegExp(
				`^${escaped}/github.com/juranki/afk-kit/issues/59/runs/20260927T120000Z-[0-9a-f]{6}$`,
			),
		);
		expect(fs.statSync(handle.dir).mode & 0o777).toBe(0o700);
		expect(
			fs.statSync(path.dirname(path.dirname(handle.dir))).mode & 0o777,
		).toBe(0o700);
		expect(fs.statSync(handle.artifactsDir).mode & 0o777).toBe(0o700);
	});

	test("snapshots the brief immutably and records its hash", () => {
		const { handle } = makeRun();
		const snapshot = fs.readFileSync(handle.briefPath, "utf8");
		expect(snapshot).toBe("# Agent brief\n\nSummary: persist runs.\n");
		expect(fs.statSync(handle.briefPath).mode & 0o777).toBe(0o600);
		const expected = createHash("sha256").update(snapshot).digest("hex");
		expect(handle.briefHash).toBe(expected);
		const briefMeta = JSON.parse(
			fs.readFileSync(path.join(handle.dir, "brief.json"), "utf8"),
		);
		expect(briefMeta.hash).toBe(expected);
		expect(briefMeta.bytes).toBe(Buffer.byteLength(snapshot));
	});

	test("opens the stream with run.started as event 1", async () => {
		const { handle } = makeRun();
		const { events } = await readRunEvents(handle.eventsPath);
		expect(events).toHaveLength(1);
		expect(events[0]?.name).toBe(RUN_EVENT_NAMES.started);
		expect(events[0]?.seq).toBe(1);
		expect(events[0]?.payload.briefHash).toBe(handle.briefHash);
		expect(fs.statSync(handle.eventsPath).mode & 0o777).toBe(0o600);
	});

	test("writes the initial run.json projection", () => {
		const { handle } = makeRun();
		const projection = JSON.parse(
			fs.readFileSync(handle.projectionPath, "utf8"),
		);
		expect(projection.runId).toBe(handle.runId);
		expect(projection.repository).toBe("juranki/afk-kit");
		expect(projection.ticket).toBe(59);
		expect(projection.outcome).toBeNull();
	});
});

describe("openRun", () => {
	test("reopens an existing run and verifies the brief hash", () => {
		const { handle } = makeRun();
		const reopened = openRun(handle.dir);
		expect(reopened.briefHash).toBe(handle.briefHash);
		expect(reopened.ticket).toBe(59);
	});

	test("refuses a tampered brief snapshot", () => {
		const { handle } = makeRun();
		fs.writeFileSync(handle.briefPath, "rewritten by someone\n");
		expect(() => openRun(handle.dir)).toThrow(RunStoreError);
		try {
			openRun(handle.dir);
		} catch (error) {
			expect((error as RunStoreError).code).toBe("brief-tampered");
		}
	});

	test("refuses a directory that is not a run", () => {
		expect(() => openRun("/tmp")).toThrow(RunStoreError);
	});
});

describe("locking", () => {
	test("acquire records the pid; release removes the lock", () => {
		const { handle } = makeRun();
		const lock = acquireRunLock(handle);
		const stored = JSON.parse(fs.readFileSync(handle.lockPath, "utf8"));
		expect(stored.pid).toBe(process.pid);
		expect(readRunLock(handle)?.pid).toBe(process.pid);
		releaseRunLock(lock, handle);
		expect(fs.existsSync(handle.lockPath)).toBeFalse();
		expect(readRunLock(handle)).toBeNull();
	});

	test("a second acquire while held is refused", () => {
		const { handle } = makeRun();
		const lock = acquireRunLock(handle);
		try {
			acquireRunLock(handle);
			expect.unreachable();
		} catch (error) {
			expect((error as RunStoreError).code).toBe("lock-held");
		}
		releaseRunLock(lock);
	});

	test("a stale lock from a dead pid is reported, not held", () => {
		const { handle } = makeRun();
		fs.writeFileSync(
			handle.lockPath,
			JSON.stringify({
				pid: 2147479999,
				token: "dead",
				startedAt: "2026-09-27T12:00:00Z",
			}),
			{ mode: 0o600 },
		);
		expect(() => acquireRunLock(handle)).toThrow(RunStoreError);
		try {
			acquireRunLock(handle);
		} catch (error) {
			expect((error as RunStoreError).code).toBe("stale-lock");
		}
	});

	test("release only removes the lock this process acquired", () => {
		const { handle } = makeRun();
		fs.writeFileSync(
			handle.lockPath,
			JSON.stringify({
				pid: 2147479999,
				token: "foreign",
				startedAt: "2026-09-27T12:00:00Z",
			}),
			{ mode: 0o600 },
		);
		// Documented recovery path: a stale lock may be stolen explicitly (the
		// crash reconciler does exactly this in ticket #65).
		const stolen = acquireRunLock(handle, { stealStale: true });
		expect(readRunLock(handle)?.token).toBe(stolen.token);
		releaseRunLock(stolen, handle);
		expect(fs.existsSync(handle.lockPath)).toBeFalse();
	});
});

describe("recordEvent", () => {
	test("appends the event and advances the run.json projection", async () => {
		const { handle } = makeRun();
		recordEvent(handle, {
			name: RUN_EVENT_NAMES.stageEntered,
			payload: { stage: "readiness" },
		});
		recordEvent(handle, {
			name: RUN_EVENT_NAMES.outcome,
			payload: { outcome: "refused", reason: "readiness failed" },
		});
		const { events } = await readRunEvents(handle.eventsPath);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);

		const projection = JSON.parse(
			fs.readFileSync(handle.projectionPath, "utf8"),
		);
		expect(projection.stage).toBe("readiness");
		expect(projection.outcome).toBe("refused");
		expect(projection.reason).toBe("readiness failed");
		expect(projection.latestEvent.seq).toBe(3);
	});

	test("fills identity from the handle", async () => {
		const { handle } = makeRun();
		const event = recordEvent(handle, {
			name: RUN_EVENT_NAMES.cycleStarted,
			cycle: 1,
			payload: { cycle: 1 },
		});
		expect(event.runId).toBe(handle.runId);
		expect(event.repository).toBe("juranki/afk-kit");
		expect(event.ticket).toBe(59);
		expect(event.cycle).toBe(1);
	});
});

describe("artifact layout", () => {
	test("creates nested evidence directories under artifacts/", () => {
		const { handle } = makeRun();
		const dir = artifactDir(handle, "cycles", "2", "verify");
		expect(dir).toBe(path.join(handle.artifactsDir, "cycles", "2", "verify"));
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
		// The layout retains complete SDK, Verify, Verdict, and Escalation
		// evidence; nothing in the store deletes.
		artifactDir(handle, "cycles", "2", "sdk");
		artifactDir(handle, "cycles", "2", "verdict");
		artifactDir(handle, "escalation");
		expect(fs.readdirSync(handle.artifactsDir).sort()).toEqual([
			"cycles",
			"escalation",
		]);
	});

	test("rejects traversal outside artifacts/", () => {
		const { handle } = makeRun();
		expect(() => artifactDir(handle, "..")).toThrow(/traversal/);
	});
});

describe("pidAlive", () => {
	test("this process is alive; an implausible pid is not", () => {
		expect(pidAlive(process.pid)).toBeTrue();
		expect(pidAlive(2147479999)).toBeFalse();
	});
});
