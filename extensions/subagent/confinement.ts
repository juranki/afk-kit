/**
 * Implementer confinement (R5) — afk-kit's production form of the prototype
 * proven in prototype/r5-confinement/ (FINDINGS.md, ticket afk-kit #17).
 *
 * Confinement is a per-agent-definition property: an agent whose frontmatter
 * carries a `confinement` field spawns confined; everyone else spawns as
 * before. The implementer agent is the only confined agent in the shipped
 * roster.
 *
 * Three independent layers, composed at the spawn seam (they govern different
 * things; neither subsumes another — FINDINGS.md, mechanics question 4):
 *
 *   1. frontmatter `tools` → the existing `--tools` argv — which pi tools the
 *      child may call at all (unchanged passthrough; see background.ts);
 *   2. a PATH shim — what its processes may do: `gh` refused in full, `git
 *      push` refused, every other git verb passes through to the real binary;
 *   3. a pinned global gitconfig — what its processes can authenticate as:
 *      identity in, credential helpers out (a push that slips past the shim
 *      dies on missing credentials, GIT_TERMINAL_PROMPT=0).
 *
 * The child environment is a curated allowlist (never a denylist — denylists
 * rot with every new secret kind) plus the git pin exports. Model credentials
 * do not ride the environment: pi authenticates from its own config store
 * under HOME, which the allowlist keeps.
 *
 * Scope (decided 2026-09-19, recorded on the ticket and in FINDINGS.md):
 * accident-level. The shim stops accidents, not adversaries — absolute paths
 * and git `-c` overrides bypass it (the verified bypass chain in
 * FINDINGS.md). The reviewer and the human merge gate are the backstops for
 * adversarial behavior.
 *
 * Refusals fail closed at the child: exit 126, one stderr line beginning
 * `CONFINEMENT_REFUSAL`. Refusals are report lines, not errors — the
 * coordinator surfaces them from the structured result and never alarms.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

/** The exit code and stderr marker every refusal carries (prototype parity). */
const REFUSAL_EXIT_CODE = 126;
const REFUSAL_MARKER = "CONFINEMENT_REFUSAL";

/**
 * The curated allowlist: what a confined child keeps from the coordinator's
 * environment, frozen after discovery (FINDINGS.md, mechanics question 1).
 *
 * - PATH, HOME, TERM, LANG, TMPDIR — exec, config resolution, terminal, locale.
 * - The proxy and TLS-root variables — the child must still reach its model
 *   API through whatever egress the host requires.
 *
 * Everything else — GitHub credentials, cloud keys, NODE_OPTIONS/BASH_ENV and
 * the other runtime injection vectors — is dropped by omission. pi's own
 * startup needs nothing else: it authenticates from its config store under
 * HOME (proven by the prototype's demo run).
 */
const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"TERM",
	"LANG",
	"TMPDIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
] as const;

export interface ConfinementMaterial {
	/** Stub directory prepended to the child's PATH. */
	shimDir: string;
	/** Pinned global gitconfig handed over as GIT_CONFIG_GLOBAL. */
	gitconfigPath: string;
}

/**
 * Build the confined child environment from the parent's: allowlist in,
 * shim dir prepended to PATH, git pin exports on top.
 *
 * Pure given its inputs; the spawn seams pass `process.env` and the
 * materialized paths.
 */
export function buildConfinedEnv(
	parentEnv: NodeJS.ProcessEnv,
	material: ConfinementMaterial,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ENV_ALLOWLIST) {
		const value = parentEnv[name];
		if (value !== undefined && value !== "") env[name] = value;
	}
	const parentPath = env.PATH;
	env.PATH = parentPath
		? `${material.shimDir}:${parentPath}`
		: material.shimDir;
	env.GIT_CONFIG_GLOBAL = material.gitconfigPath;
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

// ── The git publish-verb rule (L1: shim rule evaluation, R5) ──

/**
 * Git's global options that take a separate value argument. When scanning
 * for the subcommand these must swallow their value, or `-C <repo> push`
 * would read "<repo>" as the verb and let a push through.
 */
const GIT_FLAGS_WITH_VALUE = new Set([
	"-c",
	"-C",
	"--exec-path",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
]);

/** The git verbs a confined agent may never run. */
const REFUSED_GIT_VERBS = new Set(["push"]);

/**
 * The subcommand a git argv would run: the first argument that is neither
 * `--` nor an option (global options with separate values swallow theirs).
 * Null when the argv names no subcommand.
 */
function gitVerb(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") return (args[i + 1] as string) ?? null;
		if (arg.startsWith("-")) {
			if (GIT_FLAGS_WITH_VALUE.has(arg)) i++;
			continue;
		}
		return arg;
	}
	return null;
}

/** Whether a confined child running git with these arguments must be refused. */
export function isRefusedGitCommand(args: string[]): boolean {
	const verb = gitVerb(args);
	return verb !== null && REFUSED_GIT_VERBS.has(verb);
}

// ── The shim and the pinned gitconfig, as renderable text ──

/**
 * The `gh` stub: refuse everything (no tracker writes, no PRs, no API).
 * Stderr only — stdout stays clean for any tool that pipes it.
 */
