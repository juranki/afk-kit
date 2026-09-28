/**
 * The Run event contract (ticket afk-kit #59, durable spec #46): an
 * authoritative, append-only JSONL stream per Run. Every line carries the
 * schema version, a monotonic sequence, a timestamp, full Run/repository/
 * Ticket/cycle identity, an operation identity (`op` — side effects emit
 * intent/completed pairs that share it so reconciliation is deterministic),
 * a typed payload, and artifact references relative to the Run directory.
 *
 * This stream is the **public monitoring contract**: consumers must tolerate
 * unknown event names and an incomplete final line (a process killed
 * mid-write), so a torn write can never corrupt the evidence before it.
 * Interior corruption is *not* tolerated — it is reported, loudly.
 */

import * as fs from "node:fs";

/** Schema version of the event envelope. Bump on breaking envelope changes. */
const RUN_EVENT_SCHEMA_VERSION = 1;

/**
 * Stable v0 event names. Unknown names are legal on the wire and preserved
 * by readers — this vocabulary grows without breaking consumers.
 */
export const RUN_EVENT_NAMES = {
	/** A Run began; payload: `{ briefHash }`. */
	started: "run.started",
	/** Run-scoped facts became known; payload: `{ pr?, branch?, worktree? }`. */
	context: "run.context",
	/**
	 * The pinned implementation skills resolved at preflight (ADR 0015);
	 * payload: `{ skills: ImplementationSkill[] }`.
	 */
	implementationSkills: "run.implementation-skills",
	/** A diagnostic that changes no state; payload: `{ message }`. */
	notice: "run.notice",
	/** The Run entered a stage; payload: `{ stage }`. */
	stageEntered: "stage.entered",
	/** An Implement–Review cycle began; payload: `{ cycle }`. */
	cycleStarted: "cycle.started",
	/** A side effect was about to happen; payload: `{ operation, …detail }`. */
	sideEffectIntent: "side-effect.intent",
	/** A side effect settled; payload: `{ operation, …result }`. */
	sideEffectCompleted: "side-effect.completed",
	/** A terminal outcome was recorded; payload: `{ outcome, reason?, … }`. */
	outcome: "run.outcome",
} as const;

/** Terminal outcomes of a Run (durable spec #46). */
export type RunOutcome = "refused" | "escalated" | "handed-over-to-maintainer";

/** One pinned implementation skill's preflight record (ADR 0015, #75). */
export interface ImplementationSkill {
	/** The pinned skill name. */
	name: string;
	/** Absolute path of the installed `SKILL.md`. */
	path: string;
	/** Sha256 hex of the `SKILL.md` bytes at preflight. */
	sha256: string;
}
/** One event envelope. `name` may be any string; payloads are typed per name. */
export interface RunEvent {
	/** Envelope schema version. */
	v: number;
	/** Monotonic per-Run sequence, starting at 1; gaps are legal after a torn write. */
	seq: number;
	/** ISO 8601 UTC timestamp. */
	ts: string;
	/** The Run this event belongs to. */
	runId: string;
	/** `"owner/repo"` — the Run's repository identity. */
	repository: string;
	/** The Ticket (issue number) the Run carries. */
	ticket: number;
	/** Implement–Review cycle identity, when the event is cycle-scoped. */
	cycle: number | null;
	/** Operation identity: intent/completed pairs share it. */
	op: string | null;
	/** Stable event name; unknown names are tolerated by readers. */
	name: string;
	/** Typed payload — shape keyed by `name`. */
	payload: Record<string, unknown>;
	/** Artifact references, relative to the Run directory. */
	artifacts: string[];
}

/** Everything an appender must state; sequence and timestamp are assigned. */
export interface RunEventInput {
	runId: string;
	repository: string;
	ticket: number;
	cycle?: number | null;
	op?: string | null;
	name: string;
	payload?: Record<string, unknown>;
	artifacts?: string[];
}

