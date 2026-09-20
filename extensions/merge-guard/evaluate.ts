/**
 * The hook-level evaluator (ticket #23): the pure matrix of guard.ts plus
 * the one thing strings cannot answer — the current branch, resolved with
 * real git only when a push's verdict depends on it. This is the function
 * the extension's tool_call handler delegates to; L2 covers it against a
 * fixture clone.
 */

import { inspectCommand, type MergeRefusal, needsHead } from "./guard.ts";
import { currentBranch } from "./head.ts";

export async function evaluate(
	command: string,
	cwd: string,
): Promise<MergeRefusal | null> {
	const quick = inspectCommand(command);
	if (!needsHead(command)) return quick;
	const head = await currentBranch(cwd);
	return inspectCommand(command, head);
}
