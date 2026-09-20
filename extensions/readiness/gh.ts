/**
 * The readiness check's tracker seam (ticket afk-kit #24, ADR 0012): reads an
 * issue's brief substrate, labels, and native blocked-by dependencies through
 * `gh`, resolving the state of every ticket named in Blocked by that the
 * native dependency list does not already carry — inspection 4 ignores named
 * tickets that have since closed, so their state must be known.
 *
 * The runner is injectable; tests swap `gh` for a stub on PATH (code-verify
 * standard, L2) instead of mocking code.
 */

import { spawn } from "node:child_process";
import {
	type BlockerRef,
	checkReadiness,
	formatResult,
	type Inspection,
	namedBlockers,
	type TicketState,
} from "./check.ts";

export interface ReadinessInput {
	body: string;
	labels: string[];
	nativeBlockers: BlockerRef[];
	namedStates: Record<number, TicketState>;
}

export interface ReadinessOutcome {
	ok: boolean;
	text: string;
	inspections: Inspection[];
}

export type GhRunner = (
	args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export function runGh(cwd: string): GhRunner {
	return (args) =>
		new Promise((resolve, reject) => {
			const child = spawn("gh", args, { cwd });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", reject);
			child.on("close", (exitCode) =>
				resolve({ stdout, stderr, exitCode: exitCode ?? 1 }),
			);
		});
}

async function ghJson<T>(run: GhRunner, args: string[]): Promise<T> {
	const { stdout, stderr, exitCode } = await run(args);
	if (exitCode !== 0) {
		throw new Error(
			`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`,
		);
	}
	return JSON.parse(stdout) as T;
}

interface IssueView {
	body: string;
	labels: { name: string }[];
	blockedBy: { nodes: { number: number; state: string }[] };
}

function toTicketState(state: string): TicketState {
	return state === "CLOSED" ? "CLOSED" : "OPEN";
}

export async function fetchReadinessInput(
	issue: number,
	run: GhRunner = runGh(process.cwd()),
): Promise<ReadinessInput> {
	const view = await ghJson<IssueView>(run, [
		"issue",
		"view",
		String(issue),
		"--json",
		"body,labels,blockedBy",
	]);
	const nativeBlockers = view.blockedBy.nodes.map((n) => ({
		number: n.number,
		state: toTicketState(n.state),
	}));
	const nativeNumbers = new Set(nativeBlockers.map((b) => b.number));
	const namedStates: Record<number, TicketState> = {};
	for (const blocker of nativeBlockers)
		namedStates[blocker.number] = blocker.state;
	for (const number of namedBlockers(view.body)) {
		if (nativeNumbers.has(number)) continue;
		const state = await ghJson<{ state: string }>(run, [
			"issue",
			"view",
			String(number),
			"--json",
			"state",
		]);
		namedStates[number] = toTicketState(state.state);
	}
	return {
		body: view.body,
		labels: view.labels.map((l) => l.name),
		nativeBlockers,
		namedStates,
	};
}

/** The full check path the registered tool and any scratch driver share. */
export async function runReadinessCheck(
	issue: number,
	run: GhRunner = runGh(process.cwd()),
): Promise<ReadinessOutcome> {
	const input = await fetchReadinessInput(issue, run);
	const result = checkReadiness(input);
	return {
		ok: result.ok,
		text: formatResult(issue, result),
		inspections: result.inspections,
	};
}
