/**
 * The merge guard's decision logic (ticket afk-kit #23, ADR 0011): pure,
 * synchronous, string-level. `inspectCommand` decides whether a shell
 * invocation is merge-capable — `gh pr merge`, the pull-request merge API,
 * `git push` targeting `main` — and which pattern fired; it never spawns
 * anything, so the whole matrix is L1-provable offline. Branch-dependent
 * pushes (a bare `git push`, a bare `HEAD` refspec) are flagged by
 * `needsHead` and resolved by the caller (evaluate.ts) with real git.
 *
 * Command versus payload (#36): the gh-pr-merge check parses command
 * position structurally — the segment's own command past assignments,
 * loop keywords, and value-consuming wrappers; `xargs`'s trailing
 * command; a `sh -c` body; and `$()`/backtick spans, which the shell
 * itself executes — so composition cannot hide an invocation, while
 * merge vocabulary in payload position (a comment body, a commit
 * message, an inline script) stays data, never command. The API check
 * keeps the raw carrier rule: endpoint fragments are scanned only when
 * the segment's parsed subcommand is `gh api`/`gh graphql` or a non-`gh`
 * segment carries a network carrier (the API host, any URL).
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

/**
 * Network carriers that turn a merge-endpoint fragment into an API call:
 * gh's api/graphql subcommands, the GitHub API host, or any URL. A bare
 * fragment with no carrier (a docs grep, an echo) passes. For a segment
 * whose command is `gh`, the carrier question is answered by subcommand
 * parsing instead; this raw scan governs only non-`gh` segments.
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

/** gh global flags that take the next token as their value — needed to
 * find the subcommand slot past forms like `gh -R o/r api`. */
const GH_GLOBAL_VALUE_FLAGS = new Set([
	"-R",
	"--repo",
	"--hostname",
	"--jq",
	"--template",
]);

/** Shell keywords transparent to the command position: the word after
 * them is still the segment's command (`for x in y; do gh …`). `for` is
 * not one — its next word is the loop variable, and `in`'s is the item
 * list; both data. */
const TRANSPARENT_KEYWORDS = new Set([
	"do",
	"then",
	"else",
	"elif",
	"if",
	"while",
	"until",
]);

/** Wrappers whose only effect is to run what follows them, mapped to the
 * flags that consume the next token as their value — so `env -u X gh …`
 * and `nice -n 5 gh …` resolve to their command. Their remaining flags
 * are bare; `timeout`'s value is positional and handled in the walk. */
const WRAPPER_VALUE_FLAGS = new Map<string, Set<string>>([
	["command", new Set<string>()],
	["exec", new Set<string>(["-a"])],
	[
		"sudo",
		new Set<string>([
			"-u",
			"--user",
			"-g",
			"--group",
			"-p",
			"--prompt",
			"-C",
			"--close-from",
			"-R",
			"--chroot",
			"-T",
			"--command-timeout",
			"-D",
			"--chdir",
		]),
	],
	["doas", new Set<string>(["-u", "-C"])],
	["nohup", new Set<string>()],
	["nice", new Set<string>(["-n", "--adjustment"])],
	["time", new Set<string>(["-o", "--output", "-f", "--format"])],
	[
		"env",
		new Set<string>(["-u", "--unset", "-S", "--split-string", "-C", "--chdir"]),
	],
]);

/** timeout flags that consume the next token as their value. */
const TIMEOUT_VALUE_FLAGS = new Set(["-k", "--kill-after", "-s", "--signal"]);

/** xargs flags that consume the next token as their value; its first
 * remaining non-flag word is the command it runs. */
const XARGS_VALUE_FLAGS = new Set([
	"-n",
	"--max-args",
	"-s",
	"--max-chars",
	"-P",
	"--max-procs",
	"-I",
	"-d",
	"--delimiter",
	"-E",
	"-e",
	"-L",
	"-l",
	"-a",
	"--arg-file",
]);

/** Interpreters whose `-c` flag makes the next word command text. */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Command substitution spans in one segment's raw text: `$()` and
 * backticks — the shell executes their contents, even inside a
 * double-quoted payload, so their text is command, never data. */
const SUBSTITUTION = /\$\([^()]*\)|`[^`]*`/g;

/** Recursion cap for substitution spans, which always shrink; belt and
 * suspenders against pathological nesting. */
const MAX_SCAN_DEPTH = 4;

const SEGMENT_SPLIT = /&&|\|\||;|\||\n/;

/** Strip quoting and subshell punctuation from one whitespace token. */
function cleanToken(token: string): string {
	return token.replace(/^[({[$'"`]+/, "").replace(/[)}\]'"`;,.]+$/, "");
}

function tokens(segment: string): string[] {
	return segment
		.split(/\s+/)
		.map(cleanToken)
		.filter((word) => word.length > 0);
}

/** xargs's flags, skipped over; its first trailing non-flag is the
 * command it runs (default `echo` when none). */
function skipXargsFlags(words: string[], i: number): number {
	while (i < words.length && words[i].startsWith("-")) {
		i += XARGS_VALUE_FLAGS.has(words[i]) ? 2 : 1;
	}
	return i;
}

/** The word index after a shell interpreter's `-c` flag, or -1. */
function shellDashCBody(words: string[], i: number): number {
	while (i < words.length && /^-[A-Za-z]+$/.test(words[i])) {
		if (words[i].includes("c")) return i + 1;
		i += 1;
	}
	return -1;
}

/**
 * Every word index in one segment where a command begins in command
 * position: past `VAR=value` assignments, transparent loop keywords, and
 * wrapper commands (consuming their flag values; `timeout`'s duration is
 * its positional value). `xargs` spawns its trailing command position and
 * a `sh -c` body spawns its own, so a composition that hides a command is
 * still resolved.
 */
