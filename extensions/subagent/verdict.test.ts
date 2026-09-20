/**
 * Tests for the R6 verdict convention's coordinator-side parse (ticket
 * afk-kit #18): the reviewer's final output text goes in, an approve or a
 * severity-ranked request-changes verdict comes out, and anything else is
 * unparseable — the coordinator escalates on that (ADR 0007).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	parseVerdict,
	SEVERITIES,
	type Severity,
	type Verdict,
	type VerdictFinding,
} from "./verdict.ts";

describe("parseVerdict", () => {
	test("a bare-JSON approve verdict with no prose around it parses", () => {
		const parsed = parseVerdict('{"verdict":"approve"}');
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.verdict.verdict).toBe("approve");
	});

	test("the last fenced block wins when several are present", () => {
		const text = [
			"First a non-verdict example:",
			"```json",
			'{ "verdict": "not-a-verdict" }',
			"```",
			"Final verdict:",
			"```json",
			'{ "verdict": "approve" }',
			"```",
		].join("\n");
		const parsed = parseVerdict(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.verdict.verdict).toBe("approve");
	});

	describe("malformed verdicts are refused with a reason, never thrown", () => {
		test("output with no JSON in it", () => {
			const parsed = parseVerdict("Looks good to me. LGTM! \u{1F44D}");
			expect(parsed).toEqual({
				ok: false,
				reason: "no JSON verdict object found in the output",
			});
		});

		test("a fenced block whose JSON does not parse", () => {
			const parsed = parseVerdict('```json\n{"verdict": approve}\n```');
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.reason).toContain("does not parse");
		});

		test("a JSON array where the verdict object belongs", () => {
			const parsed = parseVerdict('```json\n[{"verdict":"approve"}]\n```');
			expect(parsed).toEqual({
				ok: false,
				reason: "verdict is not a JSON object",
			});
		});

		test("an unknown verdict value", () => {
			const parsed = parseVerdict('```json\n{"verdict":"LGTM"}\n```');
			expect(parsed.ok).toBe(false);
			if (!parsed.ok)
				expect(parsed.reason).toContain('"approve" or "request-changes"');
		});

		test("an approve that carries findings", () => {
			const parsed = parseVerdict(
				'```json\n{"verdict":"approve","findings":[{"severity":"minor","summary":"a nit"}]}\n```',
			);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.reason).toContain("contradictory");
		});

		test("a request-changes with no findings", () => {
			const parsed = parseVerdict(
				'```json\n{"verdict":"request-changes"}\n```',
			);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.reason).toContain("at least one finding");
		});

		test("a finding with an unknown severity", () => {
			const parsed = parseVerdict(
				'```json\n{"verdict":"request-changes","findings":[{"severity":"catastrophic","summary":"x"}]}\n```',
			);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.reason).toContain("blocker, major, minor");
		});

		test("a finding with no summary", () => {
			const parsed = parseVerdict(
				'```json\n{"verdict":"request-changes","findings":[{"severity":"major"}]}\n```',
			);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.reason).toContain("non-empty summary");
		});
	});

	test("the parser's severity ladder matches the reviewer prompt's", () => {
		const reviewer = fs.readFileSync(
			path.join(import.meta.dir, "agents", "reviewer.md"),
			"utf-8",
		);
		for (const severity of SEVERITIES) {
			expect(reviewer).toContain(`**${severity}**`);
		}
	});

	test("a well-formed request-changes verdict parses with its findings", () => {
		const text = [
			"The fix is missing a test and has a naming issue.",
			"",
			"```json",
			"{",
			'  "verdict": "request-changes",',
			'  "summary": "Two findings below must be addressed.",',
			'  "findings": [',
			"    {",
			'      "severity": "blocker",',
			'      "file": "src/verdict.ts",',
			'      "line": 42,',
			'      "summary": "Escalation path never taken on malformed JSON",',
			'      "detail": "The parse failure is swallowed and reported as approve."',
			"    },",
			"    {",
			'      "severity": "minor",',
			'      "file": "repo-wide",',
			'      "summary": "Severity vocabulary undocumented in the agent prompt"',
			"    }",
			"  ]",
			"}",
			"```",
		].join("\n");
		const parsed = parseVerdict(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			const verdict: Verdict = parsed.verdict;
			expect(verdict.verdict).toBe("request-changes");
			expect(verdict.findings).toHaveLength(2);
			const first: VerdictFinding = verdict.findings[0];
			const severity: Severity = first.severity;
			expect(severity).toBe("blocker");
			expect(first.file).toBe("src/verdict.ts");
			expect(first.line).toBe(42);
			expect(verdict.findings[1].severity).toBe("minor");
			expect(verdict.findings[1].line).toBeUndefined();
		}
	});

	test("a well-formed approve verdict in a fenced block parses as approve", () => {
		const text = [
			"## Review notes",
			"",
			"The change is small and correct; verify commands pass.",
			"",
			"```json",
			"{",
			'  "verdict": "approve",',
			'  "summary": "Correct, minimal, verify commands pass."',
			"}",
			"```",
		].join("\n");
		const parsed = parseVerdict(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.verdict.verdict).toBe("approve");
			expect(parsed.verdict.findings).toEqual([]);
			expect(parsed.verdict.summary).toBe(
				"Correct, minimal, verify commands pass.",
			);
		}
	});
});
