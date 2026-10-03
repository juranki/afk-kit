/**
 * The durable start operation (ticket afk-kit #60, durable spec #46):
 * `afk implement <issue-number>` runs preflight, readiness on the immutable
 * brief snapshot, and the complete deterministic Engine loop. Every unsafe start
 * is a durable `refused` Run — inspectable through `afk status`, naming the
 * failed check, and leaving no Claim and no coordination side effects. When
 * even the refusal cannot be persisted trustworthily, the start exits 3.
 *
 * Preflight validates repository and GitHub identity/access, fetches and
 * resolves `origin/main`, checks required labels and Run state storage,
 * rejects uncleared prior Runs, validates the pinned agent
 * definitions/models/SDK/executables, and proves confinement can initialize.
 * A dirty primary checkout is recorded as a diagnostic — it never blocks.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GitRunner, runGit } from "../extensions/coordinator/git.ts";
import {
	checkRepositoryLabels,
	checkTriageLabels,
} from "../extensions/readiness/check.ts";
import {
	fetchReadinessInput,
	type GhRunner,
	type ReadinessInput,
	runGh,
} from "../extensions/readiness/gh.ts";
import { collectTrackerPages } from "../extensions/readiness/pagination.ts";
import type { SessionFactory } from "./agent-runner.ts";
import { ASSESSMENT_CAP_MS, assessReadiness } from "./assessment.ts";
import {
	type ConfigPorts,
	resolveImplementationSkills,
	validateEngineConfig,
} from "./config.ts";
import { type CyclePortDeps, createCyclePort } from "./cycle.ts";
import { createInterruption, driveRun, RUN_DEADLINE_MS } from "./drive.ts";
import {
	type ConfinementRuntimePort,
	probeConfinementCapability,
} from "./preflight.ts";
import { createReviewPort, type ReviewPortDeps } from "./review.ts";
import {
	type ImplementationSkill,
	RUN_EVENT_NAMES,
	readRunEvents,
} from "./runs/events.ts";
import {
	afkStateRoot,
	issueRunsDir,
	repositoryStateRoot,
} from "./runs/paths.ts";
import { foldRunEvents } from "./runs/projection.ts";
import { finalizeInterruptedRun } from "./runs/reconcile.ts";
import { resolveRepository } from "./runs/status.ts";
import {
	acquireRunLock,
	artifactDir,
	createRun,
	type RunHandle,
	recordEvent,
	releaseRunLock,
} from "./runs/store.ts";

/** The output seams of the start command. */
interface ImplementIo {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

/** Injectable seams; defaults reach the real host (code-verify standard). */
interface ImplementPorts {
	gh?: GhRunner;
	git?: GitRunner;
	/** The srt port the confinement capability probe initializes. */
	confinementRuntime?: ConfinementRuntimePort;
	/** Lookup ports for the pinned-configuration validation. */
	config?: ConfigPorts;
	/** Agent/confinement ports for seam tests; no CLI or environment overrides. */
	cycle?: CyclePortDeps["ports"];
	review?: ReviewPortDeps["ports"];
	assessment?: { sessionFactory?: SessionFactory; capMs?: number };
	/** Worktree convention root; production uses ~/wt. */
	worktreeRoot?: string;
	/** Clock for Run ids and event timestamps. */
	now?: () => Date;
}

export interface ImplementOptions {
	ticket: number;
	/** The primary checkout the start runs against. */
	cwd: string;
	env: NodeJS.ProcessEnv;
	io: ImplementIo;
	ports?: ImplementPorts;
}

/** One named preflight check result — the unit of refusal evidence. */
interface CheckResult {
	name: string;
	pass: boolean;
	detail: string;
}

function pass(name: string, detail: string): CheckResult {
	return { name, pass: true, detail };
}

function fail(name: string, detail: string): CheckResult {
	return { name, pass: false, detail };
}

/** The message of an unknown thrown value. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The snapshot used when the ticket itself could not be read: the immutable
 * brief slot still pins that fact, and readiness never runs on it.
 */
const UNAVAILABLE_BRIEF =
	"<!-- The ticket brief could not be read at start; preflight refused before readiness. This placeholder pins that fact. -->\n";

/** What fact-gathering learned before the Run exists. */
interface StartFacts {
	checks: CheckResult[];
	/** The tracker's brief substrate, when the ticket was readable. */
	readinessInput: ReadinessInput | null;
	/** The freshly fetched origin/main SHA, when resolvable. */
	baseSha: string | null;
	/** The resolved implementation skills, when the pin validated (ADR 0015). */
	implementationSkills: ImplementationSkill[] | null;
	/** Why the primary checkout is dirty, when it is. */
	dirty: string | null;
}

async function jsonOf<T>(
	run: GhRunner,
	args: string[],
	name: string,
): Promise<T> {
	const result = await run(args);
	if (result.exitCode !== 0) {
		throw new Error(
			`${name} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
		);
	}
	return JSON.parse(result.stdout) as T;
}

/**
 * Gather every preflight fact. Never throws: each check reports its own
 * failure, so one broken seam cannot hide the others' evidence.
 */
async function gatherStartFacts(options: {
	ticket: number;
	cwd: string;
	stateRoot: string;
	owner: string;
	repo: string;
	gh: GhRunner;
	git: GitRunner;
	ports: ImplementPorts;
}): Promise<StartFacts> {
	const { ticket, cwd, stateRoot, owner, repo, gh, git, ports } = options;
	const checks: CheckResult[] = [];
	const facts: StartFacts = {
		checks,
		readinessInput: null,
		baseSha: null,
		implementationSkills: null,
		dirty: null,
	};

	// GitHub identity and access.
	try {
		const user = await jsonOf<{ login?: string }>(
			gh,
			["api", "user"],
			"gh api user",
		);
		if (user.login)
			checks.push(pass("github-identity", `authenticated as ${user.login}`));
		else checks.push(fail("github-identity", "gh api user returned no login"));
	} catch (error) {
		checks.push(fail("github-identity", messageOf(error)));
	}

	// The ticket's brief substrate — shared by preflight and readiness.
	try {
		facts.readinessInput = await fetchReadinessInput(ticket, gh);
		checks.push(
			pass("ticket-readable", "brief, labels, and blocked-by edges fetched"),
		);
	} catch (error) {
		checks.push(fail("ticket-readable", messageOf(error)));
	}

	// Required triage labels (the readiness check's rule, run as a gate).
	if (!facts.readinessInput) {
		checks.push(fail("required-labels", "not evaluated: ticket unreadable"));
	} else {
		const inspection = checkTriageLabels(facts.readinessInput.labels);
		checks.push({ ...inspection, name: "required-labels" });
	}

	// Repository labels AFK will apply later; read only, never provision them.
	try {
		const labels = await collectTrackerPages<{ name: string }>({
			readPage: (page) =>
				jsonOf<unknown>(
					gh,
					["api", `repos/${owner}/${repo}/labels?per_page=100&page=${page}`],
					"repository labels",
				),
			malformed: "malformed repository labels response",
			exhausted: "repository label pagination exhausted",
		});
		checks.push(checkRepositoryLabels(labels.map((label) => label.name)));
	} catch (error) {
		checks.push(fail("repository-labels", messageOf(error)));
	}

	// Fresh origin/main: fetch and resolve, never local main.
	try {
		const fetched = await git(["fetch", "origin"], cwd);
		if (fetched.exitCode !== 0) throw new Error(fetched.stderr.trim());
		const rev = await git(["rev-parse", "origin/main"], cwd);
		if (rev.exitCode !== 0) throw new Error(rev.stderr.trim());
		facts.baseSha = rev.stdout.trim();
		checks.push(
			pass("origin-main", `resolved origin/main at ${facts.baseSha}`),
		);
	} catch (error) {
		checks.push(fail("origin-main", messageOf(error)));
	}

	// Run state storage: the repository's state subtree must be creatable
	// and writable, owner-only.
	const repositoryRoot = repositoryStateRoot(stateRoot, owner, repo);
	try {
		fs.mkdirSync(repositoryRoot, { recursive: true, mode: 0o700 });
		const probe = path.join(repositoryRoot, ".write-probe");
		fs.writeFileSync(probe, "probe", { mode: 0o600 });
		fs.unlinkSync(probe);
		checks.push(
			pass("state-storage", `run state writable at ${repositoryRoot}`),
		);
	} catch (error) {
		checks.push(
			fail(
				"state-storage",
				`cannot write run state under ${repositoryRoot}: ${messageOf(error)}`,
			),
		);
	}

	// Uncleared prior Runs: v0 never reuses or auto-cleans — an unfinished
	// Run (or an unreadable one) needs a maintainer's decision first.
	const runsDir = issueRunsDir(repositoryRoot, ticket);
	let priorDirs: fs.Dirent[] | null;
	try {
		priorDirs = fs.readdirSync(runsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			checks.push(pass("prior-runs", "no prior Runs"));
		} else {
			checks.push(
				fail(
					"prior-runs",
					`cannot read prior Runs under ${runsDir}: ${messageOf(error)}`,
				),
			);
		}
		priorDirs = null;
	}
	if (priorDirs !== null) {
		// The interruption reconciler (ticket #65): a dead-lock Run is
		// finalized first — its interruption Escalation materialized and
		// the Run made terminal — so the next implement converges the
		// interruption instead of tripping over it. A live Run and a
		// lock-less unfinished Run are untouched and still block.
		const reconcileSeams = {
			gh,
			git,
			checkout: cwd,
			worktreeRoot: path.join(os.homedir(), "wt"),
		};
		const uncleared: string[] = [];
		for (const entry of priorDirs) {
			if (!entry.isDirectory()) continue;
			const runDir = path.join(runsDir, entry.name);
			await finalizeInterruptedRun(runDir, { seams: reconcileSeams });
			try {
				const summary = foldRunEvents(
					readRunEvents(path.join(runDir, "events.jsonl")).events,
				);
				if (summary === null || summary.outcome === null) {
					uncleared.push(entry.name);
				}
			} catch {
				uncleared.push(`${entry.name} (unreadable)`);
			}
		}
		if (uncleared.length > 0) {
			checks.push(
				fail(
					"prior-runs",
					`uncleared prior Run(s) for #${ticket}: ${uncleared.join(", ")} — a maintainer clears them before another start`,
				),
			);
		} else {
			checks.push(pass("prior-runs", "no uncleared prior Run"));
		}
	}

	// Pinned configuration: models, agent definitions, SDK, executables.
	try {
		const config = await validateEngineConfig(ports.config);
		if (config.ok) {
			checks.push(
				pass(
					"engine-config",
					"pinned definitions, models, SDK, and executables validated",
				),
			);
		} else {
			checks.push(fail("engine-config", config.problems.join("; ")));
		}
	} catch (error) {
		checks.push(fail("engine-config", messageOf(error)));
	}

	// Implementation skills: every pinned skill must resolve to its
	// installed SKILL.md (ADR 0015); the resolutions' SHA-256 hashes become
	// Run evidence, and a missing skill refuses the start naming it.
	try {
		const skills = await resolveImplementationSkills(ports.config);
		if (skills.ok) {
			facts.implementationSkills = skills.skills;
			checks.push(
				pass(
					"implementation-skills",
					skills.skills
						.map((s) => `${s.name} (${s.sha256.slice(0, 12)})`)
						.join(", "),
				),
			);
		} else {
			checks.push(fail("implementation-skills", skills.problems.join("; ")));
		}
	} catch (error) {
		checks.push(fail("implementation-skills", messageOf(error)));
	}

	// Confinement capability: the sandbox runtime must initialize.
	try {
		const probe = await probeConfinementCapability({
			runtime: ports.confinementRuntime,
		});
		checks.push(
			probe.ok
				? pass("confinement", probe.detail)
				: fail("confinement", probe.detail),
		);
	} catch (error) {
		checks.push(fail("confinement", messageOf(error)));
	}

	// Dirty primary checkout: diagnostic only, never a gate.
	try {
		const status = await git(["status", "--porcelain"], cwd);
		const entries = status.stdout.trim();
		if (status.exitCode === 0 && entries !== "") {
			facts.dirty = `${entries.split("\n").length} modified entr${entries.split("\n").length === 1 ? "y" : "ies"}`;
		}
	} catch {
		// An unreadable status is not diagnostic value; git failures surface
		// through origin-main.
	}

	return facts;
}

