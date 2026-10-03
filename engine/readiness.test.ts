import { expect, test } from "bun:test";
import { parseAssessment, renderPreparedBrief } from "./readiness.ts";
import { readyAssessment } from "./test-world.ts";

const sources = [
	{
		id: "issue:84",
		identity: "https://github.com/juranki/afk-kit/issues/84",
		content: "Use comments to establish intent.",
	},
	{
		id: "repo:package.json",
		identity: "abc:package.json",
		content: '{"scripts":{"test":"bun test"}}',
	},
];

test("rejects malformed output, ungrounded requirements, and missing commands distinctly", () => {
	for (const output of [
		"not json",
		JSON.stringify({
			...readyAssessment,
			brief: {
				...readyAssessment.brief,
				scope: [{ text: "Invented intent", refs: ["unknown"] }],
			},
		}),
		JSON.stringify({
			...readyAssessment,
			brief: { ...readyAssessment.brief, verifyCommands: [] },
		}),
	]) {
		expect(parseAssessment(output, sources, []).status).toBe(
			"assessment-failure",
		);
	}
});

test("dependency discrepancies need clarification even for closed native dependencies", () => {
	expect(
		parseAssessment(JSON.stringify(readyAssessment), sources, [83]).status,
	).toBe("needs-clarification");
});

test("unresolved human questions require source references", () => {
	expect(
		parseAssessment(
			JSON.stringify({
				status: "needs-clarification",
				questions: [{ text: "Which option?", refs: ["issue:84"] }],
			}),
			sources,
			[],
		).status,
	).toBe("needs-clarification");
	expect(
		parseAssessment(
			JSON.stringify({ status: "needs-clarification", questions: [] }),
			sources,
			[],
		).status,
	).toBe("assessment-failure");
});

test("accepts a prepared handoff with captured provenance and separates guidance", () => {
	const parsed = parseAssessment(JSON.stringify(readyAssessment), sources, []);
	expect(parsed.status).toBe("ready");
	if (parsed.status !== "ready") throw new Error("not ready");
	const brief = renderPreparedBrief(parsed.brief, sources, "abc");
	expect(brief).toContain("Non-binding guidance");
	expect(brief).toContain("repo:package.json");
	expect(brief).toContain("abc");
});
