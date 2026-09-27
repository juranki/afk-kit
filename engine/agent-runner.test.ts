/**
 * L2 seam-integration tests for the Implementer agent runner (ticket
 * afk-kit #62, durable spec #46): one fresh session per cycle launch,
 * exactly one prompt — an aborted or completed session is never prompted
 * again — the wall-clock cap aborts the run, and the complete SDK event
 * stream is persisted to the Run's evidence file while the session runs.
 * The SDK itself stays behind the session seam; these are scripted
 * sessions (code-verify standard: real SDK dispatch is L3).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentSessionLike,
	parseAgentDefinition,
	runAgentSession,
	type SessionFactory,
} from "./agent-runner.ts";

function scratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "afk-agent-"));
}

interface ScriptedSession extends AgentSessionLike {
	prompts: string[];
	aborted: boolean;
	disposed: boolean;
	/** Resolve the pending prompt with a last assistant text. */
	finish: (resultText?: string) => void;
	/** Emit one event to the subscribed listener. */
	emit: (event: unknown) => void;
	finalText: string;
}

function scriptedSession(): ScriptedSession {
	const session: ScriptedSession = {
		prompts: [],
		aborted: false,
		disposed: false,
		finish: () => {},
		emit: () => {},
	};
	session.prompt = (text) => {
		session.prompts.push(text);
		return new Promise<void>((resolve) => {
			session.finish = (resultText = "done") => {
				session.finish = () => {};
				resolve();
				void resultText;
			};
		});
	};
	session.abort = () => {
		session.aborted = true;
		session.finish();
	};
	session.subscribe = (listener) => {
		session.emit = (event) => listener(event);
		return () => {};
	};
	session.dispose = () => {
		session.disposed = true;
	};
	session.finalText = "All done.";
	session.getLastAssistantText = () => session.finalText;
	return session;
}

describe("runAgentSession", () => {
	test("prompts one fresh session once, completes, and persists the stream", async () => {
		const dir = scratch();
		const eventsPath = path.join(dir, "session-events.jsonl");
		const session = scriptedSession();
		const factories: SessionFactory[] = [
			async () => {
				setTimeout(() => {
					session.emit({ type: "agent_start" });
					session.emit({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "All done." }],
						},
					});
					session.emit({ type: "agent_end" });
					session.finish();
				}, 10);
				return session;
			},
		];
		const outcome = await runAgentSession(
			{
				worktree: dir,
				prompt: "Implement issue #9.",
				eventsPath,
				capMs: 60_000,
			},
			{ createSession: factories[0] },
		);
		expect(outcome.stop).toBe("completed");
		expect(session.prompts).toEqual(["Implement issue #9."]);
		expect(session.disposed).toBe(true);
		const lines = fs
			.readFileSync(eventsPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.map((line) => line.type)).toEqual([
			"agent_start",
			"message_end",
			"agent_end",
		]);
		expect(outcome.resultText).toBe("All done.");
	});

	test("events are persisted while the session runs, not after it", async () => {
		const dir = scratch();
		const eventsPath = path.join(dir, "session-events.jsonl");
		const session = scriptedSession();
		let listener: ((event: unknown) => void) | null = null;
		const persistedFirst = new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 5_000;
			const poll = () => {
				try {
					const text = fs.readFileSync(eventsPath, "utf8");
					if (text.includes("first")) resolve();
					else if (Date.now() > deadline)
						reject(new Error("first event never persisted"));
					else setTimeout(poll, 5);
				} catch {
					if (Date.now() > deadline) reject(new Error("events file missing"));
					else setTimeout(poll, 5);
				}
			};
			setTimeout(poll, 5);
		});
		const factory: SessionFactory = async () => {
			session.subscribe = (l) => {
				listener = l;
				l({ type: "message_update", first: true });
				return () => {};
			};
			session.prompt = () =>
				persistedFirst.then(() => {
					listener?.({ type: "message_update", second: true });
				});
			return session;
		};
		const outcome = await runAgentSession(
			{ worktree: dir, prompt: "p", eventsPath, capMs: 60_000 },
			{ createSession: factory },
		);
		expect(outcome.stop).toBe("completed");
		const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	test("the wall-clock cap aborts the session; it is never prompted again", async () => {
		const dir = scratch();
		const session = scriptedSession();
		const factory: SessionFactory = async () => {
			session.prompt = (text) => {
				session.prompts.push(text);
				return new Promise<void>((resolve) => {
					// The SDK contract: abort() resolves the pending prompt.
					session.finish = resolve;
				});
			};
			return session;
		};
		const outcome = await runAgentSession(
			{
				worktree: dir,
				prompt: "p",
				eventsPath: path.join(dir, "e.jsonl"),
				capMs: 50,
			},
			{ createSession: factory },
		);
		expect(outcome.stop).toBe("aborted");
		expect(session.prompts).toHaveLength(1);
		expect(session.aborted).toBe(true);
		expect(session.disposed).toBe(true);
	});

	test("every launch is a fresh session; none is reused or re-prompted", async () => {
		const dir = scratch();
		const created: ScriptedSession[] = [];
		const factory: SessionFactory = async () => {
			const session = scriptedSession();
			created.push(session);
			setTimeout(() => session.finish(), 5);
			return session;
		};
		const request = {
			worktree: dir,
			prompt: "cycle prompt",
			eventsPath: path.join(dir, "e.jsonl"),
			capMs: 60_000,
		};
		await runAgentSession(request, { createSession: factory });
		await runAgentSession(
			{ ...request, prompt: "cycle prompt, later cycle" },
			{ createSession: factory },
		);
		expect(created).toHaveLength(2);
		for (const session of created) expect(session.prompts).toHaveLength(1);
	});
});

describe("parseAgentDefinition", () => {
	test("reads the frontmatter pins and the prompt body", () => {
		const text = [
			"---",
			"name: implementer",
			"model: glm-5.3-flash",
			"thinking: high",
			"tools: [read, edit, write, bash]",
			"---",
			"",
			"Implement one ticket's change inside its worktree.",
		].join("\n");
		const parsed = parseAgentDefinition(text);
		expect(parsed.model).toBe("glm-5.3-flash");
		expect(parsed.thinking).toBe("high");
		expect(parsed.tools).toEqual(["read", "edit", "write", "bash"]);
		expect(parsed.body).toContain("Implement one ticket's change");
		expect(parsed.body).not.toContain("model:");
	});

	test("missing optional pins come back undefined", () => {
		const parsed = parseAgentDefinition("no frontmatter here");
		expect(parsed.model).toBeUndefined();
		expect(parsed.thinking).toBeUndefined();
		expect(parsed.tools).toEqual([]);
		expect(parsed.body).toContain("no frontmatter here");
	});
});
