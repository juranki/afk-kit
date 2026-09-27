/**
 * L2 seam-integration tests for the Review gate port (ticket afk-kit #63,
 * durable spec #46): parallel Standards and Spec Reviews — fresh,
 * independent, read-oriented sessions over the pushed `main...HEAD` diff —
 * their verdict parsing and judgment, the engine-verified consulted list,
 * and complete evidence retention. The tracker/Git seams run for real (a
 * local bare remote, a stub `gh` on PATH), the confinement runtime is a
 * fake at its library port, and the Implementer and Reviewer sessions are
 * scripted behind their factory seams (code-verify standard).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { slugFor } from "../extensions/coordinator/slug.ts";
import type { SessionFactory } from "./agent-runner.ts";
import { createCyclePort } from "./cycle.ts";
import { driveRun } from "./drive.ts";
import { createReviewPort } from "./review.ts";
import { type RunEvent, readRunEvents } from "./runs/events.ts";
import { foldRunEvents } from "./runs/projection.ts";
import { createRun, type RunHandle } from "./runs/store.ts";
import {
	baseRules,
	cleanupWorld,
	type GhRule,
	makeWorld,
} from "./test-world.ts";

const ISSUE = 63;
const TITLE = "Gate a candidate with parallel Standards and Spec Reviews";
const BRANCH = `issue-${ISSUE}-${slugFor(TITLE)}`;

const BRIEF_BODY = [
	"## Agent brief",
	"",
	"**Summary:** Scratch issue for the review gate tests.",
	"",
	"**Acceptance criteria:**",
	"- [ ] The implementer's feature lands and verifies.",
	"",
	"**Verify commands:**",
	"- `git rev-parse --is-inside-work-tree`",
	"- `test -f src/feature.txt`",
	"",
	"**Blocked by:** none",
	"**Blocks:** none",
	"",
	"**Touched areas:** src",
	"",
	"**Out of scope:** nothing.",
	"",
	"**Open questions:** none",
	"",
].join("\n");

function bootstrapRules(): GhRule[] {
	return [
		{
			args: ["issue", "view", String(ISSUE), "--json", "title,body"],
			json: { title: TITLE, body: BRIEF_BODY },
		},
		{
			args: [
				"pr",
				"list",
				"--head",
				BRANCH,
				"--state",
				"open",
				"--json",
				"number,title,url,isDraft",
			],
			json: [],
		},
		{
			args: ["pr", "create", "--draft"],
			stdout: "https://example.com/repo/pull/99\n",
		},
	];
}

function handoffRules(): GhRule[] {
	return [
		{
			args: [
				"pr",
				"list",
				"--head",
				BRANCH,
				"--state",
				"open",
				"--json",
				"number,title,url,isDraft",
			],
			json: [
				{
					number: 99,
					title: `${TITLE} (#${ISSUE})`,
					url: "https://example.com/repo/pull/99",
					isDraft: true,
				},
			],
		},
		{
			args: ["issue", "view", String(ISSUE), "--json", "body,labels"],
			json: {
				body: BRIEF_BODY,
				labels: [{ name: "ready-for-agent" }, { name: "in-progress" }],
			},
		},
		{ args: ["pr", "edit", "99"], json: {} },
		{ args: ["pr", "ready", "99"], json: {} },
	];
}

function escalationRules(): GhRule[] {
	return [
		{
			args: ["issue", "view", String(ISSUE), "--json", "labels"],
			json: { labels: [{ name: "ready-for-agent" }, { name: "in-progress" }] },
		},
		{ args: ["issue", "comment", String(ISSUE)], json: {} },
	];
}

function fencedJson(value: unknown): string {
	return ["```json", JSON.stringify(value), "```"].join("\n");
}

async function implementFeature(
	cycle: number,
	worktree: string,
	git: Awaited<ReturnType<typeof makeWorld>>["git"],
): Promise<void> {
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
	// Unique content per cycle: every cycle must leave a fresh commit.
	fs.writeFileSync(
		path.join(worktree, "src", "feature.txt"),
		`done in cycle ${String(cycle)}\n`,
	);
	const add = await git(["add", "-A"], worktree);
	if (add.exitCode !== 0) throw new Error(add.stderr);
	const commit = await git(
		["commit", "-m", `implement the feature (${String(cycle)})`],
		worktree,
	);
	if (commit.exitCode !== 0) {
		// `git commit` reports "nothing to commit" on stdout.
		throw new Error(commit.stderr || commit.stdout);
	}
}

/** The sha256 the Engine expects when the Reviewer consults a real file. */
function hashOfWorktreeFile(worktree: string, file: string): string {
	return createHash("sha256")
		.update(fs.readFileSync(path.join(worktree, file)))
		.digest("hex");
}

