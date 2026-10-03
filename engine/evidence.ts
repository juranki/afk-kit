/** Bounded, cached Engine-owned reads. The assessor never receives a command runner. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitRunner } from "../extensions/coordinator/git.ts";
import type { GhRunner, ReadinessInput } from "../extensions/readiness/gh.ts";
import type { CapturedSource } from "./readiness.ts";

interface CollectionOptions {
	ticket: number;
	repository: string;
	revision: string;
	cwd: string;
	input: ReadinessInput;
	gh: GhRunner;
	git: GitRunner;
	directory: string;
	maxSources?: number;
	maxBytes?: number;
	active?: () => boolean;
	signal?: AbortSignal;
}
interface EvidenceSnapshot {
	revision: string;
	repository: string;
	sources: CapturedSource[];
	repositoryFiles: string[];
	nativeDependencies: { number: number; state: string }[];
	failures: string[];
}
export interface EvidenceCollection {
	snapshot(): EvidenceSnapshot;
	read(target: string, relevance: string): Promise<CapturedSource>;
}

export async function collectEvidence(
	options: CollectionOptions,
): Promise<EvidenceCollection> {
	const { gh, git, revision, cwd, directory, input, repository, ticket } =
		options;
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const sources: CapturedSource[] = [];
	const failures: string[] = [];
	let bytes = 0;
	let receiptBytes = 0;
	const pending = new Map<string, Promise<CapturedSource>>();
	const snapshot: EvidenceSnapshot = {
		revision,
		repository,
		sources,
		repositoryFiles: [],
		nativeDependencies: input.nativeBlockers,
		failures,
	};
	const active = options.active ?? (() => true);
	const persist = () => {
		if (active())
			fs.writeFileSync(
				path.join(directory, "sources.json"),
				JSON.stringify(snapshot, null, 2),
				{ mode: 0o600 },
			);
	};
	const add = (source: CapturedSource): CapturedSource => {
		if (!active())
			throw new Error("assessment closed: captured evidence is immutable");
		if (
			sources.length >= (options.maxSources ?? 64) ||
			bytes + Buffer.byteLength(source.content) >
				(options.maxBytes ?? 2_000_000)
		)
			throw new Error("source-budget-exhausted");
		sources.push(source);
		bytes += Buffer.byteLength(source.content);
		persist();
		return source;
	};
	const json = async (endpoint: string): Promise<unknown> => {
		const r = await gh(["api", endpoint], options.signal);
		if (!active()) throw new Error("assessment closed");
		// Preserve every gathered page even when a subsequent read fails;
		// the final source snapshot remains a complete-discussion artifact.
		const receipt = JSON.stringify({
			identity: `https://api.github.com/${endpoint}`,
			...r,
		});
		receiptBytes += Buffer.byteLength(receipt);
		if (receiptBytes > (options.maxBytes ?? 2_000_000)) {
			fs.appendFileSync(
				path.join(directory, "tracker-responses.jsonl"),
				`${JSON.stringify({ identity: `https://api.github.com/${endpoint}`, captured: false, reason: "source-budget-exhausted", bytes: Buffer.byteLength(r.stdout) })}\n`,
				{ mode: 0o600 },
			);
			throw new Error("source-budget-exhausted: tracker receipts");
		}
		fs.appendFileSync(
			path.join(directory, "tracker-responses.jsonl"),
			`${receipt}\n`,
			{ mode: 0o600 },
		);
		if (r.exitCode !== 0)
			throw new Error(`unavailable-evidence: ${endpoint}: ${r.stderr}`);
		return JSON.parse(r.stdout);
	};
	const comments = async (repo: string, number: number): Promise<unknown[]> => {
		const all: unknown[] = [];
		for (let page = 1; page <= 100; page++) {
			const batch = await json(
				`repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
			);
			if (!Array.isArray(batch)) throw new Error("malformed tracker comments");
			all.push(...batch);
			if (
				Buffer.byteLength(JSON.stringify(all)) > (options.maxBytes ?? 2_000_000)
			)
				throw new Error("source-budget-exhausted: comments");
			if (batch.length < 100) return all;
		}
		throw new Error("source-budget-exhausted: comment pagination");
	};
	const knownIssue = (repo: string, number: number): boolean => {
		if (
			repo === repository &&
			input.nativeBlockers.some((b) => b.number === number)
		)
			return true;
		const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const linkedUrl = new RegExp(
			`https://github\\.com/${escapedRepo}/(?:issues|pull)/${number}(?!\\d)`,
		);
		return sources.some(
			(s) =>
				linkedUrl.test(s.content) ||
				(repo === repository &&
					new RegExp(`#${number}(?!\\d)`).test(s.content)),
		);
	};
	const read = (target: string, relevance: string): Promise<CapturedSource> => {
		if (!active()) return Promise.reject(new Error("assessment closed"));
		const cached = sources.find((s) => s.id === target);
		if (cached) return Promise.resolve(cached);
		const inFlight = pending.get(target);
		if (inFlight) return inFlight;
		const promise = (async () => {
			if (!relevance.trim()) throw new Error("a relevance reason is required");
			if (target.startsWith("repo:")) {
				const file = target.slice(5);
				if (!snapshot.repositoryFiles.includes(file))
					throw new Error(
						`unavailable-evidence: untracked repository path ${file}`,
					);
				const r = await git(
					["show", `${revision}:${file}`],
					cwd,
					options.signal,
				);
				if (r.exitCode !== 0)
					throw new Error(`unavailable-evidence: ${file}: ${r.stderr}`);
				return add({
					id: target,
					identity: `${revision}:${file}`,
					content: r.stdout,
				});
			}
			const match = /^issue:([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(target);
			if (!match || !knownIssue(match[1], Number(match[2])))
				throw new Error(
					`unavailable-evidence: unsupported or unlinked source ${target}`,
				);
			const repo = match[1],
				number = Number(match[2]);
			const issue = await json(`repos/${repo}/issues/${number}`);
			const discussion = await comments(repo, number);
			return add({
				id: target,
				identity: `https://github.com/${repo}/issues/${number}`,
				content: JSON.stringify({ issue, comments: discussion }),
			});
		})().catch((error) => {
			failures.push(error instanceof Error ? error.message : String(error));
			persist();
			throw error;
		});
		pending.set(target, promise);
		return promise;
	};
	try {
		// Every required source is persisted as soon as available, including evidence before a refusal.
		add({
			id: `issue:${repository}#${ticket}`,
			identity: `https://github.com/${repository}/issues/${ticket}`,
			content: JSON.stringify({
				...input.metadata,
				body: input.body,
				labels: input.labels,
				nativeDependencies: input.nativeBlockers,
			}),
		});
		const discussion = await comments(repository, ticket);
		add({
			id: `comments:${repository}#${ticket}`,
			identity: `https://github.com/${repository}/issues/${ticket}#discussion`,
			content: JSON.stringify(discussion),
		});
		// Native prerequisites and directly cited decision comments are bounded
		// first-hop sources, not an indiscriminate link crawl. Remaining links
		// are followed selectively by the assessor through the same cache.
		for (const blocker of input.nativeBlockers) {
			await read(
				`issue:${repository}#${blocker.number}`,
				"Native dependency context",
			);
		}
		const decisionLinks = [
			...`${input.body}\n${JSON.stringify(discussion)}`.matchAll(
				/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)#issuecomment-\d+/g,
			),
		];
		for (const link of decisionLinks) {
			await read(
				`issue:${link[1]}#${link[2]}`,
				"Explicitly cited decision comment",
			);
		}
		const files = await git(
			["ls-tree", "-r", "--name-only", revision],
			cwd,
			options.signal,
		);
		if (files.exitCode !== 0)
			throw new Error(`unavailable-evidence: repository tree: ${files.stderr}`);
		snapshot.repositoryFiles = files.stdout.trim().split("\n").filter(Boolean);
		persist();
		for (const file of snapshot.repositoryFiles.filter(
			(f) =>
				/(^|\/)AGENTS\.md$/.test(f) ||
				["package.json", "README.md", "docs/README.md"].includes(f),
		))
			await read(
				`repo:${file}`,
				"Governing instructions and verification entry points",
			);
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
		persist();
		throw error;
	}
	return { snapshot: () => structuredClone(snapshot), read };
}
