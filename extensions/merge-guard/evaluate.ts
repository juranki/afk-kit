/**
 * The hook-level evaluator (ticket #23): the pure matrix of guard.ts plus
 * the one thing strings cannot answer — the current branch, resolved with
 * real git only when a push's verdict depends on it. Since #38, that one
 * resolution runs in the command's own directory: leading `&&`-joined
 * `cd <dir>` segments move it off the session cwd, so a worktree push led
 * by `cd` is judged by the worktree's branch, not the session checkout's.
 * A resolution that fails (broken directory, unconfident chain) stays
 * undecided — refuse-only-what-you-can-name. L2 covers it against a
 * fixture clone.
 */

import * as path from "node:path";
import {
	inspectCommand,
	type MergeRefusal,
	needsHead,
	SEGMENT_SPLIT,
} from "./guard.ts";
import { currentBranch } from "./head.ts";

/**
 * One plain directory token: no shell metacharacter the string-level guard
 * cannot confidently read — no variable (`$WT`), subshell, glob, or quoting
 * around a space. `~` passes the shape check but spawn cannot use it, so it
 * resolves to failure and the undecided stance, like any unresolvable dir.
 */
const PLAIN_DIRECTORY = /^[A-Za-z0-9_./~@+,~-]+$/;

/**
 * The target of a simple `cd` segment — the word `cd`, an optional `-L` or
 * `-P`, and exactly one plain directory token — or null for anything else.
 * Runs on raw whitespace tokens: `cleanToken` would strip a leading `$` and
 * make a variable look like a directory name.
 */
function simpleCdTarget(segment: string): string | null {
	const words = segment.trim().split(/\s+/);
	if (words[0] !== "cd") return null;
	const dirIndex = words[1] === "-L" || words[1] === "-P" ? 2 : 1;
	if (words.length !== dirIndex + 1) return null;
	const dir = words[dirIndex];
	return PLAIN_DIRECTORY.test(dir) ? dir : null;
}

/**
 * The directory a head-dependent push runs in, per the conservative walk:
 * consume leading segments while each is a simple `cd` joined to the last
 * by `&&`, and resolve relative targets against the walk's progress. The
 * walk stops before any segment it cannot confidently interpret (a real
 * command, a variable target, a `cd` after `;`, `|`, or a newline — the
 * shell may not have survived those); the result is whatever the
 * confidently-interpreted prefix ended at, the session cwd if nothing was.
 */
function effectiveDirectory(command: string, sessionCwd: string): string {
	const parts = command.split(new RegExp(`(${SEGMENT_SPLIT.source})`));
	let dir = sessionCwd;
	for (let i = 0; i < parts.length; i += 2) {
		if (i > 0 && parts[i - 1] !== "&&") break;
		const target = simpleCdTarget(parts[i]);
		if (target === null) break;
		dir = path.resolve(dir, target);
	}
	return dir;
}

export async function evaluate(
	command: string,
	cwd: string,
): Promise<MergeRefusal | null> {
	const quick = inspectCommand(command);
	if (!needsHead(command)) return quick;
	const head = await currentBranch(effectiveDirectory(command, cwd));
	return inspectCommand(command, head);
}
