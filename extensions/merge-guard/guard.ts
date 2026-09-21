/**
 * The merge guard's decision logic (ticket afk-kit #23, ADR 0011): pure,
 * synchronous, string-level. `inspectCommand` decides whether a shell
 * invocation is merge-capable — `gh pr merge`, the pull-request merge API,
 * `git push` targeting `main` — and which pattern fired; it never spawns
 * anything, so the whole matrix is L1-provable offline. Branch-dependent
 * pushes (a bare `git push`, a bare `HEAD` refspec) are flagged by
 * `needsHead` and resolved by the caller (evaluate.ts) with real git in
 * the command's own directory (#38). Redirection tokens are stripped in
 * the tokenizer (#38) so no verdict consumer ever mistakes one for a
 * refspec or repository positional.
 *
 * The strength bar is ADR 0011's, stated honestly: airtight within a loaded
 * session at accident level, not adversarially — the documented bypass is
 * editing or uninstalling the toolkit between sessions (README.md).
 */

type MergeRefusalKind = "gh-pr-merge" | "merge-api" | "push-to-main";

export interface MergeRefusal {
	kind: MergeRefusalKind;
	/** The offending fragment of the command, for the refusal text. */
	matched: string;
}

/** Any subcommand sequence `gh pr merge`, anywhere in the command line. */
const GH_PR_MERGE = /\bgh\s+pr\s+merge\b/;

/**
 * Network carriers that turn a merge-endpoint fragment into an API call:
 * gh's api/graphql subcommands, the GitHub API host, or any URL. A bare
 * fragment with no carrier (a docs grep, an echo) passes.
 */
const NETWORK_CARRIER = /\bgh\s+(?:api|graphql)\b|api\.github\.com|https?:\/\//;

/** REST path of the pull-request merge endpoint. */
const PR_MERGE_ENDPOINT =
	/repos\/[^\s'"/]+\/[^\s'"/]+\/pulls\/[^\s'"/]+\/merge\b/;

/** REST path of the branch-merge endpoint (a direct base←head merge). */
const BRANCH_MERGE_ENDPOINT = /repos\/[^\s'"/]+\/[^\s'"/]+\/merges\b/;

/** The branch-merge endpoint merges into `main` only when base names it. */
const BRANCH_MERGE_BASE_MAIN = /\bbase\s*[:=]\s*['"]?(?:refs\/heads\/)?main\b/;

/** GraphQL mutation that merges a pull request. */
const GRAPHQL_PR_MERGE = /\bmergePullRequest\b/;

/**
 * Global git flags that take the next token as their value — needed to find
 * the `push` subcommand past forms like `git -C <path> push`.
 */
const GLOBAL_VALUE_FLAGS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--exec-path",
	"--config-env",
]);

/** git-push flags that take the next token as their value. */
const PUSH_VALUE_FLAGS = new Set([
	"--receive-pack",
	"--exec",
	"--repo",
	"--push-option",
	"-o",
]);

/** One command segment: `&&`, `||`, `;`, `|`, or a newline separates them. */
export const SEGMENT_SPLIT = /&&|\|\||;|\||\n/;

