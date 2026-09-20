# Branching and PRs

Branch, worktree, and pull-request shape for coordinator work in target repositories.
One ticket, one branch, one worktree, one pull request — a branch carries exactly one
ticket's change (ontology invariant).

## Branch

- Named `issue-<n>-<slug>`, e.g. `issue-12-jsonl-export` (matches existing practice:
  `issue-8-localstorage-fixture` in tenant-kit).
- The slug rule (canonical, implemented by the claim op): **kebab-case of the issue
  title, at most 30 characters.** Lowercase the title, replace every run of
  non-alphanumeric characters with a single hyphen, trim leading and trailing hyphens;
  if the result exceeds 30 characters, cut it at the last hyphen within that budget (a
  single word longer than 30 characters is hard-cut at 30; a title with no
  alphanumeric characters falls back to the slug `issue`). Example: the title
  "Coordinator mechanics: atomic claim + worktree + branch, push + PR (R7)" yields the
  slug `coordinator-mechanics-atomic`.
- Branched from `main`. Never stacked: a ticket blocked by another starts after that
  ticket's PR merges.

## Worktree

- Located at `~/wt/<project>/issue-<n>-<slug>`, per the worktree convention in the
  target repo's AGENTS.md (`git worktree add`).
- `<project>` derivation (canonical, implemented by the claim op): the origin remote's
  **repository name** — the last segment of `git remote get-url origin` after `/` (or
  `:`), with a trailing `.git` stripped. `git@github.com:juranki/afk-kit.git`,
  `https://github.com/juranki/afk-kit`, and a local `.../afk-kit.git` all derive
  `afk-kit`.
- The implementer subagent works inside the worktree; the branch is checked out there
  and nowhere else.
- Worktrees are preserved on escalation so partial work stays inspectable; they are
  removed only after the PR merges or the maintainer says so.

## Pull request

- Base: `main`.
- Title: imperative summary, with the issue number: `Add JSONL export (#12)`.
- Body, in order:
  1. `Closes #<n>`
  2. The brief's **Acceptance criteria** as a checklist
  3. **Touched areas** as declared in the brief
  4. **Verify commands** with their latest results
  5. Review-round notes, if any (findings and fixes, brief)
- Review requested from the maintainer when opened; the coordinator's reviewer has
  already approved it once (at least) before it is opened for the maintainer.
- Verify commands are re-run in the worktree at publish time and their results
  recorded in the body's verify-commands section; a failing command refuses the
  publish (`PUBLISH_REFUSAL`) and nothing is pushed.
- The publish and claim ops enforce this shape mechanically — one PR per branch (an
  open PR refuses a re-publish, naming it), title and body as above, and the
  compensation discipline of [issue lifecycle](issue-lifecycle.md#claim-and-publish-refusals)
  on every failed step.
- Merge method follows each target repository's habit; only the maintainer merges
  ([ADR 0002](../adr/0002-human-merge-gate.md)).
