/**
 * The current-branch seam for head-dependent push verdicts (ticket #23):
 * one read-only `git rev-parse` in the invocation's working directory. The
 * hook spawns real git — tests swap the environment (a fixture clone), never
 * the code. A failed resolution (broken cwd, detached-adjacent oddities)
 * resolves to null: the guard stays undecided rather than guessing.
 */

import { spawn } from "node:child_process";

export function currentBranch(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		const child = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", () => resolve(null));
		child.on("close", (exitCode) => {
			const branch = stdout.trim();
			resolve(exitCode === 0 && branch ? branch : null);
		});
	});
}
