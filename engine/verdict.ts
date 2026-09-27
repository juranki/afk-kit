/**
 * The structured Review verdict (ticket afk-kit #63, durable spec #46):
 * deterministic parsing of a Reviewer's final message into one of three
 * labels — `approve`, severity-ranked `request-changes`, immediate
 * `escalate` — and the pure judgment that folds the two parallel Review
 * sides into one gate outcome. A malformed verdict never guesses: it is a
 * failed Review side, which fails the cycle with evidence, and only an
 * explicit `escalate` label ends the Run immediately.
 */

import { candidatesOf } from "./prompt.ts";

/** The three verdict labels a Reviewer may return. */
type VerdictLabel = "approve" | "request-changes" | "escalate";

/** The severity ladder of review findings, strongest first. */
const SEVERITIES = ["blocker", "major", "minor"] as const;
type Severity = (typeof SEVERITIES)[number];

/** One finding: what is wrong, where, and how badly. */
interface ReviewFinding {
	severity: Severity;
	/** What is wrong and why it matters; never empty. */
	note: string;
	/** Repository-relative path the finding is about, when there is one. */
	file?: string;
}

/** One governing file a Standards Review consulted, as the Engine verifies it. */
export interface ConsultedPath {
	/** Repository-relative path, resolved against the worktree root. */
	path: string;
	/** sha256 hex of the complete file contents, lowercase. */
	hash: string;
}

/** The parsed verdict behind one Review's final message. */
export interface ReviewVerdict {
	verdict: VerdictLabel;
	/** One-line account of the judgment, when the Reviewer gives one. */
	summary?: string;
	findings: ReviewFinding[];
	/** Every governing file consulted; approval requires a verified list. */
	standardsConsulted?: ConsultedPath[];
}

export type ParsedVerdict =
	| { ok: true; verdict: ReviewVerdict }
	| { ok: false; reason: string };

/** One parallel Review's outcome as it enters the judgment. */
export type ReviewSide = ParsedVerdict;

/** The approving verdict evidence carried into the Run's artifacts. */
export interface ReviewApproval {
	/** Which Review approved: the Standards Review or the Spec Review. */
	review: "standards" | "spec";
	/** The approving verdict, verbatim as parsed. */
	verdict: ReviewVerdict;
}

/** The gate outcome for one round of parallel Reviews. */
export type ReviewJudgement =
	| {
			status: "approved";
			approvals: ReviewApproval[];
			/** The reviewers' summaries, when either left one. */
			reviewNotes?: string;
	  }
	| { status: "changes-requested"; reason: string }
	| { status: "escalate"; reason: string };

function isHex64(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

function parseFindings(
	value: unknown,
): { ok: true; findings: ReviewFinding[] } | { ok: false; reason: string } {
	if (value === undefined) return { ok: true, findings: [] };
	if (!Array.isArray(value)) {
		return { ok: false, reason: "findings is not an array" };
	}
	const findings: ReviewFinding[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return { ok: false, reason: "a finding is not a JSON object" };
		}
		const record = entry as Record<string, unknown>;
		const severity = record.severity;
		if (
			typeof severity !== "string" ||
			!SEVERITIES.includes(severity as Severity)
		) {
			return {
				ok: false,
				reason: "finding severity is not one of blocker, major, minor",
			};
		}
		const note = record.note;
		if (typeof note !== "string" || note.trim() === "") {
			return { ok: false, reason: "finding note is not a non-empty string" };
		}
		const finding: ReviewFinding = {
			severity: severity as Severity,
			note,
		};
		if (record.file !== undefined) {
			if (typeof record.file !== "string" || record.file.trim() === "") {
				return { ok: false, reason: "finding file is not a non-empty string" };
			}
			finding.file = record.file;
		}
		findings.push(finding);
	}
	return { ok: true, findings };
}

function parseConsulted(
	value: unknown,
):
	| { ok: true; consulted: ConsultedPath[] | undefined }
	| { ok: false; reason: string } {
	if (value === undefined) return { ok: true, consulted: undefined };
	if (!Array.isArray(value)) {
		return { ok: false, reason: "standardsConsulted is not an array" };
	}
	const consulted: ConsultedPath[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return {
				ok: false,
				reason: "a standardsConsulted entry is not a JSON object",
			};
		}
		const record = entry as Record<string, unknown>;
		const consultedPath = record.path;
		if (typeof consultedPath !== "string" || consultedPath.trim() === "") {
			return {
				ok: false,
				reason: "standardsConsulted path is not a non-empty string",
			};
		}
		const hash = record.hash;
		if (typeof hash !== "string" || !isHex64(hash.toLowerCase())) {
			return {
				ok: false,
				reason: `standardsConsulted hash is not sha256 hex: ${consultedPath}`,
			};
		}
		consulted.push({ path: consultedPath, hash: hash.toLowerCase() });
	}
	return { ok: true, consulted };
}

