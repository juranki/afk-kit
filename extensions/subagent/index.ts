/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three dispatch modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * afk-kit fork (ADR 0007, R8/R2 — see this directory's README): single and
 * parallel dispatch run detached and non-blocking. A call waits up to `wait`
 * seconds (default 180; 0 = return immediately; negative = wait forever), then
 * returns {status:"running", subagentId}. Results are recovered with
 * {check:"<id>"}, a live task can be killed with {cancel:"<id>"}, and every
 * task is bounded by a wall-clock cap and a no-output watchdog. A `thinking`
 * frontmatter field sets a per-agent thinking level (R2); the dispatch level
 * stays the fallback. Chain stays foreground: sequential and streaming.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	buildSubagentArgs,
	cancelSubagent,
	checkSubagentText,
	computeWaitMs,
	type DispatchDefaults,
	formatElapsedMs,
	getPiInvocation,
	pollIntervalMs,
	readRefusals,
	readStatus,
	readStderrTail,
	readWorkHistory,
	type SubagentStatusRecord,
	setCompletionNotifier,
	spawnBackgroundTask,
	summarizeMessages,
	taskDir,
	terminalFromSignal,
	waitForSubagent,
} from "./background.ts";
import {
	buildConfinedEnv,
	extractRefusals,
	materializeConfinement,
} from "./confinement.ts";

const MAX_PARALLEL_TASKS = 8;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	// biome-ignore lint/suspicious/noExplicitAny: vendored upstream signature — the theme's color union is not exported
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg(
					"warning",
					`:${startLine}${endLine ? `-${endLine}` : ""}`,
				);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return (
				themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
			);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/**
	 * R5: the confined child's CONFINEMENT_REFUSAL stderr lines. Report
	 * lines, not errors — a refusal never flips the result's error state.
	 */
	refusals?: string[];
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

/**
 * Append a result's refusals to coordinator-visible text. Refusals are
 * normal for a confined implementer (FINDINGS.md): reported, never alarmed
 * on — they never change the text's error framing.
 */
function withRefusals(text: string, result: SingleResult): string {
	if (!result.refusals || result.refusals.length === 0) return text;
	const lines = result.refusals.map((r) => `- ${r}`).join("\n");
	return `${text}\n\nRefusals (${result.refusals.length}, confined):\n${lines}`;
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			getFinalOutput(result.messages) ||
			"(no output)"
		);
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem =
	| { type: "text"; text: string }
	// biome-ignore lint/suspicious/noExplicitAny: vendored upstream shape — tool args are arbitrary JSON
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Rebuild a SingleResult for a finished background task from its status
 * record and the child's replayed JSON stream.
 */
