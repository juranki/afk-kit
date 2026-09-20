/**
 * The readiness check's inspections (ADR 0012, ticket afk-kit #24).
 *
 * Pure decision logic over the brief substrate (brief.ts) and tracker facts:
 * every inspection is a named, structured pass/fail so consumers — the
 * planning playbook's gate, the coordinator loop's step 1, the atomic claim
 * (#19) — can name exactly what failed. The failure marker is the house
 * refusal pattern: `READINESS_REFUSAL` naming the failed inspections.
 *
 * Judgment stays prompt-side (ADR 0006): whether acceptance criteria are
 * truly verifiable, whether the summary speaks the domain vocabulary — none
 * of that is checked here. The template is fixed to the shipped one; there is
 * no per-repo config.
 */

import { type FieldName, parseBrief } from "./brief.ts";

export type TicketState = "OPEN" | "CLOSED";

export interface BlockerRef {
	number: number;
	state: TicketState;
}

export interface CheckInput {
	body: string;
	labels: string[];
	/** The tracker's native blocked-by dependencies, open and closed. */
	nativeBlockers: BlockerRef[];
	/** Resolved state of every ticket named in the Blocked by line. */
	namedStates: Record<number, TicketState>;
}

export interface Inspection {
	name: InspectionName;
	pass: boolean;
	detail: string;
}

type InspectionName =
	| "brief-fields"
	| "verify-commands"
	| "open-questions"
	| "triage-labels"
	| "blocked-by-edges";

/** The five triage states (docs/agents/triage-labels.md); workflow states like
 * `in-progress` are not triage states and never compete. */
const TRIAGE_LABELS = [
	"needs-triage",
	"needs-info",
	"ready-for-agent",
	"ready-for-human",
	"wontfix",
] as const;

const READY_LABEL = "ready-for-agent";

/** Fields inspection 1 requires present; all but `openQuestions` also non-empty
 * (Open questions' content is inspection 3's business — empty or `none` is its
 * passing state, so emptiness must not fail here too). */
const PRESENCE_RULES: ReadonlyArray<{
	field: FieldName;
	label: string;
	nonEmpty: boolean;
}> = [
	{ field: "summary", label: "Summary", nonEmpty: true },
	{ field: "acceptanceCriteria", label: "Acceptance criteria", nonEmpty: true },
	{ field: "verifyCommands", label: "Verify commands", nonEmpty: true },
	{ field: "blockedBy", label: "Blocked by", nonEmpty: true },
	{ field: "blocks", label: "Blocks", nonEmpty: true },
	{ field: "touchedAreas", label: "Touched areas", nonEmpty: true },
	{ field: "outOfScope", label: "Out of scope", nonEmpty: true },
	{ field: "openQuestions", label: "Open questions", nonEmpty: false },
];

function checkBriefFields(body: string): Inspection {
	const brief = parseBrief(body);
	const problems: string[] = [];
	for (const { field, label, nonEmpty } of PRESENCE_RULES) {
		const { present, value } = brief[field];
		if (!present) {
			problems.push(`${label} line missing`);
		} else if (nonEmpty && value === "") {
			problems.push(`${label} is empty`);
		}
	}
	if (problems.length > 0) {
		return {
			name: "brief-fields",
			pass: false,
			detail: `brief template incomplete: ${problems.join("; ")} (edge fields take \`none\` when there are no edges)`,
		};
	}
	return {
		name: "brief-fields",
		pass: true,
		detail: "all seven template fields present",
	};
}

/** The verify commands as a list, one per `- ` line, backticks stripped. */
export function verifyCommandList(value: string): string[] {
	return value
		.split("\n")
		.map((line) =>
			line
				.replace(/^\s*[-*]\s*/, "")
				.replaceAll("`", "")
				.trim(),
		)
		.filter((line) => line !== "");
}

function checkVerifyCommands(body: string): Inspection {
	const brief = parseBrief(body);
	const commands = verifyCommandList(brief.verifyCommands.value);
	if (commands.length === 0) {
		return {
			name: "verify-commands",
			pass: false,
			detail:
				"at least one verify command is required — a ticket without one is ready for a human, not an agent",
		};
	}
	return {
		name: "verify-commands",
		pass: true,
		detail: `${commands.length} verify command${commands.length > 1 ? "s" : ""}`,
	};
}

