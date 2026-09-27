import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Pins the CI contract of verify.yml: pull-request trigger, the citable
// "verify" check name, and the code-verify standard's canonical command.
// Comment lines are stripped so no pin can be satisfied from prose.
const lines = fs
	.readFileSync(path.join(import.meta.dir, "verify.yml"), "utf-8")
	.split("\n")
	.filter((line) => !line.trimStart().startsWith("#"));

const onIndex = lines.findIndex((line) => line.trimEnd() === "on:");

test("the verify workflow triggers on pull requests", () => {
	expect(onIndex).toBeGreaterThanOrEqual(0);
	const scope = lines.slice(onIndex + 1, onIndex + 4);
	expect(scope.some((line) => line.trim() === "pull_request:")).toBe(true);
});

test("the verify workflow carries the citable verify check name", () => {
	expect(lines).toContain("jobs:");
	expect(lines).toContain("  verify:");
});

test("the verify workflow runs the canonical verify command", () => {
	const commands = lines
		.filter((line) => /^\s*-\s*run:/.test(line))
		.map((line) => line.replace(/^\s*-\s*run:\s*/, "").trim());
	expect(commands).toContain("bun install && bun run verify");
});
