/**
 * The agent runner (ticket afk-kit #62 and #63, durable spec #46): each
 * launch — an Implementer inside its cycle, or one of the two parallel
 * Reviewers — runs in exactly one fresh session prompted exactly once — an
 * aborted or completed session is never prompted again — under a
 * wall-clock cap that aborts the run. The complete SDK event stream is
 * appended to the Run's evidence file as it arrives, so persistence never
 * waits for the session to finish. The session itself stays behind a
 * structural seam: tests script it (L2), production builds it from the
 * package-owned definition (real SDK dispatch is L3, the proof run is L4).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	BashOperations,
	ModelRuntime,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Interruption } from "./drive.ts";
import type { ImplementationSkill } from "./runs/events.ts";

/**
 * How long an aborted session may keep settling and flushing after the
 * cap fired; the prompt promise resolving is the normal path, this is the
 * backstop so a wedged session cannot wedge the Engine.
 */
const ABORT_SETTLE_CAP_MS = 30_000;

/** The slice of an SDK session the runner depends on. */
export interface AgentSessionLike {
	subscribe(listener: (event: unknown) => void): () => void;
	/** Resolves when the run finishes; an abort resolves it. */
	prompt(text: string): Promise<void>;
	abort(): void | Promise<void>;
	dispose(): void | Promise<void>;
	/** The final assistant message's text, as the session saw it. */
	getLastAssistantText(): string | undefined;
}

/** Everything one session launch needs; the request is the prompt's facts. */
export interface AgentSpawnRequest {
	/** The worktree the session works in (its cwd). */
	worktree: string;
	/** The one prompt this fresh session is given. */
	prompt: string;
	/** File the complete event stream is appended to, live. */
	eventsPath: string;
	/** Wall-clock cap; firing aborts the session. */
	capMs: number;
}

/** Builds the session for one launch; a new session every call. */
export type SessionFactory = (
	request: AgentSpawnRequest,
) => Promise<AgentSessionLike>;

export interface AgentSpawnOutcome {
	/** `"aborted"` when the cap fired or the Run was interrupted; `"completed"` on a normal finish. */
	stop: "completed" | "aborted";
	/** The final assistant text; empty on an aborted run. */
	resultText: string;
}

export interface AgentRunnerPorts {
	createSession?: SessionFactory;
	/**
	 * The Run's interruption seam (ticket #65): when given, an interrupt
	 * aborts this launch — the outcome reports `aborted`, so the judged
	 * evidence stays honest about why the session did not finish.
	 */
	interruption?: Interruption;
}

function appendEvent(eventsPath: string, event: unknown): void {
	let line: string;
	try {
		line = JSON.stringify(event);
	} catch {
		line = JSON.stringify({ type: "unserializable" });
	}
	fs.appendFileSync(eventsPath, `${line}\n`, { mode: 0o600 });
}

/**
 * Run one agent session: fresh session, one prompt, live event
 * persistence, wall-clock cap with abort. The outcome's stop reason is a
 * fact the caller judges — this function never judges the result itself.
 */
