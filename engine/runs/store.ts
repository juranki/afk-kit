/**
 * The Run store (ticket afk-kit #59, durable spec #46): creates and opens a
 * Run's durable directory, guards it with a per-Run lock, holds the
 * initial Issue-body source snapshot and its legacy `brief` hash, keeps the authoritative
 * append-only event stream, and trails a replaceable `run.json` projection
 * after it. The artifact layout retains complete SDK, Verify, Verdict, and
 * Escalation evidence; nothing here deletes. ADR 0016's separate prepared brief,
 * captured sources/revision, output and hash live under artifacts/readiness/;
 * the legacy Run-root body is never the implementation handoff.
 *
 * Everything is owner-only (0700 directories, 0600 files): Run evidence
 * carries private repository material and stays outside every repository.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	appendRunEvent,
	RUN_EVENT_NAMES,
	type RunEvent,
	type RunEventInput,
	readRunEvents,
} from "./events.ts";
import { repositoryStateRoot, runDirectory } from "./paths.ts";
import { emptyRunSummary, foldRunEvents } from "./projection.ts";

/** Failures the store raises with a machine-readable code. */
export class RunStoreError extends Error {
	constructor(
		readonly code:
			| "lock-held"
			| "stale-lock"
			| "brief-tampered"
			| "not-a-run"
			| "path-traversal",
		message: string,
	) {
		super(message);
		this.name = "RunStoreError";
	}
}

/** A sortable, unique Run id: UTC timestamp plus random suffix. */
export function runIdFor(
	now: () => Date = () => new Date(),
	hex: () => string = () => randomBytes(3).toString("hex"),
): string {
	const ts = now()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	return `${ts}-${hex()}`;
}

/** Everything the store knows about one Run's durable location. */
export interface RunHandle {
	runId: string;
	owner: string;
	repo: string;
	ticket: number;
	/** Absolute Run directory. */
	dir: string;
	eventsPath: string;
	briefPath: string;
	/** Sha256 hex of the immutable brief snapshot. */
	briefHash: string;
	projectionPath: string;
	lockPath: string;
	artifactsDir: string;
}

export interface CreateRunOptions {
	/** Root of the XDG state hierarchy (see paths.ts). */
	stateRoot: string;
	owner: string;
	repo: string;
	ticket: number;
	/** Initial Issue-body source snapshot (legacy field name, not the prepared handoff). */
	brief: string;
	now?: () => Date;
	runId?: string;
}

