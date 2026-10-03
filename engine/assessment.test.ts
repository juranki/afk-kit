import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { assessReadiness } from "./assessment.ts";
import { cleanupWorld, makeWorld, readyAssessment } from "./test-world.ts";

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
					JSON.stringify({
						...readyAssessment,
						brief: {
							...readyAssessment.brief,
							intent: { text: "Use comments", refs: ["comments:o/r#84"] },
							scope: [{ text: "bounded", refs: ["issue:o/r#84"] }],
							exclusions: [
								{ text: "No unrelated work", refs: ["issue:o/r#84"] },
							],
							acceptanceCriteria: [
								{ text: "comments used", refs: ["comments:o/r#84"] },
							],
							decisions: [],
							verifyCommands: [
								{
									command: "bun test",
									verifies: "behavior",
									refs: ["issue:o/r#84"],
								},
							],
						},
					}),
				prompt: async () => {
					expect(request.prompt).toContain("Non-template intent");
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
