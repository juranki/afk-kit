/**
 * L1 unit tests for the Engine's pinned implementation skills (ADR 0015,
 * ticket afk-kit #75): the pin list lives with the engine configuration,
 * each pinned name must resolve to an installed `SKILL.md` under the SDK's
 * own agent directory, and every resolution records the file's SHA-256 —
 * the evidence of the precise text an Implementer session is given. The
 * skills root is injected; the SDK import is faked at its port
 * (code-verify standard: deterministic, offline, no host state).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAgentDefinition } from "./agent-runner.ts";
import {
	IMPLEMENTATION_SKILLS,
	resolveImplementationSkills,
	validateEngineConfig,
} from "./config.ts";

function scratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "afk-config-"));
}

function installSkill(skillsDir: string, name: string, body: string): string {
	const dir = path.join(skillsDir, name);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "SKILL.md");
	fs.writeFileSync(file, body);
	return file;
}

/** A fake SDK module whose agent directory is the given one. */
function fakeSdk(agentDir: () => string): () => Promise<unknown> {
	return async () => ({ getAgentDir: agentDir });
}

/** An agent directory with all three pinned skills installed in it. */
function agentDirWithSkills(): { agentDir: string; skillsDir: string } {
	const agentDir = scratch();
	const skillsDir = path.join(agentDir, "skills");
	fs.mkdirSync(skillsDir, { recursive: true });
	return { agentDir, skillsDir };
}

test("preflight rejects assessor definitions with implementation capabilities or missing role pins", async () => {
	const root = scratch();
	try {
		for (const file of fs.readdirSync(path.join(import.meta.dir, "agents")))
			fs.copyFileSync(
				path.join(import.meta.dir, "agents", file),
				path.join(root, file),
			);
		fs.writeFileSync(
			path.join(root, "readiness-assessor.md"),
			"---\nname: readiness-assessor\nprovider: zai\nmodel: glm-5.3\nthinking: high\ntools: [read, edit, write, bash]\n---\nAssess readiness.\n",
		);
		const result = await validateEngineConfig({
			definitionsRoot: root,
			sdkImport: async () => ({}),
		});
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("readiness-assessor");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("resolveImplementationSkills (L1)", () => {
	test("resolves each pinned skill to its installed SKILL.md and hashes it", async () => {
		const { agentDir, skillsDir } = agentDirWithSkills();
		const implement = installSkill(
			skillsDir,
			"implement",
			"---\nname: implement\n---\nDo the work.\n",
		);
		const tdd = installSkill(
			skillsDir,
			"tdd",
			"---\nname: tdd\n---\nRed, then green.\n",
		);
		const design = installSkill(
			skillsDir,
			"codebase-design",
			"---\nname: codebase-design\n---\nDeep modules.\n",
		);

		const resolved = await resolveImplementationSkills({
			sdkImport: fakeSdk(() => agentDir),
		});

		expect(resolved.ok).toBe(true);
		expect(resolved.problems).toEqual([]);
		expect(resolved.skills.map((s) => s.name)).toEqual([
			"implement",
			"tdd",
			"codebase-design",
		]);
		expect(resolved.skills.map((s) => s.path)).toEqual([
			implement,
			tdd,
			design,
		]);
		// The hashes are the SHA-256 of the exact bytes on disk.
		expect(resolved.skills.map((s) => s.sha256)).toEqual(
			[implement, tdd, design].map((file) =>
				createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
			),
		);
	});

	test("a missing pinned skill is a named problem, not a throw", async () => {
		const { agentDir, skillsDir } = agentDirWithSkills();
		installSkill(skillsDir, "implement", "present");
		// tdd and codebase-design are not installed.

		const resolved = await resolveImplementationSkills({
			sdkImport: fakeSdk(() => agentDir),
		});

		expect(resolved.ok).toBe(false);
		expect(resolved.problems).toHaveLength(2);
		expect(resolved.problems[0]).toContain("tdd");
		expect(resolved.problems[1]).toContain("codebase-design");
		expect(resolved.skills.map((s) => s.name)).toEqual(["implement"]);
	});

	test("an empty SKILL.md is a problem", async () => {
		const { agentDir, skillsDir } = agentDirWithSkills();
		installSkill(skillsDir, "implement", "");
		installSkill(skillsDir, "tdd", "present");
		installSkill(skillsDir, "codebase-design", "present");

		const resolved = await resolveImplementationSkills({
			sdkImport: fakeSdk(() => agentDir),
		});

		expect(resolved.ok).toBe(false);
		expect(resolved.problems).toHaveLength(1);
		expect(resolved.problems[0]).toContain("implement");
	});

	test("the default skills root comes from the SDK's agent directory", async () => {
		const { agentDir, skillsDir } = agentDirWithSkills();
		installSkill(skillsDir, "implement", "present");
		installSkill(skillsDir, "tdd", "present");
		installSkill(skillsDir, "codebase-design", "present");

		const resolved = await resolveImplementationSkills({
			sdkImport: fakeSdk(() => agentDir),
		});

		expect(resolved.ok).toBe(true);
		// Every resolved path sits in the SDK agent directory's skills set —
		// the same text an attended session discovers.
		for (const skill of resolved.skills) {
			expect(skill.path.startsWith(`${skillsDir}${path.sep}`)).toBe(true);
		}
	});

	test("an SDK that exports no agent directory is a named problem", async () => {
		const resolved = await resolveImplementationSkills({
			sdkImport: async () => ({}),
		});

		expect(resolved.ok).toBe(false);
		expect(resolved.problems.join(" ")).toContain("agent directory");
	});
});

describe("the implementation skills pin (ADR 0015)", () => {
	test("the engine pin matches the shipped Implementer definition's pin", () => {
		const definition = parseAgentDefinition(
			fs.readFileSync(
				path.join(import.meta.dir, "agents", "implementer.md"),
				"utf8",
			),
		);
		expect([...IMPLEMENTATION_SKILLS]).toEqual(definition.skills);
	});
});
