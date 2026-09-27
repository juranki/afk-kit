/**
 * The read-only Status projection and its collection seams (ticket
 * afk-kit #59, durable spec #46): `afk status` renders every Run for the
 * current repository — or one Ticket — grouped by active, action-required,
 * handed-over, and recently merged, with stage/outcome, cycle, elapsed
 * time, PR, branch/worktree, latest event, and artifact path.
 *
 * Collection is observational: it reads the authoritative event streams,
 * the per-Run locks, and — read-only — the tracker's merge state for
 * handed-over pull requests. The one sanctioned write is the separately
 * specified hard-interruption finalization seam (`finalizeInterrupted`,
 * materialized by ticket #65): when given, the collector invokes it for
 * dead-lock unfinished Runs and re-reads their events afterwards.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runGit } from "../../extensions/coordinator/git.ts";
import { type GhRunner, runGh } from "../../extensions/readiness/gh.ts";
import { MalformedEventError, readRunEvents } from "./events.ts";
import {
	emptyRunSummary,
	foldRunEvents,
	groupRuns,
	type RunSummary,
	type StatusGroups,
} from "./projection.ts";
import { pidAlive } from "./store.ts";

/** How long a merged Run stays in "recently merged" (policy, not ontology). */
const RECENTLY_MERGED_DAYS = 30;

/**
 * Parse a GitHub origin URL into owner/repo. The state hierarchy keys on
 * `github.com`, so any other host is refused.
 */
export function parseOriginUrl(
	url: string,
): { owner: string; repo: string } | null {
	const trimmed = url.trim().replace(/\.git$/, "");
	const ownerRepo = (
		match: RegExpExecArray | null,
	): { owner: string; repo: string } | null => {
		const owner = match?.[1];
		const repo = match?.[2];
		return owner && repo ? { owner, repo } : null;
	};
	return (
		ownerRepo(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/.exec(trimmed)) ??
		ownerRepo(/^git@github\.com:([^/]+)\/([^/]+)$/.exec(trimmed)) ??
		ownerRepo(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(trimmed))
	);
}

/** Human elapsed time: `<1m`, `5m`, `2h 13m`, `3d 4h`. */
export function formatDuration(fromMs: number, toMs: number): string {
	const ms = Math.max(0, toMs - fromMs);
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "<1m";
	const hours = Math.floor(minutes / 60);
	if (hours < 1) return `${minutes}m`;
	const days = Math.floor(hours / 24);
	if (days < 1) return `${hours}h ${minutes % 60}m`;
	return `${days}d ${hours % 24}h`;
}

/** Read-only merge-state lookup for one pull request. */
export type PrLookup = (
	owner: string,
	repo: string,
	pr: number,
) => Promise<{ mergedAt: string | null } | null>;

/**
 * The default lookup: `gh pr view --json state,mergedAt` — a read, never a
 * mutation. Any failure degrades to "not known to be merged".
 */
export function ghPrLookup(cwd: string, run: GhRunner = runGh(cwd)): PrLookup {
	return async (owner, repo, pr) => {
		const { stdout, exitCode } = await run([
			"pr",
			"view",
			String(pr),
			"--repo",
			`${owner}/${repo}`,
			"--json",
			"state,mergedAt",
		]);
		if (exitCode !== 0) return null;
		try {
			const parsed = JSON.parse(stdout) as {
				state?: string;
				mergedAt?: string | null;
			};
			if (parsed.state === "MERGED" && parsed.mergedAt)
				return { mergedAt: parsed.mergedAt };
			return { mergedAt: null };
		} catch {
			return null;
		}
	};
}

/** Resolve the current repository's GitHub identity from its origin remote. */
export async function resolveRepository(
	checkout: string,
): Promise<{ owner: string; repo: string }> {
	const git = runGit();
	const result = await git(["remote", "get-url", "origin"], checkout);
	if (result.exitCode !== 0) {
		throw new Error(
			`cannot resolve the repository: git remote get-url origin failed: ${result.stderr.trim()}`,
		);
	}
	const parsed = parseOriginUrl(result.stdout);
	if (!parsed) {
		throw new Error(
			`origin remote is not a GitHub repository: ${result.stdout.trim()} — the Run state hierarchy is keyed on github.com`,
		);
	}
	return parsed;
}

