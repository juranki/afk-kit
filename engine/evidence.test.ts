import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectEvidence } from "./evidence.ts";
import { cleanupWorld, makeWorld } from "./test-world.ts";

test("read budgets and unavailable relevant sources fail closed and never authorize arbitrary commands", async () => {
	const w = await makeWorld(84, "Readiness", [
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=1"],
			json: [],
		},
	]);
	try {
		const collection = await collectEvidence({
			ticket: 84,
			repository: "o/r",
			revision: w.originMainSha,
			cwd: w.checkout,
			gh: w.seams.gh,
			git: w.seams.git,
			input: {
				body: "Clear intent. Context link https://github.com/o/r/issues/999",
				labels: [],
				nativeBlockers: [],
			},
			directory: path.join(w.root, "evidence"),
		});
		await expect(
			collection.read("repo:../../etc/passwd", "Need evidence"),
		).rejects.toThrow("untracked repository path");
		await expect(collection.read("issue:o/r#99", "Not linked")).rejects.toThrow(
			"unlinked source",
		);
		await expect(
			collection.read("bash:touch marker", "Verify requested"),
		).rejects.toThrow("unsupported");
		expect(collection.snapshot().failures).toHaveLength(3);
		expect(fs.existsSync(path.join(w.checkout, "marker"))).toBe(false);
		expect(w.argvLog()).toEqual([
			"api repos/o/r/issues/84/comments?per_page=100&page=1",
		]);
		await expect(
			collectEvidence({
				ticket: 84,
				repository: "o/r",
				revision: w.originMainSha,
				cwd: w.checkout,
				gh: w.seams.gh,
				git: w.seams.git,
				input: { body: "Clear intent", labels: [], nativeBlockers: [] },
				directory: path.join(w.root, "budget"),
				maxSources: 1,
			}),
		).rejects.toThrow("source-budget-exhausted");
	} finally {
		cleanupWorld(w);
	}
});

test("a failed later comment page preserves previously gathered tracker evidence", async () => {
	const w = await makeWorld(84, "Readiness", [
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=1"],
			json: Array.from({ length: 100 }, (_, i) => ({
				id: i + 1,
				body: "Captured before failure",
			})),
		},
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=2"],
			status: 4,
		},
	]);
	try {
		const directory = path.join(w.root, "evidence");
		await expect(
			collectEvidence({
				ticket: 84,
				repository: "o/r",
				revision: w.originMainSha,
				cwd: w.checkout,
				input: { body: "Request", labels: [], nativeBlockers: [] },
				gh: w.seams.gh,
				git: w.seams.git,
				directory,
			}),
		).rejects.toThrow("unavailable-evidence");
		const receipts = fs.readFileSync(
			path.join(directory, "tracker-responses.jsonl"),
			"utf8",
		);
		expect(receipts).toContain("Captured before failure");
		expect(receipts).toContain("per_page=100&page=1");
	} finally {
		cleanupWorld(w);
	}
});

test("captures explicitly linked decision comments and native dependencies before assessment", async () => {
	const w = await makeWorld(84, "Readiness", [
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=1"],
			json: [],
		},
		{
			args: ["api", "repos/o/r/issues/82"],
			json: { number: 82, body: "Decision discussion" },
		},
		{
			args: ["api", "repos/o/r/issues/82/comments?per_page=100&page=1"],
			json: [{ id: 99, body: "Confirmed canonical decision" }],
		},
		{
			args: ["api", "repos/o/r/issues/83"],
			json: { number: 83, body: "Predecessor complete" },
		},
		{
			args: ["api", "repos/o/r/issues/83/comments?per_page=100&page=1"],
			json: [],
		},
	]);
	try {
		const collection = await collectEvidence({
			ticket: 84,
			repository: "o/r",
			revision: w.originMainSha,
			cwd: w.checkout,
			gh: w.seams.gh,
			git: w.seams.git,
			input: {
				body: "Implement https://github.com/o/r/issues/82#issuecomment-99. Map https://github.com/o/r/issues/43",
				labels: [],
				nativeBlockers: [{ number: 83, state: "CLOSED" }],
			},
			directory: path.join(w.root, "evidence"),
		});
		expect(collection.snapshot().sources.map((s) => s.id)).toEqual([
			"issue:o/r#84",
			"comments:o/r#84",
			"issue:o/r#83",
			"issue:o/r#82",
		]);
		expect(
			collection
				.snapshot()
				.sources.some((s) =>
					s.content.includes("Confirmed canonical decision"),
				),
		).toBe(true);
		expect(w.argvLog().some((a) => a.includes("issues/43"))).toBe(false);
	} finally {
		cleanupWorld(w);
	}
});

test("captures all comment pages once and selectively follows linked decisions without mutations", async () => {
	const w = await makeWorld(84, "Readiness", [
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=1"],
			json: Array.from({ length: 100 }, (_, i) => ({
				id: i + 1,
				body:
					i === 99
						? "Conclusion: use #82, not the historical approach."
						: "Earlier alternative",
				user: { login: "human" },
			})),
		},
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=2"],
			json: [{ id: 101, body: "Settled conclusion", user: { login: "human" } }],
		},
		{
			args: ["api", "repos/o/r/issues/82"],
			json: { number: 82, body: "Linked decision", user: { login: "human" } },
		},
		{
			args: ["api", "repos/o/r/issues/82/comments?per_page=100&page=1"],
			json: [],
		},
	]);
	try {
		fs.writeFileSync(path.join(w.checkout, "AGENTS.md"), "Use bun test.");
		await w.git(["add", "AGENTS.md"]);
		await w.git(["commit", "-m", "instructions"]);
		const revision = (await w.git(["rev-parse", "HEAD"])).stdout.trim();
		const evidence = await collectEvidence({
			ticket: 84,
			repository: "o/r",
			revision,
			cwd: w.checkout,
			gh: w.seams.gh,
			git: w.seams.git,
			input: {
				body: "Clear non-template request",
				labels: [],
				nativeBlockers: [],
			},
			directory: path.join(w.root, "evidence"),
		});
		expect(
			evidence
				.snapshot()
				.sources.some((s) => s.content.includes("Settled conclusion")),
		).toBe(true);
		expect(
			evidence
				.snapshot()
				.sources.some((s) => s.content.includes("Use bun test")),
		).toBe(true);
		expect(w.argvLog().some((a) => a.includes("issues/82"))).toBe(false);
		await evidence.read(
			"issue:o/r#82",
			"The conclusion depends on this decision",
		);
		await evidence.read("issue:o/r#82", "Already captured");
		expect(
			w.argvLog().filter((a) => a === "api repos/o/r/issues/82"),
		).toHaveLength(1);
		expect(
			evidence
				.snapshot()
				.sources.some((s) => s.content.includes("Linked decision")),
		).toBe(true);
		expect(w.argvLog().every((a) => a.startsWith("api repos/o/r/"))).toBe(true);
	} finally {
		cleanupWorld(w);
	}
});
