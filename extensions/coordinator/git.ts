/**
 * The git seam for the coordinator ops (ticket afk-kit #19): every op call
 * spawns the real `git` with an explicit working directory — the checkout
 * for claims, the worktree for publishes. The runner is injectable only in
 * signature (cwd is an argument); tests swap the environment — a bare
 * remote, a fixture clone — never the code (code-verify standard, L2).
 */

import { spawn } from "node:child_process";

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export function runGit(): GitRunner {
	return (args, cwd) =>
		new Promise((resolve) => {
			const child = spawn("git", args, { cwd });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", (error) =>
				resolve({ stdout, stderr: String(error), exitCode: 127 }),
			);
			child.on("close", (exitCode) =>
				resolve({ stdout, stderr, exitCode: exitCode ?? 1 }),
			);
		});
}