function mkdirOwnerOnly(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeOwnerOnly(file: string, data: string): void {
	const fd = fs.openSync(file, "w", 0o600);
	try {
		fs.writeSync(fd, data);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/** Create a Run: snapshot the brief, open the stream, write the projection. */
export function createRun(options: CreateRunOptions): RunHandle {
	const runId = options.runId ?? runIdFor(options.now);
	const repositoryRoot = repositoryStateRoot(
		options.stateRoot,
		options.owner,
		options.repo,
	);
	const dir = runDirectory(repositoryRoot, options.ticket, runId);
	mkdirOwnerOnly(dir);
	const artifactsDir = path.join(dir, "artifacts");
	mkdirOwnerOnly(artifactsDir);

	const briefPath = path.join(dir, "brief.md");
	writeOwnerOnly(briefPath, options.brief);
	const briefHash = createHash("sha256").update(options.brief).digest("hex");
	writeOwnerOnly(
		path.join(dir, "brief.json"),
		`${JSON.stringify({ hash: briefHash, bytes: Buffer.byteLength(options.brief) }, null, "\t")}\n`,
	);

	const handle: RunHandle = {
		runId,
		owner: options.owner,
		repo: options.repo,
		ticket: options.ticket,
		dir,
		eventsPath: path.join(dir, "events.jsonl"),
		briefPath,
		briefHash,
		projectionPath: path.join(dir, "run.json"),
		lockPath: path.join(dir, "lock"),
		artifactsDir,
	};
	appendRunEvent(
		handle.eventsPath,
		{
			runId,
			repository: `${options.owner}/${options.repo}`,
			ticket: options.ticket,
			name: RUN_EVENT_NAMES.started,
			payload: { briefHash },
		},
		options.now,
	);
	writeProjection(handle);
	return handle;
}

/**
 * Reopen an existing Run from its directory. The canonical hierarchy is
 * parsed from the path and the immutable brief snapshot is verified against
 * its recorded hash.
 */
export function openRun(dir: string): RunHandle {
	const parts = dir.split(path.sep);
	const markerIndex = parts.indexOf("github.com");
	if (markerIndex < 0) {
		throw new RunStoreError(
			"not-a-run",
			`not inside the run state hierarchy: ${dir}`,
		);
	}
	const owner = parts[markerIndex + 1];
	const repo = parts[markerIndex + 2];
	const ticket = Number(parts[markerIndex + 4]);
	const runId = parts[markerIndex + 6];
	if (!owner || !repo || !Number.isInteger(ticket) || ticket <= 0 || !runId) {
		throw new RunStoreError("not-a-run", `malformed run directory: ${dir}`);
	}
	const briefPath = path.join(dir, "brief.md");
	let brief: string;
	try {
		brief = fs.readFileSync(briefPath, "utf8");
	} catch {
		throw new RunStoreError("not-a-run", `run has no brief snapshot: ${dir}`);
	}
	let meta: { hash?: string };
	try {
		meta = JSON.parse(fs.readFileSync(path.join(dir, "brief.json"), "utf8"));
	} catch {
		throw new RunStoreError(
			"brief-tampered",
			`run has unreadable brief metadata: ${dir}`,
		);
	}
	const actual = createHash("sha256").update(brief).digest("hex");
	if (meta.hash !== actual) {
		throw new RunStoreError(
			"brief-tampered",
			`brief snapshot hash mismatch in ${dir}: expected ${meta.hash}, found ${actual}`,
		);
	}
	return {
		runId,
		owner,
		repo,
		ticket,
		dir,
		eventsPath: path.join(dir, "events.jsonl"),
		briefPath,
		briefHash: actual,
		projectionPath: path.join(dir, "run.json"),
		lockPath: path.join(dir, "lock"),
		artifactsDir: path.join(dir, "artifacts"),
	};
}

/** The per-Run lock's stored content. */
export interface RunLock {
	pid: number;
	token: string;
	startedAt: string;
}

/** Is a process id alive? EPERM (a foreign live process) counts as alive. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Read the Run's lock, or null when unlocked. */
export function readRunLock(handle: RunHandle): RunLock | null {
	try {
		return JSON.parse(fs.readFileSync(handle.lockPath, "utf8")) as RunLock;
	} catch {
		return null;
	}
}

export interface AcquireLockOptions {
	/**
	 * Recovery path for the crash reconciler: take over a lock whose pid is
	 * dead. A lock held by a live process is always refused.
	 */
	stealStale?: boolean;
}

/**
 * Take the per-Run lock (ontology invariant: a claimed Run is never claimed
 * by two coordinators at once). Throws `lock-held` while a live process
 * holds it and `stale-lock` when the pid is dead and `stealStale` was not
 * set.
 */
export function acquireRunLock(
	handle: RunHandle,
	options: AcquireLockOptions = {},
): RunLock {
	const lock: RunLock = {
		pid: process.pid,
		token: randomBytes(8).toString("hex"),
		startedAt: new Date().toISOString(),
	};
	try {
		const fd = fs.openSync(handle.lockPath, "wx", 0o600);
		try {
			fs.writeSync(fd, JSON.stringify(lock));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		return lock;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = readRunLock(handle);
		if (existing && pidAlive(existing.pid)) {
			throw new RunStoreError(
				"lock-held",
				`run ${handle.runId} is locked by live process ${existing.pid}`,
			);
		}
		if (!options.stealStale) {
			throw new RunStoreError(
				"stale-lock",
				`run ${handle.runId} has a stale lock from dead process ${existing?.pid ?? "?"}`,
			);
		}
		fs.writeFileSync(handle.lockPath, JSON.stringify(lock), {
			mode: 0o600,
			flag: "w",
		});
		return lock;
	}
}

/**
 * Release a lock this process acquired. The token is checked before the
 * unlink so a stolen-then-reacquired lock is never removed by the old
 * holder.
 */
export function releaseRunLock(lock: RunLock, handle: RunHandle): void {
	const existing = readRunLock(handle);
	if (existing?.token !== lock.token) return;
	fs.unlinkSync(handle.lockPath);
}

/** Rewrite the replaceable projection from the authoritative events. */
function writeProjection(handle: RunHandle): void {
	const { events } = readRunEvents(handle.eventsPath);
	const summary = foldRunEvents(events) ?? {
		...emptyRunSummary(),
		runId: handle.runId,
		repository: `${handle.owner}/${handle.repo}`,
		ticket: handle.ticket,
		briefHash: handle.briefHash,
	};
	const body = `${JSON.stringify({ v: 1, ...summary }, null, "\t")}\n`;
	const tmp = `${handle.projectionPath}.tmp`;
	writeOwnerOnly(tmp, body);
	fs.renameSync(tmp, handle.projectionPath);
}

/**
 * Append an event with identity filled from the handle, then advance the
 * projection. Callers must hold the Run lock; appends are serialized by it.
 */
export function recordEvent(
	handle: RunHandle,
	input: Omit<RunEventInput, "runId" | "repository" | "ticket">,
): RunEvent {
	const event = appendRunEvent(handle.eventsPath, {
		runId: handle.runId,
		repository: `${handle.owner}/${handle.repo}`,
		ticket: handle.ticket,
		...input,
	});
	writeProjection(handle);
	return event;
}

/**
 * Create (idempotently) and return an evidence directory under the Run's
 * `artifacts/`. The layout retains complete SDK, Verify, Verdict, and
 * Escalation evidence — nothing deletes it.
 */
export function artifactDir(handle: RunHandle, ...segments: string[]): string {
	const resolved = path.resolve(handle.artifactsDir, ...segments);
	if (
		resolved !== handle.artifactsDir &&
		!resolved.startsWith(handle.artifactsDir + path.sep)
	) {
		throw new RunStoreError(
			"path-traversal",
			`artifact path traversal escapes the run: ${segments.join("/")}`,
		);
	}
	mkdirOwnerOnly(resolved);
	return resolved;
}
