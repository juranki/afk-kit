/**
 * L1 unit tests for the engine's pure pull-request and escalation shaping
 * (ticket afk-kit #58, code-verify standard): deterministic decision logic,
 * offline — no git, no network, no stubs.
 */

import { describe, expect, test } from "bun:test";
import { statusComment } from "./escalate.ts";
import { draftPrBody } from "./pr-ops.ts";

const BRIEF_BODY = [
	"## Agent brief",
	"",
	"**Summary:** Scratch issue for the shaping tests.",
	"",
	"**Acceptance criteria:**",
	"- [ ] The shaped body matches the convention.",
	"",
	"**Verify commands:**",
	"- `bun test`",
	"- `bun run verify`",
	"",
	"**Blocked by:** none",
	"**Blocks:** none",
	"",
	"**Touched areas:** scratch only",
	"",
	"**Out of scope:** nothing.",
	"",
	"**Open questions:** none",
	"",
].join("\n");

describe("draftPrBody", () => {
	test("shapes the convention's sections with every verify command pending", () => {
		const body = draftPrBody(BRIEF_BODY, 7);
		const lines = body.split("\n");
		expect(lines[0]).toBe("Closes #7");
		expect(body).toContain("## Acceptance criteria");
		expect(body).toContain("The shaped body matches the convention.");
		expect(body).toContain("## Touched areas");
		expect(body).toContain("scratch only");
		expect(body).toContain("## Verify commands");
		expect(body).toContain("- `bun test` — pending");
		expect(body).toContain("- `bun run verify` — pending");
		// Sections in the convention's order.
		expect(lines.indexOf("## Acceptance criteria")).toBeLessThan(
			lines.indexOf("## Touched areas"),
		);
		expect(lines.indexOf("## Touched areas")).toBeLessThan(
			lines.indexOf("## Verify commands"),
		);
		// No result lines: the draft carries no evidence yet.
		expect(body).not.toContain("— pass");
		expect(body).not.toContain("— FAIL");
		expect(body.endsWith("\n")).toBe(false);
	});
});

describe("statusComment", () => {
	test("names the run, stage, cycle, reason, and every artifact given", () => {
		const comment = statusComment({
			issue: 7,
			run: "20260927T120000Z-abcd",
			stage: "implement",
			cycle: 3,
			reason: "Verify failed after the third cycle",
			pr: { number: 57, url: "https://example.com/repo/pull/57" },
			branch: "issue-7-scratch",
			worktree: "/tmp/wt/remote/issue-7-scratch",
			runDirectory:
				"/state/afk/github.com/example/repo/issues/7/runs/20260927T120000Z-abcd",
		});
		expect(comment).toContain(
			"ESCALATION: Run 20260927T120000Z-abcd on #7 stopped at implement, cycle 3: Verify failed after the third cycle",
		);
		expect(comment).toContain("- PR: #57 https://example.com/repo/pull/57");
		expect(comment).toContain("- Branch: issue-7-scratch");
		expect(comment).toContain("- Worktree: /tmp/wt/remote/issue-7-scratch");
		expect(comment).toContain(
			"- Run directory: /state/afk/github.com/example/repo/issues/7/runs/20260927T120000Z-abcd",
		);
		expect(comment).toContain("preserved for inspection");
		expect(comment).toContain("ready-for-agent");
	});

	test("omits the lines for absent facts and never names a cycle that is not there", () => {
		const comment = statusComment({
			issue: 7,
			run: "20260927T120000Z-abcd",
			stage: "preflight",
			reason: "the pinned model is unavailable",
		});
		expect(comment).toContain("stopped at preflight:");
		expect(comment).not.toContain(", cycle");
		expect(comment).not.toContain("- PR:");
		expect(comment).not.toContain("- Branch:");
		expect(comment).not.toContain("- Worktree:");
		expect(comment).not.toContain("- Run directory:");
	});
});
