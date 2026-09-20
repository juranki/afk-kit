/**
 * The agentic drift review (ADR 0013, ticket afk-kit #20): a change-gated
 * model review inside `bun run verify` that pins the shipped coordinator
 * skill to the docs it was copied from. No token list — the docs are
 * canonical, the skill is their runtime form, and when the corpus (skill +
 * workflow conventions + coordinator playbook) moves against the committed
 * hash record, a `glm-5.3-flash` reviewer judges their agreement with ADR
 * 0013 as the copy contract. A `drift` verdict — or output the strict
 * parser cannot read — fails verify loudly.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** One corpus file and its content hash (empty hash = not yet hashed). */
export interface CorpusEntry {
	path: string;
	hash: string;
}

/**
 * The review corpus (ADR 0013): the coordinator skill, the workflow
 * conventions its carried text restates, and the coordinator playbook.
 * Repo-relative, from the repository root.
 */
export const corpusFiles = [
	"docs/conventions/branching-and-prs.md",
	"docs/conventions/issue-lifecycle.md",
	"docs/conventions/review-and-escalation.md",
	"docs/playbooks/coordinator-session.md",
	"skills/coordinator/SKILL.md",
] as const;

/** The copy contract the reviewer's prompt cites (ADR 0013). */
export const contractAdr =
	"docs/adr/0013-coordinator-skill-carries-judgment-agentic-drift-review.md";

/** The committed hash record, repo-relative. */
export const recordFile = "scripts/drift-corpus.sha256";

export type DriftVerdict =
	| { verdict: "agree" }
	| { verdict: "drift"; findings: Array<{ claim: string; doc: string }> };

interface FindingShape {
	claim?: unknown;
	doc?: unknown;
}

function isFinding(value: unknown): value is { claim: string; doc: string } {
	if (typeof value !== "object" || value === null) return false;
	const { claim, doc } = value as FindingShape;
	return (
		typeof claim === "string" &&
		claim.trim().length > 0 &&
		typeof doc === "string" &&
		doc.trim().length > 0
	);
}

/**
 * Parse the reviewer's verdict: strict JSON, the whole output. `agree` never
 * carries findings; `drift` always carries at least one finding naming the
 * skill claim and the doc it conflicts with. Anything else is unparseable —
 * null, and the caller fails loudly.
 */
export function parseDriftVerdict(text: string): DriftVerdict | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.trim());
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const { verdict, findings } = parsed as {
		verdict?: unknown;
		findings?: unknown;
	};
	if (verdict === "agree") {
		if (findings !== undefined) return null;
		return { verdict: "agree" };
	}
	if (verdict === "drift") {
		if (
			!Array.isArray(findings) ||
			findings.length === 0 ||
			!findings.every(isFinding)
		) {
			return null;
		}
		return { verdict: "drift", findings };
	}
	return null;
}

/** Parse the committed record: `<sha256>  <repo-relative-path>` lines. */
export function parseRecord(text: string): CorpusEntry[] {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const hash = line.slice(0, line.indexOf("  "));
			return { hash, path: line.slice(line.indexOf("  ") + 2) };
		});
}

/** Format the record: sorted by path, `sha256sum -c`-compatible, newline-terminated. */
export function formatRecord(entries: CorpusEntry[]): string {
	const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
	return `${sorted.map((entry) => `${entry.hash}  ${entry.path}`).join("\n")}\n`;
}

/**
 * Hash the corpus. A missing corpus file fails loudly: deleting a canonical
 * doc is itself drift until the corpus list and the skill are reconciled.
 */
export function hashCorpus(repoRoot: string): CorpusEntry[] {
	return corpusFiles.map((file) => {
		let content: string;
		try {
			content = fs.readFileSync(path.join(repoRoot, file), "utf-8");
		} catch {
			throw new Error(
				`drift review: corpus file missing: ${file} — restore it or reconcile the corpus list`,
			);
		}
		return {
			path: file,
			hash: createHash("sha256").update(content).digest("hex"),
		};
	});
}

/**
 * The change-gate decision: skip only when every corpus file hashes exactly
 * as recorded; any move, addition, or removal opens the gate, naming the
 * changed paths.
 */
export function gateFor(
	computed: CorpusEntry[],
	recorded: CorpusEntry[],
): { action: "skip" } | { action: "review"; changed: string[] } {
	const recordedByPath = new Map(
		recorded.map((entry) => [entry.path, entry.hash]),
	);
	const computedByPath = new Map(
		computed.map((entry) => [entry.path, entry.hash]),
	);
	const changed: string[] = [];
	for (const [p, hash] of computedByPath) {
		if (recordedByPath.get(p) !== hash) changed.push(p);
	}
	for (const p of recordedByPath.keys()) {
		if (!computedByPath.has(p)) changed.push(p);
	}
	return changed.length === 0
		? { action: "skip" }
		: { action: "review", changed };
}

