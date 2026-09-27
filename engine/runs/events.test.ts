/**
 * Contract tests for the versioned Run event stream (ticket afk-kit #59,
 * durable spec #46): append-only JSONL, monotonic sequence, full Run/
 * repository/Ticket/cycle identity, operation identity for side-effect
 * intent/completed pairs, typed payloads, and run-relative artifact
 * references. Readers tolerate unknown event names and an incomplete final
 * line — a torn write must never corrupt the evidence before it.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendRunEvent,
	RUN_EVENT_NAMES,
	type RunEvent,
	readRunEvents,
} from "./events.ts";

function tmpFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-events-"));
	return path.join(dir, "events.jsonl");
}

const BASE = {
	runId: "20260927T120000Z-abc123",
	repository: "juranki/afk-kit",
	ticket: 59,
} as const;

function input(overrides: Partial<Parameters<typeof appendRunEvent>[1]> = {}) {
	return {
		...BASE,
		name: RUN_EVENT_NAMES.stageEntered,
		payload: { stage: "cycle" },
		...overrides,
	};
}

describe("appendRunEvent", () => {
	test("assigns a monotonic sequence and full identity", async () => {
		const file = tmpFile();
		const first = await appendRunEvent(
			file,
			input(),
			() => new Date("2026-09-27T12:00:00Z"),
		);
		const second = await appendRunEvent(
			file,
			input(),
			() => new Date("2026-09-27T12:01:00Z"),
		);

		expect(first.seq).toBe(1);
		expect(second.seq).toBe(2);
		expect(first.ts).toBe("2026-09-27T12:00:00.000Z");
		for (const event of [first, second]) {
			expect(event.v).toBe(1);
			expect(event.runId).toBe(BASE.runId);
			expect(event.repository).toBe(BASE.repository);
			expect(event.ticket).toBe(BASE.ticket);
			expect(event.name).toBe("stage.entered");
		}
	});

	test("records cycle identity, operation identity, and artifact references", async () => {
		const file = tmpFile();
		const event = await appendRunEvent(
			file,
			input({
				cycle: 2,
				op: "verify:issue-59:cycle-2",
				name: RUN_EVENT_NAMES.sideEffectCompleted,
				payload: { operation: "verify" },
				artifacts: ["artifacts/cycles/2/verify/exit-codes.json"],
			}),
			() => new Date("2026-09-27T12:00:00Z"),
		);
		expect(event.cycle).toBe(2);
		expect(event.op).toBe("verify:issue-59:cycle-2");
		expect(event.artifacts).toEqual([
			"artifacts/cycles/2/verify/exit-codes.json",
		]);

		const line = fs.readFileSync(file, "utf8").trimEnd();
		expect(JSON.parse(line)).toMatchObject({ cycle: 2, op: event.op });
		expect(line.endsWith("\n") || !line.includes("\n")).toBeTrue();
	});

	test("every line ends with exactly one newline", async () => {
		const file = tmpFile();
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:00:00Z"));
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:01:00Z"));
		const raw = fs.readFileSync(file, "utf8");
		expect(raw.endsWith("\n")).toBeTrue();
		expect(raw.split("\n").length).toBe(3); // two lines + trailing empty
	});

	test("continues the sequence after a torn final line", async () => {
		const file = tmpFile();
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:00:00Z"));
		fs.appendFileSync(file, '{"v":1,"seq":2,"na'); // simulate a kill mid-write

		const event = await appendRunEvent(
			file,
			input(),
			() => new Date("2026-09-27T12:02:00Z"),
		);
		expect(event.seq).toBe(2);
		const { events, truncated } = await readRunEvents(file);
		expect(truncated).toBeTrue();
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
	});
});

describe("readRunEvents", () => {
	test("round-trips appended events", async () => {
		const file = tmpFile();
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:00:00Z"));
		await appendRunEvent(
			file,
			input({
				name: RUN_EVENT_NAMES.outcome,
				payload: { outcome: "escalated" },
			}),
			() => new Date("2026-09-27T12:05:00Z"),
		);
		const { events, truncated } = await readRunEvents(file);
		expect(truncated).toBeFalse();
		expect(events).toHaveLength(2);
		expect(events[1]?.name).toBe("run.outcome");
		expect(events[1]?.payload).toEqual({ outcome: "escalated" });
	});

	test("keeps unknown event names as first-class evidence", async () => {
		const file = tmpFile();
		await appendRunEvent(
			file,
			input({ name: "cycle.review.verdict.v9", payload: { exotic: true } }),
			() => new Date("2026-09-27T12:00:00Z"),
		);
		const { events } = await readRunEvents(file);
		expect(events).toHaveLength(1);
		expect(events[0]?.name).toBe("cycle.review.verdict.v9");
	});

	test("skips blank lines", async () => {
		const file = tmpFile();
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:00:00Z"));
		fs.appendFileSync(file, "\n\n");
		const { events, truncated } = await readRunEvents(file);
		expect(events).toHaveLength(1);
		expect(truncated).toBeFalse();
	});

	test("accepts a complete final line without trailing newline", async () => {
		const file = tmpFile();
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:00:00Z"));
		fs.truncateSync(file, fs.statSync(file).size - 1); // drop only the "\n"
		const { events, truncated } = await readRunEvents(file);
		expect(truncated).toBeFalse();
		expect(events).toHaveLength(1);
	});

	test("drops only an incomplete final line and flags the truncation", async () => {
		const file = tmpFile();
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:00:00Z"));
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:01:00Z"));
		fs.appendFileSync(file, '{"v":1,"seq":3'); // torn write, no newline

		const { events, truncated } = await readRunEvents(file);
		expect(truncated).toBeTrue();
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
	});

	test("throws on parseable corruption before the final line", async () => {
		const file = tmpFile();
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:00:00Z"));
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:01:00Z"));
		const raw = fs.readFileSync(file, "utf8").split("\n");
		// Parseable JSON that fails the envelope cannot come from a torn write —
		// it is corruption or tampering and must fail loudly.
		raw[0] = '{"hello":"world"}';
		fs.writeFileSync(file, raw.join("\n"));

		expect(() => readRunEvents(file)).toThrow(/line 1/);
	});

	test("tolerates a torn fragment sealed by a later append", async () => {
		const file = tmpFile();
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:00:00Z"));
		fs.appendFileSync(file, '{"v":1,"seq":2,"na'); // torn
		// The writer seals the fragment before appending, so the torn bytes end
		// up interior to the stream — still dropped, still flagged.
		fs.appendFileSync(file, "\n");
		await appendRunEvent(file, input(), () => new Date("2026-09-27T12:02:00Z"));

		const { events, truncated } = await readRunEvents(file);
		expect(truncated).toBeTrue();
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
	});

	test("an empty stream reads as empty, not truncated", async () => {
		const file = tmpFile();
		fs.writeFileSync(file, "");
		const { events, truncated } = await readRunEvents(file);
		expect(events).toEqual([]);
		expect(truncated).toBeFalse();
	});

	test("a missing stream reads as empty", async () => {
		const { events, truncated } = await readRunEvents(
			"/nonexistent/events.jsonl",
		);
		expect(events).toEqual([]);
		expect(truncated).toBeFalse();
	});
});

describe("event envelope contract", () => {
	test("stable names cover the v0 vocabulary", () => {
		expect(RUN_EVENT_NAMES.started).toBe("run.started");
		expect(RUN_EVENT_NAMES.context).toBe("run.context");
		expect(RUN_EVENT_NAMES.stageEntered).toBe("stage.entered");
		expect(RUN_EVENT_NAMES.cycleStarted).toBe("cycle.started");
		expect(RUN_EVENT_NAMES.sideEffectIntent).toBe("side-effect.intent");
		expect(RUN_EVENT_NAMES.sideEffectCompleted).toBe("side-effect.completed");
		expect(RUN_EVENT_NAMES.outcome).toBe("run.outcome");
	});

	test("unknown names are assignable on write without losing envelope typing", async () => {
		const file = tmpFile();
		const event: RunEvent = await appendRunEvent(
			file,
			input({ name: "future.thing", payload: { x: 1 } }),
			() => new Date("2026-09-27T12:00:00Z"),
		);
		expect(event.name).toBe("future.thing");
	});
});
