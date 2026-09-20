/**
 * Agent brief parser (ADR 0012's readiness check, ticket afk-kit #24).
 *
 * Splits a ticket body into the brief-template lines the readiness check's
 * inspections read. The template is fixed to the shipped one
 * (docs/brief-template.md): seven fields, of which "Blocked by / blocks" is
 * carried as two lines (`blockedBy`, `blocks`) because the tracker's native
 * dependency check needs them separately.
 *
 * Field content runs from the `**Label:**` line to the next known field label
 * or the end of the brief section. The brief section is the body between a
 * `## Agent brief` heading and the next `##` heading; a body without the
 * heading is read as one brief section, since only the field lines — not the
 * heading — are template-mandated structure.
 */

export type FieldName =
	| "summary"
	| "acceptanceCriteria"
	| "verifyCommands"
	| "blockedBy"
	| "blocks"
	| "touchedAreas"
	| "outOfScope"
	| "openQuestions";

interface BriefField {
	/** The `**Label:**` line exists in the brief section. */
	present: boolean;
	/** Trimmed content from the label line to the next field; "" when absent. */
	value: string;
}

export type ParsedBrief = Record<FieldName, BriefField>;

const FIELD_LABELS: ReadonlyArray<{ name: FieldName; label: string }> = [
	{ name: "summary", label: "Summary" },
	{ name: "acceptanceCriteria", label: "Acceptance criteria" },
	{ name: "verifyCommands", label: "Verify commands" },
	{ name: "blockedBy", label: "Blocked by" },
	{ name: "blocks", label: "Blocks" },
	{ name: "touchedAreas", label: "Touched areas" },
	{ name: "outOfScope", label: "Out of scope" },
	{ name: "openQuestions", label: "Open questions" },
];

const LABEL_LINE = new RegExp(
	`^\\**(${FIELD_LABELS.map((f) => f.label).join("|")})\\s*:\\s*\\**\\s*(.*)$`,
	"i",
);

/** The `## Agent brief` section of a body, or the whole body without it. */
function briefSection(body: string): string {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => /^##\s+Agent brief\s*$/i.test(line));
	if (start === -1) return body;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n");
}

export function parseBrief(body: string): ParsedBrief {
	const brief = Object.fromEntries(
		FIELD_LABELS.map(({ name }) => [
			name,
			{ present: false, value: "" } satisfies BriefField,
		]),
	) as ParsedBrief;

	const section = briefSection(body);
	const lines = section.split("\n");

	let current: FieldName | undefined;
	const values = new Map<FieldName, string[]>();
	for (const line of lines) {
		const match = LABEL_LINE.exec(line);
		if (match) {
			const label = match[1].toLowerCase();
			const field = FIELD_LABELS.find((f) => f.label.toLowerCase() === label);
			if (field) {
				current = field.name;
				values.set(current, [match[2]]);
				continue;
			}
		}
		if (current) values.get(current)?.push(line);
	}

	for (const [name, valueLines] of values) {
		brief[name] = { present: true, value: valueLines.join("\n").trim() };
	}
	return brief;
}
