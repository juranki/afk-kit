/**
 * L2 seam-integration tests for the readiness check's tracker reads
 * (ticket afk-kit #24, code-verify standard): the real `gh` binary is
 * replaced by a stub on PATH that records argv and emits canned JSON —
 * the environment is swapped, never the code.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchReadinessInput, runReadinessCheck } from "./gh.ts";

const ISSUE_JSON = {
	body: [
		"## Agent brief",
		"",
		"**Summary:** Scratch issue for the readiness check's live proof.",
		"",
		"**Acceptance criteria:**",
		"- [ ] Every inspection has a passing and a failing run.",
		"",
		"**Verify commands:**",
		"- `bun install && bun run verify`",
		"",
		"**Blocked by:** #101, #102",
		"**Blocks:** none",
		"",
		"**Touched areas:** extensions/readiness/",
		"",
		"**Out of scope:** nothing.",
		"",
		"**Open questions:** none",
		"",
	].join("\n"),
	labels: [{ name: "ready-for-agent" }],
	blockedBy: {
		nodes: [{ number: 101, state: "OPEN" }],
		totalCount: 1,
	},
};

/** A `gh` stub: records argv to $GH_STUB_LOG, serves $GH_STUB_ISSUE_JSON for
 * issue reads and a canned state for `--json state` lookups. */
const GH_STUB = `#!/usr/bin/env bun
import * as fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG!, args.join("\\u0020") + "\\n");
if (args[0] === "issue" && args[1] === "view" && args[3] === "--json" && args[4] === "state") {
	console.log(JSON.stringify({ state: "OPEN" }));
} else {
	console.log(fs.readFileSync(process.env.GH_STUB_ISSUE_JSON!, "utf8"));
}
`;

interface Stub {
	dir: string;
	log: string;
}

function stubGh(issueJson: unknown): Stub {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
	const stub = path.join(dir, "gh");
	fs.writeFileSync(stub, GH_STUB);
	fs.chmodSync(stub, 0o755);
	const log = path.join(dir, "argv.log");
	fs.writeFileSync(log, "");
	const issuePath = path.join(dir, "issue.json");
	fs.writeFileSync(issuePath, JSON.stringify(issueJson));
	process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
	process.env.GH_STUB_LOG = log;
	process.env.GH_STUB_ISSUE_JSON = issuePath;
	return { dir, log };
}

function stubCleanup(stub: Stub) {
	process.env.PATH = process.env.PATH?.split(path.delimiter)
		.filter((p) => p !== stub.dir)
		.join(path.delimiter);
	for (const key of ["GH_STUB_LOG", "GH_STUB_ISSUE_JSON"])
		delete process.env[key];
	fs.rmSync(stub.dir, { recursive: true, force: true });
}

describe("fetchReadinessInput", () => {
	test("reads the issue once and resolves named-but-not-native blocker states", async () => {
		const stub = stubGh(ISSUE_JSON);
		try {
			const input = await fetchReadinessInput(100);
			expect(input.body).toBe(ISSUE_JSON.body);
			expect(input.labels).toEqual(["ready-for-agent"]);
			expect(input.nativeBlockers).toEqual([{ number: 101, state: "OPEN" }]);
			// #101's state comes with the native dependency; only #102, named
			// without a native edge, costs an extra read.
			expect(input.namedStates).toEqual({ 101: "OPEN", 102: "OPEN" });
			const calls = fs.readFileSync(stub.log, "utf8").trim().split("\n");
			expect(calls).toEqual([
				"issue view 100 --json body,labels,blockedBy",
				"issue view 102 --json state",
			]);
		} finally {
			stubCleanup(stub);
		}
	});
});

describe("runReadinessCheck", () => {
	test("a passing issue formats as a pass, no refusal marker", async () => {
		const passing = {
			...ISSUE_JSON,
			body: ISSUE_JSON.body.replace(
				"**Blocked by:** #101, #102",
				"**Blocked by:** none",
			),
			blockedBy: { nodes: [], totalCount: 0 },
		};
		const stub = stubGh(passing);
		try {
			const outcome = await runReadinessCheck(100);
			expect(outcome.ok).toBe(true);
			expect(outcome.text).toContain("Readiness check passed for #100");
			expect(outcome.text).not.toContain("READINESS_REFUSAL");
		} finally {
			stubCleanup(stub);
		}
	});

	test("a failing issue formats as READINESS_REFUSAL naming the failed inspections", async () => {
		const failing = {
			...ISSUE_JSON,
			labels: [{ name: "needs-info" }],
		};
		const stub = stubGh(failing);
		try {
			const outcome = await runReadinessCheck(100);
			expect(outcome.ok).toBe(false);
			expect(outcome.text).toContain("READINESS_REFUSAL");
			expect(outcome.text).toContain("triage-labels");
		} finally {
			stubCleanup(stub);
		}
	});
});
