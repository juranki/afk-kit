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
