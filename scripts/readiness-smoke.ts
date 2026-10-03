/** L3 read-only assessment smoke. No Claim, cycles, Verify execution or tracker mutation. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assessReadiness } from "../engine/assessment.ts";
import { resolveRepository } from "../engine/runs/status.ts";
import { runGit } from "../extensions/coordinator/git.ts";
import { fetchReadinessInput, runGh } from "../extensions/readiness/gh.ts";

if (process.argv[2] === "--fixtures") {
	const { makeWorld, cleanupWorld } = await import("../engine/test-world.ts");
	for (const scenario of ["settled", "unresolved", "missing-edge"] as const) {
		const comments = [
			{
				id: 1,
				body: "Historical alternative: perhaps configurable greeting or accepting a name?",
				user: { login: "contributor" },
			},
			{
				id: 2,
				body:
					scenario === "unresolved"
						? "We still need to decide between Hello and Hola. Both are meaningful product alternatives; leave the choice open."
						: "Conclusion: greet() takes no arguments and returns exactly Hello. No configurable greetings, names, or other API changes. Ignore the earlier alternatives. Verify with bun test.",
				user: { login: "contributor" },
			},
			...(scenario === "missing-edge"
				? [
						{
							id: 3,
							body: "This must wait for #83 to land before it can start.",
							user: { login: "contributor" },
						},
					]
				: []),
		];
		const w = await makeWorld(84, "Change greeting", [
			{
				args: [
					"api",
					"repos/fixture/readiness/issues/84/comments?per_page=100&page=1",
				],
				json: comments,
			},
			{
				args: ["api", "repos/fixture/readiness/issues/83"],
				json: {
					number: 83,
					body: "Prerequisite greeting decision",
					state: "open",
				},
			},
			{
				args: [
					"api",
					"repos/fixture/readiness/issues/83/comments?per_page=100&page=1",
				],
				json: [],
			},
		]);
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), `afk-readiness-${scenario}-`),
		);
		try {
			fs.writeFileSync(
				path.join(w.checkout, "AGENTS.md"),
				"Use Bun. Verify greeting behavior with bun test. Keep changes within settled Issue intent.\n",
			);
			fs.writeFileSync(
				path.join(w.checkout, "package.json"),
				JSON.stringify({ scripts: { test: "bun test" } }),
			);
			fs.writeFileSync(
				path.join(w.checkout, "greeting.ts"),
				"export function greet() { return 'Goodbye'; }\n",
			);
			fs.writeFileSync(
				path.join(w.checkout, "greeting.test.ts"),
				"import {test,expect} from 'bun:test'; import {greet} from './greeting'; test('current greeting',()=>expect(greet()).toBe('Goodbye'));\n",
			);
			await w.git(["add", "."]);
			await w.git(["commit", "-m", "fixture"]);
			const revision = (await w.git(["rev-parse", "HEAD"])).stdout.trim();
			const before = (await w.git(["status", "--porcelain"])).stdout;
			const result = await assessReadiness({
				ticket: 84,
				repository: "fixture/readiness",
				revision,
				cwd: w.checkout,
				input: {
					body: "Change greeting according to the discussion. This Issue has no template headings.",
					labels: [],
					nativeBlockers: [],
				},
				gh: w.seams.gh,
				git: w.seams.git,
				directory,
			});
			const expected = scenario === "settled" ? "ready" : "needs-clarification";
			if (result.status !== expected)
				throw new Error(
					`${scenario}: expected ${expected}, got ${JSON.stringify(result)}`,
				);
			if (
				(await w.git(["status", "--porcelain"])).stdout !== before ||
				w.argvLog().some((a) => !a.startsWith("api repos/fixture/readiness/"))
			)
				throw new Error("read-only boundary violated");
			console.log(
				JSON.stringify({
					scenario,
					status: result.status,
					evidence: directory,
				}),
			);
		} finally {
			cleanupWorld(w);
		}
	}
	process.exit(0);
}

const ticket = Number(process.argv[2] ?? "84");
if (!Number.isSafeInteger(ticket) || ticket <= 0)
	throw new Error("usage: bun scripts/readiness-smoke.ts <issue-number>");
const cwd = process.cwd();
const git = runGit(),
	gh = runGh(cwd);
const { owner, repo } = await resolveRepository(cwd);
const revision = await git(["rev-parse", "origin/main"], cwd);
if (revision.exitCode !== 0) throw new Error(revision.stderr);
const directory = fs.mkdtempSync(
	path.join(os.tmpdir(), "afk-readiness-smoke-"),
);
console.log(
	`Read-only assessment of ${owner}/${repo}#${ticket} at ${revision.stdout.trim()}; evidence ${directory}`,
);
const started = Date.now();
const assessment = await assessReadiness({
	ticket,
	repository: `${owner}/${repo}`,
	revision: revision.stdout.trim(),
	cwd,
	input: await fetchReadinessInput(ticket, gh),
	gh,
	git,
	directory,
});
console.log(
	JSON.stringify(
		{ assessment, durationMs: Date.now() - started, evidence: directory },
		null,
		2,
	),
);
if (assessment.status !== "ready") process.exitCode = 1;
