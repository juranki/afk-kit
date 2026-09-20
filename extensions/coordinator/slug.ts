/**
 * The branch/worktree slug rule (ticket afk-kit #19): kebab-case of the
 * issue title, at most 30 characters — canonical wording in
 * docs/conventions/branching-and-prs.md. Pure decision logic, L1-verified.
 */

const SLUG_BUDGET = 30;

/** `<project>` for worktree paths: the origin remote's repository name — the
 * last path segment with `.git` stripped (canonical wording in
 * docs/conventions/branching-and-prs.md). */
export function projectFor(remoteUrl: string): string {
	const clean = remoteUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	const last = clean.split(/[/:]/).filter(Boolean).pop();
	return last ?? "repo";
}

export function slugFor(title: string): string {
	const kebab = title
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "");
	if (kebab === "") return "issue";
	if (kebab.length <= SLUG_BUDGET) return kebab;
	const cut = kebab.lastIndexOf("-", SLUG_BUDGET);
	return cut === -1 ? kebab.slice(0, SLUG_BUDGET) : kebab.slice(0, cut);
}
