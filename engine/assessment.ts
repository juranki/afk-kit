/** One read-only assessment, no implementation cycle, no reassessment (ADR 0016). */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ModelRuntime,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GitRunner } from "../extensions/coordinator/git.ts";
import type { GhRunner, ReadinessInput } from "../extensions/readiness/gh.ts";
import {
	createAssessmentSessionFactory,
	runAgentSession,
	type SessionFactory,
} from "./agent-runner.ts";
import { createInterruption } from "./drive.ts";
import { collectEvidence, type EvidenceCollection } from "./evidence.ts";
import {
	type Assessment,
	parseAssessment,
	renderPreparedBrief,
} from "./readiness.ts";

export const ASSESSMENT_CAP_MS = 15 * 60 * 1000;
interface AssessmentOptions {
	ticket: number;
	repository: string;
	revision: string;
	cwd: string;
	input: ReadinessInput;
	gh: GhRunner;
	git: GitRunner;
	directory: string;
	capMs?: number;
	sessionFactory?: SessionFactory;
	modelRuntime?: ModelRuntime;
}

function evidenceTool(evidence: EvidenceCollection): ToolDefinition {
	return {
		name: "read_evidence",
		label: "Read captured evidence",
		description:
			"Read relevant tracked repository files (repo:path) or linked GitHub Issues (issue:owner/repo#number, including full comments). Reads are cached, bounded, and captured once. No commands or mutations. Explain relevance.",
		parameters: Type.Object({
			target: Type.String(),
			relevance: Type.String(),
		}),
		async execute(_id, params) {
			const { target, relevance } = params as {
				target: string;
				relevance: string;
			};
			const source = await evidence.read(target, relevance);
			return {
				content: [{ type: "text", text: JSON.stringify(source) }],
				details: source,
			};
		},
	};
}

const OUTPUT_CONTRACT = `Return one JSON object, optionally fenced:
{"status":"ready","brief":{
 "intent":{"text":"outcome","refs":["captured source ID"]},
 "scope":[{"text":"bound","refs":["source ID"]}],
 "exclusions":[{"text":"non-goal","refs":["source ID"]}],
 "acceptanceCriteria":[{"text":"verifiable consequence","refs":["source ID"]}],
 "constraints":[],
 "verifyCommands":[{"command":"concrete shell command on one line","verifies":"what this proves","refs":["source ID"]}],
 "dependencies":[{"number":123,"refs":["source ID"]}],
 "decisions":[{"text":"settled decision","refs":["source ID"]}],
 "repositoryContext":["relevant files/interfaces/patterns/tests"],
 "guidance":["non-binding suggestions"],"assumptions":["assumptions to validate"]}}
All binding statement lists use {text,refs}. Empty lists are allowed only for constraints, dependencies, decisions, repositoryContext, guidance and assumptions. Dependencies list only native blocked-by prerequisites, not issues this work blocks or merely references.
Or {"status":"needs-clarification","questions":[{"text":"specific unresolved human question or discrepancy","refs":["source ID"]}]}
Or {"status":"assessment-failure","reason":"unavailable evidence or inability to assess"}.
References MUST use captured source IDs, never uncaptured URLs. The repository file inventory is navigation only: a repo:path reference is valid only when the source is already captured or read_evidence has returned it, not merely because the path exists or is mentioned. Use only the fields in this contract, with no additional keys. Guidance is not binding.
repositoryContext, guidance and assumptions are arrays of strings only, never {text,refs} objects. Put provenance on binding statements and commands as shown; keep non-binding context in plain strings.`;

