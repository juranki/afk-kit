import { expect, test } from "bun:test";
import {
	checkRepositoryLabels,
	checkTriageLabels,
	verifyCommandList,
} from "./check.ts";

test("repository labels report every missing AFK mutation label with setup guidance", () => {
	const result = checkRepositoryLabels(["ready-for-agent", "needs-info"]);
	expect(result.pass).toBe(false);
	expect(result.detail).toContain(
		"missing repository labels: in-progress, in-review",
	);
	expect(result.detail).toContain('gh label create "in-progress"');
	expect(result.detail).toContain('gh label create "in-review"');
	expect(result.detail).not.toContain('gh label create "needs-info"');
});

test.each([
	["in-progress", ["in-review", "needs-info"]],
	["in-review", ["in-progress", "needs-info"]],
	["needs-info", ["in-progress", "in-review"]],
] as const)(
	"repository label validation refuses missing %s",
	(missing, labels) => {
		const result = checkRepositoryLabels([...labels]);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain(`missing repository labels: ${missing}.`);
	},
);

test("fully configured repository labels pass regardless of issue triage state", () => {
	expect(
		checkRepositoryLabels(["in-progress", "in-review", "needs-info"]).pass,
	).toBe(true);
});

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