function readOrNull(repoRoot: string, file: string): string | null {
	try {
		return fs.readFileSync(path.join(repoRoot, file), "utf-8");
	} catch {
		return null;
	}
}

function buildPrompt(repoRoot: string): string {
	const contract = readOrNull(repoRoot, contractAdr);
	const sections = corpusFiles.map((file) => {
		const content =
			readOrNull(repoRoot, file) ?? "(missing from the repository)";
		return `=== Canonical doc: ${file} ===\n\n${content}`;
	});
	return [
		"You are the drift reviewer for afk-kit's coordinator skill.",
		"",
		"Contract (ADR 0013): the skill carries the workflow's judgment as its runtime form; the docs below are canonical. Wherever the skill restates doc policy — the commands, the loop's steps, the hard rules, the coordinator-side caps, the escalation procedure, the stop condition — it must agree with the docs. It may rephrase; it may not contradict, drop, or invent policy. Deliberate omissions (the maintainer's parallel-session cap, per-repo mappings, mechanics owned by extension code, model pins) are not drift. The ADR text below is the copy contract for this check.",
		"",
		`=== The copy contract: ${contractAdr} ===`,
		"",
		contract ?? "(missing from the repository)",
		"",
		"=== The skill under review: skills/coordinator/SKILL.md ===",
		"",
		readOrNull(repoRoot, "skills/coordinator/SKILL.md") ??
			"(missing from the repository)",
		"",
		...sections,
		"",
		"Compare the skill against the canonical docs. Reply with EXACTLY one JSON object and nothing else — no prose, no code fence:",
		'{"verdict":"agree"}',
		"or, for each disagreement, one finding naming the skill's claim and the doc it conflicts with:",
		'{"verdict":"drift","findings":[{"claim":"<the skill claim>","doc":"<the doc file and the policy it conflicts with>"}]}',
	].join("\n");
}

export interface DriftOutcome {
	ok: boolean;
	text: string;
}

/**
 * Run the change-gated drift review for the repository at `repoRoot`.
 * Unchanged corpus: pass without touching the model. Moved corpus: spawn the
 * drift reviewer (`pi -p --model glm-5.3-flash`, resolved via PATH), require
 * the strict JSON verdict; agree refreshes the record, drift or unparseable
 * output fails — loudly.
 */
export async function runDriftReview(repoRoot: string): Promise<DriftOutcome> {
	const computed = hashCorpus(repoRoot);
	const recordedText = readOrNull(repoRoot, recordFile);
	const recorded = recordedText === null ? [] : parseRecord(recordedText);
	const gate = gateFor(computed, recorded);
	if (gate.action === "skip") {
		return {
			ok: true,
			text: `drift review: corpus unchanged (${computed.length} files) — review skipped`,
		};
	}
	console.error(
		`drift review: corpus moved (${gate.changed.join(", ")}) — running the drift reviewer`,
	);

	const result = spawnSync(
		"pi",
		["-p", "--no-session", "--model", "glm-5.3-flash", buildPrompt(repoRoot)],
		{ encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
	);
	if (result.error) {
		return {
			ok: false,
			text: `DRIFT REVIEW FAILED: could not run the drift reviewer (pi): ${result.error.message}`,
		};
	}
	if (result.status !== 0) {
		return {
			ok: false,
			text: `DRIFT REVIEW FAILED: the drift reviewer exited ${result.status}:\n${result.stderr}`,
		};
	}

	const verdict = parseDriftVerdict(result.stdout);
	if (verdict === null) {
		return {
			ok: false,
			text: `DRIFT REVIEW FAILED: unparseable verdict — expected exactly one JSON object ({"verdict":"agree"} or {"verdict":"drift","findings":[...]}). Raw output:\n${result.stdout}`,
		};
	}
	if (verdict.verdict === "drift") {
		const findings = verdict.findings
			.map(
				(finding) =>
					`- claim: ${finding.claim}\n  conflicts with: ${finding.doc}`,
			)
			.join("\n");
		return {
			ok: false,
			text: `DRIFT REVIEW FAILED: the coordinator skill disagrees with the canonical docs (ADR 0013). Fix the wording or the docs, then re-run.\n${findings}`,
		};
	}

	fs.writeFileSync(path.join(repoRoot, recordFile), formatRecord(computed));
	return {
		ok: true,
		text: `drift review: reviewer agrees — record refreshed (${recordFile})`,
	};
}

if (import.meta.main) {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const outcome = await runDriftReview(repoRoot);
	console.log(outcome.text);
	process.exit(outcome.ok ? 0 : 1);
}
