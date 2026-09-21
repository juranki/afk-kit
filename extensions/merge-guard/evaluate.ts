/**
 * The hook-level evaluator (ticket #23): the pure matrix of guard.ts plus
 * the one thing strings cannot answer — the current branch, resolved with
 * real git only when a push's verdict depends on it. Since #38, that one
 * resolution runs in the command's own directory: leading `cd <dir>`
 * segments move it off the session cwd — the first whatever operator joins
 * it to the rest (`;` and a newline preserve the change just like `&&`),
 * the rest while `&&`-joined — so a worktree push led by `cd` is judged by
 * the worktree's branch, not the session checkout's. Two stops keep the
 * undecided stance, refuse-only-what-you-can-name: a leading `cd` the walk
 * cannot read (a variable target — the push does not run where the walk
 * ended) and a resolution that fails. A `cd` after a real command is not
 * part of the walk: the session directory decides, a residue documented in
 * README.md. L2 covers it against a fixture clone.
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
 * around a space.
 */
const PLAIN_DIRECTORY = /^[A-Za-z0-9_./~@+,~-]+$/;

/**
 * How one command segment reads to the directory walk: a simple `cd` with
 * a plain target, a `cd` the walk cannot confidently read — a variable
 * (`$WT`), a subshell, quoting around a space, no target at all — or a
 * real command. Runs on raw whitespace tokens: `cleanToken` would strip a
 * leading `$` and make a variable look like a directory name. `~` passes
 * the shape check but spawn cannot use it, so it resolves to failure and
 * the undecided stance, like any unresolvable dir.
 */
type CdRead =
	| { kind: "simple"; target: string }
	| { kind: "opaque" }
	| { kind: "other" };

function readCd(segment: string): CdRead {
	const words = segment.trim().split(/\s+/);
	if (words[0] !== "cd") return { kind: "other" };
	const dirIndex = words[1] === "-L" || words[1] === "-P" ? 2 : 1;
	if (words.length !== dirIndex + 1) return { kind: "opaque" };
	const target = words[dirIndex];
	return PLAIN_DIRECTORY.test(target)
		? { kind: "simple", target }
		: { kind: "opaque" };
}

/**
 * The directory a head-dependent push runs in, per the conservative walk:
 * consume leading simple `cd` segments, resolving relative targets against
 * the walk's progress. The first segment is consumed whatever operator
 * joins it to the rest of the command (`;` preserves the change like `&&`);
 * the run continues through further simple `cd`s while `&&`-joined and
 * stops before the first segment that is not one. The stop kind decides
 * how the result may be used: stopping at a `cd` the walk cannot read means
 * the push certainly does not run where the walk ended (`cd $WT && git
 * push` runs wherever `$WT` points), so the caller must not decide there;
 * stopping at a real command means the command never had a cd-led prefix
 * and the session directory stands.
 */
function effectiveDirectory(
	command: string,
	sessionCwd: string,
): { dir: string; opaqueCd: boolean } {
	const parts = command.split(new RegExp(`(${SEGMENT_SPLIT.source})`));
	let dir = sessionCwd;
	for (let i = 0; i < parts.length; i += 2) {
		if (i > 0 && parts[i - 1] !== "&&") break;
		const read = readCd(parts[i]);
		if (read.kind === "simple") {
			dir = path.resolve(dir, read.target);
			continue;
		}
		if (read.kind === "opaque") return { dir, opaqueCd: true };
		break;
	}
	return { dir, opaqueCd: false };
}

export async function evaluate(
	command: string,
	cwd: string,
): Promise<MergeRefusal | null> {
	const quick = inspectCommand(command);
	if (!needsHead(command)) return quick;
	const walk = effectiveDirectory(command, cwd);
	if (walk.opaqueCd) return quick;
	const head = await currentBranch(walk.dir);
	return inspectCommand(command, head);
}
