/**
 * Tests for agent discovery's frontmatter parsing — R2's `thinking` field
 * (ticket afk-kit #16) plus the existing tools/model handling, which now
 * share the discovery code path with it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	discoverAgents,
	parseThinkingLevel,
	THINKING_LEVELS,
} from "./agents.ts";

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