export async function runAgentSession(
	request: AgentSpawnRequest,
	ports: AgentRunnerPorts = {},
): Promise<AgentSpawnOutcome> {
	const createSession = ports.createSession;
	const interruption = ports.interruption;
	if (createSession === undefined) {
		throw new Error(
			"no session factory configured — the Engine never spawns an unconfigured session",
		);
	}
	fs.mkdirSync(path.dirname(request.eventsPath), {
		recursive: true,
		mode: 0o700,
	});

	const session = await createSession(request);
	let capFired = false;
	let interrupted = false;
	let settleCapFired = false;
	const unsubscribe = session.subscribe((event) => {
		appendEvent(request.eventsPath, event);
	});

	// The Run's interruption aborts this launch exactly like the wall-clock
	// cap does — and the outcome says so (ticket #65).
	const offInterrupt = interruption?.onRequest(() => {
		interrupted = true;
		void session.abort();
	});

	const promptPromise = session.prompt(request.prompt);
	const timer = setTimeout(() => {
		capFired = true;
		void session.abort();
	}, request.capMs);
	try {
		await Promise.race([
			promptPromise,
			new Promise<never>((_, reject) => {
				setTimeout(() => {
					if (capFired || interrupted) {
						settleCapFired = true;
						reject(
							new Error("aborted session did not settle within 30 seconds"),
						);
					}
				}, ABORT_SETTLE_CAP_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
		unsubscribe();
		offInterrupt?.();
		try {
			await session.dispose();
		} catch {
			// A dispose failure must not erase the run's outcome.
		}
	}
	return {
		stop: capFired || interrupted ? "aborted" : "completed",
		resultText:
			capFired || interrupted || settleCapFired
				? ""
				: (session.getLastAssistantText() ?? ""),
	};
}

/** The pins a package-owned agent definition carries in its frontmatter. */
export interface AgentDefinition {
	name?: string;
	/** The provider carrying the pinned model id; model ids alone can be ambiguous. */
	provider?: string;
	model?: string;
	thinking?: string;
	tools: string[];
	/** The installed skills this session mounts (ADR 0015); none by default. */
	skills: string[];
	/** The prompt body, frontmatter stripped. */
	body: string;
}

/** Parse a bracketed comma-separated frontmatter list pin: `[a, b]`. */
function parseListPin(value: string): string[] {
	const inner = value.replace(/^\[/, "").replace(/\]$/, "");
	return inner
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/**
 * Parse a package-owned agent definition: frontmatter pins plus prompt
 * body. Lenient by design — preflight already validated the file; this
 * only extracts what the session construction honors.
 */
export function parseAgentDefinition(text: string): AgentDefinition {
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (match === null) {
		return { tools: [], skills: [], body: text };
	}
	const definition: AgentDefinition = { tools: [], skills: [], body: "" };
	for (const line of (match[1] ?? "").split("\n")) {
		const entry = /^(\w[\w-]*):\s*(.*)$/.exec(line);
		if (entry === null) continue;
		const [, key, raw] = entry;
		const value = (raw ?? "").trim();
		if (key === "name") definition.name = value;
		else if (key === "provider") definition.provider = value;
		else if (key === "model") definition.model = value;
		else if (key === "thinking") definition.thinking = value;
		else if (key === "tools") {
			definition.tools = parseListPin(value);
		} else if (key === "skills") {
			definition.skills = parseListPin(value);
		}
	}
	definition.body = text.slice((match[0] ?? "").length);
	return definition;
}

/**
 * Resolve the paths a session mounts for its definition's `skills:` pin
 * (ADR 0015): each pinned name must have a preflight record, the recorded
 * `SKILL.md` must still be readable, and its bytes must still hash to the
 * preflight-recorded SHA-256 — a hash mismatch is a loud error, never a
 * fallback onto drifted text. A definition with no pin mounts nothing.
 */
export function resolveMountedSkillPaths(
	skills: readonly string[],
	records: readonly ImplementationSkill[] | undefined,
): string[] {
	if (skills.length === 0) return [];
	if (records === undefined) {
		throw new Error(
			`the definition pins implementation skills (${skills.join(", ")}) but the Run records no preflight resolution — refusing to spawn with unpinned text`,
		);
	}
	return skills.map((name) => {
		const record = records.find((r) => r.name === name);
		if (record === undefined) {
			throw new Error(
				`pinned implementation skill has no preflight record: ${name}`,
			);
		}
		let actual: string;
		try {
			actual = createHash("sha256")
				.update(fs.readFileSync(record.path))
				.digest("hex");
		} catch (error) {
			throw new Error(
				`pinned implementation skill not readable: ${name} (${record.path}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (actual !== record.sha256) {
			throw new Error(
				`pinned implementation skill changed since preflight: ${name} (preflight ${record.sha256}, now ${actual}) — refusing to spawn with drifted text`,
			);
		}
		return record.path;
	});
}

/**
 * The production session factory (L3): builds one fresh SDK session per
 * launch from a package-owned definition — its model pin, its thinking
 * pin, its tool allowlist, and its skills pin mounted against the
 * preflight records (ADR 0015). The Implementer's confined bash overrides
 * the built-in by name (prototype r45, finding 2); the Reviewers are
 * read-oriented and carry no bash at all.
 */
interface DefinitionSpawnConfig {
	/** The package-owned definition this factory builds sessions from. */
	definitionPath: string;
	/**
	 * The implementation skills preflight resolved for this Run (ADR 0015);
	 * required when the definition carries a `skills:` pin.
	 */
	pinnedSkills?: readonly ImplementationSkill[];
	/** Resolved once per Run and reused across cycles. */
	modelRuntime?: ModelRuntime;
	/** The cycle's confined bash operations; absent for read-only roles. */
	operations?: BashOperations;
	customTools?: ToolDefinition[];
}

function createDefinitionSessionFactory(
	config: DefinitionSpawnConfig,
): SessionFactory {
	return async (request) => {
		const {
			createAgentSession,
			createBashToolDefinition,
			DefaultResourceLoader,
			ModelRuntime,
			SessionManager,
			SettingsManager,
		} = await import("@earendil-works/pi-coding-agent");
		const definition = parseAgentDefinition(
			fs.readFileSync(config.definitionPath, "utf8"),
		);
		const runtime = config.modelRuntime ?? (await ModelRuntime.create());
		const model = resolvePinnedModel(
			runtime,
			definition.provider,
			definition.model,
		);
		const resourceLoader = new DefaultResourceLoader({
			cwd: request.worktree,
			// Off-tree and unused: discovery is off and settings are in-memory.
			agentDir: path.join(os.tmpdir(), "afk-engine-agent"),
			systemPrompt: definition.body,
			noExtensions: true,
			noSkills: true,
			// The pinned skills are the only skills present (ADR 0015):
			// discovery stays off, nothing ambient leaks in.
			additionalSkillPaths: resolveMountedSkillPaths(
				definition.skills,
				config.pinnedSkills,
			),
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		// Supplied loaders must be loaded explicitly; otherwise the SDK uses its
		// generic coding prompt instead of the package-owned role definition.
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: request.worktree,
			model,
			thinkingLevel: (definition.thinking as "high" | undefined) ?? "high",
			tools: definition.tools,
			customTools: config.customTools,
			...(config.operations === undefined
				? {}
				: {
						customTools: [
							// The confined definition must override the built-in bash
							// by name — "bash" has to stay in the allowlist (prototype
							// r45, finding 2) or the session would run bash nowhere.
							createBashToolDefinition(request.worktree, {
								operations: config.operations,
							}),
						],
					}),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(request.worktree),
			resourceLoader,
		});
		return session;
	};
}

/** The assessor's factory has only Engine-owned source reads, no built-in tools. */
export function createAssessmentSessionFactory(config: {
	readEvidence: ToolDefinition;
	modelRuntime?: ModelRuntime;
}): SessionFactory {
	return createDefinitionSessionFactory({
		definitionPath: path.join(
			import.meta.dir,
			"agents",
			"readiness-assessor.md",
		),
		customTools: [config.readEvidence],
		modelRuntime: config.modelRuntime,
	});
}

/** The Implementer's factory: the confined-bash definition (ticket #62). */
export function createImplementerSessionFactory(config: {
	/** The cycle's confined bash operations (confinement integration). */
	operations: BashOperations;
	/** Absolute path of the package-owned implementer definition. */
	definitionPath: string;
	/**
	 * The implementation skills preflight resolved for this Run, from the
	 * Run's evidence (ADR 0015, ticket #75).
	 */
	pinnedSkills?: readonly ImplementationSkill[];
	/** Resolved once per Run and reused across cycles. */
	modelRuntime?: ModelRuntime;
}): SessionFactory {
	return createDefinitionSessionFactory(config);
}

/**
 * A Reviewer's factory: the read-only definition, exactly as pinned —
 * no bash, nothing to confine (ticket #63).
 */
export function createReviewerSessionFactory(config: {
	/** Absolute path of the package-owned reviewer definition. */
	definitionPath: string;
	/** Resolved once per Run and reused across cycles. */
	modelRuntime?: ModelRuntime;
}): SessionFactory {
	return createDefinitionSessionFactory(config);
}

/** The model type `ModelRuntime.getModel` resolves to. */
type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * Resolve the definition's pinned provider/model pair. Deterministic: the
 * definition pins the provider because a model id alone can be carried by
 * several; a pin that resolves to nothing is a loud error, not a fallback.
 */
function resolvePinnedModel(
	runtime: ModelRuntime,
	providerId: string | undefined,
	modelId: string | undefined,
): ResolvedModel {
	const provider = providerId?.trim();
	const id = modelId?.trim();
	if (provider === undefined || provider === "") {
		throw new Error("the agent definition pins no provider");
	}
	if (id === undefined || id === "") {
		throw new Error("the agent definition pins no model");
	}
	const model = runtime.getModel(provider, id);
	if (model === undefined) {
		throw new Error(`pinned agent model not found: ${provider}/${id}`);
	}
	return model;
}
