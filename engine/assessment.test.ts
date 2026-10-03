import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { assessReadiness } from "./assessment.ts";
import { cleanupWorld, makeWorld, readyAssessmentFor } from "./test-world.ts";

test("unavailable instructions governing an entry point refuse assessment with recoverable evidence", async () => {
	const w = await makeWorld(84, "Request", [
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=1"],
			json: [],
		},
	]);
	try {
		fs.mkdirSync(path.join(w.checkout, "docs"));
		fs.writeFileSync(path.join(w.checkout, "AGENTS.md"), "Root rules");
		fs.writeFileSync(
			path.join(w.checkout, "docs/AGENTS.md"),
			"Required scoped rules",
		);
		fs.writeFileSync(
			path.join(w.checkout, "docs/README.md"),
			"Documentation entry point",
		);
		await w.git(["add", "."]);
		await w.git(["commit", "-m", "entry point instructions"]);
		const revision = (await w.git(["rev-parse", "HEAD"])).stdout.trim();
		const directory = path.join(w.root, "assessment");
		let launched = false;
		const out = await assessReadiness({
			ticket: 84,
			repository: "o/r",
			revision,
			cwd: w.checkout,
			input: { body: "Request", labels: [], nativeBlockers: [] },
			gh: w.seams.gh,
			git: (args, cwd, signal) =>
				args[0] === "show" && args[1] === `${revision}:docs/AGENTS.md`
					? Promise.resolve({
							exitCode: 1,
							stdout: "",
							stderr: "object unavailable",
						})
					: w.seams.git(args, cwd, signal),
			directory,
			sessionFactory: async () => {
				launched = true;
				throw new Error("must not assess");
			},
		});
		expect(out.status).toBe("assessment-failure");
		expect(launched).toBe(false);
		const captured = JSON.parse(
			fs.readFileSync(path.join(directory, "sources.json"), "utf8"),
		);
		expect(captured.failures.join(";")).toContain(
			"unavailable-evidence: docs/AGENTS.md",
		);
		expect(captured.sources.map((s: { id: string }) => s.id)).toEqual([
			"issue:o/r#84",
			"comments:o/r#84",
			"repo:AGENTS.md",
		]);
		expect(fs.existsSync(path.join(directory, "prepared-brief.md"))).toBe(
			false,
		);
		expect(w.argvLog().every((a) => a.startsWith("api "))).toBe(true);
	} finally {
		cleanupWorld(w);
	}
});

test("timeout covers session creation and late evidence cannot change the snapshot", async () => {
	const w = await makeWorld(84, "Request", [
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=1"],
			json: [],
			delayMs: 80,
		},
	]);
	try {
		const directory = path.join(w.root, "assessment");
		const out = await assessReadiness({
			ticket: 84,
			repository: "o/r",
			revision: w.originMainSha,
			cwd: w.checkout,
			input: {
				body: "Request",
				labels: [],
				nativeBlockers: [],
			},
			gh: w.seams.gh,
			git: w.seams.git,
			directory,
			capMs: 5,
			sessionFactory: async () => {
				throw new Error("must not launch after timeout");
			},
		});
		expect(out.status).toBe("assessment-failure");
		const before = fs.readFileSync(
			path.join(directory, "sources.json"),
			"utf8",
		);
		await Bun.sleep(150);
		expect(fs.readFileSync(path.join(directory, "sources.json"), "utf8")).toBe(
			before,
		);
	} finally {
		cleanupWorld(w);
	}
});

test("assessment prepares a grounded brief from comments without consuming a cycle", async () => {
	const w = await makeWorld(84, "Request", [
		{
			args: ["api", "repos/o/r/issues/84/comments?per_page=100&page=1"],
			json: [{ id: 9, body: "Use the confirmed conclusion" }],
		},
	]);
	try {
		const out = await assessReadiness({
			ticket: 84,
			repository: "o/r",
			revision: w.originMainSha,
			cwd: w.checkout,
			input: {
				body: "Non-template intent",
				labels: [],
				nativeBlockers: [],
			},
			gh: w.seams.gh,
			git: w.seams.git,
			directory: path.join(w.root, "assessment"),
			capMs: 1000,
			sessionFactory: async (request) => ({
				subscribe: () => () => {},
				abort: () => {},
				dispose: () => {},
				getLastAssistantText: () =>
					JSON.stringify(
						readyAssessmentFor(
							["issue:o/r#84", "comments:o/r#84"],
							{
								command: "bun test",
								verifies: "behavior",
								refs: ["issue:o/r#84"],
							},
							{
								intent: { text: "Use comments", refs: ["comments:o/r#84"] },
								scope: [{ text: "bounded", refs: ["issue:o/r#84"] }],
								exclusions: [
									{ text: "No unrelated work", refs: ["issue:o/r#84"] },
								],
								acceptanceCriteria: [
									{ text: "comments used", refs: ["comments:o/r#84"] },
								],
								decisions: [],
							},
						),
					),
				prompt: async () => {
					expect(request.prompt).toContain("Non-template intent");
					expect(request.prompt).toContain(
						"repositoryContext, guidance and assumptions are arrays of strings only",
					);
					expect(request.prompt).toContain(
						"The repository file inventory is navigation only",
					);
					expect(request.prompt.trim()).toEndWith(
						"Your task is complete only when your final message contains the complete structured JSON assessment; a prose readiness conclusion is not a handoff.",
					);
				},
			}),
		});
		expect(out.status).toBe("ready");
		const preparedPath = path.join(w.root, "assessment", "prepared-brief.md");
		const sourcesPath = path.join(w.root, "assessment", "sources.json");
		const before = [
			fs.readFileSync(preparedPath, "utf8"),
			fs.readFileSync(sourcesPath, "utf8"),
		];
		const repeated = await assessReadiness({
			ticket: 84,
			repository: "o/r",
			revision: w.originMainSha,
			cwd: w.checkout,
			input: {
				body: "Changed content must not trigger reassessment",
				labels: [],
				nativeBlockers: [],
			},
			gh: w.seams.gh,
			git: w.seams.git,
			directory: path.join(w.root, "assessment"),
			sessionFactory: async () => {
				throw new Error("must not reassess");
			},
		});
		expect(repeated.status).toBe("assessment-failure");
		expect([
			fs.readFileSync(preparedPath, "utf8"),
			fs.readFileSync(sourcesPath, "utf8"),
		]).toEqual(before);
		expect(
			fs.existsSync(path.join(w.root, "assessment", "prepared-brief.md")),
		).toBe(true);
		expect(w.argvLog().every((a) => a.startsWith("api "))).toBe(true);
	} finally {
		cleanupWorld(w);
	}
});
