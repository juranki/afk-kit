/**
 * Tests for agent discovery's frontmatter parsing — R2's `thinking` field
 * (ticket afk-kit #16) plus the existing tools/model handling, which now
 * share the discovery code path with it; and for the shipped implementer
 * agent definition (R2 + R5, ticket afk-kit #17).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	discoverAgents,
	parseThinkingLevel,
	THINKING_LEVELS,
} from "./agents.ts";
import { buildSubagentArgs } from "./background.ts";

let projectDir: string;

beforeEach(() => {
	const tmpRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "subagent-agents-test-"),
	);
	projectDir = tmpRoot;
	fs.mkdirSync(path.join(tmpRoot, ".pi", "agents"), { recursive: true });
});

function writeAgent(name: string, frontmatter: string): void {
	fs.writeFileSync(
		path.join(projectDir, ".pi", "agents", `${name}.md`),
		`---\n${frontmatter}\n---\n\nBody.\n`,
	);
}

describe("frontmatter parsing", () => {
	describe("the confinement field (R5, #17)", () => {
		test("a confinement value marks the agent confined", () => {
			writeAgent("a", "name: a\ndescription: d\nconfinement: implementer");
			const { agents } = discoverAgents(projectDir, "project");
			expect(agents[0].confinement).toBe("implementer");
		});

		test("a missing confinement field means unconfined", () => {
			writeAgent("a", "name: a\ndescription: d");
			const { agents } = discoverAgents(projectDir, "project");
			expect(agents[0].confinement).toBeUndefined();
		});

		test("an empty confinement value means unconfined", () => {
			writeAgent("a", 'name: a\ndescription: d\nconfinement: ""');
			const { agents } = discoverAgents(projectDir, "project");
			expect(agents[0].confinement).toBeUndefined();
		});

		test("an unknown value still confines (fail-safe: the only shipped profile applies)", () => {
			writeAgent("a", "name: a\ndescription: d\nconfinement: implementa");
			const { agents } = discoverAgents(projectDir, "project");
			expect(agents[0].confinement).toBe("implementa");
		});
	});

	test("a valid thinking level is picked up", () => {
		writeAgent("a", "name: a\ndescription: d\nthinking: high");
		const { agents } = discoverAgents(projectDir, "project");
		expect(agents).toHaveLength(1);
		expect(agents[0].thinking).toBe("high");
	});

	test("an invalid thinking level yields no thinking instead of throwing", () => {
		writeAgent("a", "name: a\ndescription: d\nthinking: extremely");
		const { agents } = discoverAgents(projectDir, "project");
		expect(agents).toHaveLength(1);
		expect(agents[0].thinking).toBeUndefined();
	});

	test("a non-string thinking level yields no thinking", () => {
		writeAgent("a", "name: a\ndescription: d\nthinking: 3");
		const { agents } = discoverAgents(projectDir, "project");
		expect(agents[0].thinking).toBeUndefined();
	});

	test("a missing thinking field yields no thinking", () => {
		writeAgent("a", "name: a\ndescription: d");
		const { agents } = discoverAgents(projectDir, "project");
		expect(agents[0].thinking).toBeUndefined();
	});

	test("every documented level parses", () => {
		for (const level of THINKING_LEVELS) {
			expect(parseThinkingLevel(level)).toBe(level);
		}
		expect(parseThinkingLevel("HIGH")).toBeUndefined();
	});

	test("agents without a thinking field still discover with tools and model", () => {
		writeAgent(
			"a",
			"name: a\ndescription: d\nmodel: zai/glm-5.3\ntools: read, bash",
		);
		const { agents } = discoverAgents(projectDir, "project");
		expect(agents[0].model).toBe("zai/glm-5.3");
		expect(agents[0].tools).toEqual(["read", "bash"]);
	});
});

describe("the shipped implementer agent (R2 + R5, #17)", () => {
	const filePath = path.join(import.meta.dir, "agents", "implementer.md");
	let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;

	const load = () =>
		parseFrontmatter<Record<string, unknown>>(
			fs.readFileSync(filePath, "utf-8"),
		);

	test("exists in the shipped roster and parses", () => {
		parsed = load();
		expect(parsed.frontmatter.name).toBe("implementer");
		expect(typeof parsed.frontmatter.description).toBe("string");
	});

	test("routes on glm-5.3-flash (ADR 0004), through to the child argv", () => {
		expect(parsed.frontmatter.model).toBe("glm-5.3-flash");
		const args = buildSubagentArgs(
			{ name: "implementer", description: "d", model: "glm-5.3-flash" },
			{},
		);
		expect(args).toContain("glm-5.3-flash");
	});

	test("is confined and carries a tools allowlist", () => {
		expect(parsed.frontmatter.confinement).toBe("implementer");
		expect(typeof parsed.frontmatter.tools).toBe("string");
		expect(String(parsed.frontmatter.tools)).toContain("bash");
	});

	test("its system prompt forbids publishing and requires the structured result", () => {
		const body = parsed.body.toLowerCase();
		expect(body).toContain("push");
		expect(body).toContain("gh");
		expect(body).toContain("commit");
		expect(body).toContain("open questions");
	});
});

describe("package-relative roster loading (R2, #34)", () => {
	// getAgentDir() honors PI_CODING_AGENT_DIR at call time; pointing it at a
	// fresh directory empties the user layer and keeps the test hermetic.
	let cleanUserDir: string;

	beforeEach(() => {
		cleanUserDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "subagent-package-roster-"),
		);
		process.env.PI_CODING_AGENT_DIR = cleanUserDir;
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	test("the shipped roster reaches discovery with no user or project agents", () => {
		const { agents } = discoverAgents(projectDir, "user");
		const names = agents.map((a) => a.name);
		expect(names).toContain("implementer");
		expect(names).toContain("reviewer");
		for (const agent of agents) expect(agent.source).toBe("package");
	});

	test("the shipped implementer is confined and package-sourced", () => {
		const { agents } = discoverAgents(projectDir, "user");
		const implementer = agents.find((a) => a.name === "implementer");
		expect(implementer?.confinement).toBe("implementer");
		expect(implementer?.filePath).toContain(
			path.join("extensions", "subagent", "agents"),
		);
	});

	test("a user-level definition shadows the shipped one by name", () => {
		fs.mkdirSync(path.join(cleanUserDir, "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(cleanUserDir, "agents", "implementer.md"),
			"---\nname: implementer\ndescription: local override\n---\n\nBody.\n",
		);
		const { agents } = discoverAgents(projectDir, "user");
		const implementers = agents.filter((a) => a.name === "implementer");
		expect(implementers).toHaveLength(1);
		expect(implementers[0].source).toBe("user");
		expect(implementers[0].description).toBe("local override");
	});

	test("project scope stays project-only: no package agents leak in", () => {
		writeAgent("local", "name: local\ndescription: d");
		const { agents } = discoverAgents(projectDir, "project");
		expect(agents.map((a) => a.name)).toEqual(["local"]);
	});

	test("scope both layers user over package", () => {
		fs.mkdirSync(path.join(cleanUserDir, "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(cleanUserDir, "agents", "implementer.md"),
			"---\nname: implementer\ndescription: local override\n---\n\nBody.\n",
		);
		const { agents } = discoverAgents(projectDir, "both");
		const implementer = agents.find((a) => a.name === "implementer");
		const reviewer = agents.find((a) => a.name === "reviewer");
		expect(implementer?.source).toBe("user");
		expect(reviewer?.source).toBe("package");
	});
});

describe("the shipped reviewer agent (R6, #18)", () => {
	const filePath = path.join(import.meta.dir, "agents", "reviewer.md");
	let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;

	const load = () =>
		parseFrontmatter<Record<string, unknown>>(
			fs.readFileSync(filePath, "utf-8"),
		);

	test("exists in the shipped roster and parses", () => {
		parsed = load();
		expect(parsed.frontmatter.name).toBe("reviewer");
		expect(typeof parsed.frontmatter.description).toBe("string");
	});

	test("routes on glm-5.3 (ADR 0004's reviewer routing), through to the child argv", () => {
		expect(parsed.frontmatter.model).toBe("glm-5.3");
		const args = buildSubagentArgs(
			{ name: "reviewer", description: "d", model: "glm-5.3" },
			{},
		);
		expect(args).toContain("glm-5.3");
	});

	test("is not confined (the implementer is the only confined agent)", () => {
		expect(parsed.frontmatter.confinement).toBeUndefined();
	});

	test("carries a tools allowlist including bash, for the brief's verify commands", () => {
		expect(typeof parsed.frontmatter.tools).toBe("string");
		const tools = String(parsed.frontmatter.tools);
		expect(tools).toContain("bash");
		expect(tools).toContain("read");
		expect(tools).not.toContain("edit");
		expect(tools).not.toContain("write");
	});

	test("its system prompt takes the diff from the task, not the network", () => {
		const body = parsed.body.toLowerCase();
		expect(body).toContain("task text");
		expect(body).toContain("verify");
		expect(body).not.toContain("git diff");
	});

	test("its system prompt emits the JSON verdict convention the parser reads", () => {
		const body = parsed.body;
		expect(body).toContain('"verdict"');
		expect(body).toContain("request-changes");
		expect(body).toContain("severity");
		expect(body).toContain("```json");
	});
});
