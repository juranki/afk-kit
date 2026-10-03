import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSessionLike, SessionFactory } from "./agent-runner.ts";
import { runCli } from "./cli.ts";
import { readRunEvents } from "./runs/events.ts";
import { foldRunEvents } from "./runs/projection.ts";
import {
	baseRules,
	cleanupWorld,
	type GhRule,
	makeWorld,
	readyAssessment,
} from "./test-world.ts";

const ISSUE = 66;
const TITLE = "Ship Engine";
const BRANCH = "issue-66-ship-engine";
const BODY = `## Agent brief
**Summary:** Ship the Engine.
**Acceptance criteria:**
- [ ] The CLI hands over an approved PR.
**Verify commands:**
- \`test -f candidate.txt\`
**Blocked by:** none
**Blocks:** none
**Touched areas:** scratch
**Out of scope:** merge
**Open questions:** none
`;

const runtime = {
	initialize: async () => {},
	wrapWithSandbox: async (command: string) => command,
	annotateStderrWithSandboxFailures: (_id: string, output: string) => output,
	cleanupAfterCommand: () => {},
	reset: async () => {},
};

function session(
	result: string,
	act: () => Promise<void> = async () => {},
): AgentSessionLike {
	return {
		subscribe: () => () => {},
		prompt: act,
		abort: () => {},
		dispose: () => {},
		getLastAssistantText: () => result,
	};
}

function rules(draftExists = false): GhRule[] {
	return [
		{
			args: ["api", "repos/test/remote/issues/66/comments?per_page=100&page=1"],
			json: [
				{
					id: 9,
					body: "Settled conclusion: implement and verify the requested behavior",
				},
			],
		},
		{
			args: ["issue", "view", String(ISSUE), "--json", "title"],
			json: { title: TITLE },
		},
		{
			args: ["issue", "view", String(ISSUE), "--json", "labels"],
			json: { labels: [{ name: "in-progress" }] },
		},
		{
			args: [
				"issue",
				"view",
				String(ISSUE),
				"--json",
				"body,labels,blockedBy,title,url,author,state,number",
			],
			json: {
				body: BODY,
				labels: [{ name: "ready-for-agent" }],
				blockedBy: { nodes: [] },
			},
		},
		{
			args: ["issue", "view", String(ISSUE), "--json", "title,body"],
			json: { title: TITLE, body: BODY },
		},
		{
			args: ["pr", "list"],
			json: draftExists
				? [
						{
							number: 99,
							title: `${TITLE} (#66)`,
							url: "https://example.com/repo/pull/99",
							isDraft: true,
						},
					]
				: [],
		},
		{
			args: ["pr", "create", "--draft"],
			stdout: "https://example.com/repo/pull/99\n",
		},
		{ args: ["pr", "edit"], json: {} },
		{ args: ["pr", "ready"], json: {} },
		{
			args: ["issue", "view", String(ISSUE), "--json", "body,labels"],
			json: { body: BODY, labels: [{ name: "in-progress" }] },
		},
		...baseRules(ISSUE, TITLE),
	];
}