/** Durable append: one line, written and fsynced as a unit. */
export function appendRunEvent(
	eventsPath: string,
	input: RunEventInput,
	now: () => Date = () => new Date(),
): RunEvent {
	const { events } = readRunEvents(eventsPath);
	const seq = events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
	const event: RunEvent = {
		v: RUN_EVENT_SCHEMA_VERSION,
		seq,
		ts: now().toISOString(),
		runId: input.runId,
		repository: input.repository,
		ticket: input.ticket,
		cycle: input.cycle ?? null,
		op: input.op ?? null,
		name: input.name,
		payload: input.payload ?? {},
		artifacts: input.artifacts ?? [],
	};
	// If a previous write was torn (no trailing newline), seal the dangling
	// fragment so it stays its own dropped line and never swallows this one.
	// Evidence bytes are never rewritten or removed.
	let raw = "";
	try {
		raw = fs.readFileSync(eventsPath, "utf8");
	} catch {
		raw = "";
	}
	const seal = raw !== "" && !raw.endsWith("\n") ? "\n" : "";
	const line = `${seal}${JSON.stringify(event)}\n`;
	// Run evidence is owner-only (durable spec #46), including on first create.
	const fd = fs.openSync(eventsPath, "a", 0o600);
	try {
		fs.writeSync(fd, line);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	return event;
}

/** Result of a tolerant read. */
export interface RunEventLog {
	/** Every intact event, in stream order. */
	events: RunEvent[];
	/** True when an incomplete final line was dropped. */
	truncated: boolean;
}

/** Interior corruption: the stream is authoritative, so this is fatal. */
export class MalformedEventError extends Error {
	constructor(
		message: string,
		readonly line: number,
	) {
		super(message);
		this.name = "MalformedEventError";
	}
}

/**
 * Unparseable bytes: the only signature of a torn write (no JSON prefix of
 * an object is itself valid JSON). Dropped and flagged wherever they sit —
 * a later append seals the torn tail, leaving the fragment interior.
 */
class TornLineError extends Error {}

function parseLine(raw: string, lineNo: number): RunEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new TornLineError();
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new MalformedEventError(
			`events.jsonl line ${lineNo} is not an event object`,
			lineNo,
		);
	}
	const candidate = parsed as Record<string, unknown>;
	const required = [
		"v",
		"seq",
		"ts",
		"runId",
		"repository",
		"ticket",
		"name",
	] as const;
	for (const field of required) {
		if (candidate[field] === undefined) {
			throw new MalformedEventError(
				`events.jsonl line ${lineNo} is missing "${field}"`,
				lineNo,
			);
		}
	}
	return {
		v: candidate.v as number,
		seq: candidate.seq as number,
		ts: candidate.ts as string,
		runId: candidate.runId as string,
		repository: candidate.repository as string,
		ticket: candidate.ticket as number,
		cycle: (candidate.cycle as number | null) ?? null,
		op: (candidate.op as string | null) ?? null,
		name: candidate.name as string,
		payload: (candidate.payload as Record<string, unknown>) ?? {},
		artifacts: (candidate.artifacts as string[]) ?? [],
	};
}

/**
 * Tolerant reader: blank lines are skipped, unknown event names are kept,
 * and unparseable lines — torn writes, wherever a later append has sealed
 * them — are dropped and flagged. Parseable lines that fail the envelope
 * cannot come from tearing, so they always throw: that is corruption.
 */
export function readRunEvents(eventsPath: string): RunEventLog {
	let raw: string;
	try {
		raw = fs.readFileSync(eventsPath, "utf8");
	} catch {
		return { events: [], truncated: false };
	}
	const events: RunEvent[] = [];
	let truncated = false;
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (line === "") continue;
		try {
			events.push(parseLine(line, i + 1));
		} catch (error) {
			if (error instanceof TornLineError) {
				truncated = true;
				continue;
			}
			throw error;
		}
	}
	return { events, truncated };
}
