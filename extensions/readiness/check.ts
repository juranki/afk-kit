/** Live triage mechanics and prepared-brief command projection (ADR 0016).
 * Source-author template validation and the planning two-pass gate are retired.
 */
export type TicketState = "OPEN" | "CLOSED";
export interface BlockerRef {
	number: number;
	state: TicketState;
}
interface Inspection {
	name: string;
	pass: boolean;
	detail: string;
}
const TRIAGE_LABELS = [
	"needs-triage",
	"needs-info",
	"ready-for-agent",
	"ready-for-human",
	"wontfix",
];
export function checkTriageLabels(labels: string[]): Inspection {
	const triage = labels.filter((l) => TRIAGE_LABELS.includes(l));
	const competing = triage.filter((l) => l !== "ready-for-agent");
	const hasReady = triage.includes("ready-for-agent");
	return {
		name: "triage-labels",
		pass: hasReady && competing.length === 0,
		detail:
			hasReady && competing.length === 0
				? "ready-for-agent present, no competing triage state"
				: [
						!hasReady ? "ready-for-agent absent" : "",
						competing.length
							? `competing triage state: ${competing.join(", ")}`
							: "",
					]
						.filter(Boolean)
						.join("; "),
	};
}
/** Labels applied by Claim, PR handoff, and Escalation, not issue triage state. */
export function checkRepositoryLabels(labels: string[]): Inspection {
	const missing = ["in-progress", "in-review", "needs-info"].filter(
		(label) => !labels.includes(label),
	);
	return {
		name: "repository-labels",
		pass: missing.length === 0,
		detail:
			missing.length === 0
				? "AFK workflow labels exist: in-progress, in-review, needs-info"
				: `missing repository labels: ${missing.join(", ")}. In the target repository, run: ${missing.map((label) => `gh label create "${label}"`).join("; ")}. Pocock / Wayfinder setup alone does not provision AFK workflow labels.`,
	};
}
export function verifyCommandList(value: string): string[] {
	return value
		.split("\n")
		.map((line) =>
			line
				.replace(/^\s*[-*]\s*/, "")
				.replaceAll("`", "")
				.trim(),
		)
		.filter(Boolean);
}