test.each([
	["handoff", 0],
	["escalation", 2],
	["failed-escalation", 3],
] as const)(
	"afk implement production composition: %s exits %i",
	async (outcome, expectedExit) => {
		const escalationRules: GhRule[] = [
			{
				args: ["issue", "view", String(ISSUE), "--json", "comments"],
				json: { comments: [] },
			},
			{
				args: ["issue", "view", String(ISSUE), "--json", "labels"],
				json: { labels: [{ name: "in-progress" }] },
			},
			{
				args: ["issue", "comment", String(ISSUE)],
				status: outcome === "failed-escalation" ? 1 : 0,
			},
		];
		const world = await makeWorld(ISSUE, TITLE, [
			...escalationRules,
			...rules(),
		]);
		const out: string[] = [];
		const err: string[] = [];
		try {
			await world.git([
				"remote",
				"set-url",
				"origin",
				"https://github.com/test/remote",
			]);
			const skillsRoot = path.join(world.root, "skills");
			for (const name of ["implement", "tdd", "codebase-design"]) {
				fs.mkdirSync(path.join(skillsRoot, name), { recursive: true });
				fs.writeFileSync(
					path.join(skillsRoot, name, "SKILL.md"),
					`# ${name}\n`,
				);
			}
			const git: typeof world.seams.git = (args, cwd) => {
				// Real Git with a local remote substituted at the environment seam.
				const child = Bun.spawn(["git", ...args], {
					cwd,
					env: {
						...process.env,
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: `url.${world.bare}.insteadOf`,
						GIT_CONFIG_VALUE_0: "https://github.com/test/remote",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				return Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
			};
			const implementerPrompts: string[] = [],
				specPrompts: string[] = [];
			const implementer: SessionFactory = async (request) => {
				implementerPrompts.push(request.prompt);
				return session(
					'```json\n{"status":"done","summary":"implemented","openQuestions":[]}\n```',
					async () => {
						if (outcome !== "handoff")
							throw new Error("agent infrastructure unavailable");
						fs.writeFileSync(
							path.join(request.worktree, "candidate.txt"),
							"candidate\n",
						);
						fs.writeFileSync(
							path.join(request.worktree, "AGENTS.md"),
							"# Standards\n",
						);
						expect((await git(["add", "."], request.worktree)).exitCode).toBe(
							0,
						);
						expect(
							(await git(["commit", "-m", "candidate"], request.worktree))
								.exitCode,
						).toBe(0);
						world.setRules(rules(true));
					},
				);
			};
			let reviewsStarted = 0;
			let release!: () => void;
			const bothStarted = new Promise<void>((resolve) => {
				release = resolve;
			});
			const reviewer =
				(standards: boolean): SessionFactory =>
				async (request) => {
					if (!standards) specPrompts.push(request.prompt);
					const hash = createHash("sha256")
						.update(fs.readFileSync(path.join(request.worktree, "AGENTS.md")))
						.digest("hex");
					return session(
						`\`\`\`json\n${JSON.stringify({ verdict: "approve", ...(standards ? { standardsConsulted: [{ path: "AGENTS.md", hash }] } : {}) })}\n\`\`\``,
						async () => {
							reviewsStarted += 1;
							if (reviewsStarted === 2) release();
							await bothStarted;
						},
					);
				};
			const env = { XDG_STATE_HOME: path.join(world.root, "state") };
			const io = {
				cwd: world.checkout,
				env,
				stdout: (s: string) => out.push(s),
				stderr: (s: string) => err.push(s),
			};
			const exit = await runCli(["implement", "66"], io, {
				implement: {
					git,
					worktreeRoot: world.worktreeRoot,
					config: { skillsRoot },
					confinementRuntime: runtime,
					assessment: {
						sessionFactory: async () =>
							session(
								JSON.stringify({
									status: "ready",
									brief: {
										...readyAssessment.brief,
										intent: {
											text: "Ship the Engine",
											refs: ["issue:test/remote#66"],
										},
										scope: [
											{
												text: "Ship the Engine",
												refs: ["issue:test/remote#66"],
											},
										],
										exclusions: [
											{ text: "merge", refs: ["issue:test/remote#66"] },
										],
										acceptanceCriteria: [
											{
												text: "The CLI hands over an approved PR",
												refs: ["issue:test/remote#66"],
											},
										],
										decisions: [],
										verifyCommands: [
											{
												command: "test -f candidate.txt",
												verifies: "candidate is produced",
												refs: ["issue:test/remote#66"],
											},
										],
									},
								}),
							),
					},
					cycle: { sessionFactory: implementer, confinementRuntime: runtime },
					review: {
						standardsFactory: reviewer(true),
						specFactory: reviewer(false),
					},
				},
			});
			expect(exit).toBe(expectedExit);
			const runs = path.join(
				env.XDG_STATE_HOME,
				"afk/github.com/test/remote/issues/66/runs",
			);
			const ids = fs.readdirSync(runs);
			expect(ids).toHaveLength(1);
			const dir = path.join(runs, ids[0] ?? "");
			const events = readRunEvents(path.join(dir, "events.jsonl")).events;
			expect(foldRunEvents(events)?.outcome).toBe(
				outcome === "handoff" ? "handed-over-to-maintainer" : "escalated",
			);
			expect(fs.existsSync(path.join(dir, "lock"))).toBe(false);
			expect(fs.readFileSync(path.join(dir, "brief.md"), "utf8")).toBe(BODY);
			expect(world.argvLog().some((s) => s.startsWith("pr merge"))).toBe(false);
			if (outcome !== "handoff") {
				expect(err.join("")).toContain("agent infrastructure unavailable");
				expect(
					world.argvLog().filter((s) => s.startsWith("issue comment")),
				).toHaveLength(1);
				expect(world.argvLog().some((s) => s.startsWith("pr ready"))).toBe(
					false,
				);
				expect(reviewsStarted).toBe(0);
				return;
			}
			const prepared = fs.readFileSync(
				path.join(dir, "artifacts/readiness/prepared-brief.md"),
				"utf8",
			);
			expect(implementerPrompts).toHaveLength(1);
			expect(specPrompts).toHaveLength(1);
			for (const prompt of [...implementerPrompts, ...specPrompts])
				expect(prompt).toContain(prepared);
			expect(prepared).toContain("Settled conclusion");
			expect(
				world
					.argvLog()
					.filter(
						(s) =>
							s ===
							"issue view 66 --json body,labels,blockedBy,title,url,author,state,number",
					),
			).toHaveLength(1);
			expect(
				world
					.argvLog()
					.some(
						(s) =>
							s === "issue view 66 --json title,body" ||
							s === "issue view 66 --json body,labels",
					),
			).toBe(false);
			expect(err).toEqual([]);
			expect(out.join("")).toContain("handed over");
			expect(fs.existsSync(path.join(dir, "artifacts/cycle-1/verify"))).toBe(
				true,
			);
			expect(world.argvLog().some((s) => s.startsWith("pr ready 99"))).toBe(
				true,
			);
			expect(
				(await git(["ls-remote", "origin", BRANCH], world.checkout)).stdout,
			).toContain(BRANCH);
			out.length = 0;
			expect(await runCli(["status", "66"], io)).toBe(0);
			expect(out.join("")).toContain("HANDED OVER");
		} finally {
			cleanupWorld(world);
		}
	},
	30_000,
);