function resultFromRecord(
	record: SubagentStatusRecord,
	id: string,
): SingleResult {
	const { messages } = readWorkHistory(path.join(taskDir(id), "stdout.jsonl"));
	const summary = summarizeMessages(messages);
	const refusals = readRefusals(id);
	return {
		agent: record.agent,
		agentSource: record.agentSource,
		task: record.task,
		exitCode: record.exitCode ?? 1,
		messages,
		stderr: readStderrTail(id),
		usage: summary.usage,
		...(summary.model ? { model: summary.model } : {}),
		...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
		errorMessage: record.errorMessage ?? summary.errorMessage,
		...(record.step !== undefined ? { step: record.step } : {}),
		...(refusals.length > 0 ? { refusals } : {}),
	};
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			step,
		};
	}

	const args: string[] = buildSubagentArgs(agent, dispatchDefaults);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	// R5 confinement (#17) on the foreground chain path: materialize the shim
	// + git pin into a per-child temp dir, pass the allowlist env to the spawn,
	// clean up with the prompt temp file.
	let confinementDir: string | null = null;
	let spawnEnv: NodeJS.ProcessEnv | undefined;
	if (agent.confinement) {
		confinementDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagent-confined-"),
		);
		spawnEnv = buildConfinedEnv(
			process.env,
			materializeConfinement(confinementDir),
		);
	}

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model: agent.model ?? dispatchDefaults.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: spawnEnv,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				// biome-ignore lint/suspicious/noExplicitAny: vendored upstream pattern — child events are untrusted JSON
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model)
							currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code, signalTerm) => {
				if (buffer.trim()) processLine(buffer);
				// Fork fix (research finding 6): a signal-killed child must not
				// resolve as success. Map the signal to a failure exit code.
				const fromSignal = terminalFromSignal(signalTerm);
				if (fromSignal) {
					currentResult.errorMessage = `terminated by ${fromSignal.signal}`;
					resolve(fromSignal.exitCode);
				} else {
					resolve(code ?? 1);
				}
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		const refusals = extractRefusals(
			currentResult.stderr,
			currentResult.messages,
		);
		if (refusals.length > 0) currentResult.refusals = refusals;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		if (confinementDir)
			try {
				fs.rmSync(confinementDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	wait: Type.Optional(
		Type.Number({
			description:
				'Seconds the call may block on a dispatch before returning {status:"running", subagentId}. Default 180. 0 = return immediately; negative = wait forever.',
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Dispatch without blocking at all (equivalent to wait: 0). Default: false.",
		}),
	),
	check: Type.Optional(
		Type.String({
			description:
				'Return the status and output of a background task: {check: "<subagentId>"}',
		}),
	),
	cancel: Type.Optional(
		Type.String({
			description: 'Kill a running background task: {cancel: "<subagentId>"}',
		}),
	),
	history: Type.Optional(
		StringEnum(["full"] as const, {
			description: 'With check: "full" returns the complete message stream.',
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Dispatch modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Single and parallel are non-blocking: the call waits up to `wait` seconds (default 180; 0 = return immediately; negative = forever), then returns {status: "running", subagentId}.',
			'Recover the result later with {check: "<subagentId>"} (history: "full" for the whole stream); kill a stuck task with {cancel: "<subagentId>"}.',
			"Every task is also bounded on its own: a wall-clock cap and a no-output watchdog kill a hung child.",
			"Agents whose frontmatter carries a confinement field spawn confined (R5): env allowlist + pinned gitconfig, a PATH shim refusing gh and git push; their CONFINEMENT_REFUSAL stderr lines come back as a refusals field — report lines, not errors.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			// Completion notifications ride the session UI when there is one
			// (the fork's completion-watcher behavior, best-effort).
			if (ctx.hasUI) {
				setCompletionNotifier((text) => ctx.ui.notify(text));
			}
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasCheck = Boolean(params.check);
			const hasCancel = Boolean(params.cancel);
			const modeCount =
				Number(hasChain) +
				Number(hasTasks) +
				Number(hasSingle) +
				Number(hasCheck) +
				Number(hasCancel);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available =
					agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain)
					for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks)
					for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: makeDetails(
								hasChain ? "chain" : hasTasks ? "parallel" : "single",
							)([]),
						};
				}
			}

			if (hasCheck) {
				const checkId = params.check;
				if (checkId) {
					const { text } = checkSubagentText(
						checkId,
						params.history === "full",
					);
					return {
						content: [{ type: "text", text }],
						details: makeDetails("single")([]),
					};
				}
			}

			if (hasCancel) {
				const cancelId = params.cancel;
				if (cancelId) {
					const { text } = await cancelSubagent(cancelId);
					return {
						content: [{ type: "text", text }],
						details: makeDetails("single")([]),
					};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(
						/\{previous\}/g,
						previousOutput,
					);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{
							type: "text",
							text:
								getFinalOutput(results[results.length - 1].messages) ||
								"(no output)",
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Dispatch every member detached; the group poll below replaces
				// the attached concurrency-limited loop (fork shape).
				const zeroUsage = () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				});
				const availableList =
					agents.map((a) => `"${a.name}"`).join(", ") || "none";

				const members = params.tasks.map((t) => {
					const agent = agents.find((a) => a.name === t.agent);
					if (!agent) return { t, id: null as string | null };
					const spawnedTask = spawnBackgroundTask({
						agent,
						dispatchDefaults,
						mode: "parallel",
						task: t.task,
						cwd: t.cwd ?? ctx.cwd,
					});
					return { t, id: spawnedTask.id };
				});

				const plan = computeWaitMs(
					params.wait ?? (params.background ? 0 : undefined),
				);

				// Group poll: block until every member is terminal or the call's
				// wait cap is hit; progress streams as aggregate updates.
				const start = Date.now();
				let timedOut = plan.kind === "background";
				while (!timedOut) {
					const pending = members.filter((m) => {
						if (!m.id) return false;
						const rec = readStatus(m.id);
						return !rec || rec.status === "running";
					});
					if (pending.length === 0) break;
					const elapsed = Date.now() - start;
					if (plan.kind === "deadline" && elapsed >= plan.ms) {
						timedOut = true;
						break;
					}
					const done = members.length - pending.length;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Parallel: ${done}/${members.length} done, ${pending.length} running...`,
							},
						],
						details: makeDetails("parallel")([]),
					});
					const nextPoll =
						plan.kind === "deadline"
							? Math.min(pollIntervalMs(), plan.ms - elapsed)
							: pollIntervalMs();
					if (nextPoll > 0) await new Promise((r) => setTimeout(r, nextPoll));
				}

				if (timedOut) {
					const lines = members.map((m) => {
						const rec = m.id ? readStatus(m.id) : null;
						const status = rec?.status ?? "running";
						return m.id
							? `- ${m.t.agent}: ${status} [${m.id}]`
							: `- ${m.t.agent}: dispatch failed (unknown agent)`;
					});
					return {
						content: [
							{
								type: "text",
								text: `Parallel dispatch still running (waited ${formatElapsedMs(Date.now() - start)}).\n${lines.join("\n")}\nCheck with subagent({ check: "<subagentId>" }); cancel with subagent({ cancel: "<subagentId>" }).`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				}

				const results: SingleResult[] = members.map((m) => {
					if (!m.id) {
						return {
							agent: m.t.agent,
							agentSource: "unknown" as const,
							task: m.t.task,
							exitCode: 1,
							messages: [],
							stderr: `Unknown agent: "${m.t.agent}". Available agents: ${availableList}.`,
							usage: zeroUsage(),
						};
					}
					const rec = readStatus(m.id);
					if (!rec || rec.status === "running") {
						// Only reachable when a record vanished mid-poll.
						return {
							agent: m.t.agent,
							agentSource: "unknown" as const,
							task: m.t.task,
							exitCode: 1,
							messages: [],
							stderr: "Task record missing.",
							usage: zeroUsage(),
						};
					}
					return resultFromRecord(rec, m.id);
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = withRefusals(
						truncateParallelOutput(getResultOutput(r)),
						r,
					);
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available =
						agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
					return {
						content: [
							{
								type: "text",
								text: `Unknown agent: "${params.agent}". Available agents: ${available}.`,
							},
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				const spawnedTask = spawnBackgroundTask({
					agent,
					dispatchDefaults,
					mode: "single",
					task: params.task,
					cwd: params.cwd ?? ctx.cwd,
				});
				const plan = computeWaitMs(
					params.wait ?? (params.background ? 0 : undefined),
				);
				const outcome = await waitForSubagent(
					spawnedTask.id,
					plan,
					(elapsedMs) => {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `⏳ ${params.agent} running… ${formatElapsedMs(elapsedMs)} [${spawnedTask.id}]`,
								},
							],
							details: makeDetails("single")([]),
						});
					},
				);

				// Still running past the wait cap: hand control back with the id.
				if (
					outcome.timedOut ||
					!outcome.record ||
					outcome.record.status === "running"
				) {
					const snapshot = checkSubagentText(spawnedTask.id, false).text;
					return {
						content: [
							{
								type: "text",
								text: `Subagent "${params.agent}" is still running after ${formatElapsedMs(outcome.elapsedMs)}.\n{"status":"running","subagentId":"${spawnedTask.id}"}\n${snapshot}`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				const result = resultFromRecord(outcome.record, spawnedTask.id);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: withRefusals(
									`Agent ${result.stopReason || "failed"}: ${errorMsg}`,
									result,
								),
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: withRefusals(
								getFinalOutput(result.messages) || "(no output)",
								result,
							),
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available =
				agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.cancel) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("error", `cancel ${args.cancel}`),
					0,
					0,
				);
			}
			if (args.check) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `check ${args.check}`),
					0,
					0,
				);
			}
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview =
						cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview =
						t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(
					text?.type === "text" ? text.text : "(no output)",
					0,
					0,
				);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped =
					limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0)
					text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded
							? item.text
							: item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason)
						header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(
							new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
						);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", "─── Output ───"), 0, 0),
					);
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(
							new Text(theme.fg("muted", "(no output)"), 0, 0),
						);
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason)
					text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage)
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0)
					text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
				};
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter(
					(r) => r.exitCode === 0,
				).length;
				const icon =
					successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg(
									"accent",
									`${successCount}/${details.results.length} steps`,
								),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage)
							container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon =
						r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter(
					(r) => r.exitCode !== -1 && !isFailedResult(r),
				).length;
				const failCount = details.results.filter(
					(r) => r.exitCode !== -1 && isFailedResult(r),
				).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage)
							container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