function renderGhStub(): string {
	return [
		"#!/usr/bin/env bash",
		"# R5 confinement: gh is refused in full — implementers have no GitHub",
		"# access. The coordinator publishes.",
		`echo "${REFUSAL_MARKER} gh: 'gh $*' — implementers have no GitHub access (R5). The coordinator publishes." >&2`,
		`exit ${REFUSAL_EXIT_CODE}`,
		"",
	].join("\n");
}

/**
 * The `git` wrapper: publish verbs refused, everything else exec'd through
 * to the real binary found behind this shim dir. Same rule as
 * `isRefusedGitCommand` — keep the two in sync (the subprocess matrix test
 * exercises them together).
 */
function renderGitStub(): string {
	const valueFlags = Array.from(GIT_FLAGS_WITH_VALUE)
		.map((f) => JSON.stringify(f))
		.join("|");
	return `#!/usr/bin/env bash
# R5 confinement: git wrapper. Local work passes through to the real binary
# behind this shim dir; publish verbs are refused (exit ${REFUSAL_EXIT_CODE}).
self_dir="$(cd "$(dirname "$0")" && pwd)"
verb=""
skip=0
for a in "$@"; do
	if [ "$skip" = "1" ]; then skip=0; continue; fi
	case "$a" in
		${valueFlags}) skip=1; continue ;;
		-*) continue ;;
		*) verb="$a"; break ;;
	esac
done
case "$verb" in
${Array.from(REFUSED_GIT_VERBS)
	.map(
		(verb) =>
			`\t${verb}) echo "${REFUSAL_MARKER} git: 'git ${verb}' is a publish verb (R5). Commit locally; the coordinator publishes." >&2; exit ${REFUSAL_EXIT_CODE} ;;`,
	)
	.join("\n")}
esac
IFS=: read -ra dirs <<< "$PATH"
for d in "\${dirs[@]}"; do
	[ "$d" = "$self_dir" ] && continue
	if [ -x "$d/git" ]; then exec "$d/git" "$@"; fi
done
echo "${REFUSAL_MARKER} git: no real git found behind shim" >&2
exit 127
`;
}

/**
 * The pinned global gitconfig text: identity in, credential helpers out.
 * `helper =` (empty) resets any inherited helper list; system config is
 * already out via GIT_CONFIG_NOSYSTEM. Repo-local config can still override
 * this — the known bypass chain, accepted at accident-level scope.
 */
export function renderPinnedGitconfig(identity: {
	name: string;
	email: string;
}): string {
	return [
		"# GIT_CONFIG_GLOBAL for confined agents (R5). Replaces the real global",
		"# config: identity in, credential helpers out.",
		"[user]",
		`\tname = ${identity.name}`,
		`\temail = ${identity.email}`,
		"[init]",
		"\tdefaultBranch = main",
		"[credential]",
		"\thelper =",
		"",
	].join("\n");
}

/**
 * The child's git identity: the coordinator user's global config when it
 * names one, the implementer defaults otherwise (prototype parity). Commits
 * must work out of the box; they carry the local work, and the coordinator
 * can rebase-author them at merge time if the project cares.
 */
function resolveGitIdentity(): { name: string; email: string } {
	const global = (key: string): string | null => {
		try {
			return execFileSync("git", ["config", "--global", key], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return null;
		}
	};
	return {
		name: global("user.name") || "implementer",
		email: global("user.email") || "implementer@localhost",
	};
}

/**
 * Materialize the confinement for one child into `dir`: the shim stubs and
 * the pinned gitconfig. Called once per spawn at the spawn seam — the
 * background path passes the task dir (the material lives with the task
 * record), the foreground chain path a temp dir it cleans up after.
 */
export function materializeConfinement(dir: string): ConfinementMaterial {
	const shimDir = path.join(dir, "shim.d");
	fs.mkdirSync(shimDir, { recursive: true });
	fs.writeFileSync(path.join(shimDir, "gh"), renderGhStub(), { mode: 0o755 });
	fs.writeFileSync(path.join(shimDir, "git"), renderGitStub(), { mode: 0o755 });
	const gitconfigPath = path.join(dir, "gitconfig");
	fs.writeFileSync(gitconfigPath, renderPinnedGitconfig(resolveGitIdentity()));
	return { shimDir, gitconfigPath };
}

// ── Refusal surfacing ──

function refusalLines(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.includes(REFUSAL_MARKER)) lines.push(line);
	}
	return lines;
}

/**
 * The refusal report lines from a child's stderr and, when given, its
 * message stream — in first-sighting order, deduplicated. Both streams
 * matter: a refused *subprocess* surfaces through the child's tool results
 * (not the child process's own stderr — proven by the L3 smoke), while a
 * refusal on the child's own stdout path lands in stderr. A refusal is a
 * report line, not an exception: the coordinator surfaces these from the
 * structured result and moves on (FINDINGS.md, mechanics question 3).
 */
export function extractRefusals(
	stderr: string,
	messages?: Message[],
): string[] {
	const lines = refusalLines(stderr);
	if (messages) {
		for (const msg of messages) {
			for (const part of msg.content) {
				if (part.type === "text") lines.push(...refusalLines(part.text));
			}
		}
	}
	// A confined child often narrates its refusals verbatim (markdown-quoted);
	// dedupe on the backtick-stripped line so narration never doubles a report.
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const line of lines) {
		const key = line.replaceAll("`", "");
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(line);
	}
	return unique;
}