/** Strip quoting and subshell punctuation from one whitespace token. */
function cleanToken(token: string): string {
	return token.replace(/^[({[$'"`]+/, "").replace(/[)}\]'"`;,.]+$/, "");
}

/**
 * Redirection with the target embedded in the same token — an optional fd
 * prefix, the operator, a non-empty target: `2>&1`, `>file`, `>>file`,
 * `2>file`, `<file`, `&>file`.
 */
const REDIRECT_EMBEDDED = /^(?:\d+|&)?(?:>>|>&|>|<)\S+$/;

/** A redirection operator alone — `>`, `>>`, `<`, `2>`, `&>` — whose target
 * is the next token (or a dup spec like `&1`). */
const REDIRECT_BARE = /^(?:\d+|&)?(?:>>|>&|>|<)$/;

/**
 * Drop redirection syntax so no consumer (pushIndex, parsePush, refspec
 * checks) ever sees it: an embedded `2>&1`-form token drops whole, a bare
 * operator drops together with the next token — the target, or an
 * operator-shaped dup spec like `&1`, which is redirection syntax either
 * way. This is string-level parse hygiene, so it shares the documented
 * over-matching residue (README): cleanToken has already stripped quoting,
 * meaning an operator-shaped token inside a quoted argument (a bare `>` in
 * a jq filter) is indistinguishable from redirection here and strips too.
 * That residue touches no verdict: verdicts judge only `git push` segments
 * and their refspecs, and removing redirection tokens never names a
 * refspec that was not already in the command.
 */
function stripRedirects(words: string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < words.length; i++) {
		if (REDIRECT_EMBEDDED.test(words[i])) continue;
		if (REDIRECT_BARE.test(words[i])) {
			i += 1;
			continue;
		}
		kept.push(words[i]);
	}
	return kept;
}

function tokens(segment: string): string[] {
	return stripRedirects(
		segment
			.split(/\s+/)
			.map(cleanToken)
			.filter((word) => word.length > 0),
	);
}

/**
 * The word index of the `push` subcommand in one command segment, or -1.
 * Finds a `git` token and walks its global flags (consuming flag values) to
 * the subcommand slot; anything else there means this segment is not a push.
 */
function pushIndex(words: string[]): number {
	for (let i = 0; i < words.length; i++) {
		if (words[i] !== "git") continue;
		let j = i + 1;
		while (j < words.length) {
			const word = words[j];
			if (!word.startsWith("-")) return word === "push" ? j : -1;
			if (GLOBAL_VALUE_FLAGS.has(word)) j += 2;
			else j += 1;
		}
	}
	return -1;
}

interface PushInvocation {
	delete: boolean;
	all: boolean;
	mirror: boolean;
	/** --repo=<r> (or --repo <r>) named the repository: every remaining
	 * positional is a refspec, none is the repository. */
	repoFromFlag: boolean;
	/** Positionals after `push`: [<repository> [<refspec>...]]. */
	positionals: string[];
}

function parsePush(words: string[], push: number): PushInvocation {
	const invocation: PushInvocation = {
		delete: false,
		all: false,
		mirror: false,
		repoFromFlag: false,
		positionals: [],
	};
	for (let i = push + 1; i < words.length; i++) {
		const word = words[i];
		if (word === "--") continue;
		if (word === "--delete" || word === "-d") invocation.delete = true;
		else if (word === "--all") invocation.all = true;
		else if (word === "--mirror") invocation.mirror = true;
		else if (word === "--repo") {
			invocation.repoFromFlag = true;
			i += 1;
		} else if (word.startsWith("--repo=")) invocation.repoFromFlag = true;
		else if (word.startsWith("-")) {
			if (PUSH_VALUE_FLAGS.has(word)) i += 1;
			continue;
		}
		if (!word.startsWith("-")) invocation.positionals.push(word);
	}
	return invocation;
}

/** Strip the refs/heads/ prefix; `main` in every spelling normalizes to it. */
function normalizeBranch(ref: string): string {
	return ref.replace(/^refs\/heads\//, "");
}

const GATE_ACT: Record<MergeRefusalKind, string> = {
	"gh-pr-merge": "merging a pull request is the maintainer's own act",
	"merge-api": "the merge API is the maintainer's own act",
	"push-to-main": "pushing to main is the maintainer's own act",
};

/**
 * The refusal text returned to the session: the marker first (scannable,
 * like CONFINEMENT_REFUSAL), the matched fragment, the gate and its ADRs,
 * and the escalation convention's stop-and-report — a refusal routes back
 * to the maintainer, it never invites a retry (ADR 0011).
 */
export function refusalText(refusal: MergeRefusal): string {
	return [
		`MERGE_GATE_REFUSAL ${refusal.kind}: '${refusal.matched}'`,
		`the merge gate is maintainer-only (ADR 0002, ADR 0011): ${GATE_ACT[refusal.kind]},`,
		"and no agent session merges or pushes to main — outside maintainer action means the human's own hand outside any session.",
		"Stop and report per the escalation convention: status comment on the ticket, preserve the worktree and branch, report to the maintainer, stop.",
		"Do not retry or route around.",
	].join(" — ");
}

const REFSPEC = /^(?<force>[+]?)(?<src>[^:]*)(?::(?<dst>.*))?$/;

/**
 * Whether one refspec lands on `main` at the remote — as destination, as a
 * bare source (same-named destination), or as a heads glob that carries it.
 */
function refspecTargetsMain(refspec: string): string | null {
	const match = REFSPEC.exec(refspec);
	if (!match?.groups) return null;
	const { src, dst } = match.groups;
	if (dst !== undefined) {
		if (dst === "refs/heads/*") return refspec;
		if (normalizeBranch(dst) === "main") return refspec;
		return null;
	}
	if (normalizeBranch(src) === "main") return refspec;
	return null;
}

/**
 * True when the command contains a `git push` whose verdict depends on the
 * current branch, which the caller must resolve with git: a bare push (with
 * or without an explicit repository) or a bare `HEAD` refspec.
 */
export function needsHead(command: string): boolean {
	for (const segment of command.split(SEGMENT_SPLIT)) {
		const words = tokens(segment);
		const push = pushIndex(words);
		if (push === -1) continue;
		const invocation = parsePush(words, push);
		if (invocation.all || invocation.mirror) continue;
		if (invocation.positionals.length === 0) return true;
		if (invocation.positionals.length === 1) return true;
		return invocation.positionals
			.slice(1)
			.some((refspec) => /^(?:refs\/heads\/)?HEAD$/.test(refspec));
	}
	return false;
}

function pushRefusal(
	words: string[],
	head: string | null,
): MergeRefusal | null {
	const push = pushIndex(words);
	if (push === -1) return null;
	const invocation = parsePush(words, push);
	if (invocation.all || invocation.mirror) {
		return {
			kind: "push-to-main",
			matched: invocation.mirror ? "--mirror" : "--all",
		};
	}
	const refspecs = invocation.repoFromFlag
		? invocation.positionals
		: invocation.positionals.slice(1);
	if (!invocation.repoFromFlag) {
		if (invocation.positionals.length === 0 && head === "main") {
			return {
				kind: "push-to-main",
				matched: "git push (current branch main)",
			};
		}
		if (invocation.positionals.length === 1 && head === "main") {
			return {
				kind: "push-to-main",
				matched: `git push ${invocation.positionals[0]} (current branch main)`,
			};
		}
	}
	if (head === "main") {
		const headRefspec = refspecs.find((refspec) =>
			/^(?:refs\/heads\/)?HEAD$/.test(refspec),
		);
		if (headRefspec) {
			return { kind: "push-to-main", matched: headRefspec };
		}
	}
	for (const refspec of refspecs) {
		if (invocation.delete) {
			if (normalizeBranch(refspec.replace(/^[+:]/, "")) === "main") {
				return { kind: "push-to-main", matched: refspec };
			}
			continue;
		}
		const targeted = refspecTargetsMain(refspec);
		if (targeted) return { kind: "push-to-main", matched: targeted };
	}
	return null;
}

export function inspectCommand(
	command: string,
	head?: string | null,
): MergeRefusal | null {
	const prMerge = GH_PR_MERGE.exec(command);
	if (prMerge) {
		return { kind: "gh-pr-merge", matched: prMerge[0] };
	}
	if (NETWORK_CARRIER.test(command)) {
		const endpoint =
			PR_MERGE_ENDPOINT.exec(command) ?? GRAPHQL_PR_MERGE.exec(command);
		if (endpoint) {
			return { kind: "merge-api", matched: endpoint[0] };
		}
		const branchMerge = BRANCH_MERGE_ENDPOINT.exec(command);
		if (branchMerge && BRANCH_MERGE_BASE_MAIN.test(command)) {
			return { kind: "merge-api", matched: branchMerge[0] };
		}
	}
	for (const segment of command.split(SEGMENT_SPLIT)) {
		const words = tokens(segment);
		if (pushIndex(words) !== -1) {
			const refusal = pushRefusal(words, head ?? null);
			if (refusal) return refusal;
		}
	}
	return null;
}
