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
 * Command versus payload (#36): the gh-pr-merge check parses command
 * position structurally — the segment's own command past assignments,
 * loop keywords, and value-consuming wrappers; `xargs`'s trailing
 * command; a `sh -c` body; and `$()`/backtick spans, which the shell
 * itself executes — so composition cannot hide an invocation, while
 * merge vocabulary in payload position (a comment body, a commit
 * message, an inline script) stays data, never command. The flag walks
 * fail closed on the unknown (#36): `skipFlags` consumes a value only
 * for tabled value flags and marks any unrecognized flag ambiguous, and
 * an ambiguous segment additionally gets the raw fragment scan confined
 * to it — a flag-decorated merge subcommand, merge endpoint, or push to
 * `main` refuses even when the parse resolved to nothing, at the
 * documented cost of false-refusing merge vocabulary quoted in the same
 * ambiguous segment (README.md). The API check keeps the raw carrier
 * rule: endpoint fragments are scanned only when the segment's parsed
 * subcommand is `gh api`/`gh graphql` (or its ambiguous-zone evidence
 * finds those subcommand words) or a non-`gh` segment carries a network
 * carrier (the API host, any URL).
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

/** One command segment: `&&`, `||`, `;`, `|`, or a newline separates them. */
export const SEGMENT_SPLIT = /&&|\|\||;|\||\n/;

/** Strip quoting and subshell punctuation from one whitespace token. */
function cleanToken(token: string): string {
	return token.replace(/^[({[$'"`]+/, "").replace(/[)}\]'"`;,.]+$/, "");
}

/**
 * Redirection with the target embedded in the same token — an optional fd
 * prefix, the operator, a non-empty target: `2>&1`, `>file`, `>>file`,
 * `2>file`, `<file`, `&>file`. The `(?![<>&])` keeps the operator maximal:
 * without it a bare `>>`/`2>>` (target in the next token) backtracks into
 * operator `>` plus a bogus `>` target, drops alone, and its real target
 * leaks through stripRedirects as a positional (#38 review).
 */
const REDIRECT_EMBEDDED = /^(?:\d+|&)?(?:>>|>&|>|<)(?![<>&])\S+$/;

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
 * Walk flags from word index `i`, consuming the next token for flags in
 * `valueFlags`. A flag outside the table is walked past but marks the
 * walk `ambiguous`: the guard cannot know whether it consumes a value,
 * so the position this walk resolves is untrusted and its callers must
 * fail closed (the ambiguity fallbacks in `segmentRefusal` and
 * `inspectCommand`).
 */
function skipFlags(
	words: string[],
	i: number,
	valueFlags: Set<string>,
): { index: number; ambiguous: boolean } {
	let ambiguous = false;
	while (i < words.length && words[i].startsWith("-")) {
		if (valueFlags.has(words[i])) {
			i += 2;
		} else {
			ambiguous = true;
			i += 1;
		}
	}
	return { index: i, ambiguous };
}

/** xargs's flags, skipped over; its first trailing non-flag is the
 * command it runs (default `echo` when none). xargs spawns a separate
 * command position, so its own flag ambiguity is not propagated. */
function skipXargsFlags(words: string[], i: number): number {
	return skipFlags(words, i, XARGS_VALUE_FLAGS).index;
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
 * still resolved. A wrapper or timeout flag walk that met an unrecognized
 * flag marks the resolved command positions `ambiguous` — an unknown flag
 * may have swallowed the real command.
 */
function commandStarts(words: string[]): {
	starts: number[];
	ambiguous: boolean;
} {
	const starts: number[] = [];
	const pending: number[] = [0];
	let ambiguous = false;
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
				const flags = skipFlags(words, i, TIMEOUT_VALUE_FLAGS);
				if (flags.ambiguous) ambiguous = true;
				i = flags.index + 1;
			} else if (word === "command" && /^-[vV]$/.test(words[i + 1] ?? "")) {
				break; // `command -v gh …` names a command, it runs none
			} else if (WRAPPER_VALUE_FLAGS.has(word)) {
				const valueFlags = WRAPPER_VALUE_FLAGS.get(word) as Set<string>;
				i += 1;
				const flags = skipFlags(words, i, valueFlags);
				if (flags.ambiguous) ambiguous = true;
				i = flags.index;
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
	return { starts, ambiguous };
}

/** Walk gh's global flags (consuming flag values) from word index `i`. */
function skipGhGlobalFlags(
	words: string[],
	i: number,
): { index: number; ambiguous: boolean } {
	return skipFlags(words, i, GH_GLOBAL_VALUE_FLAGS);
}

/**
 * The gh subcommand of a segment whose command is `gh`: the first
 * subcommand slot after gh's global flags, one level deeper for `pr`.
 * Returns the subcommand name (e.g. "pr merge", "api", "issue"), the
 * index of its last word, and whether either global-flag walk met an
 * unrecognized flag — an unknown flag may consume a value, so the
 * resolved slot is untrusted; null when the segment runs out before a
 * subcommand appears.
 */
function ghSubcommand(
	words: string[],
	gh: number,
): { name: string; end: number; ambiguous: boolean } | null {
	const first = skipGhGlobalFlags(words, gh + 1);
	const name1 = words[first.index];
	if (name1 === undefined) return null;
	if (name1 !== "pr") {
		return { name: name1, end: first.index, ambiguous: first.ambiguous };
	}
	const second = skipGhGlobalFlags(words, first.index + 1);
	const name2 = words[second.index];
	const ambiguous = first.ambiguous || second.ambiguous;
	return name2 === undefined
		? { name: name1, end: second.index - 1, ambiguous }
		: { name: `${name1} ${name2}`, end: second.index, ambiguous };
}

/**
 * The word index of the `push` subcommand in one command segment, or -1.
 * Finds a `git` token and walks its global flags (consuming flag values) to
 * the subcommand slot; anything else there means this segment is not a push.
 * `ambiguous` reports an unrecognized flag on the resolving walk: the flag
 * may have swallowed the real subcommand or shifted the slot, so a `-1`
 * cannot be trusted as "no push", and a found slot may not be the whole
 * story.
 */
function pushIndex(words: string[]): { index: number; ambiguous: boolean } {
	for (let i = 0; i < words.length; i++) {
		if (words[i] !== "git") continue;
		const walk = skipFlags(words, i + 1, GLOBAL_VALUE_FLAGS);
		const slot = words[walk.index];
		if (slot === undefined) continue;
		return slot === "push"
			? { index: walk.index, ambiguous: walk.ambiguous }
			: { index: -1, ambiguous: walk.ambiguous };
	}
	return { index: -1, ambiguous: false };
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
 * or without an explicit repository), a bare `HEAD` refspec, or an
 * ambiguous git push — unrecognized flags in the walk — with no explicit
 * main evidence, whose real subcommand cannot be parsed at all.
 */
export function needsHead(command: string): boolean {
	for (const segment of command.split(SEGMENT_SPLIT)) {
		const words = tokens(segment);
		const push = pushIndex(words);
		if (push.ambiguous) {
			const token = pushToken(words);
			if (token !== null && !pushMainEvidence(words, token)) return true;
			continue;
		}
		if (push.index === -1) continue;
		const invocation = parsePush(words, push.index);
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
	push: number,
): MergeRefusal | null {
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
 * The merge-endpoint patterns over one segment's raw text, without the
 * carrier gate — shared by `apiRefusal` and the ambiguity fallback (whose
 * gh-plus-api/graphql token evidence has already established the call).
 */
function apiEndpointRefusal(segment: string): MergeRefusal | null {
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

/**
 * The merge-endpoint scan for one segment, governed by the raw carrier
 * rule: the fragment refuses only when the segment also carries a network
 * carrier (gh api/graphql named as words, the GitHub API host, any URL),
 * so grepping docs for these strings passes.
 */
function apiRefusal(segment: string): MergeRefusal | null {
	if (!NETWORK_CARRIER.test(segment)) return null;
	return apiEndpointRefusal(segment);
}

/** Loose gh-pr-merge evidence in an ambiguous segment: `gh`, then `pr`,
 * then `merge` — in that order, not necessarily adjacent. */
function mergeEvidence(words: string[]): boolean {
	let gh = false;
	let pr = false;
	for (const word of words) {
		if (word === "gh") gh = true;
		else if (gh && word === "pr") pr = true;
		else if (pr && word === "merge") return true;
	}
	return false;
}

/** Loose api evidence in an ambiguous segment: `gh` plus an `api` or
 * `graphql` word — the parsed subcommand slot cannot be trusted, so the
 * segment may be a gh API call. */
function apiEvidence(words: string[]): boolean {
	let gh = false;
	for (const word of words) {
		if (word === "gh") gh = true;
		else if (gh && (word === "api" || word === "graphql")) return true;
	}
	return false;
}

/** The `push` token following a `git` token, for the ambiguity fallback's
 * loose push evidence, or null. */
function pushToken(words: string[]): number | null {
	let git = false;
	for (let i = 0; i < words.length; i++) {
		if (words[i] === "git") git = true;
		else if (git && words[i] === "push") return i;
	}
	return null;
}

/** Loose push-to-main evidence after a `push` token: `--all`/`--mirror`,
 * or any non-flag token whose refspec normalizes to `main`. */
function pushMainEvidence(words: string[], push: number): boolean {
	for (let i = push + 1; i < words.length; i++) {
		const word = words[i];
		if (word === "--all" || word === "--mirror") return true;
		if (!word.startsWith("-") && refspecTargetsMain(word) !== null) return true;
	}
	return false;
}

/** The ambiguity-zone push fallback for one segment: with `git` and
 * `push` tokens present, refuse on `--all`/`--mirror` or a main evidence
 * token; without main evidence the resolved current branch decides, and
 * a failed resolution stays a pass — the guard refuses only what it can
 * name. */
function ambiguousPushRefusal(
	words: string[],
	head: string | null,
): MergeRefusal | null {
	const push = pushToken(words);
	if (push === null) return null;
	if (pushMainEvidence(words, push) || head === "main") {
		return {
			kind: "push-to-main",
			matched: "git push behind unrecognized flags",
		};
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
 * positional walk that finds `git` anywhere in the segment. Fail closed
 * on the unknown (#36): a flag walk that met an unrecognized flag marks
 * the segment's resolution ambiguous, and an ambiguous segment
 * additionally gets the raw fragment scan confined to it — merge
 * evidence (gh, then pr, then merge) refuses, and gh api/graphql
 * evidence runs the endpoint patterns.
 */
function segmentRefusal(segment: string, depth: number): MergeRefusal | null {
	const words = tokens(segment);
	const resolution = commandStarts(words);
	let ambiguous = resolution.ambiguous;
	for (const start of resolution.starts) {
		if (words[start] !== "gh") continue;
		const sub = ghSubcommand(words, start);
		if (sub === null) continue;
		if (sub.ambiguous) ambiguous = true;
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
	if (ambiguous) {
		if (mergeEvidence(words)) {
			return {
				kind: "gh-pr-merge",
				matched: "pr merge behind unrecognized flags",
			};
		}
		if (apiEvidence(words)) {
			const api = apiEndpointRefusal(segment);
			if (api) return api;
		}
	}
	if (depth < MAX_SCAN_DEPTH) {
		for (const span of substitutionSpans(segment)) {
			const refusal = segmentRefusal(span, depth + 1);
			if (refusal) return refusal;
		}
	}
	const main = resolution.starts[0];
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
		const push = pushIndex(words);
		if (push.index !== -1) {
			const refused = pushRefusal(words, head ?? null, push.index);
			if (refused) return refused;
		}
		if (push.ambiguous) {
			const fallback = ambiguousPushRefusal(words, head ?? null);
			if (fallback) return fallback;
		}
	}
	return null;
}