/**
 * Parse a Reviewer's final output into its structured verdict.
 * Deterministic; never guesses and never throws.
 */
export function parseVerdict(text: string): ParsedVerdict {
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
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			invalid = "the verdict is not a JSON object";
			continue;
		}
		const record = value as Record<string, unknown>;
		const label = record.verdict;
		if (
			typeof label !== "string" ||
			!["approve", "request-changes", "escalate"].includes(label)
		) {
			invalid = "verdict is not one of approve, request-changes, escalate";
			continue;
		}
		const summary = record.summary;
		if (summary !== undefined && typeof summary !== "string") {
			invalid = "summary is not a string";
			continue;
		}
		const findings = parseFindings(record.findings);
		if (!findings.ok) {
			invalid = findings.reason;
			continue;
		}
		if (label === "request-changes" && findings.findings.length === 0) {
			invalid = "request-changes requires at least one severity-ranked finding";
			continue;
		}
		const consulted = parseConsulted(record.standardsConsulted);
		if (!consulted.ok) {
			invalid = consulted.reason;
			continue;
		}
		const verdict: ReviewVerdict = {
			verdict: label as VerdictLabel,
			findings: findings.findings,
		};
		if (summary !== undefined) verdict.summary = summary;
		if (consulted.consulted !== undefined) {
			verdict.standardsConsulted = consulted.consulted;
		}
		return { ok: true, verdict };
	}
	if (invalid !== null) return { ok: false, reason: invalid };
	return { ok: false, reason: "no JSON verdict object found in the output" };
}

/** One requesting side's section of the failed-cycle reason. */
function renderRequests(
	review: "standards" | "spec",
	verdict: ReviewVerdict,
): string {
	const lines = [
		`${review} review requests changes${verdict.summary === undefined ? "" : `: ${verdict.summary}`}`,
	];
	for (const finding of verdict.findings) {
		lines.push(
			`- [${finding.severity}] ${finding.file ?? "general"}: ${finding.note}`,
		);
	}
	return lines.join("\n");
}

/**
 * Fold the two parallel Review sides into one gate outcome. Priority is
 * the durable spec's: an explicit `escalate` ends the Run immediately; a
 * side with no usable verdict fails the gate deterministically; a
 * `request-changes` fails the gate with its findings; only dual approval
 * passes.
 */
export function judgeReviews(
	standards: ReviewSide,
	spec: ReviewSide,
): ReviewJudgement {
	const sides = [
		{ review: "standards" as const, side: standards },
		{ review: "spec" as const, side: spec },
	];

	for (const { review, side } of sides) {
		if (side.ok && side.verdict.verdict === "escalate") {
			return {
				status: "escalate",
				reason: `${review} review escalated${side.verdict.summary === undefined ? " (no reason given)" : `: ${side.verdict.summary}`}`,
			};
		}
	}

	const unusable = sides
		.filter(({ side }) => !side.ok)
		.map(
			({ review, side }) =>
				`${review} review produced no usable verdict: ${side.ok === false ? side.reason : ""}`,
		);
	if (unusable.length > 0) {
		return { status: "changes-requested", reason: unusable.join("\n") };
	}

	const requesting = sides
		.filter(({ side }) => side.ok && side.verdict.verdict === "request-changes")
		.map(({ review, side }) =>
			renderRequests(review, (side as { verdict: ReviewVerdict }).verdict),
		);
	if (requesting.length > 0) {
		return { status: "changes-requested", reason: requesting.join("\n") };
	}

	const approvals: ReviewApproval[] = sides.map(({ review, side }) => ({
		review,
		verdict: (side as { verdict: ReviewVerdict }).verdict,
	}));
	const notes = sides
		.map(({ review, side }) => {
			const summary = (side as { verdict: ReviewVerdict }).verdict.summary;
			return summary === undefined
				? undefined
				: `${review === "standards" ? "Standards" : "Spec"} Review: ${summary}`;
		})
		.filter((note) => note !== undefined);
	return {
		status: "approved",
		approvals,
		...(notes.length === 0 ? {} : { reviewNotes: notes.join("\n") }),
	};
}
