/**
 * The Implementer prompt and structured-result contract (ticket afk-kit
 * #62, durable spec #46): the prompt carries the cumulative worktree
 * facts, the immutable brief, the done contract, and the fenced result
 * block; the parser reads that block deterministically. The result is the
 * session's claim, never its proof — the Engine judges done from observed
 * Git and exit-code facts, and the prose cannot override them.
 */

/** The Implementer's structured end-of-run report, parsed from its final message. */
export interface ImplementerResult {
	/** `"done"` when the work is complete; any other value reports trouble. */
	status: string;
	/** One-line account of what was done, when the Implementer gives one. */
	summary?: string;
	/** Questions that need a human before work can continue; empty when done. */
	openQuestions: string[];
}

export type ParsedImplementerResult =
	| { ok: true; result: ImplementerResult }
	| { ok: false; reason: string };

/**
 * Candidate JSON objects: the last fenced block first, then the whole text
 * as bare JSON. The first candidate that parses and validates wins.
 */
function candidatesOf(text: string): string[] {
	const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(
		(m) => m[1] ?? "",
	);
	const list = fenced.reverse();
	list.push(text);
	return list;
}

function validate(value: unknown): ParsedImplementerResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "the result is not a JSON object" };
	}
	const record = value as Record<string, unknown>;
	const status = record.status;
	if (typeof status !== "string" || status.trim() === "") {
		return { ok: false, reason: "status is not a non-empty string" };
	}
	const rawQuestions = record.openQuestions;
	if (rawQuestions !== undefined && !Array.isArray(rawQuestions)) {
		return { ok: false, reason: "openQuestions is not an array" };
	}
	const questions: string[] = [];
	for (const question of rawQuestions ?? []) {
		if (typeof question !== "string") {
			return { ok: false, reason: "openQuestions holds a non-string" };
		}
		questions.push(question);
	}
	const summary = record.summary;
	if (summary !== undefined && typeof summary !== "string") {
		return { ok: false, reason: "summary is not a string" };
	}
	const result: ImplementerResult = { status, openQuestions: questions };
	if (summary !== undefined) result.summary = summary;
	return { ok: true, result };
}

/**
 * Parse the Implementer's final output into its structured result.
 * Deterministic; never guesses and never throws.
 */
export function parseImplementerResult(
	text: string,
): ParsedImplementerResult {
	let invalid: string | null = null;
	for (const candidate of candidatesOf(text)) {
		const trimmed = candidate.trim();
		if (trimmed === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const checked = validate(value);
		if (checked.ok) return checked;
		invalid = checked.reason;
	}
	if (invalid !== null) return { ok: false, reason: invalid };
	return { ok: false, reason: "no JSON result object found in the output" };
}

/** Done is the done status and an empty question list — nothing else. */
export function requireDone(
	result: Pick<ImplementerResult, "status"> &
		Partial<Pick<ImplementerResult, "openQuestions">>,
): boolean {
	return result.status === "done" && (result.openQuestions ?? []).length === 0;
}

/** The facts one cycle's prompt is built from. */
export interface ImplementerPromptFacts {
	issue: number;
	branch: string;
	worktree: string;
	/** 1-based cycle number; 1 is a fresh start, later cycles are cumulative. */
	cycle: number;
	/** The immutable brief snapshot, verbatim. */
	brief: string;
	/** Bounded failed-cycle feedback, present only from cycle 2 on. */
	feedback?: string;
}

/**
 * Build the one prompt a fresh Implementer session sees. The done contract
 * states observed facts — commits, verify exits, a clean worktree — as the
 * only currency: the report's prose cannot override what Git and the exit
 * codes observed.
 */
export function buildImplementerPrompt(facts: ImplementerPromptFacts): string {
	const lines: string[] = [
		`You are the Implementer for issue #${facts.issue}, working alone inside the Ticket worktree.`,
		"",
		"- Worktree (your working directory): " + facts.worktree,
		"- Branch (commit here, locally only): " + facts.branch,
		"- Cycle: " + String(facts.cycle),
		"",
	];
	if (facts.cycle > 1) {
		lines.push(
			"Cumulative rule: commits from earlier cycles stay — never reset, rebase, amend, force-push, or squash them. Add your work on top.",
			"",
		);
	}
	if (facts.feedback !== undefined && facts.feedback !== "") {
		lines.push(
			"The previous cycle failed. Its feedback follows; treat it as your first priority.",
			"",
			"## Previous-cycle feedback",
			"",
			facts.feedback,
			"",
		);
	}
	lines.push(
		"## The ticket brief (immutable — work within it, out of scope means out of scope)",
		"",
		facts.brief,
		"",
		"## Rules",
		"",
		"- Commit only inside this worktree, on this branch, locally. Never push, never open or comment on pull requests, never write to the issue tracker.",
		"- Follow the target repository's test-first standard when it has one.",
		"- Every verify command from the brief must pass before you report done.",
		"- If you cannot proceed — conflicting guidance, missing context, an unsafe step — stop and report blocked instead of guessing.",
		"",
		"## End-of-run report (required)",
		"",
		"End your final message with one fenced ```json block exactly like:",
		"",
		"```json",
		'{ "status": "done", "summary": "what changed, one line", "openQuestions": [] }',
		"```",
		"",
		'- `"status"` is `"done"` only when you made at least one commit, the worktree is clean, and every verify command passed. Use `"blocked"` otherwise.',
		'- `"openQuestions"` lists what a human must answer before work can continue; it must be empty when status is `"done"`.',
		"- Observed facts (Git, exit codes) decide, never your prose — a report cannot make a failing command pass.",
	);
	return lines.join("\n");
}
