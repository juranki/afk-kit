/**
 * The read-only Status projection (ticket afk-kit #59): pure folds from the
 * authoritative event stream to what `afk status` shows. `run.json` and the
 * rendered groups are replaceable projections; the events are the truth.
 * Unknown event names never break the fold — they still count as activity.
 */

import {
	type ImplementationSkill,
	RUN_EVENT_NAMES,
	type RunEvent,
	type RunOutcome,
} from "./events.ts";

/** What a human sees about one Run, folded from its events. */
export interface RunSummary {
	runId: string | null;
	/** `"owner/repo"`. */
	repository: string | null;
	ticket: number | null;
	/** First `run.started` timestamp. */
	startedAt: string | null;
	/** Timestamp of the highest-sequence event seen. */
	lastActivityAt: string | null;
	/** Latest `stage.entered` payload, or null. */
	stage: string | null;
	/** Latest `cycle.started` cycle, or null. */
	cycle: number | null;
	/** Terminal outcome, or null while the Run is unfinished. */
	outcome: RunOutcome | null;
	outcomeAt: string | null;
	/** Outcome reason, when the outcome carries one. */
	reason: string | null;
	pr: number | null;
	branch: string | null;
	worktree: string | null;
	/** Sha256 of the immutable brief snapshot. */
	briefHash: string | null;
	/** The pinned implementation skills' preflight records (ADR 0015), or null. */
	implementationSkills: ImplementationSkill[] | null;
	latestEvent: { seq: number; name: string; ts: string } | null;
	eventCount: number;
	/**
	 * Lock liveness, overlaid by the status collector from the filesystem —
	 * not derived from events. Null when unknown.
	 */
	lockAlive: boolean | null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/** A zero-value summary; the fold fills it, other callers patch identity. */
export function emptyRunSummary(): RunSummary {
	return {
		runId: null,
		repository: null,
		ticket: null,
		startedAt: null,
		lastActivityAt: null,
		stage: null,
		cycle: null,
		outcome: null,
		outcomeAt: null,
		reason: null,
		pr: null,
		branch: null,
		worktree: null,
		briefHash: null,
		implementationSkills: null,
		latestEvent: null,
		eventCount: 0,
		lockAlive: null,
	};
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fold the event stream into a summary. Returns null for an empty stream.
 * Later facts win; unknown names are skipped without breaking the fold.
 */
export function foldRunEvents(events: RunEvent[]): RunSummary | null {
	if (events.length === 0) return null;
	const summary = emptyRunSummary();
	for (const event of events) {
		summary.eventCount += 1;
		summary.runId ??= asString(event.runId);
		summary.repository ??= asString(event.repository);
		summary.ticket ??= asNumber(event.ticket);
		if (summary.latestEvent === null || event.seq > summary.latestEvent.seq) {
			summary.latestEvent = { seq: event.seq, name: event.name, ts: event.ts };
		}
		switch (event.name) {
			case RUN_EVENT_NAMES.started:
				summary.startedAt ??= event.ts;
				summary.briefHash ??= asString(event.payload.briefHash);
				break;
			case RUN_EVENT_NAMES.context: {
				const pr = asNumber(event.payload.pr);
				if (pr !== null) summary.pr = pr;
				const branch = asString(event.payload.branch);
				if (branch !== null) summary.branch = branch;
				const worktree = asString(event.payload.worktree);
				if (worktree !== null) summary.worktree = worktree;
				break;
			}
			case RUN_EVENT_NAMES.stageEntered: {
				const stage = asString(event.payload.stage);
				if (stage !== null) summary.stage = stage;
				break;
			}
			case RUN_EVENT_NAMES.cycleStarted: {
				const cycle = asNumber(event.payload.cycle) ?? asNumber(event.cycle);
				if (cycle !== null) summary.cycle = cycle;
				break;
			}
			case RUN_EVENT_NAMES.outcome: {
				const outcome = asString(event.payload.outcome);
				if (
					outcome === "refused" ||
					outcome === "escalated" ||
					outcome === "handed-over-to-maintainer"
				) {
					summary.outcome = outcome;
					summary.outcomeAt = event.ts;
					summary.reason = asString(event.payload.reason);
				}
				const pr = asNumber(event.payload.pr);
				if (pr !== null) summary.pr = pr;
				break;
			}
			case RUN_EVENT_NAMES.implementationSkills: {
				const skills = event.payload.skills;
				if (Array.isArray(skills)) {
					summary.implementationSkills = skills.filter(
						(skill): skill is ImplementationSkill =>
							typeof skill === "object" &&
							skill !== null &&
							typeof (skill as ImplementationSkill).name === "string" &&
							typeof (skill as ImplementationSkill).path === "string" &&
							typeof (skill as ImplementationSkill).sha256 === "string",
					);
				}
				break;
			}
			default:
				// Unknown event names are first-class evidence, not errors.
				break;
		}
	}
	summary.lastActivityAt = summary.latestEvent?.ts ?? null;
	return summary;
}

/** The monitoring boundary's four buckets (durable spec #46). */
export interface StatusGroups {
	/** Runs still working — lock held, no terminal outcome. */
	active: RunSummary[];
	/** Runs a human must look at: escalated, refused, or interrupted. */
	actionRequired: RunSummary[];
	/** Engine done, PR with the maintainer at the Merge gate. */
	handedOver: RunSummary[];
	/** Handed-over Runs whose PR merged inside the recency window. */
	recentlyMerged: RunSummary[];
}

export interface GroupOptions {
	/** Now — injected for determinism. */
	now: Date;
	/** How many days a merged Run stays "recently merged". */
	mergedWindowDays: number;
	/** PR number → merge timestamp, resolved read-only by the caller. */
	mergedPrs: Record<number, string>;
}

function byRecency(a: RunSummary, b: RunSummary): number {
	const aTs = a.lastActivityAt ?? "";
	const bTs = b.lastActivityAt ?? "";
	return bTs.localeCompare(aTs);
}

/** Group folded summaries into the four status buckets. */
export function groupRuns(
	summaries: RunSummary[],
	options: GroupOptions,
): StatusGroups {
	const groups: StatusGroups = {
		active: [],
		actionRequired: [],
		handedOver: [],
		recentlyMerged: [],
	};
	const windowMs = options.mergedWindowDays * 24 * 60 * 60 * 1000;
	for (const summary of summaries) {
		if (summary.outcome === "refused" || summary.outcome === "escalated") {
			groups.actionRequired.push(summary);
		} else if (summary.outcome === "handed-over-to-maintainer") {
			const mergedAt =
				summary.pr === null ? undefined : options.mergedPrs[summary.pr];
			const mergedMs = mergedAt === undefined ? NaN : Date.parse(mergedAt);
			const recent =
				Number.isFinite(mergedMs) &&
				options.now.getTime() - mergedMs <= windowMs;
			if (recent) groups.recentlyMerged.push(summary);
			else groups.handedOver.push(summary);
		} else if (summary.lockAlive === false) {
			// Dead lock, no terminal outcome: the Run was interrupted and its
			// Escalation has not been materialized yet — a human must look.
			groups.actionRequired.push(summary);
		} else {
			groups.active.push(summary);
		}
	}
	groups.active.sort(byRecency);
	groups.actionRequired.sort(byRecency);
	groups.handedOver.sort(byRecency);
	groups.recentlyMerged.sort(byRecency);
	return groups;
}
