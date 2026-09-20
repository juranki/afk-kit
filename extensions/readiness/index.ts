/**
 * Readiness Check — the brief template's mechanical substrate as a
 * deterministic readiness check (ADR 0012, ticket afk-kit #24).
 *
 * A registered tool callable in any session where afk-kit is installed: it
 * takes an issue and returns a structured pass/fail with a per-inspection
 * result. Four inspections per the ADR, plus its strictness rule, as five
 * named results:
 *
 *   brief-fields      — all seven brief-template fields present and non-empty
 *                       (Open questions needs presence; its content is below)
 *   verify-commands   — at least one verify command required; a ticket
 *                       without one is ready for a human, not an agent
 *   open-questions    — Open questions empty (the literal `none` counts)
 *   triage-labels     — `ready-for-agent` present, no competing triage state
 *   blocked-by-edges  — Blocked by agreeing with the tracker's native
 *                       dependencies, ignoring named tickets that have since
 *                       closed; the Blocks line is required but not
 *                       cross-checked
 *
 * A failing run formats as `READINESS_REFUSAL` naming the failed inspections
 * — the house refusal pattern. Consumers: the planning playbook gates
 * `ready-for-agent` on a pass; the coordinator loop's step 1 refuses on it;
 * the atomic claim op (#19) embeds the check. Judgment (are the criteria
 * truly verifiable, does the summary speak the domain vocabulary) stays
 * prompt-side — this tool verifies structure only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runReadinessCheck } from "./gh.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "readiness_check",
		label: "Readiness check",
		description: [
			"Verify an issue's agent brief against the brief template mechanically (ADR 0012):",
			"all seven template fields present and non-empty, at least one verify command, Open questions empty (`none` counts),",
			"the `ready-for-agent` label present with no competing triage state, and Blocked by agreeing with the tracker's",
			"native dependencies (named tickets that have since closed are ignored).",
			"Returns a structured pass/fail with a per-inspection result; a failing run carries `READINESS_REFUSAL` naming the failed inspections.",
			"Planning sessions run it around applying the label: a pre-apply run may fail only `triage-labels`, as ready-for-agent absent; after applying, a confirm run passing all inspections is the exit proof (any other failure — remove the label, fix, run again);",
			"a coordinator's step 1 and the atomic claim refuse on it. Structural only: brief quality stays with planning and the reviewer.",
		].join(" "),
		parameters: Type.Object({
			issue: Type.Number({ description: "The issue number to check." }),
		}),

		async execute(_toolCallId, params) {
			try {
				const outcome = await runReadinessCheck(params.issue);
				return {
					content: [{ type: "text", text: outcome.text }],
					details: { ok: outcome.ok, inspections: outcome.inspections },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Readiness check could not run for #${params.issue}: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { ok: false, inspections: [] },
				};
			}
		},
	});
}
