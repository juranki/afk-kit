/**
 * Tests for the readiness check's inspections (ticket afk-kit #24, ADR 0012):
 * a parsed-brief substrate plus tracker facts go in, a per-inspection
 * pass/fail comes out — and the failure formats as a `READINESS_REFUSAL`
 * naming the failed inspections, the marker the coordinator loop's step 1 and
 * the atomic claim (#19) refuse on.
 */

import { describe, expect, test } from "bun:test";
import { type CheckInput, checkReadiness, formatResult } from "./check.ts";

function goodInput(overrides: Partial<CheckInput> = {}): CheckInput {
	return {
		body: [
			"## Agent brief",
			"",
			"**Summary:** Add JSONL export to the reader.",
			"",
			"**Acceptance criteria:**",
			"- [ ] Exported file parses as JSONL.",
			"",
			"**Verify commands:**",
			"- `bun install && bun run verify`",
			"",
			"**Blocked by:** none",
			"**Blocks:** #20",
			"",
			"**Touched areas:** src/reader.ts",
			"",
			"**Out of scope:** CSV export.",
			"",
			"**Open questions:** none",
			"",
		].join("\n"),
		labels: ["ready-for-agent"],
		nativeBlockers: [],
		namedStates: {},
		...overrides,
	};
}

function inspection(result: ReturnType<typeof checkReadiness>, name: string) {
	const found = result.inspections.find((i) => i.name === name);
	if (!found) throw new Error(`no inspection named ${name}`);
	return found;
}

