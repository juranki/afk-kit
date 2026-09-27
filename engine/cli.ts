/**
 * The `afk` CLI (ticket afk-kit #59): today `afk status [issue-number]` —
 * the read-only monitoring boundary; later tickets add `afk implement
 * <issue-number>` (#60) and the rest of the durable loop.
 *
 * Exit codes follow the durable spec's CLI contract: 0 success; 1 pre-Claim
 * refusal; 2 claimed-Run Escalated (also used for usage errors, which no
 * status path can collide with); 3 internal/configuration failure where a
 * durable Escalation could not complete.
 */

import { afkStateRoot } from "./runs/paths.ts";
import {
	collectStatus,
	ghPrLookup,
	renderStatus,
	resolveRepository,
} from "./runs/status.ts";

const USAGE = `usage: afk <command> [args]

commands:
  status [issue-number]   show Runs for this repository, or one Ticket
                          (a single bare positive integer)

Run evidence lives outside every repository, under
\${XDG_STATE_HOME:-~/.local/state}/afk/github.com/<owner>/<repo>/.
exit codes: 0 success · 1 pre-Claim refusal · 2 escalated or usage · 3 internal failure
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
	if (!/^[1-9][0-9]*$/.test(raw)) return null;
	return { ticket: Number(raw) };
}

async function statusCommand(args: string[], io: CliIo): Promise<number> {
	const parsed = parseStatusArgs(args);
	if (parsed === null) {
		io.stderr(USAGE);
		return 2;
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
	});
	io.stdout(`${renderStatus(report)}\n`);
	return 0;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
	const [command = "", ...args] = argv;
	switch (command) {
		case "status":
			return statusCommand(args, io);
		case "help":
		case "--help":
		case "-h":
			io.stdout(USAGE);
			return 0;
		default:
			if (command) io.stderr(`afk: unknown command "${command}"\n`);
			io.stderr(USAGE);
			return 2;
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