export async function assessReadiness(
	options: AssessmentOptions,
): Promise<Assessment> {
	const capMs = Math.min(options.capMs ?? ASSESSMENT_CAP_MS, ASSESSMENT_CAP_MS);
	fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(
			path.join(options.directory, "assessment-started.json"),
			JSON.stringify({
				ticket: options.ticket,
				repository: options.repository,
				revision: options.revision,
			}),
			{ mode: 0o600, flag: "wx" },
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			return {
				status: "assessment-failure",
				reason:
					"assessment already started for this Run; no reassessment or source replacement",
			};
		throw error;
	}
	const interruption = createInterruption();
	const readAbort = new AbortController();
	let expired = false;
	let finished = false;
	let evidence: EvidenceCollection | undefined;
	let raw = "";
	let cancelTimer: ReturnType<typeof setTimeout> | undefined;
	let cancelInterrupt: (() => void) | undefined;
	const onSignal = () => interruption.request("assessment interrupted");
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	const execute = async (): Promise<Assessment> => {
		if (capMs <= 0)
			throw new Error("assessment-budget-exhausted: Run deadline reached");
		evidence = await collectEvidence({
			...options,
			directory: options.directory,
			active: () => !expired && !finished,
			signal: readAbort.signal,
		});
		if (expired) throw new Error("assessment-timeout");
		const tool = evidenceTool(evidence);
		const factory =
			options.sessionFactory ??
			createAssessmentSessionFactory({
				readEvidence: tool,
				modelRuntime: options.modelRuntime,
			});
		const guardedFactory: SessionFactory = async (request) => {
			const session = await factory(request);
			if (expired) {
				void session.abort();
				void session.dispose();
				throw new Error("assessment-timeout during session creation");
			}
			return session;
		};
		const out = await runAgentSession(
			{
				worktree: options.cwd,
				eventsPath: path.join(options.directory, "session-events.jsonl"),
				capMs,
				prompt: [
					"Assess this captured discussion once. Selectively gather relevant evidence using read_evidence, then produce the prepared brief or refusal.",
					JSON.stringify(evidence.snapshot()),
					OUTPUT_CONTRACT,
					"Keep the handoff concise while complete. Your task is complete only when your final message contains the complete structured JSON assessment; a prose readiness conclusion is not a handoff.",
				].join("\n\n"),
			},
			{ createSession: guardedFactory, interruption },
		);
		raw = out.resultText;
		if (out.stop !== "completed" || interruption.reason())
			throw new Error("assessment-timeout/runtime: session aborted");
		const captured = evidence.snapshot();
		if (captured.failures.length)
			return {
				status: "assessment-failure",
				reason: captured.failures.join("; "),
			};
		return parseAssessment(
			raw,
			captured.sources,
			options.input.nativeBlockers.map((b) => b.number),
		);
	};
	let assessment: Assessment;
	try {
		assessment = await Promise.race([
			execute(),
			new Promise<never>((_, reject) => {
				cancelInterrupt = interruption.onRequest((reason) => {
					expired = true;
					reject(new Error(reason));
				});
			}),
			new Promise<never>((_, reject) => {
				cancelTimer = setTimeout(
					() => {
						expired = true;
						interruption.request("assessment-timeout");
						reject(
							new Error(
								"assessment-timeout: read-only assessment deadline exhausted",
							),
						);
					},
					Math.max(0, capMs),
				);
			}),
		]);
	} catch (error) {
		assessment = {
			status: "assessment-failure",
			reason: error instanceof Error ? error.message : String(error),
		};
	} finally {
		finished = true;
		readAbort.abort();
		if (cancelTimer) clearTimeout(cancelTimer);
		cancelInterrupt?.();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
	fs.writeFileSync(
		path.join(options.directory, "assessment.json"),
		JSON.stringify({ raw, assessment }, null, 2),
		{ mode: 0o600, flag: "wx" },
	);
	if (assessment.status === "ready" && evidence) {
		const brief = renderPreparedBrief(
			assessment.brief,
			evidence.snapshot().sources,
			options.revision,
		);
		fs.writeFileSync(path.join(options.directory, "prepared-brief.md"), brief, {
			mode: 0o600,
			flag: "wx",
		});
		fs.writeFileSync(
			path.join(options.directory, "prepared-brief.json"),
			JSON.stringify(
				{
					brief: assessment.brief,
					hash: createHash("sha256").update(brief).digest("hex"),
				},
				null,
				2,
			),
			{ mode: 0o600, flag: "wx" },
		);
	}
	return assessment;
}