/** One Run as the report carries it. */
interface StatusEntry {
	/** Absolute Run directory — the artifact path status surfaces. */
	dir: string;
	/** Folded summary, present when the event stream was readable. */
	summary?: RunSummary;
	/** Ticket number from the canonical path (shown even for error entries). */
	ticket?: number;
	runId?: string;
	/** True when torn bytes were dropped from the stream. */
	truncated?: boolean;
	/** Why the Run could not be read, when it could not. */
	error?: string;
}

export interface StatusReport {
	repository: { owner: string; repo: string };
	ticket?: number;
	now: Date;
	entries: StatusEntry[];
	groups: StatusGroups;
}

export interface CollectStatusOptions {
	stateRoot: string;
	owner: string;
	repo: string;
	/** Restrict the report to one Ticket. */
	ticket?: number;
	/** Now — injected for determinism. */
	now?: Date;
	/** Read-only merge lookup; `null` stays offline. Defaults to `gh`. */
	prLookup?: PrLookup | null;
	/**
	 * The hard-interruption finalization seam (ticket #65): called with the
	 * directory of every dead-lock Run that has no terminal outcome; events
	 * are re-read afterwards. Absent by default — plain status is read-only.
	 */
	finalizeInterrupted?: (dir: string) => Promise<void>;
}

function summaryFromPath(
	dir: string,
	owner: string,
	repo: string,
	lockAlive: boolean | null,
): RunSummary {
	const parts = dir.split(path.sep);
	return {
		...emptyRunSummary(),
		runId: parts.at(-1) ?? null,
		repository: `${owner}/${repo}`,
		ticket: Number(parts.at(-3)) || null,
		lockAlive,
	};
}

function listRunDirs(
	stateRoot: string,
	owner: string,
	repo: string,
	ticket?: number,
): string[] {
	const repositoryRoot = path.join(stateRoot, "github.com", owner, repo);
	const issuesRoot = path.join(repositoryRoot, "issues");
	let ticketDirs: string[];
	try {
		ticketDirs =
			ticket === undefined
				? fs
						.readdirSync(issuesRoot, { withFileTypes: true })
						.filter((entry) => entry.isDirectory())
						.map((entry) => entry.name)
				: [String(ticket)];
	} catch {
		return [];
	}
	const runs: string[] = [];
	for (const ticketDir of ticketDirs) {
		const runsDir = path.join(issuesRoot, ticketDir, "runs");
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(runsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) runs.push(path.join(runsDir, entry.name));
		}
	}
	return runs.sort();
}

/** Gather the read-only status report for a repository (or one Ticket). */
export async function collectStatus(
	options: CollectStatusOptions,
): Promise<StatusReport> {
	const now = options.now ?? new Date();
	const prLookup =
		options.prLookup === undefined
			? ghPrLookup(process.cwd())
			: options.prLookup;
	const entries: StatusEntry[] = [];

	for (const dir of listRunDirs(
		options.stateRoot,
		options.owner,
		options.repo,
		options.ticket,
	)) {
		const entry: StatusEntry = { dir };
		const parts = dir.split(path.sep);
		entry.runId = parts.at(-1);
		entry.ticket = Number(parts.at(-3)) || undefined;
		try {
			const log = readRunEvents(path.join(dir, "events.jsonl"));
			entry.truncated = log.truncated;
			let lockAlive: boolean | null = null;
			try {
				const lock = JSON.parse(
					fs.readFileSync(path.join(dir, "lock"), "utf8"),
				) as {
					pid?: number;
				};
				lockAlive = typeof lock.pid === "number" ? pidAlive(lock.pid) : null;
			} catch {
				lockAlive = null;
			}
			const unfinished = foldRunEvents(log.events)?.outcome == null;
			let summary: RunSummary;
			if (lockAlive === false && unfinished && options.finalizeInterrupted) {
				// The separately specified hard-interruption finalization seam.
				await options.finalizeInterrupted(dir);
				const reread = readRunEvents(path.join(dir, "events.jsonl"));
				summary =
					foldRunEvents(reread.events) ??
					summaryFromPath(dir, options.owner, options.repo, lockAlive);
				entry.truncated = reread.truncated;
			} else {
				summary =
					foldRunEvents(log.events) ??
					summaryFromPath(dir, options.owner, options.repo, lockAlive);
			}
			// Liveness is filesystem state, not an event — overlay it either way.
			summary.lockAlive = lockAlive;
			entry.summary = summary;
			entries.push(entry);
		} catch (error) {
			if (!(error instanceof MalformedEventError)) throw error;
			entry.error = error.message;
			entries.push(entry);
		}
	}

	const mergedPrs: Record<number, string> = {};
	if (prLookup) {
		const prs = entries
			.map((e) => e.summary)
			.filter(
				(s): s is RunSummary =>
					s?.outcome === "handed-over-to-maintainer" && s.pr != null,
			)
			.map((s) => s.pr);
		await Promise.all(
			prs.map(async (pr) => {
				const result = await prLookup(options.owner, options.repo, pr);
				if (result?.mergedAt) mergedPrs[pr] = result.mergedAt;
			}),
		);
	}

	const summaries = entries
		.map((e) => e.summary)
		.filter((s): s is RunSummary => s !== undefined);
	const groups = groupRuns(summaries, {
		now,
		mergedWindowDays: RECENTLY_MERGED_DAYS,
		mergedPrs,
	});
	return {
		repository: { owner: options.owner, repo: options.repo },
		ticket: options.ticket,
		now,
		entries,
		groups,
	};
}

