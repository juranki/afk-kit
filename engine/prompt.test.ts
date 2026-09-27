/**
 * L1 unit tests for the Implementer prompt and structured-result contract
 * (ticket afk-kit #62, durable spec #46): the prompt pins the worktree
 * facts, the immutable brief, the done contract, and the fenced result
 * block; the parser reads that block deterministically — the last fenced
 * JSON block wins, unknown fields are tolerated, and done is judged from
 * the parsed shape, never from prose.
 */

import { describe, expect, test } from "bun:test";
import {
	buildImplementerPrompt,
	parseImplementerResult,
	requireDone,
} from "./prompt.ts";

describe("parseImplementerResult", () => {
	test("reads the fenced status block: done, no open questions", () => {
		const text = [
			"Everything is implemented and committed.",
			"",
			"```json",
			JSON.stringify({ status: "done", summary: "Added the export." }),
			"```",
		].join("\n");
		const parsed = parseImplementerResult(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.result.status).toBe("done");
		expect(parsed.result.summary).toBe("Added the export.");
	});

	test("the last fenced block wins over earlier ones and prose", () => {
		const text = [
			"```json",
			JSON.stringify({ status: "blocked", openQuestions: ["stale?"] }),
			"```",
			"Never mind, resolved.",
			"```json",
			JSON.stringify({ status: "done" }),
			"```",
		].join("\n");
		const parsed = parseImplementerResult(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.result.status).toBe("done");
		expect(parsed.result.openQuestions).toEqual([]);
	});

	test("a bare JSON object with no fence is a candidate", () => {
		const parsed = parseImplementerResult('{"status": "done"}');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.result.status).toBe("done");
	});

	test("blocked reports with open questions parse honestly", () => {
		const text = [
			"I cannot proceed.",
			"```json",
			JSON.stringify({
				status: "blocked",
				summary: "The brief contradicts itself.",
				openQuestions: ["Which timestamp is authoritative?"],
			}),
			"```",
		].join("\n");
		const parsed = parseImplementerResult(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.result.status).toBe("blocked");
		expect(parsed.result.openQuestions).toEqual([
			"Which timestamp is authoritative?",
		]);
	});

	test("no JSON object at all is a parse failure with a reason", () => {
		const parsed = parseImplementerResult("I am done, trust me.");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.reason).toContain("no JSON");
	});

	test("non-JSON fence content is a parse failure", () => {
		const parsed = parseImplementerResult("```\nstatus: done\n```");
		expect(parsed.ok).toBe(false);
	});

	test("a status that is not a non-empty string is invalid", () => {
		const parsed = parseImplementerResult('```json\n{"status": 42}\n```');
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.reason).toContain("status");
	});

	test("non-string or non-array openQuestions are invalid", () => {
		for (const bad of [
			'{"status":"done","openQuestions":"none"}',
			'{"status":"done","openQuestions":[42]}',
		]) {
			const parsed = parseImplementerResult(`\`\`\`json\n${bad}\n\`\`\``);
			expect(parsed.ok).toBe(false);
		}
	});
});

describe("requireDone", () => {
	test("done means status done and no open questions", () => {
		expect(requireDone({ status: "done", openQuestions: [] })).toBe(true);
		expect(requireDone({ status: "done" })).toBe(true);
	});

	test("any other status, or done with questions, is not done", () => {
		expect(requireDone({ status: "blocked", openQuestions: ["?"] })).toBe(
			false,
		);
		expect(
			requireDone({ status: "done", openQuestions: ["one open"] }),
		).toBe(false);
	});
});

describe("buildImplementerPrompt", () => {
	const brief = [
		"## Agent brief",
		"",
		"**Summary:** Fix the export.",
		"",
		"**Acceptance criteria:**",
		"- [ ] It works.",
		"",
		"**Verify commands:**",
		"- `bun test`",
		"",
		"**Blocked by:** none",
		"**Blocks:** none",
		"**Touched areas:** src",
		"**Out of scope:** nothing",
		"**Open questions:** none",
	].join("\n");

	const facts = {
		issue: 7,
		branch: "issue-7-fix-export",
		worktree: "/tmp/wt/issue-7",
		cycle: 1,
		brief,
	};

	test("cycle 1 carries the brief, the worktree facts, and the done contract", () => {
		const prompt = buildImplementerPrompt(facts);
		expect(prompt).toContain("#7");
		expect(prompt).toContain("issue-7-fix-export");
		expect(prompt).toContain("/tmp/wt/issue-7");
		expect(prompt).toContain(brief);
		expect(prompt).toContain("`bun test`");
		expect(prompt).toContain("status");
		expect(prompt).toContain("done");
		expect(prompt).toContain("openQuestions");
	});

	test("the done contract demands observed facts over prose", () => {
		const prompt = buildImplementerPrompt(facts);
		expect(prompt).toMatch(/commit/i);
		expect(prompt).toMatch(/clean/i);
	});

	test("a later cycle is cumulative: prior work must never be undone", () => {
		const prompt = buildImplementerPrompt({ ...facts, cycle: 2 });
		expect(prompt).toMatch(/earlier/i);
		expect(prompt).toMatch(/never/i);
	});

	test("failed-cycle feedback rides into the next prompt verbatim", () => {
		const feedback =
			"Verify command `bun test` failed (exit 1, 0 timeouts).\n--- stdout (last 3 chars) ---\nout";
		const prompt = buildImplementerPrompt({ ...facts, cycle: 2, feedback });
		expect(prompt).toContain(feedback);
	});

	test("cycle 1 never carries a feedback section", () => {
		const prompt = buildImplementerPrompt(facts);
		expect(prompt).not.toMatch(/previous cycle/i);
	});
});
