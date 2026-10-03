/**
 * The Engine's typed seams (ticket afk-kit #58): every narrow operation
 * reaches the outside world only through a tracker runner (`gh`), a Git
 * runner, the primary checkout, and the worktree-root convention. Tests swap
 * the environment — a local bare remote, a stub `gh` on PATH — never the
 * code (code-verify standard, L2).
 */

import type { GitRunner } from "../extensions/coordinator/git.ts";
import type { GhRunner } from "../extensions/readiness/gh.ts";

export interface EngineSeams {
	/** gh, bound to the primary checkout. */
	gh: GhRunner;
	git: GitRunner;
	/** The primary checkout the claim works against. */
	checkout: string;
	/** Root of the worktree convention: <root>/<project>/<branch>. */
	worktreeRoot: string;
	/** Prepared handoff captured before Claim; no mutable-body re-derivation. */
	preparedBrief?: string;
	preparedVerifyCommands?: readonly string[];
}

/** The pull request a shaping operation created or reconciled. */
export interface PrRef {
	number: number;
	url: string;
}