/** One scripted Reviewer launch: role, prompt, and the worktree it runs in. */
interface ReviewerRun {
	role: "standards" | "spec";
	prompt: string;
	worktree: string;
}

interface ScriptedReviewers {
	standardsFactory: SessionFactory;
	specFactory: SessionFactory;
	launched: ReviewerRun[];
	/** Resolves when the Spec Reviewer has been prompted. */
	specStarted: Promise<void>;
}

/**
 * Scripted Reviewer sessions: they record their prompt, produce the
 * behavior's verdict text, and the Standards Reviewer finishes only after
 * the Spec Reviewer was prompted — proving both run concurrently.
 */
function scriptedReviewers(
	verdictText: (
		role: "standards" | "spec",
		worktree: string,
		prompt: string,
	) => string,
	options: { hang?: "standards" | "spec" } = {},
): ScriptedReviewers {
	const launched: ReviewerRun[] = [];
	let releaseSpecStarted!: () => void;
	const specStarted = new Promise<void>((resolve) => {
		releaseSpecStarted = resolve;
	});
	const make =
		(role: "standards" | "spec"): SessionFactory =>
		async (request) => {
			let listener: ((event: unknown) => void) | null = null;
			let resolvePrompt: (() => void) | null = null;
			let finalText = "";
			return {
				subscribe: (l: (event: unknown) => void) => {
					listener = l;
					return () => {};
				},
				prompt: async (text: string) => {
					launched.push({ role, prompt: text, worktree: request.worktree });
					listener?.({ type: "agent_start" });
					if (role === "spec") releaseSpecStarted();
					if (role === "standards") await specStarted;
					if (options.hang === role) {
						// The SDK contract: abort() resolves the pending prompt.
						await new Promise<void>((resolve) => {
							resolvePrompt = resolve;
						});
						return;
					}
					finalText = verdictText(role, request.worktree, text);
					listener?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: finalText }],
						},
					});
					listener?.({ type: "agent_end" });
				},
				abort: async () => {
					resolvePrompt?.();
				},
				dispose: () => {},
				getLastAssistantText: () => finalText,
			};
		};
	return {
		standardsFactory: make("standards"),
		specFactory: make("spec"),
		launched,
		specStarted,
	};
}

const approveSpec = (): string =>
	fencedJson({ verdict: "approve", summary: "Brief satisfied." });

const approveStandards = (worktree: string): string =>
	fencedJson({
		verdict: "approve",
		summary: "Built our way.",
		standardsConsulted: [
			{
				path: "src/feature.txt",
				hash: hashOfWorktreeFile(worktree, "src/feature.txt"),
			},
		],
	});

function fakeRuntime() {
	return {
		port: {
			initialize: async () => {},
			wrapWithSandbox: async (command: string) => command,
			annotateStderrWithSandboxFailures: (_id: string, out: string) => out,
			cleanupAfterCommand: () => {},
			reset: async () => {},
		},
	};
}

interface RunDrivenOptions {
	/** Verdict text per Reviewer role; defaults to dual approval. */
	verdictText?: (
		role: "standards" | "spec",
		worktree: string,
		prompt: string,
	) => string;
	/** A Reviewer session hangs until aborted (models the wall-clock cap). */
	hangReviewer?: "standards" | "spec";
	/** Per-Review cap override (tests); default 15 minutes. */
	reviewCapMs?: number;
}

