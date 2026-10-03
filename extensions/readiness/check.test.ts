import { expect, test } from "bun:test";
import { checkTriageLabels, verifyCommandList } from "./check.ts";

test("live triage requires ready-for-agent without a competing triage state", () => {
	expect(checkTriageLabels(["ready-for-agent"]).pass).toBe(true);
	expect(checkTriageLabels(["ready-for-agent", "in-progress"]).pass).toBe(true);
	expect(checkTriageLabels(["needs-info"]).pass).toBe(false);
	expect(checkTriageLabels(["ready-for-agent", "needs-info"]).pass).toBe(false);
});
test("prepared command projection keeps shell operators intact", () => {
	expect(
		verifyCommandList("- `bun install && bun run verify`\n- `bun test`\n"),
	).toEqual(["bun install && bun run verify", "bun test"]);
});
