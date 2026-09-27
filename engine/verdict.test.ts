/**
 * L1 unit tests for the structured Review verdict (ticket afk-kit #63,
 * durable spec #46): parsing the reviewers' fenced JSON verdicts and the
 * pure judgment that folds two Review sides into one gate outcome.
 * Deterministic decision logic — offline, no git, no network.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { judgeReviews, parseVerdict } from "./verdict.ts";

function fenced(json: unknown): string {
	return [
		"Prose before the block.",
		"```json",
		JSON.stringify(json),
		"```",
	].join("\n");
}

const SHA = (content: string): string =>
	createHash("sha256").update(content).digest("hex");

describe("parseVerdict", () => {
	test("an approve verdict parses with empty findings", () => {
		const parsed = parseVerdict(
			fenced({ verdict: "approve", summary: "The diff is clean." }),
		);
		expect(parsed).toEqual({
			ok: true,
			verdict: {
				verdict: "approve",
				summary: "The diff is clean.",
				findings: [],
			},
		});
	});

	test("the last fenced block wins over earlier prose and blocks", () => {
		const text = [
			"```json",
			JSON.stringify({ verdict: "request-changes" }),
			"```",
			"More thought led me here.",
			"```json",
			JSON.stringify({ verdict: "approve", summary: "settled" }),
			"```",
		].join("\n");
		const parsed = parseVerdict(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.verdict.verdict).toBe("approve");
	});

	test("a bare JSON object without fencing parses", () => {
		const parsed = parseVerdict(
			JSON.stringify({ verdict: "escalate", summary: "unsafe" }),
		);
		expect(parsed).toEqual({
			ok: true,
			verdict: { verdict: "escalate", summary: "unsafe", findings: [] },
		});
	});

	test("an unknown verdict label is refused, naming the allowed labels", () => {
		const parsed = parseVerdict(fenced({ verdict: "LGTM" }));
		expect(parsed).toEqual({
			ok: false,
			reason: "verdict is not one of approve, request-changes, escalate",
		});
	});

	test("a missing verdict label is refused", () => {
		const parsed = parseVerdict(fenced({ summary: "looks fine" }));
		expect(parsed).toEqual({
			ok: false,
			reason: "verdict is not one of approve, request-changes, escalate",
		});
	});

	test("a non-object payload is refused", () => {
		expect(parseVerdict(fenced(["approve"]))).toEqual({
			ok: false,
			reason: "the verdict is not a JSON object",
		});
	});

	test("text with no JSON at all is refused", () => {
		expect(parseVerdict("I approve this wholeheartedly!")).toEqual({
			ok: false,
			reason: "no JSON verdict object found in the output",
		});
	});

	test("request-changes without findings is malformed", () => {
		const parsed = parseVerdict(fenced({ verdict: "request-changes" }));
		expect(parsed).toEqual({
			ok: false,
			reason: "request-changes requires at least one severity-ranked finding",
		});
	});

	test("findings carry severity, note, and optional file", () => {
		const parsed = parseVerdict(
			fenced({
				verdict: "request-changes",
				summary: "Two problems.",
				findings: [
					{
						severity: "blocker",
						file: "src/gate.ts",
						note: "the gate never closes",
					},
					{ severity: "minor", note: "typo in the doc comment" },
				],
			}),
		);
		expect(parsed).toEqual({
			ok: true,
			verdict: {
				verdict: "request-changes",
				summary: "Two problems.",
				findings: [
					{
						severity: "blocker",
						file: "src/gate.ts",
						note: "the gate never closes",
					},
					{ severity: "minor", note: "typo in the doc comment" },
				],
			},
		});
	});

	test("an off-ladder finding severity is refused", () => {
		const parsed = parseVerdict(
			fenced({
				verdict: "request-changes",
				findings: [{ severity: "huge", note: "bad" }],
			}),
		);
		expect(parsed).toEqual({
			ok: false,
			reason: "finding severity is not one of blocker, major, minor",
		});
	});

	test("an empty finding note is refused", () => {
		const parsed = parseVerdict(
			fenced({
				verdict: "request-changes",
				findings: [{ severity: "major", note: "  " }],
			}),
		);
		expect(parsed).toEqual({
			ok: false,
			reason: "finding note is not a non-empty string",
		});
	});

	test("standardsConsulted entries demand a path and a sha256 hex hash", () => {
		const parsed = parseVerdict(
			fenced({
				verdict: "approve",
				standardsConsulted: [
					{ path: "AGENTS.md", hash: SHA("contents").toUpperCase() },
				],
			}),
		);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			// Hashes normalize to lowercase so the Engine compares one form.
			expect(parsed.verdict.standardsConsulted?.[0]?.hash).toBe(
				SHA("contents"),
			);
		}
	});

	test("a consulted entry with a non-hex hash is refused", () => {
		const parsed = parseVerdict(
			fenced({
				verdict: "approve",
				standardsConsulted: [{ path: "AGENTS.md", hash: "deadbee" }],
			}),
		);
		expect(parsed).toEqual({
			ok: false,
			reason: "standardsConsulted hash is not sha256 hex: AGENTS.md",
		});
	});

	test("a consulted entry with an empty path is refused", () => {
		const parsed = parseVerdict(
			fenced({
				verdict: "approve",
				standardsConsulted: [{ path: "", hash: SHA("x") }],
			}),
		);
		expect(parsed).toEqual({
			ok: false,
			reason: "standardsConsulted path is not a non-empty string",
		});
	});
});

describe("judgeReviews", () => {
	const approve = (summary?: string) => ({
		ok: true as const,
		verdict: {
			verdict: "approve" as const,
			findings: [],
			...(summary === undefined ? {} : { summary }),
		},
	});

	test("dual approval carries both verdicts and the reviewers' notes", () => {
		const judged = judgeReviews(
			{
				ok: true,
				verdict: {
					verdict: "approve",
					summary: "Built our way.",
					findings: [],
				},
			},
			{
				ok: true,
				verdict: {
					verdict: "approve",
					summary: "Brief satisfied.",
					findings: [],
				},
			},
		);
		expect(judged).toEqual({
			status: "approved",
			approvals: [
				{
					review: "standards",
					verdict: {
						verdict: "approve",
						summary: "Built our way.",
						findings: [],
					},
				},
				{
					review: "spec",
					verdict: {
						verdict: "approve",
						summary: "Brief satisfied.",
						findings: [],
					},
				},
			],
			reviewNotes:
				"Standards Review: Built our way.\nSpec Review: Brief satisfied.",
		});
	});

	test("approvals without summaries carry no review notes", () => {
		const judged = judgeReviews(approve(), approve());
		expect(judged).toEqual({
			status: "approved",
			approvals: [
				{ review: "standards", verdict: { verdict: "approve", findings: [] } },
				{ review: "spec", verdict: { verdict: "approve", findings: [] } },
			],
		});
		expect(judged.status === "approved" && judged.reviewNotes).toBeUndefined();
	});

	test("one requesting review fails the gate, ranking its findings", () => {
		const judged = judgeReviews(
			{
				ok: true,
				verdict: {
					verdict: "request-changes",
					summary: "Conventions broken.",
					findings: [
						{ severity: "blocker", file: "src/a.ts", note: "no tests" },
						{ severity: "minor", note: "naming" },
					],
				},
			},
			approve("Brief satisfied."),
		);
		expect(judged.status).toBe("changes-requested");
		if (judged.status === "changes-requested") {
			expect(judged.reason).toContain("standards review requests changes");
			expect(judged.reason).toContain("Conventions broken.");
			expect(judged.reason).toContain("[blocker] src/a.ts: no tests");
			expect(judged.reason).toContain("[minor] general: naming");
		}
	});

	test("both requesting reviews are rendered, standards first", () => {
		const judged = judgeReviews(
			{
				ok: true,
				verdict: {
					verdict: "request-changes",
					findings: [{ severity: "major", note: "s" }],
				},
			},
			{
				ok: true,
				verdict: {
					verdict: "request-changes",
					findings: [{ severity: "minor", note: "p" }],
				},
			},
		);
		expect(judged.status).toBe("changes-requested");
		if (judged.status === "changes-requested") {
			expect(judged.reason.indexOf("standards")).toBeLessThan(
				judged.reason.indexOf("spec review requests changes"),
			);
		}
	});

	test("an escalate verdict wins over a request-changes from the other review", () => {
		const judged = judgeReviews(approve(), {
			ok: true,
			verdict: {
				verdict: "escalate",
				summary: "the brief contradicts the ADR",
				findings: [],
			},
		});
		expect(judged).toEqual({
			status: "escalate",
			reason: "spec review escalated: the brief contradicts the ADR",
		});
	});

	test("an escalate without a summary still names the escalating review", () => {
		const judged = judgeReviews(
			{ ok: true, verdict: { verdict: "escalate", findings: [] } },
			approve(),
		);
		expect(judged).toEqual({
			status: "escalate",
			reason: "standards review escalated (no reason given)",
		});
	});

	test("a malformed review fails the gate deterministically", () => {
		const judged = judgeReviews(
			{ ok: false, reason: "no JSON verdict object found in the output" },
			approve("Brief satisfied."),
		);
		expect(judged).toEqual({
			status: "changes-requested",
			reason:
				"standards review produced no usable verdict: no JSON verdict object found in the output",
		});
	});

	test("an escalate outranks a malformed sibling review", () => {
		const judged = judgeReviews(
			{
				ok: false,
				reason: "verdict is not one of approve, request-changes, escalate",
			},
			{
				ok: true,
				verdict: { verdict: "escalate", summary: "unsafe", findings: [] },
			},
		);
		expect(judged).toEqual({
			status: "escalate",
			reason: "spec review escalated: unsafe",
		});
	});

	test("every failure reason is collected when nothing approves", () => {
		const judged = judgeReviews(
			{ ok: false, reason: "standards failure" },
			{ ok: false, reason: "spec failure" },
		);
		expect(judged).toEqual({
			status: "changes-requested",
			reason: [
				"standards review produced no usable verdict: standards failure",
				"spec review produced no usable verdict: spec failure",
			].join("\n"),
		});
	});
});