interface RunResult {
	exit: 0 | 1 | 2 | 3;
	handle: RunHandle;
	world: Awaited<ReturnType<typeof makeWorld>>;
	worktree: string;
	reviewers: ScriptedReviewers;
	events: RunEvent[];
	stderr: string;
}

async function runDrivenWorld(
	options: RunDrivenOptions = {},
): Promise<RunResult> {
	const world = await makeWorld(ISSUE, TITLE, [
		...bootstrapRules(),
		...escalationRules(),
	]);
	const handle = createRun({
		stateRoot: path.join(world.root, "state"),
		owner: "test",
		repo: "repo",
		ticket: ISSUE,
		brief: BRIEF_BODY,
	});
	const worktree = path.join(world.worktreeRoot, "remote", BRANCH);
	const reviewers = scriptedReviewers(
		options.verdictText ??
			((role, wt) =>
				role === "standards" ? approveStandards(wt) : approveSpec()),
		{ hang: options.hangReviewer },
	);
	const doneReport = [
		"Work complete.",
		fencedJson({ status: "done", summary: "implemented" }),
	].join("\n");

	/** The scripted Implementer session the cycle port receives. */
	const implementerFactory: SessionFactory = (request) => {
		let listener: ((event: unknown) => void) | null = null;
		let finalText = "";
		return Promise.resolve({
			subscribe: (l: (event: unknown) => void) => {
				listener = l;
				return () => {};
			},
			prompt: async (text: string) => {
				listener?.({ type: "agent_start" });
				// From the first cycle on, the tracker presents the draft PR.
				world.setRules([
					...handoffRules(),
					...escalationRules(),
					...baseRules(ISSUE, TITLE),
				]);
				const cycle = /Cycle: (\d+)/.exec(text)?.[1];
				await implementFeature(Number(cycle ?? 1), request.worktree, world.git);
				finalText = doneReport;
				listener?.({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: finalText }],
					},
				});
				listener?.({ type: "agent_end" });
			},
			abort: async () => {},
			dispose: () => {},
			getLastAssistantText: () => finalText,
		});
	};

	const stderrLines: string[] = [];
	const exit = await driveRun({
		handle,
		seams: world.seams,
		runCycle: createCyclePort({
			handle,
			seams: world.seams,
			brief: BRIEF_BODY,
			ports: {
				sessionFactory: implementerFactory,
				confinementRuntime: fakeRuntime().port,
			},
		}),
		runReviews: createReviewPort({
			handle,
			seams: world.seams,
			brief: BRIEF_BODY,
			ports: {
				standardsFactory: reviewers.standardsFactory,
				specFactory: reviewers.specFactory,
				...(options.reviewCapMs === undefined
					? {}
					: { reviewCapMs: options.reviewCapMs }),
			},
		}),
		io: {
			stdout: () => {},
			stderr: (t) => stderrLines.push(t),
		},
	});
	const events = readRunEvents(handle.eventsPath).events;
	return {
		exit,
		handle,
		world,
		worktree,
		reviewers,
		events,
		stderr: stderrLines.join(""),
	};
}

