/**
 * The merge guard (R7, ticket afk-kit #23, ADR 0011): session-bound,
 * client-side enforcement of the merge gate at the tool boundary. A
 * `tool_call` hook inspects every shell invocation — `bash` and
 * `powershell` — in every pi session where afk-kit is installed:
 * coordinators, subagent children (fresh pi processes), and the
 * maintainer's own interactive sessions. Merge-capable invocations —
 * `gh pr merge`, the pull-request merge API, `git push` targeting `main` —
 * refuse with a structured `MERGE_GATE_REFUSAL` (guard.ts) that names the
 * gate and instructs stop-and-report per the escalation convention; the
 * block carries `terminate` so the turn ends in a report, not a retry.
 *
 * No arming, no opt-in (ADR 0011: a guard that must be armed can silently
 * fail to arm). No registration is needed for refusals to fire; judgment
 * (when to escalate, what to report) stays prompt-side. The honest strength
 * bar and the bypass chain are documented in README.md, next to this code.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { evaluate } from "./evaluate.ts";
import { refusalText } from "./guard.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (
			!isToolCallEventType("bash", event) &&
			!isToolCallEventType("powershell", event)
		) {
			return;
		}
		const { command } = event.input;
		if (typeof command !== "string") return;
		const refusal = await evaluate(command, process.cwd());
		if (!refusal) return;
		return { block: true, terminate: true, reason: refusalText(refusal) };
	});
}
