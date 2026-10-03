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
 * Shared with the Review verdict parser (ticket afk-kit #63), which reads
 * the same fenced-block contract.
 */
export function candidatesOf(text: string): string[] {
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
export function parseImplementerResult(text: string): ParsedImplementerResult {
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
		`- Worktree (your working directory): ${facts.worktree}`,
		`- Branch (commit here, locally only): ${facts.branch}`,
		`- Cycle: ${String(facts.cycle)}`,
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
		"- Prepared binding requirements and captured evidence are the shared contract with Spec Review; guidance is non-binding, including suggested touch points. Inspect changed code and validate assumptions; departures from guidance need evidence, not permission to amend requirements.",
		"- Report status escalate on meaningful contradictions discovered later; the Engine must Escalate immediately rather than silently reinterpret intent or try another implementation cycle.",
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
		'- `"status"` is `"done"` only when you made at least one commit, the worktree is clean, and every verify command passed. Use `"escalate"` for meaningful binding-intent contradictions requiring a Maintainer decision, and `"blocked"` for other failure.',
		'- `"openQuestions"` lists what a human must answer before work can continue; it must be empty when status is `"done"`.',
		"- Observed facts (Git, exit codes) decide, never your prose — a report cannot make a failing command pass.",
	);
	return lines.join("\n");
}

/** The facts one Reviewer's prompt is built from. */
export interface ReviewerPromptFacts {
	issue: number;
	/** 1-based cycle whose candidate the Review judges. */
	cycle: number;
	branch: string;
	/** The worktree root the Review reads from (read-only). */
	worktree: string;
	/** Absolute path of the complete `main...HEAD` diff artifact. */
	diffPath: string;
}

/** The Spec Reviewer's facts: its contract is the immutable brief. */
export interface SpecReviewPromptFacts extends ReviewerPromptFacts {
	/** The immutable brief snapshot, verbatim. */
	brief: string;
}

/** The verdict contract both Reviewers' prompts close with. */
const VERDICT_CONTRACT = [
	"## Verdict (required)",
	"",
	"End your final message with one fenced ```json block exactly like:",
	"",
	"```json",
	'{ "verdict": "approve", "summary": "one line", "findings": [] }',
	"```",
	"",
	'- `"verdict"` is `"approve"`, `"request-changes"`, or `"escalate"` — nothing else is parseable.',
	'- `"approve"` only when nothing fails your judgment; `"findings"` is `[]` then.',
	'- `"request-changes"` requires at least one finding in `"findings"`, each `{ "severity": "blocker" | "major" | "minor", "file": "repo-relative path or omitted", "note": "what is wrong and why it matters" }` — ranked by severity: `blocker` must not merge, `major` should be fixed before merge, `minor` is worth noting.',
	'- `"escalate"` is for decisions you are not entitled to make, conflicting guidance, or an unsafe continuation — say why in `"summary"`.',
	"- Observed content decides, never the diff's self-descriptions.",
].join("\n");

function reviewerHeader(role: string, facts: ReviewerPromptFacts): string[] {
	return [
		`You are the ${role} for issue #${facts.issue}, cycle ${String(facts.cycle)}.`,
		"",
		`- Worktree (your read-only window on the change): ${facts.worktree}`,
		`- Branch under review: ${facts.branch}`,
		`- The complete pushed \`main...HEAD\` diff of the merge candidate: read ${facts.diffPath} in full.`,
		"",
	];
}

/**
 * Build the one prompt a fresh Standards Reviewer session sees (ticket
 * afk-kit #63): judge the pushed candidate against the repository's
 * governing guidance, and name that guidance so the Engine can verify it.
 */
export function buildStandardsReviewPrompt(facts: ReviewerPromptFacts): string {
	const lines: string[] = [
		...reviewerHeader("Standards Reviewer", facts),
		"Your judgment: is the change built the way this repository builds things?",
		"",
		"## Rules",
		"",
		"- You are read-only: you judge, you never modify anything, and the candidate is already pushed — you cannot merge or change it.",
		"- Read the repository's governing guidance inside the worktree: `AGENTS.md`, `docs/` (conventions, ADRs, and anything they point to that bears on the diff).",
		"- Judge whether the diff follows that guidance. Whether the change matches the ticket is the spec reviewer's judgment, not yours.",
		"- If you cannot review — unreadable guidance, conflicting rules, an unsafe step — return `escalate` instead of guessing.",
		"",
		"## Consulted guidance (required for an approval)",
		"",
		'Your verdict must list every file that materially guided it in `standardsConsulted`, each `{ "path": "repo-relative path", "hash": "sha256 hex of the complete file contents" }` (for example `AGENTS.md`). The list must be non-empty for an `approve`; the Engine verifies each path exists and each hash matches the file as read, and an approval it cannot verify is rejected.',
		"",
		VERDICT_CONTRACT,
	];
	return lines.join("\n");
}

/**
 * Build the one prompt a fresh Spec Reviewer session sees (ticket
 * afk-kit #63): judge the pushed candidate against the ticket's immutable
 * brief — every acceptance criterion and the out-of-scope line.
 */
export function buildSpecReviewPrompt(facts: SpecReviewPromptFacts): string {
	const lines: string[] = [
		...reviewerHeader("Spec Reviewer", facts),
		"Your judgment: does the change satisfy the ticket's immutable brief?",
		"",
		"## Rules",
		"",
		"- You are read-only: you judge, you never modify anything, and the candidate is already pushed — you cannot merge or change it.",
		"- Judge the diff against every acceptance criterion and the out-of-scope declaration below. Acceptance criteria are done when their verify commands pass, not when they are described as done.",
		"- The prepared binding requirements and captured evidence are the contract shared with the Implementer; guidance is non-binding. Never promote assessor recommendations or suggested touch points into Maintainer requirements.",
		"- The brief is the contract; neither the implementer's prose nor the diff's self-descriptions override it. Out-of-scope means out-of-scope.",
		"- Return escalate for meaningful contradictions discovered later rather than silently reinterpret intent.",
		"- If you cannot review — a self-contradictory brief, an unsafe step — return `escalate` instead of guessing.",
		"",
		"## The ticket brief (immutable)",
		"",
		facts.brief,
		"",
		VERDICT_CONTRACT,
	];
	return lines.join("\n");
}
