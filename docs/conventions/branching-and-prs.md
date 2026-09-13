# Branching and PRs

Branch, worktree, and pull-request shape for coordinator work in target repositories.
One ticket, one branch, one worktree, one pull request — a branch carries exactly one
ticket's change (ontology invariant).

## Branch

- Named `issue-<n>-<slug>`, e.g. `issue-12-jsonl-export` (matches existing practice:
  `issue-8-localstorage-fixture` in tenant-kit).
- Branched from `main`. Never stacked: a ticket blocked by another starts after that
  ticket's PR merges.

## Worktree

- Located at `~/wt/<project>/issue-<n>-<slug>`, per the worktree convention in the
  target repo's AGENTS.md (`git worktree add`).
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
- Merge method follows each target repository's habit; only the maintainer merges
  ([ADR 0002](../adr/0002-human-merge-gate.md)).
