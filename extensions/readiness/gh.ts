/**
 * Engine tracker reads: capture the initial Issue body, authority/identity
 * metadata, labels and complete native dependencies. Semantic assessment and
 * full comment/link collection live in engine/evidence.ts (ADR 0016); there is
 * no source-template parser or planning gate here.
 *
 * The runner is injectable; tests swap `gh` for a stub on PATH (code-verify
 * standard, L2) instead of mocking code.
 */

import { spawn } from "node:child_process";
import type { BlockerRef, TicketState } from "./check.ts";

export interface ReadinessInput {
	body: string;
	labels: string[];
	nativeBlockers: BlockerRef[];
	/** Complete identity/authority metadata returned by the initial Issue read. */
	metadata?: Record<string, unknown>;
}

export type GhRunner = (
	args: string[],
	signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export function runGh(cwd: string): GhRunner {
	return (args, signal) =>
		new Promise((resolve, reject) => {
			const child = spawn("gh", args, { cwd, signal });
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
	number: number;
	title: string;
	url: string;
	author: unknown;
	state: string;
	body: string;
	labels: { name: string }[];
	blockedBy: {
		nodes: { number: number; state: string }[];
		totalCount?: number;
	};
}

function toTicketState(state: string): TicketState {
	return state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN";
}

/** Complete native edges for either the captured discussion or a live Claim gate. */
export async function nativeBlockersOf(
	issue: number,
	blockedBy: IssueView["blockedBy"],
	run: GhRunner,
): Promise<BlockerRef[]> {
	let edges = blockedBy.nodes;
	if ((blockedBy.totalCount ?? edges.length) > edges.length) {
		edges = [];
		for (let page = 1; page <= 100; page++) {
			const batch = await ghJson<{ number: number; state: string }[]>(run, [
				"api",
				`repos/{owner}/{repo}/issues/${issue}/dependencies/blocked_by?per_page=100&page=${page}`,
			]);
			if (!Array.isArray(batch))
				throw new Error("unavailable-evidence: malformed native dependencies");
			edges.push(...batch);
			if (batch.length < 100) break;
			if (page === 100)
				throw new Error(
					"source-budget-exhausted: native dependency pagination",
				);
		}
	}
	return edges.map((n) => ({
		number: n.number,
		state: toTicketState(n.state),
	}));
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
		"body,labels,blockedBy,title,url,author,state,number",
	]);
	const nativeBlockers = await nativeBlockersOf(issue, view.blockedBy, run);
	return {
		body: view.body,
		labels: view.labels.map((l) => l.name),
		nativeBlockers,
		metadata: {
			number: view.number,
			title: view.title,
			url: view.url,
			author: view.author,
			state: view.state,
		},
	};
}