describe("createReviewPort: the dual-approval path", () => {
	let result: RunResult;

	beforeAll(async () => {
		result = await runDrivenWorld();
	});

	afterAll(() => {
		cleanupWorld(result.world);
	});

	test("the Run reaches handed-over-to-maintainer with exit 0", () => {
		if (result.exit !== 0) console.error("STDERR:", result.stderr);
		expect(result.exit).toBe(0);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("handed-over-to-maintainer");
	});

	test("both Reviewers ran concurrently as fresh independent sessions", async () => {
		expect(result.reviewers.launched.map((r) => r.role)).toEqual([
			"standards",
			"spec",
		]);
		// Distinct roles saw distinct prompts (independence).
		expect(result.reviewers.launched[0]?.prompt).not.toBe(
			result.reviewers.launched[1]?.prompt,
		);
		for (const run of result.reviewers.launched) {
			const dir = path.join(
				result.handle.artifactsDir,
				"cycle-1",
				"reviews",
				run.role,
			);
			const stream = fs
				.readFileSync(path.join(dir, "session-events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(stream.map((e) => e.type)).toEqual([
				"agent_start",
				"message_end",
				"agent_end",
			]);
		}
	});

	test("the Reviews judged the complete pushed main...HEAD diff", () => {
		for (const run of result.reviewers.launched) {
			expect(run.prompt).toContain(run.worktree);
			expect(run.prompt).toContain("main...HEAD");
			const diffPath = /read (\S+diff\.patch)/.exec(run.prompt)?.[1];
			expect(diffPath).toBeDefined();
			const diff = fs.readFileSync(diffPath as string, "utf8");
			expect(diff).toContain("feature.txt");
		}
		expect(
			fs.existsSync(
				path.join(
					result.handle.artifactsDir,
					"cycle-1",
					"reviews",
					"diff.patch",
				),
			),
		).toBe(true);
	});

	test("the Standards prompt demands the consulted contract", () => {
		const prompt = result.reviewers.launched.find(
			(r) => r.role === "standards",
		)?.prompt;
		expect(prompt).toContain("Standards Reviewer");
		expect(prompt).toContain("standardsConsulted");
		expect(prompt).toContain("sha256");
	});

	test("the Spec prompt carries the immutable brief", () => {
		const prompt = result.reviewers.launched.find(
			(r) => r.role === "spec",
		)?.prompt;
		expect(prompt).toContain("Spec Reviewer");
		expect(prompt).toContain(BRIEF_BODY);
		expect(prompt).toContain("out-of-scope");
	});

	test("the dual approval is retained with the verified consulted list", () => {
		const reviewResult = JSON.parse(
			fs.readFileSync(
				path.join(result.handle.artifactsDir, "cycle-1", "review-result.json"),
				"utf8",
			),
		) as {
			status: string;
			approvals: { review: string; verdict: Record<string, unknown> }[];
		};
		expect(reviewResult.status).toBe("approved");
		expect(reviewResult.approvals.map((a) => a.review)).toEqual([
			"standards",
			"spec",
		]);
		expect(reviewResult.approvals[0]?.verdict.standardsConsulted).toEqual([
			{
				path: "src/feature.txt",
				hash: hashOfWorktreeFile(result.worktree, "src/feature.txt"),
			},
		]);
	});

	test("each Reviewer's side evidence records its verdict", () => {
		for (const role of ["standards", "spec"] as const) {
			const side = JSON.parse(
				fs.readFileSync(
					path.join(
						result.handle.artifactsDir,
						"cycle-1",
						"reviews",
						role,
						"result.json",
					),
					"utf8",
				),
			) as { role: string; stop: string; verdict: { ok: boolean } };
			expect(side.role).toBe(role);
			expect(side.stop).toBe("completed");
			expect(side.verdict.ok).toBe(true);
		}
	});
});