describe("checkReadiness", () => {
	test("a complete brief with consistent tracker facts passes every inspection", () => {
		const result = checkReadiness(goodInput());
		expect(result.ok).toBe(true);
		expect(result.inspections.map((i) => i.name)).toEqual([
			"brief-fields",
			"verify-commands",
			"open-questions",
			"triage-labels",
			"blocked-by-edges",
		]);
		expect(result.inspections.every((i) => i.pass)).toBe(true);
	});

	describe("brief-fields", () => {
		test("a missing template field fails, naming it", () => {
			const body = goodInput().body.replace(
				"**Out of scope:** CSV export.\n",
				"",
			);
			const result = checkReadiness(goodInput({ body }));
			expect(result.ok).toBe(false);
			const fields = inspection(result, "brief-fields");
			expect(fields.pass).toBe(false);
			expect(fields.detail).toContain("Out of scope");
		});

		test("an empty content field fails even though the line is present", () => {
			const body = goodInput().body.replace(
				"**Summary:** Add JSONL export to the reader.",
				"**Summary:**",
			);
			const result = checkReadiness(goodInput({ body }));
			expect(inspection(result, "brief-fields").pass).toBe(false);
		});

		test("`none` satisfies the non-empty rule on the edge fields", () => {
			const result = checkReadiness(goodInput());
			expect(inspection(result, "brief-fields").pass).toBe(true);
		});

		test("Open questions needs presence only — its content is another inspection", () => {
			const body = goodInput().body.replace(
				"**Open questions:** none",
				"**Open questions:** should CSV land too?",
			);
			const result = checkReadiness(goodInput({ body }));
			expect(inspection(result, "brief-fields").pass).toBe(true);
			expect(inspection(result, "open-questions").pass).toBe(false);
		});
	});

	describe("verify-commands", () => {
		test("a brief without any verify command fails", () => {
			const body = goodInput().body.replace(
				"- `bun install && bun run verify`",
				"",
			);
			const result = checkReadiness(goodInput({ body }));
			expect(result.ok).toBe(false);
			expect(inspection(result, "verify-commands").pass).toBe(false);
			expect(inspection(result, "verify-commands").detail).toContain(
				"verify command",
			);
		});

		test("a list-marker-only field is not a command", () => {
			const body = goodInput().body.replace(
				"- `bun install && bun run verify`",
				"-",
			);
			const result = checkReadiness(goodInput({ body }));
			expect(inspection(result, "verify-commands").pass).toBe(false);
		});
	});

	describe("open-questions", () => {
		test("`none`, `None`, `none.`, and empty pass", () => {
			for (const value of ["none", "None", "none.", ""]) {
				const body = goodInput().body.replace(
					"**Open questions:** none",
					`**Open questions:** ${value}`.trimEnd(),
				);
				const result = checkReadiness(goodInput({ body }));
				expect(inspection(result, "open-questions").pass).toBe(true);
			}
		});

		test("a live question fails", () => {
			const body = goodInput().body.replace(
				"**Open questions:** none",
				"**Open questions:** is CSV in scope?",
			);
			const result = checkReadiness(goodInput({ body }));
			expect(inspection(result, "open-questions").pass).toBe(false);
		});
	});

	describe("triage-labels", () => {
		test("`ready-for-agent` alone passes", () => {
			const result = checkReadiness(goodInput());
			expect(inspection(result, "triage-labels").pass).toBe(true);
		});

		test("workflow-state labels alongside it do not compete", () => {
			const result = checkReadiness(
				goodInput({ labels: ["ready-for-agent", "in-progress"] }),
			);
			expect(inspection(result, "triage-labels").pass).toBe(true);
		});

		test("a competing triage state fails, naming it", () => {
			const result = checkReadiness(
				goodInput({ labels: ["ready-for-agent", "needs-info"] }),
			);
			const labels = inspection(result, "triage-labels");
			expect(labels.pass).toBe(false);
			expect(labels.detail).toContain("needs-info");
		});

		test("a missing `ready-for-agent` fails", () => {
			const result = checkReadiness(goodInput({ labels: ["needs-triage"] }));
			expect(inspection(result, "triage-labels").pass).toBe(false);
		});
	});

	describe("blocked-by-edges", () => {
		test("a named open blocker with a matching native edge passes", () => {
			const body = goodInput().body.replace(
				"**Blocked by:** none",
				"**Blocked by:** #19",
			);
			const result = checkReadiness(
				goodInput({
					body,
					nativeBlockers: [{ number: 19, state: "OPEN" }],
					namedStates: { 19: "OPEN" },
				}),
			);
			expect(inspection(result, "blocked-by-edges").pass).toBe(true);
		});

		test("closed named blockers are ignored — even when their native edge exists", () => {
			const body = goodInput().body.replace(
				"**Blocked by:** none",
				"**Blocked by:** #12, #19",
			);
			const result = checkReadiness(
				goodInput({
					body,
					nativeBlockers: [
						{ number: 12, state: "CLOSED" },
						{ number: 19, state: "OPEN" },
					],
					namedStates: { 12: "CLOSED", 19: "OPEN" },
				}),
			);
			expect(inspection(result, "blocked-by-edges").pass).toBe(true);
		});

		test("a named blocker that closed without ever having a native edge is ignored", () => {
			const body = goodInput().body.replace(
				"**Blocked by:** none",
				"**Blocked by:** #12",
			);
			const result = checkReadiness(
				goodInput({ body, namedStates: { 12: "CLOSED" } }),
			);
			expect(inspection(result, "blocked-by-edges").pass).toBe(true);
		});

		test("an open named blocker without a native edge fails, naming it", () => {
			const body = goodInput().body.replace(
				"**Blocked by:** none",
				"**Blocked by:** #19",
			);
			const result = checkReadiness(
				goodInput({ body, namedStates: { 19: "OPEN" } }),
			);
			const edges = inspection(result, "blocked-by-edges");
			expect(edges.pass).toBe(false);
			expect(edges.detail).toContain("#19");
		});

		test("an open native blocker not named in the brief fails, naming it", () => {
			const result = checkReadiness(
				goodInput({ nativeBlockers: [{ number: 23, state: "OPEN" }] }),
			);
			const edges = inspection(result, "blocked-by-edges");
			expect(edges.pass).toBe(false);
			expect(edges.detail).toContain("#23");
		});

		test("`none` on an unblocked ticket passes", () => {
			const result = checkReadiness(goodInput());
			expect(inspection(result, "blocked-by-edges").pass).toBe(true);
		});
	});
});

describe("formatResult", () => {
	test("a pass names the issue and no refusal marker", () => {
		const text = formatResult(24, checkReadiness(goodInput()));
		expect(text).toContain("#24");
		expect(text).not.toContain("READINESS_REFUSAL");
	});

	test("a failure carries READINESS_REFUSAL naming every failed inspection", () => {
		const body = goodInput().body.replace(
			"**Open questions:** none",
			"**Open questions:** is CSV in scope?",
		);
		const result = checkReadiness(
			goodInput({
				body,
				labels: ["needs-info"],
				nativeBlockers: [{ number: 23, state: "OPEN" }],
			}),
		);
		expect(result.ok).toBe(false);
		const text = formatResult(24, result);
		expect(text).toContain("READINESS_REFUSAL");
		expect(text).toContain("open-questions");
		expect(text).toContain("triage-labels");
		expect(text).toContain("blocked-by-edges");
		expect(text).not.toContain("brief-fields");
	});
});
