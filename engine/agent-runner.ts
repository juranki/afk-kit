/**
 * The Implementer agent runner (ticket afk-kit #62, durable spec #46):
 * each cycle launches exactly one fresh session and prompts it exactly
 * once — an aborted or completed session is never prompted again — under
 * a wall-clock cap that aborts the run. The complete SDK event stream is
 * appended to the Run's evidence file as it arrives, so persistence never
 * waits for the session to finish. The session itself stays behind a
 * structural seam: tests script it (L2), production builds it from the
 * package-owned definition with confined tools (real SDK dispatch is L3,
 * the proof run is L4).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	BashOperations,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";

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
	getLastAssistantText(): string;
}

/** Everything one session launch needs; the request is the prompt's facts. */
export interface ImplementerSpawnRequest {
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
	request: ImplementerSpawnRequest,
) => Promise<AgentSessionLike>;

export interface ImplementerSpawnOutcome {
	/** `"aborted"` when the cap fired; `"completed"` on a normal finish. */
	stop: "completed" | "aborted";
	/** The final assistant text; empty on an aborted run. */
	resultText: string;
}

export interface ImplementerRunnerPorts {
	createSession?: SessionFactory;
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
 * Run one Implementer session: fresh session, one prompt, live event
 * persistence, wall-clock cap with abort. The outcome's stop reason is a
 * fact the cycle judges — this function never judges done itself.
 */
export async function runImplementerSession(
	request: ImplementerSpawnRequest,
	ports: ImplementerRunnerPorts = {},
): Promise<ImplementerSpawnOutcome> {
	const createSession = ports.createSession;
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
	let settleCapFired = false;
	const unsubscribe = session.subscribe((event) => {
		appendEvent(request.eventsPath, event);
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
					if (capFired) {
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
		try {
			await session.dispose();
		} catch {
			// A dispose failure must not erase the run's outcome.
		}
	}
	return {
		stop: capFired ? "aborted" : "completed",
		resultText:
			capFired || settleCapFired ? "" : session.getLastAssistantText(),
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
	/** The prompt body, frontmatter stripped. */
	body: string;
}

/**
 * Parse a package-owned agent definition: frontmatter pins plus prompt
 * body. Lenient by design — preflight already validated the file; this
 * only extracts what the session construction honors.
 */
export function parseAgentDefinition(text: string): AgentDefinition {
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (match === null) {
		return { tools: [], body: text };
	}
	const definition: AgentDefinition = { tools: [] };
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
			const inner = value.replace(/^\[/, "").replace(/\]$/, "");
			definition.tools = inner
				.split(",")
				.map((tool) => tool.trim())
				.filter((tool) => tool !== "");
		}
	}
	definition.body = text.slice((match[0] ?? "").length);
	return definition;
}

/**
 * The production session factory (L3): builds one fresh SDK session per
 * launch from the package-owned definition — its model pin, its thinking
 * pin, its tool allowlist with the confined bash overriding the built-in
 * by name — with discovery, settings, and session files all off.
 */
export interface ImplementerSpawnConfig {
	/** The cycle's confined bash operations (confinement integration). */
	operations: BashOperations;
	/** Absolute path of the package-owned implementer definition. */
	definitionPath: string;
	/** Resolved once per Run and reused across cycles. */
	modelRuntime?: ModelRuntime;
}

export function createImplementerSessionFactory(
	config: ImplementerSpawnConfig,
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
			agentDir: path.join(os.tmpdir(), "afk-implementer-agent"),
			systemPrompt: definition.body,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		const { session } = await createAgentSession({
			cwd: request.worktree,
			model,
			thinkingLevel: (definition.thinking as "high" | undefined) ?? "high",
			tools: definition.tools,
			customTools: [
				// The confined definition must override the built-in bash by
				// name — "bash" has to stay in the allowlist (prototype r45,
				// finding 2) or the session would run bash nowhere.
				createBashToolDefinition(request.worktree, {
					operations: config.operations,
				}),
			],
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(request.worktree),
			resourceLoader,
		});
		return session;
	};
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
		throw new Error("implementer definition pins no provider");
	}
	if (id === undefined || id === "") {
		throw new Error("implementer definition pins no model");
	}
	const model = runtime.getModel(provider, id);
	if (model === undefined) {
		throw new Error(`pinned implementer model not found: ${provider}/${id}`);
	}
	return model;
}
