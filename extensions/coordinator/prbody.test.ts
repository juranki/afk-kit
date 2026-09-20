/**
 * L1 unit tests for the pull-request body/title assembly (ticket afk-kit
 * #19). The body's shape and section order are canonical:
 * docs/conventions/branching-and-prs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseBrief } from "../readiness/brief.ts";
import { prBody, prTitle } from "./prbody.ts";

const BRIEF = parseBrief(
	[
		"## Agent brief",
		"",
		"**Summary:** Scratch issue for the publish op's live proof.",
		"",
		"**Acceptance criteria:**",
		"- [ ] Claim refuses a claimed issue without touching state.",
		"- [ ] Publish refuses an issue that already has an open PR.",
		"",
		"**Verify commands:**",
		"- `bun install && bun run verify`",
		"- `bash scripts/smoke-dispatch.sh`",
		"",
		"**Blocked by:** none",
		"**Blocks:** none",
		"",
		"**Touched areas:** extensions/coordinator/",
		"",
		"**Out of scope:** nothing.",
		"",
		"**Open questions:** none",
		"",
	].join("\n"),
);

describe("prTitle", () => {
	test("is the imperative summary with the issue number", () => {
		expect(prTitle("Add JSONL export", 12)).toBe("Add JSONL export (#12)");
	});
});

describe("prBody", () => {
	test("carries Closes, the criteria checklist, touched areas, and verify results, in order", () => {
		const body = prBody(BRIEF, 101, [
			{ command: "bun install && bun run verify", ok: true },
			{ command: "bash scripts/smoke-dispatch.sh", ok: true },
		]);
		const sections = body.split(/^## /m).map((s) => s.split("\n")[0]);
		expect(sections).toEqual([
			"Closes #101",
			"Acceptance criteria",
			"Touched areas",
			"Verify commands",
		]);
		expect(body).toMatch(/^Closes #101\n/);
		expect(body).toContain(
			"- [ ] Claim refuses a claimed issue without touching state.",
		);
		expect(body).toContain("extensions/coordinator/");
		expect(body).toContain("- `bun install && bun run verify` — pass");
		expect(body).toContain("- `bash scripts/smoke-dispatch.sh` — pass");
		// The brief's other fields do not leak into the body.
		expect(body).not.toContain("Out of scope");
		expect(body).not.toContain("Open questions");
	});
});