describe("createReviewPort: the gate refuses", () => {
	test("a Standards approval without a verifiable consulted list is not an approval", async () => {
		const result = await runDrivenWorld({
			verdictText: (role, wt) =>
				role === "standards"
					? // Approves, but consults a file that does not exist.
						fencedJson({
							verdict: "approve",
							summary: "Built our way.",
							standardsConsulted: [
								{
									path: "docs/nope.md",
									hash: hashOfWorktreeFile(wt, "src/feature.txt"),
								},
							],
						})
					: approveSpec(),
		});
		expect(result.exit).toBe(2);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("escalated");
		expect(summary?.reason).toContain("standards");
		expect(summary?.reason).toContain("docs/nope.md");
		// All three cycles were gated; the gate never approved.
		expect(result.reviewers.launched).toHaveLength(6);
	}, 30_000);

	test("a malformed verdict fails the cycle deterministically", async () => {
		const result = await runDrivenWorld({
			verdictText: (role) =>
				role === "standards" ? "LGTM, ship it!" : approveSpec(),
		});
		expect(result.exit).toBe(2);
		const summary = foldRunEvents(result.events);
		expect(summary?.reason).toContain(
			"standards review produced no usable verdict",
		);
		const side = JSON.parse(
			fs.readFileSync(
				path.join(
					result.handle.artifactsDir,
					"cycle-1",
					"reviews",
					"standards",
					"result.json",
				),
				"utf8",
			),
		) as { verdict: { ok: boolean; reason?: string } };
		expect(side.verdict.ok).toBe(false);
		expect(side.verdict.reason).toContain("no JSON verdict object");
	});

	test("an aborted Reviewer session fails the cycle, and both sessions still finish", async () => {
		const result = await runDrivenWorld({
			hangReviewer: "standards",
			reviewCapMs: 100,
		});
		expect(result.exit).toBe(2);
		const summary = foldRunEvents(result.events);
		expect(summary?.reason).toContain("did not complete (aborted)");
		// Both sessions were launched every cycle, and the completed Spec
		// side's evidence was retained beside the aborted Standards side.
		expect(result.reviewers.launched).toHaveLength(6);
		const specSide = JSON.parse(
			fs.readFileSync(
				path.join(
					result.handle.artifactsDir,
					"cycle-1",
					"reviews",
					"spec",
					"result.json",
				),
				"utf8",
			),
		) as { verdict: { ok: boolean } };
		expect(specSide.verdict.ok).toBe(true);
	}, 30_000);

	test("an escalate verdict ends the Run immediately, outranking changes", async () => {
		const result = await runDrivenWorld({
			verdictText: (role, wt) =>
				role === "standards"
					? fencedJson({
							verdict: "request-changes",
							findings: [{ severity: "blocker", note: "no tests" }],
						})
					: role === "spec"
						? fencedJson({
								verdict: "escalate",
								summary: "the brief contradicts the ADR",
							})
						: approveStandards(wt),
		});
		expect(result.exit).toBe(2);
		const summary = foldRunEvents(result.events);
		expect(summary?.outcome).toBe("escalated");
		expect(summary?.reason).toContain(
			"spec review escalated: the brief contradicts the ADR",
		);
		// Immediate: only one cycle was gated.
		expect(result.reviewers.launched).toHaveLength(2);
	});

	test("one requesting review fails the cycle while both sides finish", async () => {
		let gated = 0;
		const result = await runDrivenWorld({
			verdictText: (role, wt) => {
				if (role === "standards") {
					gated += 1;
					// Cycle 1 requests changes; cycle 2 approves.
					if (gated === 1) {
						return fencedJson({
							verdict: "request-changes",
							summary: "Conventions broken.",
							findings: [
								{ severity: "major", file: "src/feature.txt", note: "no docs" },
							],
						});
					}
					return approveStandards(wt);
				}
				return approveSpec();
			},
		});
		expect(result.exit).toBe(0);
		expect(foldRunEvents(result.events)?.outcome).toBe(
			"handed-over-to-maintainer",
		);
		// Cycle 1's requested changes are retained with the full findings.
		const first = JSON.parse(
			fs.readFileSync(
				path.join(result.handle.artifactsDir, "cycle-1", "review-result.json"),
				"utf8",
			),
		) as { status: string; reason: string };
		expect(first.status).toBe("changes-requested");
		expect(first.reason).toContain("[major] src/feature.txt: no docs");
		// Both sides' evidence was retained even though one requested changes.
		for (const role of ["standards", "spec"] as const) {
			expect(
				fs.existsSync(
					path.join(
						result.handle.artifactsDir,
						"cycle-1",
						"reviews",
						role,
						"result.json",
					),
				),
			).toBe(true);
		}
		// Cycle 2 approved; the candidate was pushed additively both times.
		const second = JSON.parse(
			fs.readFileSync(
				path.join(result.handle.artifactsDir, "cycle-2", "review-result.json"),
				"utf8",
			),
		) as { status: string };
		expect(second.status).toBe("approved");
	});
});
