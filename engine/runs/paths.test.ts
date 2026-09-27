/**
 * L1 unit tests for the Run-state path hierarchy (ticket afk-kit #59): the
 * durable spec pins Run state to
 * `${XDG_STATE_HOME:-~/.local/state}/afk/github.com/<owner>/<repo>/issues/<issue>/runs/<run-id>/`
 * — outside every repository, resolved from the environment.
 */

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	afkStateRoot,
	issueRunsDir,
	repositoryStateRoot,
	runDirectory,
} from "./paths.ts";

describe("afkStateRoot", () => {
	test("honors XDG_STATE_HOME", () => {
		const root = afkStateRoot({ XDG_STATE_HOME: "/var/state" });
		expect(root).toBe(path.join("/var/state", "afk"));
	});

	test("falls back to ~/.local/state", () => {
		const root = afkStateRoot({});
		expect(root).toBe(path.join(os.homedir(), ".local", "state", "afk"));
	});

	test("ignores an empty XDG_STATE_HOME", () => {
		const root = afkStateRoot({ XDG_STATE_HOME: "" });
		expect(root).toBe(path.join(os.homedir(), ".local", "state", "afk"));
	});
});

describe("repositoryStateRoot", () => {
	test("nests under github.com/<owner>/<repo>", () => {
		const root = repositoryStateRoot("/var/state/afk", "juranki", "afk-kit");
		expect(root).toBe(
			path.join("/var/state/afk", "github.com", "juranki", "afk-kit"),
		);
	});
});

describe("issueRunsDir", () => {
	test("groups runs per issue", () => {
		const dir = issueRunsDir("/state/afk/github.com/o/r", 59);
		expect(dir).toBe(
			path.join("/state/afk/github.com/o/r", "issues", "59", "runs"),
		);
	});
});

describe("runDirectory", () => {
	test("one directory per run id", () => {
		const dir = runDirectory(
			"/state/afk/github.com/o/r",
			59,
			"20260927T120000Z-abc123",
		);
		expect(dir).toBe(
			path.join(
				"/state/afk/github.com/o/r",
				"issues",
				"59",
				"runs",
				"20260927T120000Z-abc123",
			),
		);
	});
});