function checkOpenQuestions(body: string): Inspection {
	const brief = parseBrief(body);
	const normalized = brief.openQuestions.value
		.trim()
		.toLowerCase()
		.replace(/\.$/, "");
	if (normalized === "" || normalized === "none") {
		return { name: "open-questions", pass: true, detail: "no open questions" };
	}
	return {
		name: "open-questions",
		pass: false,
		detail: `open questions remain: ${brief.openQuestions.value.trim()}`,
	};
}

function checkTriageLabels(labels: string[]): Inspection {
	const triage = labels.filter((label) =>
		(TRIAGE_LABELS as readonly string[]).includes(label),
	);
	const competing = triage.filter((label) => label !== READY_LABEL);
	const hasReady = triage.includes(READY_LABEL);
	if (hasReady && competing.length === 0) {
		return {
			name: "triage-labels",
			pass: true,
			detail: `${READY_LABEL} present, no competing triage state`,
		};
	}
	const problems: string[] = [];
	if (!hasReady) problems.push(`${READY_LABEL} absent`);
	if (competing.length > 0)
		problems.push(`competing triage state: ${competing.join(", ")}`);
	return { name: "triage-labels", pass: false, detail: problems.join("; ") };
}

/** Ticket numbers named in the brief's Blocked by line, deduplicated. */
export function namedBlockers(body: string): number[] {
	const brief = parseBrief(body);
	const numbers = [...brief.blockedBy.value.matchAll(/#(\d+)/g)].map((m) =>
		Number(m[1]),
	);
	return [...new Set(numbers)];
}

function checkBlockedByEdges(input: CheckInput): Inspection {
	const named = namedBlockers(input.body);
	const openNamed: number[] = [];
	const unknown: number[] = [];
	for (const number of named) {
		const state = input.namedStates[number];
		if (state === "OPEN") openNamed.push(number);
		else if (state === undefined) unknown.push(number);
	}
	const openNative = input.nativeBlockers
		.filter((b) => b.state === "OPEN")
		.map((b) => b.number);
	const missingEdges = openNamed.filter((n) => !openNative.includes(n));
	const undeclared = openNative.filter((n) => !openNamed.includes(n));

	if (
		missingEdges.length === 0 &&
		undeclared.length === 0 &&
		unknown.length === 0
	) {
		return {
			name: "blocked-by-edges",
			pass: true,
			detail: "blocked-by edges agree with the tracker's native dependencies",
		};
	}
	const problems: string[] = [];
	if (missingEdges.length > 0)
		problems.push(
			`named in Blocked by but missing a native dependency edge: ${missingEdges.map((n) => `#${n}`).join(", ")}`,
		);
	if (undeclared.length > 0)
		problems.push(
			`native open blockers not named in Blocked by: ${undeclared.map((n) => `#${n}`).join(", ")}`,
		);
	if (unknown.length > 0)
		problems.push(
			`could not resolve state of named ticket: ${unknown.map((n) => `#${n}`).join(", ")}`,
		);
	return { name: "blocked-by-edges", pass: false, detail: problems.join("; ") };
}

export function checkReadiness(input: CheckInput): {
	ok: boolean;
	inspections: Inspection[];
} {
	const inspections = [
		checkBriefFields(input.body),
		checkVerifyCommands(input.body),
		checkOpenQuestions(input.body),
		checkTriageLabels(input.labels),
		checkBlockedByEdges(input),
	];
	return { ok: inspections.every((i) => i.pass), inspections };
}

export function formatResult(
	issue: number,
	result: { ok: boolean; inspections: Inspection[] },
): string {
	if (result.ok) {
		return `Readiness check passed for #${issue}: ${result.inspections.map((i) => i.name).join(", ")} all pass.`;
	}
	const failed = result.inspections.filter((i) => !i.pass);
	const lines = [
		`READINESS_REFUSAL: readiness check failed for #${issue} — failed inspections: ${failed.map((i) => i.name).join(", ")}.`,
		...failed.map((i) => `- ${i.name}: ${i.detail}`),
	];
	return lines.join("\n");
}