/** The structured evidence written under the Run's artifacts/. */
function writeStageReport(
	handle: RunHandle,
	stage: string,
	report: Record<string, unknown>,
): string {
	const dir = artifactDir(handle, stage);
	const file = path.join(dir, "report.json");
	fs.writeFileSync(
		file,
		`${JSON.stringify({ stage, repository: `${handle.owner}/${handle.repo}`, ticket: handle.ticket, ...report }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	return `${stage}/report.json`;
}

/** Record the durable refusal and tell the maintainer what failed. */
function refuseRun(
	handle: RunHandle,
	io: ImplementIo,
	stage: string,
	failed: CheckResult[],
): 1 {
	const names = failed.map((c) => c.name);
	const reason = `${stage} failed: ${names.join(", ")}`;
	recordEvent(handle, {
		name: RUN_EVENT_NAMES.outcome,
		payload: { outcome: "refused", reason, stage, failed: names },
		artifacts: [`${stage}/report.json`],
	});
	io.stderr(`IMPLEMENT_REFUSAL: ${reason}\n`);
	for (const check of failed) {
		io.stderr(`- ${check.name}: ${check.detail}\n`);
	}
	io.stderr(`run ${handle.runId} at ${handle.dir}\n`);
	return 1;
}

/**
 * Run preflight, readiness, and the Engine under one continuously held lock.
 * Exits: 0 handoff; 1 pre-Claim refusal; 2 claimed-Run Escalation;
 * 3 internal failure preventing durable evidence/Escalation.
 */
export async function runImplement(options: ImplementOptions): Promise<number> {
	const { ticket, cwd, env, io } = options;
	const ports = options.ports ?? {};
	const gh = ports.gh ?? runGh(cwd);
	const git = ports.git ?? runGit();

	// Without a GitHub-keyed repository identity there is no Run directory
	// to persist evidence under — a diagnostic and exit 3 are all that
	// remain.
	let repository: { owner: string; repo: string };
	try {
		repository = await resolveRepository(cwd);
	} catch (error) {
		io.stderr(`afk implement: ${messageOf(error)}\n`);
		return 3;
	}

	const facts = await gatherStartFacts({
		ticket,
		cwd,
		stateRoot: afkStateRoot(env),
		owner: repository.owner,
		repo: repository.repo,
		gh,
		git,
		ports,
	});

	let handle: RunHandle;
	try {
		handle = createRun({
			stateRoot: afkStateRoot(env),
			owner: repository.owner,
			repo: repository.repo,
			ticket,
			brief: facts.readinessInput?.body ?? UNAVAILABLE_BRIEF,
			now: ports.now,
		});
	} catch (error) {
		io.stderr(
			`afk implement: cannot persist Run evidence: ${messageOf(error)}\n`,
		);
		return 3;
	}

	try {
		const lock = acquireRunLock(handle);
		try {
			const reportArtifact = writeStageReport(handle, "preflight", {
				checks: facts.checks,
				baseSha: facts.baseSha,
				generatedAt: new Date().toISOString(),
			});
			recordEvent(handle, {
				name: RUN_EVENT_NAMES.stageEntered,
				payload: { stage: "preflight" },
				artifacts: [reportArtifact],
			});
			if (facts.dirty) {
				recordEvent(handle, {
					name: RUN_EVENT_NAMES.notice,
					payload: {
						message: `primary checkout is dirty (${facts.dirty}) — diagnostic only, it does not block`,
					},
				});
			}
			if (facts.implementationSkills !== null) {
				// Evidence of the precise text the Implementer sessions will
				// be given (ADR 0015): name, path, and SHA-256 per pinned
				// skill, recorded even if another check refuses the start.
				recordEvent(handle, {
					name: RUN_EVENT_NAMES.implementationSkills,
					payload: { skills: facts.implementationSkills },
				});
			}

			const failed = facts.checks.filter((c) => !c.pass);
			if (failed.length > 0) return refuseRun(handle, io, "preflight", failed);

			// ADR 0016: capture once; the assessor prepares a separate handoff.
			const readinessDirectory = artifactDir(handle, "readiness");
			recordEvent(handle, {
				name: RUN_EVENT_NAMES.stageEntered,
				payload: { stage: "readiness" },
				artifacts: ["readiness"],
			});
			const started = readRunEvents(handle.eventsPath).events[0]?.ts;
			const remaining =
				RUN_DEADLINE_MS -
				(Date.now() - Date.parse(started ?? new Date().toISOString()));
			if (facts.baseSha === null || facts.readinessInput === null) {
				throw new Error(
					"passing preflight has no repository revision or Issue evidence",
				);
			}
			const readiness = await assessReadiness({
				ticket,
				repository: `${repository.owner}/${repository.repo}`,
				revision: facts.baseSha,
				cwd,
				input: facts.readinessInput,
				gh,
				git,
				directory: readinessDirectory,
				capMs: Math.min(
					ports.assessment?.capMs ?? ASSESSMENT_CAP_MS,
					remaining,
				),
				sessionFactory: ports.assessment?.sessionFactory,
			});
			writeStageReport(handle, "readiness", { assessment: readiness });
			if (readiness.status !== "ready") {
				const detail =
					readiness.status === "needs-clarification"
						? readiness.questions
								.map((q) => `${q.text} [${q.refs.join(", ")}]`)
								.join("; ")
						: readiness.reason;
				return refuseRun(handle, io, "readiness", [
					fail(readiness.status, detail),
				]);
			}
			const snapshot = fs.readFileSync(
				path.join(handle.artifactsDir, "readiness", "prepared-brief.md"),
				"utf8",
			);
			recordEvent(handle, {
				name: RUN_EVENT_NAMES.notice,
				payload: {
					message:
						"Readiness Ready: immutable prepared brief and captured sources established",
				},
				artifacts: [
					"readiness/prepared-brief.md",
					"readiness/prepared-brief.json",
				],
			});

			const seams = {
				gh,
				git,
				checkout: cwd,
				worktreeRoot: ports.worktreeRoot ?? path.join(os.homedir(), "wt"),
				preparedBrief: snapshot,
				preparedVerifyCommands: readiness.brief.verifyCommands.map(
					(c) => c.command,
				),
			};
			const interruption = createInterruption();
			return await driveRun({
				handle,
				lock,
				seams,
				io,
				interruption,
				runCycle: createCyclePort({
					handle,
					seams,
					brief: snapshot,
					verifyCommands: seams.preparedVerifyCommands,
					ports: { ...ports.cycle, interruption },
				}),
				runReviews: createReviewPort({
					handle,
					seams,
					brief: snapshot,
					ports: { ...ports.review, interruption },
				}),
			});
		} finally {
			releaseRunLock(lock, handle);
		}
	} catch (error) {
		io.stderr(
			`afk implement: cannot persist trustworthy Run evidence: ${messageOf(error)}\n  ${handle.dir}\n`,
		);
		return 3;
	}
}