const GROUP_HEADERS: Array<{ key: keyof StatusGroups; label: string }> = [
	{ key: "active", label: "ACTIVE" },
	{ key: "actionRequired", label: "ACTION REQUIRED" },
	{ key: "handedOver", label: "HANDED OVER" },
	{ key: "recentlyMerged", label: "RECENTLY MERGED" },
];
function summaryLine(
	summary: RunSummary,
	now: Date,
	truncated: boolean | undefined,
): string {
	const cells: string[] = [];
	cells.push(summary.ticket === null ? "#?" : `#${summary.ticket}`);
	cells.push(`run ${summary.runId ?? "?"}`);
	const state = summary.outcome ?? summary.stage ?? "starting";
	cells.push(state);
	if (summary.reason) cells.push(`— ${summary.reason}`);
	if (summary.cycle !== null) cells.push(`cycle ${summary.cycle}`);
	if (summary.startedAt) {
		// An unfinished Run is measured to now; a terminal one to its outcome.
		const endMs = summary.outcomeAt
			? Date.parse(summary.outcomeAt)
			: now.getTime();
		cells.push(
			`elapsed ${formatDuration(Date.parse(summary.startedAt), endMs)}`,
		);
	}
	if (summary.latestEvent) {
		cells.push(
			`last: ${summary.latestEvent.name} (seq ${summary.latestEvent.seq})`,
		);
	}
	if (truncated) cells.push("stream truncated");
	return `  ${cells.join(" · ")}`;
}

/** Render the report as human-readable text. */
export function renderStatus(report: StatusReport): string {
	const lines: string[] = [];
	const scope = report.ticket === undefined ? "" : ` — ticket ${report.ticket}`;
	lines.push(
		`Runs for github.com/${report.repository.owner}/${report.repository.repo}${scope}`,
	);
	if (report.entries.length === 0) {
		lines.push("no runs");
		return lines.join("\n");
	}
	for (const group of GROUP_HEADERS) {
		const summaries = report.groups[group.key];
		if (summaries.length === 0) continue;
		lines.push("");
		lines.push(group.label);
		for (const summary of summaries) {
			const entry = report.entries.find((e) => e.summary === summary);
			lines.push(summaryLine(summary, report.now, entry?.truncated));
			const detail: string[] = [];
			if (summary.pr !== null) detail.push(`pr #${summary.pr}`);
			if (summary.branch) detail.push(`branch ${summary.branch}`);
			if (summary.worktree) detail.push(`worktree ${summary.worktree}`);
			if (detail.length > 0) lines.push(`      ${detail.join(" · ")}`);
			if (entry) lines.push(`      at ${entry.dir}`);
		}
	}
	const unreadable = report.entries.filter((e) => e.error !== undefined);
	if (unreadable.length > 0) {
		lines.push("");
		lines.push("UNREADABLE");
		for (const entry of unreadable) {
			lines.push(
				`  #${entry.ticket ?? "?"} · run ${entry.runId ?? "?"} · unreadable: ${entry.error}`,
			);
			lines.push(`      at ${entry.dir}`);
		}
	}
	return lines.join("\n");
}
