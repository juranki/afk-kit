/**
 * The R6 verdict convention (ticket #18, ADR 0007): the reviewer ends its
 * final message with a fenced ```json block carrying its verdict, and the
 * coordinator parses it deterministically. An unparseable verdict escalates
 * like any other failure (ADR 0007) — this module returns a reason instead
 * of throwing, and never guesses.
 *
 * The wire format:
 *
 *     {
 *       "verdict": "approve",
 *       "summary": "optional overall assessment"
 *     }
 *
 * or, with severity-ranked findings (blocker > major > minor):
 *
 *     {
 *       "verdict": "request-changes",
 *       "summary": "optional overall assessment",
 *       "findings": [
 *         {
 *           "severity": "blocker",
 *           "file": "src/example.ts",
 *           "line": 42,
 *           "summary": "one-line finding",
 *           "detail": "optional elaboration"
 *         }
 *       ]
 *     }
 *
 * Validation is strict where it carries meaning: `approve` admits no
 * findings (an approval with findings is a contradiction, not a verdict —
 * the coordinator escalates on it); `request-changes` requires at least one
 * finding, each with a known severity and a non-empty summary. Unknown
 * extra fields are tolerated, so the format can grow without breaking old
 * parsers.
 */

/** The severity ladder, most severe first. */
export const SEVERITIES = ["blocker", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface VerdictFinding {
	severity: Severity;
	/** What is wrong, in one line. */
	summary: string;
	/** Where it is; a repo path, or a phrase like "repo-wide". */
	file?: string;
	line?: number;
	detail?: string;
}

export type Verdict =
	| { verdict: "approve"; findings: []; summary?: string }
	| {
			verdict: "request-changes";
			findings: VerdictFinding[];
			summary?: string;
	  };

export type ParsedVerdict =
	| { ok: true; verdict: Verdict }
	| { ok: false; reason: string };

/**
 * Parse the reviewer's final output text into a verdict. Deterministic:
 * candidate JSON objects are the fenced ```json blocks (last one first) and
 * then the whole text as bare JSON; the first candidate that parses *and*
 * validates wins. Nothing qualifies ⇒ `ok: false` with the reason the last
 * candidate failed.
 */
export function parseVerdict(text: string): ParsedVerdict {
	const candidate = extractVerdictObject(text);
	if (candidate === null) {
		return { ok: false, reason: "no JSON verdict object found in the output" };
	}

	let value: unknown;
	try {
		value = JSON.parse(candidate);
	} catch (error) {
		return {
			ok: false,
			reason: `verdict JSON does not parse: ${(error as Error).message}`,
		};
	}
	return validate(value);
}

/**
 * Pull the most likely verdict object out of the output text: the last
 * fenced ```json block, falling back to the whole text trimmed when it is
 * itself a bare-JSON object (a verdict with no prose around it). Prose-only
 * output yields no candidate at all.
 */
function extractVerdictObject(text: string): string | null {
	const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map(
		(match) => match[1],
	);
	if (blocks.length > 0) return blocks[blocks.length - 1].trim();
	const trimmed = text.trim();
	return trimmed.startsWith("{") ? trimmed : null;
}

function validate(value: unknown): ParsedVerdict {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "verdict is not a JSON object" };
	}
	const record = value as Record<string, unknown>;
	const verdict = record.verdict;
	if (verdict !== "approve" && verdict !== "request-changes") {
		return {
			ok: false,
			reason: `verdict must be "approve" or "request-changes", got ${JSON.stringify(verdict)}`,
		};
	}

	const summary =
		typeof record.summary === "string" && record.summary.trim().length > 0
			? record.summary.trim()
			: undefined;
	const rawFindings = record.findings ?? [];

	if (verdict === "approve") {
		if (Array.isArray(rawFindings) && rawFindings.length > 0) {
			return {
				ok: false,
				reason:
					'an "approve" verdict carries findings — a contradictory verdict, not a decision',
			};
		}
		return { ok: true, verdict: { verdict: "approve", findings: [], summary } };
	}

	if (!Array.isArray(rawFindings) || rawFindings.length === 0) {
		return {
			ok: false,
			reason: 'a "request-changes" verdict needs at least one finding',
		};
	}
	const findings: VerdictFinding[] = [];
	for (const raw of rawFindings) {
		const finding = validateFinding(raw);
		if (typeof finding === "string") {
			return { ok: false, reason: `invalid finding: ${finding}` };
		}
		findings.push(finding);
	}
	return { ok: true, verdict: { verdict, findings, summary } };
}

/** A finding object, or the reason it is not one. */
function validateFinding(value: unknown): VerdictFinding | string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "a finding must be a JSON object";
	}
	const record = value as Record<string, unknown>;
	const severity = record.severity;
	if (
		typeof severity !== "string" ||
		!(SEVERITIES as readonly string[]).includes(severity)
	) {
		return `severity must be one of ${SEVERITIES.join(", ")}, got ${JSON.stringify(severity)}`;
	}
	if (
		typeof record.summary !== "string" ||
		record.summary.trim().length === 0
	) {
		return "a finding needs a non-empty summary";
	}
	const finding: VerdictFinding = {
		severity: severity as Severity,
		summary: record.summary.trim(),
	};
	if (typeof record.file === "string" && record.file.trim().length > 0) {
		finding.file = record.file.trim();
	}
	if (
		typeof record.line === "number" &&
		Number.isInteger(record.line) &&
		record.line > 0
	) {
		finding.line = record.line;
	}
	if (typeof record.detail === "string" && record.detail.trim().length > 0) {
		finding.detail = record.detail.trim();
	}
	return finding;
}
