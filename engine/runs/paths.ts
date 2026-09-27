/**
 * The Run-state path hierarchy (ticket afk-kit #59, durable spec in #46):
 * Run evidence lives **outside** every target repository, under the XDG
 * state home, keyed by GitHub host, owner, repository, issue, and run id:
 *
 *   ${XDG_STATE_HOME:-~/.local/state}/afk/github.com/<owner>/<repo>/issues/<issue>/runs/<run-id>/
 *
 * Nothing here deletes: retention is a human decision (no automatic
 * artifact cleanup in v0).
 */

import * as os from "node:os";
import * as path from "node:path";

/** The only forge the state hierarchy keys on in v0. */
const GITHUB_HOST = "github.com";

/** The toolkit's subtree of the XDG state home. */
const AFK_STATE_DIRNAME = "afk";

/** Environment consulted for the XDG state home (testable subset). */
export type PathEnv = { XDG_STATE_HOME?: string };

/** `${XDG_STATE_HOME:-~/.local/state}/afk` — the root of all Run state. */
export function afkStateRoot(env: PathEnv = process.env): string {
	const base = env.XDG_STATE_HOME?.trim()
		? env.XDG_STATE_HOME
		: path.join(os.homedir(), ".local", "state");
	return path.join(base, AFK_STATE_DIRNAME);
}

/** `…/afk/github.com/<owner>/<repo>` — all Run state for one repository. */
export function repositoryStateRoot(
	stateRoot: string,
	owner: string,
	repo: string,
): string {
	return path.join(stateRoot, GITHUB_HOST, owner, repo);
}

/** `…/github.com/<owner>/<repo>/issues/<issue>/runs` — one ticket's runs. */
export function issueRunsDir(repositoryRoot: string, ticket: number): string {
	return path.join(repositoryRoot, "issues", String(ticket), "runs");
}

/** `…/issues/<issue>/runs/<run-id>` — one Run's durable directory. */
export function runDirectory(
	repositoryRoot: string,
	ticket: number,
	runId: string,
): string {
	return path.join(issueRunsDir(repositoryRoot, ticket), runId);
}
