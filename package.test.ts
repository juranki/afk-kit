import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { parseAgentDefinition } from "./engine/agent-runner.ts";

const repoRoot = import.meta.dir;
const manifest = JSON.parse(
	fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
) as {
	bin?: Record<string, string>;
	pi?: { extensions?: string[]; prompts?: string[]; skills?: string[] };
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

test("pi exposes readiness only, not a second prompt-facing coordinator loop", async () => {
	expect(manifest.pi?.extensions).toEqual(["./extensions/readiness/index.ts"]);
	expect(manifest.pi?.skills).toEqual([]);
	expect(
		fs.existsSync(path.join(repoRoot, "extensions/coordinator/index.ts")),
	).toBe(false);
	expect(
		fs.existsSync(path.join(repoRoot, "extensions/coordinator/ops.ts")),
	).toBe(false);
	const libraries = await import("./engine/claim.ts");
	expect(typeof libraries.claimTicket).toBe("function");
});

test("the distributable ships an executable CLI and exact agent resources, without retired surfaces", () => {
	const result = Bun.spawnSync(
		["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
		{ cwd: repoRoot },
	);
	expect(result.exitCode).toBe(0);
	const [pack] = JSON.parse(result.stdout.toString()) as {
		files: { path: string; mode: number }[];
	}[];
	if (!pack) throw new Error("npm pack returned no package");
	const files = pack.files.map((f) => f.path);
	expect(manifest.bin).toEqual({ afk: "./engine/cli.ts" });
	expect(files).toContain("engine/cli.ts");
	for (const role of ["implementer", "standards-reviewer", "spec-reviewer"]) {
		expect(files).toContain(`engine/agents/${role}.md`);
	}
	expect(
		fs.readFileSync(path.join(repoRoot, "engine/cli.ts"), "utf8"),
	).toStartWith("#!/usr/bin/env bun\n");
	fs.accessSync(path.join(repoRoot, "engine/cli.ts"), fs.constants.X_OK);
	expect(
		files.some(
			(f) =>
				f.startsWith("skills/") ||
				f.endsWith(".test.ts") ||
				f.startsWith("prototype/") ||
				f === "extensions/coordinator/index.ts",
		),
	).toBe(false);
	const cli = Bun.spawnSync([path.join(repoRoot, "engine/cli.ts"), "help"], {
		cwd: repoRoot,
	});
	expect(cli.exitCode).toBe(0);
	expect(cli.stdout.toString()).toContain("implement <issue-number>");
}, 30_000);

test("pi loads the package without retired coordinator tools or skills", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "afk-package-load-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: path.join(root, "agent"),
			settingsManager: SettingsManager.inMemory({ packages: [repoRoot] }),
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		expect([...(loaded.extensions[0]?.tools.keys() ?? [])]).toEqual([
			"readiness_check",
		]);
		expect(
			loader
				.getSkills()
				.skills.filter((skill) =>
					skill.filePath.startsWith(repoRoot + path.sep),
				),
		).toEqual([]);
		expect(loader.getPrompts().prompts).toEqual([]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("package-owned agent definitions pin models, thinking and role capabilities", () => {
	for (const role of ["implementer", "standards-reviewer", "spec-reviewer"]) {
		const definition = parseAgentDefinition(
			fs.readFileSync(
				path.join(repoRoot, "engine/agents", `${role}.md`),
				"utf8",
			),
		);
		expect(definition.provider).toBe("zai");
		expect(definition.model).toBe(
			role === "implementer" ? "glm-5.3-flash" : "glm-5.3",
		);
		expect(definition.thinking).toBe("high");
		expect(definition.tools).toEqual(
			role === "implementer" ? ["read", "edit", "write", "bash"] : ["read"],
		);
	}
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
