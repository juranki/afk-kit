/**
 * L1 unit tests for the branch/worktree slug rule (ticket afk-kit #19):
 * kebab-case of the issue title, at most 30 characters — the canonical rule
 * lives in docs/conventions/branching-and-prs.md.
 */

import { describe, expect, test } from "bun:test";
import { projectFor, slugFor } from "./slug.ts";

describe("slugFor", () => {
	test("kebab-cases the title and truncates at the last hyphen within 30 characters", () => {
		expect(
			slugFor(
				"Coordinator mechanics: atomic claim + worktree + branch, push + PR (R7)",
			),
		).toBe("coordinator-mechanics-atomic");
	});

	test("collapses runs of non-alphanumerics into single hyphens and trims", () => {
		expect(slugFor("  Hello,  World!! -- again  ")).toBe("hello-world-again");
	});

	test("keeps a title already within the budget whole", () => {
		expect(slugFor("Add JSONL export")).toBe("add-jsonl-export");
	});

	test("hard-cuts a single word longer than 30 characters", () => {
		expect(slugFor("supercalifragilisticexpialidocious")).toBe(
			"supercalifragilisticexpialidoc",
		);
	});

	test("a degenerate title falls back to issue", () => {
		expect(slugFor("???")).toBe("issue");
		expect(slugFor("")).toBe("issue");
	});
});

describe("projectFor", () => {
	test("strips .git and takes the last path segment", () => {
		expect(projectFor("git@github.com:juranki/afk-kit.git")).toBe("afk-kit");
		expect(projectFor("https://github.com/juranki/afk-kit")).toBe("afk-kit");
		expect(projectFor("/tmp/coordinator-ops-x/remote.git")).toBe("remote");
	});
});
