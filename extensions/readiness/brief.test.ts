/**
 * Tests for the agent brief parser (ticket afk-kit #24): a ticket body goes
 * in, the eight brief-template lines (the template's seven fields — "Blocked
 * by / blocks" is one field with two lines) come out with presence and
 * content. This is the substrate the readiness check's inspections read
 * (ADR 0012); the template is fixed to the shipped one
 * (docs/brief-template.md) — no per-repo variation.
 */

import { describe, expect, test } from "bun:test";
import { parseBrief } from "./brief.ts";

const SKELETON = [
	"## Agent brief",
	"",
	"**Summary:** Add JSONL export to the reader.",
	"",
	"**Acceptance criteria:**",
	"- [ ] Exported file parses as JSONL.",
	"- [ ] Existing JSON reads are unchanged.",
	"",
	"**Verify commands:**",
	"- `bun test`",
	"- `bun run verify`",
	"",
	"**Blocked by:** #12",
	"**Blocks:** #20",
	"",
	"**Touched areas:** src/reader.ts",
	"",
	"**Out of scope:** CSV export.",
	"",
	"**Open questions:** none",
	"",
].join("\n");

describe("parseBrief", () => {
	test("the shipped template's skeleton parses with every field present", () => {
		const brief = parseBrief(SKELETON);
		for (const field of [
			"summary",
			"acceptanceCriteria",
			"verifyCommands",
			"blockedBy",
			"blocks",
			"touchedAreas",
			"outOfScope",
			"openQuestions",
		] as const) {
			expect(brief[field].present).toBe(true);
		}
		expect(brief.summary.value).toBe("Add JSONL export to the reader.");
		expect(brief.acceptanceCriteria.value).toBe(
			"- [ ] Exported file parses as JSONL.\n- [ ] Existing JSON reads are unchanged.",
		);
		expect(brief.verifyCommands.value).toBe("- `bun test`\n- `bun run verify`");
		expect(brief.blockedBy.value).toBe("#12");
		expect(brief.blocks.value).toBe("#20");
		expect(brief.touchedAreas.value).toBe("src/reader.ts");
		expect(brief.outOfScope.value).toBe("CSV export.");
		expect(brief.openQuestions.value).toBe("none");
	});

	test("a missing field is absent with an empty value, not an error", () => {
		const brief = parseBrief(
			SKELETON.replace("**Out of scope:** CSV export.\n", ""),
		);
		expect(brief.outOfScope.present).toBe(false);
		expect(brief.outOfScope.value).toBe("");
		expect(brief.summary.present).toBe(true);
	});

	test("a field present but empty is present with an empty value", () => {
		const brief = parseBrief(
			SKELETON.replace(
				"**Summary:** Add JSONL export to the reader.",
				"**Summary:**",
			),
		);
		expect(brief.summary.present).toBe(true);
		expect(brief.summary.value).toBe("");
	});

	test("fields are found when the body has no `## Agent brief` heading", () => {
		const brief = parseBrief(SKELETON.replace("## Agent brief\n", ""));
		expect(brief.summary.present).toBe(true);
		expect(brief.summary.value).toBe("Add JSONL export to the reader.");
	});

	test("prose before the heading is not read as field content", () => {
		const body = [
			"## Question",
			"",
			"**Summary:** this is question prose, not a brief field.",
			"",
			SKELETON,
		].join("\n");
		const brief = parseBrief(body);
		expect(brief.summary.value).toBe("Add JSONL export to the reader.");
	});

	test("field content after the heading's next section is ignored", () => {
		const body = [
			SKELETON,
			"## Notes",
			"",
			"**Summary:** trailing prose.",
		].join("\n");
		const brief = parseBrief(body);
		expect(brief.summary.value).toBe("Add JSONL export to the reader.");
	});

	test("`none` and empty count as an Open questions value; fields stay present", () => {
		for (const value of ["none", "None", "none.", ""]) {
			const brief = parseBrief(
				SKELETON.replace(
					"**Open questions:** none",
					`**Open questions:** ${value}`.trimEnd(),
				),
			);
			expect(brief.openQuestions.present).toBe(true);
			expect(brief.openQuestions.value).toBe(value.trimEnd());
		}
	});
});
