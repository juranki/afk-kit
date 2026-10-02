#!/usr/bin/env bun
/**
 * The Engine-only CLI: `afk implement <issue-number>` drives one Ticket to
 * handoff or Escalation; `afk status [issue-number]` renders durable evidence.
 * Exits: 0 handoff/status success; 1 pre-Claim refusal (including usage);
 * 2 claimed-Run Escalation; 3 failure preventing durable Escalation.
 */

import * as os from "node:os";
import * as path from "node:path";
import { runGit } from "../extensions/coordinator/git.ts";
import { runGh } from "../extensions/readiness/gh.ts";
import { type ImplementOptions, runImplement } from "./implement.ts";
import { afkStateRoot } from "./runs/paths.ts";
import { finalizeInterruptedRun } from "./runs/reconcile.ts";
import {
	collectStatus,
	ghPrLookup,
	renderStatus,
	resolveRepository,
} from "./runs/status.ts";

const USAGE = `usage: afk <command> [args]

commands:
  implement <issue-number>  start the durable Engine Run for one Ticket
                          (a single bare positive integer)
  status [issue-number]   show Runs for this repository, or one Ticket
                          (a single bare positive integer)

Run evidence lives outside every repository, under
\${XDG_STATE_HOME:-~/.local/state}/afk/github.com/<owner>/<repo>/.
exit codes: 0 handoff/status success · 1 pre-Claim refusal · 2 escalated · 3 internal failure
`;

/** Which CLI environment a run sees; injectable for tests. */
export interface CliIo {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

/**
 * Parse `status` arguments: at most one bare positive integer. Hashes,
 * URLs, signs, ranges, zero, leading zeros, flags, and extra arguments are
 * refused — the same discipline `afk implement` is held to in #60.
 */
export function parseStatusArgs(args: string[]): { ticket?: number } | null {
	if (args.length === 0) return {};
	if (args.length > 1) return null;
	const raw = args[0] ?? "";
	if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
		return null;
	return { ticket: Number(raw) };
}

/**
 * Parse `implement` arguments: exactly one bare positive integer. Hashes,
 * URLs, signs, ranges, zero, leading zeros, flags, extra arguments, and a
 * missing argument are refused — the Engine starts exactly one Ticket, and
 * only when named unambiguously (durable spec #46, ticket #60).
 */
export function parseImplementArgs(args: string[]): { ticket: number } | null {
	if (args.length !== 1) return null;
	const raw = args[0] ?? "";
	if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
		return null;
	return { ticket: Number(raw) };
}

interface CliPorts {
	/** Typed host seams for integration tests, never CLI flags or environment overrides. */
	implement?: ImplementOptions["ports"];
}

async function implementCommand(
	args: string[],
	io: CliIo,
	ports: CliPorts,
): Promise<number> {
	const parsed = parseImplementArgs(args);
	if (parsed === null) {
		io.stderr(USAGE);
		return 1;
	}
	return runImplement({
		ticket: parsed.ticket,
		cwd: io.cwd,
		env: io.env,
		io,
		ports: ports.implement,
	});
}

async function statusCommand(args: string[], io: CliIo): Promise<number> {
	const parsed = parseStatusArgs(args);
	if (parsed === null) {
		io.stderr(USAGE);
		return 1;
	}
	let repository: { owner: string; repo: string };
	try {
		repository = await resolveRepository(io.cwd);
	} catch (error) {
		io.stderr(`afk status: ${(error as Error).message}\n`);
		return 3;
	}
	const report = await collectStatus({
		stateRoot: afkStateRoot(io.env),
		owner: repository.owner,
		repo: repository.repo,
		ticket: parsed.ticket,
		// Default lookup reads merge state via gh, best-effort; pass null to
		// stay offline. Failures degrade to "not known to be merged".
		prLookup: ghPrLookup(io.cwd),
		// A dead-lock Run's interruption is materialized here — idempotently
		// (ticket #65): the next status converges it to one Escalation.
		finalizeInterrupted: (dir) =>
			finalizeInterruptedRun(dir, {
				seams: {
					gh: runGh(io.cwd),
					git: runGit(),
					checkout: io.cwd,
					// The worktree-root convention (claim ops).
					worktreeRoot: path.join(os.homedir(), "wt"),
				},
			}),
	});
	io.stdout(`${renderStatus(report)}\n`);
	return 0;
}

export async function runCli(
	argv: string[],
	io: CliIo,
	ports: CliPorts = {},
): Promise<number> {
	const [command = "", ...args] = argv;
	switch (command) {
		case "status":
			return statusCommand(args, io);
		case "implement":
			return implementCommand(args, io, ports);
		case "help":
		case "--help":
		case "-h":
			io.stdout(USAGE);
			return 0;
		default:
			if (command) io.stderr(`afk: unknown command "${command}"\n`);
			io.stderr(USAGE);
			return 1;
	}
}

/** Entry point wired as the `afk` bin. */
export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	return runCli(argv, {
		cwd: process.cwd(),
		env: process.env,
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	});
}

// Direct execution: `bun engine/cli.ts status`
if (import.meta.main) {
	const exit = await main();
	process.exit(exit);
}
