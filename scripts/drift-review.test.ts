/**
 * L1 unit tests for the agentic drift review's decision logic (ADR 0013,
 * ticket afk-kit #20): strict verdict parsing, the change-gate decision, and
 * the committed hash-record format. The corpus is the coordinator skill, the
 * workflow conventions, and the coordinator playbook; the record is
 * sha256sum-compatible so `sha256sum -c` can double-check it by hand.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	corpusFiles,
	formatRecord,
	gateFor,
	hashCorpus,
	parseDriftVerdict,
	parseRecord,
	runDriftReview,
} from "./drift-review.ts";

describe("parseDriftVerdict", () => {
	test("accepts a bare agree verdict", () => {
		expect(parseDriftVerdict('{"verdict":"agree"}')).toEqual({
			verdict: "agree",
		});
	});

	test("accepts a drift verdict with claim/doc findings", () => {
		const out = parseDriftVerdict(
			'{"verdict":"drift","findings":[{"claim":"at most three review rounds","doc":"review-and-escalation.md caps it at two"}]}',
		);
		expect(out).toEqual({
			verdict: "drift",
			findings: [
				{
					claim: "at most three review rounds",
					doc: "review-and-escalation.md caps it at two",
				},
			],
		});
	});

	test("rejects agree carrying findings", () => {
		expect(
			parseDriftVerdict(
				'{"verdict":"agree","findings":[{"claim":"x","doc":"y"}]}',
			),
		).toBeNull();
	});

	test("rejects drift with empty findings", () => {
		expect(parseDriftVerdict('{"verdict":"drift","findings":[]}')).toBeNull();
	});

	test("rejects a drift finding without a doc", () => {
		expect(
			parseDriftVerdict('{"verdict":"drift","findings":[{"claim":"x"}]}'),
		).toBeNull();
	});

	test("rejects a drift finding with an empty claim", () => {
		expect(
			parseDriftVerdict(
				'{"verdict":"drift","findings":[{"claim":"","doc":"y"}]}',
			),
		).toBeNull();
	});

	test("rejects prose around the JSON — the verdict must be the whole output", () => {
		expect(parseDriftVerdict('The verdict is: {"verdict":"agree"}')).toBeNull();
	});

	test("rejects non-JSON output", () => {
		expect(parseDriftVerdict("looks fine to me")).toBeNull();
	});

	test("rejects a JSON array", () => {
		expect(parseDriftVerdict('[{"verdict":"agree"}]')).toBeNull();
	});

	test("rejects an unknown verdict string", () => {
		expect(parseDriftVerdict('{"verdict":"approve"}')).toBeNull();
	});
});

describe("record format", () => {
	test("round-trips entries sorted by path in sha256sum form", () => {
		const entries = [
			{ path: "docs/conventions/issue-lifecycle.md", hash: "aaa111" },
			{ path: "skills/coordinator/SKILL.md", hash: "bbb222" },
		];
		const text = formatRecord(entries);
		expect(text).toBe(
			"aaa111  docs/conventions/issue-lifecycle.md\nbbb222  skills/coordinator/SKILL.md\n",
		);
		expect(parseRecord(text)).toEqual(entries);
	});

	test("formatRecord sorts by path regardless of input order", () => {
		const text = formatRecord([
			{ path: "z.md", hash: "h2" },
			{ path: "a.md", hash: "h1" },
		]);
		expect(text).toBe("h1  a.md\nh2  z.md\n");
	});

	test("parseRecord ignores blank lines", () => {
		expect(parseRecord("h1  a.md\n\nh2  b.md\n")).toEqual([
			{ path: "a.md", hash: "h1" },
			{ path: "b.md", hash: "h2" },
		]);
	});
});

describe("hashCorpus", () => {
	test("throws loudly when a corpus file is missing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "drift-missing-"));
		try {
			expect(() => hashCorpus(root)).toThrow();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("runDriftReview", () => {
	const roots: string[] = [];

	function fixture(skillBody: string): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "drift-fixture-"));
		roots.push(root);
		fs.mkdirSync(path.join(root, "skills/coordinator"), { recursive: true });
		fs.mkdirSync(path.join(root, "docs/conventions"), { recursive: true });
		fs.mkdirSync(path.join(root, "docs/playbooks"), { recursive: true });
		fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		for (const file of corpusFiles) {
			fs.writeFileSync(
				path.join(root, file),
				file.includes("SKILL") ? skillBody : `canonical: ${file}\n`,
			);
		}
		fs.writeFileSync(
			path.join(root, "docs/adr/0013-drift.md"),
			"copy contract\n",
		);
		return root;
	}

	/** A `pi` stub on PATH: logs its argv, prints the canned stdout. */
	function stubPi(root: string, stdout: string): string {
		const bin = path.join(root, "stub-bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(
			path.join(bin, "pi"),
			`#!/usr/bin/env bash
printf '%s\\0' "$@" >> "${bin}/argv.log"
cat <<'PIEOF'
${stdout}
PIEOF
`,
		);
		fs.chmodSync(path.join(bin, "pi"), 0o755);
		return bin;
	}

	function withStubbedPath<T>(bin: string, fn: () => T): T {
		const original = process.env.PATH;
		process.env.PATH = `${bin}:${original}`;
		try {
			return fn();
		} finally {
			process.env.PATH = original;
		}
	}

	function recordPath(root: string): string {
		return path.join(root, "scripts/drift-corpus.sha256");
	}

	afterAll(() => {
		for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	});

	test("an unchanged corpus skips the review — the model is never invoked", async () => {
		const root = fixture("the skill\n");
		fs.writeFileSync(recordPath(root), formatRecord(hashCorpus(root)));
		const bin = stubPi(root, "SHOULD-NOT-RUN");
		const outcome = await withStubbedPath(bin, () => runDriftReview(root));
		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("unchanged");
		expect(fs.existsSync(path.join(bin, "argv.log"))).toBe(false);
	});

	test("a moved corpus runs the review; an agree verdict refreshes the record", async () => {
		const root = fixture("the skill\n");
		fs.writeFileSync(recordPath(root), formatRecord(hashCorpus(root)));
		fs.writeFileSync(path.join(root, corpusFiles[0]), "the skill, edited\n");
		const bin = stubPi(root, '{"verdict":"agree"}');
		const outcome = await withStubbedPath(bin, () => runDriftReview(root));
		expect(outcome.ok).toBe(true);
		expect(parseRecord(fs.readFileSync(recordPath(root), "utf-8"))).toEqual(
			hashCorpus(root),
		);
	});

	test("a drift verdict fails with the findings and leaves the record alone", async () => {
		const root = fixture("the skill\n");
		const before = formatRecord(hashCorpus(root));
		fs.writeFileSync(recordPath(root), before);
		fs.writeFileSync(
			path.join(root, corpusFiles[0]),
			"the skill, contradicted\n",
		);
		const bin = stubPi(
			root,
			'{"verdict":"drift","findings":[{"claim":"three review rounds","doc":"review-and-escalation.md caps automatic rounds at two"}]}',
		);
		const outcome = await withStubbedPath(bin, () => runDriftReview(root));
		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("three review rounds");
		expect(fs.readFileSync(recordPath(root), "utf-8")).toBe(before);
	});

	test("unparseable output fails loudly and shows the raw output", async () => {
		const root = fixture("the skill\n");
		fs.writeFileSync(recordPath(root), formatRecord(hashCorpus(root)));
		fs.writeFileSync(path.join(root, corpusFiles[0]), "the skill, edited\n");
		const bin = stubPi(root, "seems consistent to me");
		const outcome = await withStubbedPath(bin, () => runDriftReview(root));
		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("seems consistent to me");
	});

	test("a missing record counts as everything moved — the review creates it", async () => {
		const root = fixture("the skill\n");
		const bin = stubPi(root, '{"verdict":"agree"}');
		const outcome = await withStubbedPath(bin, () => runDriftReview(root));
		expect(outcome.ok).toBe(true);
		expect(parseRecord(fs.readFileSync(recordPath(root), "utf-8"))).toEqual(
			hashCorpus(root),
		);
	});
});

describe("gateFor", () => {
	const recorded = [
		{ path: "skills/coordinator/SKILL.md", hash: "h1" },
		{ path: "docs/playbooks/coordinator-session.md", hash: "h2" },
	];

	test("an unchanged corpus is skipped", () => {
		expect(gateFor(recorded, recorded)).toEqual({ action: "skip" });
	});

	test("a moved file opens the gate, naming it", () => {
		const computed = [
			{ path: "skills/coordinator/SKILL.md", hash: "h1x" },
			{ path: "docs/playbooks/coordinator-session.md", hash: "h2" },
		];
		expect(gateFor(computed, recorded)).toEqual({
			action: "review",
			changed: ["skills/coordinator/SKILL.md"],
		});
	});

	test("a file added to or removed from the corpus opens the gate", () => {
		const computed = recorded.slice(1);
		expect(gateFor(computed, recorded)).toEqual({
			action: "review",
			changed: ["skills/coordinator/SKILL.md"],
		});
	});
});
