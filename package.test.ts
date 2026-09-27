import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = import.meta.dir;
const manifest = JSON.parse(
	fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
) as {
	pi?: { extensions?: string[]; prompts?: string[] };
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
};

test("the package ships without the vendored subagent extension", () => {
	expect(manifest.pi?.extensions ?? []).not.toContain(
		"./extensions/subagent/index.ts",
	);
	expect(manifest.pi?.prompts ?? []).not.toContain(
		"./extensions/subagent/prompts",
	);
	expect(fs.existsSync(path.join(repoRoot, "extensions/subagent"))).toBe(false);
});

test("the package ships without the merge-guard extension", () => {
	expect(manifest.pi?.extensions ?? []).not.toContain(
		"./extensions/merge-guard/index.ts",
	);
	expect(fs.existsSync(path.join(repoRoot, "extensions/merge-guard"))).toBe(
		false,
	);
});

test("sandbox-runtime upgrades are exact-pinned and gated by the live smoke", () => {
	expect(manifest.dependencies?.["@anthropic-ai/sandbox-runtime"]).toMatch(
		/^\d+\.\d+\.\d+$/,
	);
	expect(manifest.scripts?.["confinement:smoke"]).toBe(
		"bun scripts/confinement-smoke.ts",
	);
	expect(
		fs.existsSync(path.join(repoRoot, "scripts/confinement-smoke.ts")),
	).toBe(true);
});