function commandStarts(words: string[]): number[] {
	const starts: number[] = [];
	const pending: number[] = [0];
	while (pending.length > 0) {
		let i = pending.shift() as number;
		let atCommand = false;
		while (i < words.length) {
			const word = words[i];
			if (
				/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ||
				TRANSPARENT_KEYWORDS.has(word)
			) {
				i += 1;
			} else if (word === "timeout") {
				i += 1;
				while (i < words.length && words[i].startsWith("-")) {
					i += TIMEOUT_VALUE_FLAGS.has(words[i]) ? 2 : 1;
				}
				i += 1;
			} else if (word === "command" && /^-[vV]$/.test(words[i + 1] ?? "")) {
				break; // `command -v gh …` names a command, it runs none
			} else if (WRAPPER_VALUE_FLAGS.has(word)) {
				const valueFlags = WRAPPER_VALUE_FLAGS.get(word) as Set<string>;
				i += 1;
				while (i < words.length && words[i].startsWith("-")) {
					i += valueFlags.has(words[i]) ? 2 : 1;
				}
			} else {
				atCommand = true;
				break;
			}
		}
		if (!atCommand) continue;
		starts.push(i);
		const word = words[i];
		if (word === "xargs") {
			pending.push(skipXargsFlags(words, i + 1));
		} else if (SHELL_INTERPRETERS.has(word)) {
			const body = shellDashCBody(words, i + 1);
			if (body !== -1) pending.push(body);
		}
	}
	return starts;
}

/** Walk gh's global flags (consuming flag values) from word index `i`. */
function skipGhGlobalFlags(words: string[], i: number): number {
	while (i < words.length && words[i].startsWith("-")) {
		i += GH_GLOBAL_VALUE_FLAGS.has(words[i]) ? 2 : 1;
	}
	return i;
}

/**
 * The gh subcommand of a segment whose command is `gh`: the first
 * subcommand slot after gh's global flags, one level deeper for `pr`.
 * Returns the subcommand name (e.g. "pr merge", "api", "issue") and the
 * index of its last word; null when the segment runs out before a
 * subcommand appears.
 */
function ghSubcommand(
	words: string[],
	gh: number,
): { name: string; end: number } | null {
	let i = skipGhGlobalFlags(words, gh + 1);
	const first = words[i];
	if (first === undefined) return null;
	if (first !== "pr") return { name: first, end: i };
	i = skipGhGlobalFlags(words, i + 1);
	const second = words[i];
	return second === undefined
		? { name: first, end: i - 1 }
		: { name: `${first} ${second}`, end: i };
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

/**
 * The merge-endpoint scan for one segment, governed by the raw carrier
 * rule: the fragment refuses only when the segment also carries a network
 * carrier (gh api/graphql named as words, the GitHub API host, any URL),
 * so grepping docs for these strings passes.
 */
function apiRefusal(segment: string): MergeRefusal | null {
	if (!NETWORK_CARRIER.test(segment)) return null;
	const endpoint =
		PR_MERGE_ENDPOINT.exec(segment) ?? GRAPHQL_PR_MERGE.exec(segment);
	if (endpoint) {
		return { kind: "merge-api", matched: endpoint[0] };
	}
	const branchMerge = BRANCH_MERGE_ENDPOINT.exec(segment);
	if (branchMerge && BRANCH_MERGE_BASE_MAIN.test(segment)) {
		return { kind: "merge-api", matched: branchMerge[0] };
	}
	return null;
}

/** The `$()`/backtick spans of one segment's raw text, unwrapped. */
function substitutionSpans(segment: string): string[] {
	return [...segment.matchAll(SUBSTITUTION)].map((m) =>
		m[0].startsWith("$(") ? m[0].slice(2, -1) : m[0].slice(1, -1),
	);
}

/**
 * One segment's refusal, command-position-aware: the gh-pr-merge check
 * runs at every position where a command actually begins — the segment's
 * own command, `xargs`'s trailing command, a `sh -c` body — while flag
 * payloads stay data. `$()`/backtick spans are command text and are
 * scanned recursively. The API check keeps the raw carrier rule: fired
 * for the segment's own `gh api`/`gh graphql` subcommand or any non-`gh`
 * main command, passed for a `gh` segment whose parsed subcommand is
 * neither — a comment body's URL is data. The push check stays a
 * positional walk that finds `git` anywhere in the segment.
 */
function segmentRefusal(segment: string, depth: number): MergeRefusal | null {
	const words = tokens(segment);
	const starts = commandStarts(words);
	for (const start of starts) {
		if (words[start] !== "gh") continue;
		const sub = ghSubcommand(words, start);
		if (sub === null) continue;
		if (sub.name === "pr merge") {
			return {
				kind: "gh-pr-merge",
				matched: words.slice(start, sub.end + 1).join(" "),
			};
		}
		if (sub.name === "api" || sub.name === "graphql") {
			return apiRefusal(segment);
		}
	}
	if (depth < MAX_SCAN_DEPTH) {
		for (const span of substitutionSpans(segment)) {
			const refusal = segmentRefusal(span, depth + 1);
			if (refusal) return refusal;
		}
	}
	const main = starts[0];
	if (main === undefined || words[main] !== "gh") {
		return apiRefusal(segment);
	}
	return null;
}

export function inspectCommand(
	command: string,
	head?: string | null,
): MergeRefusal | null {
	for (const segment of command.split(SEGMENT_SPLIT)) {
		const words = tokens(segment);
		const refusal = segmentRefusal(segment, 0);
		if (refusal) return refusal;
		if (pushIndex(words) !== -1) {
			const push = pushRefusal(words, head ?? null);
			if (push) return push;
		}
	}
	return null;
}
