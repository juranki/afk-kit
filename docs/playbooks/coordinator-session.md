# Coordinator session

One session per issue ([ADR 0001](../adr/0001-per-issue-coordinators.md)). A
coordinator carries a single claimed ticket from the maintainer's command to a pull
request awaiting review, then stops. The maintainer runs up to three coordinator
sessions in parallel — the cap is how many sessions they open; nothing enforces it.

## Commands

A coordinator acts only on explicit commands ([ADR 0001](../adr/0001-per-issue-coordinators.md));
it never picks work on its own:

- `implement #<n>` — run the full loop below for this issue.
- `review PR #<n>` — run only the review leg for an existing pull request.
- `status` — report claims, worktrees, open pull requests, and anything waiting on the
  maintainer.

## The loop

For `implement #<n>`:

1. **Check readiness** — the issue carries `ready-for-agent`, has a complete brief, and
   no open blockers. Refuse and report if not.
2. **Claim** — assign the issue and apply `in-progress` (the claim, per
   [issue lifecycle](../conventions/issue-lifecycle.md)).
3. **Worktree and branch** — create them per
   [branching and PRs](../conventions/branching-and-prs.md).
4. **Implement** — delegate to an `implementer` subagent (`glm-5.3-flash`) inside the
   worktree: local commits only, no publishing. Verify commands must pass.
5. **Push and open the pull request** — with the brief's acceptance criteria as a
   checklist; request the maintainer's review.
6. **Review** — delegate to a `reviewer` subagent (`glm-5.3`) on the pushed diff.
7. **Fix rounds** — on request-changes, send findings to a fresh implementer in the
   same worktree; at most two automatic rounds
   ([review and escalation](../conventions/review-and-escalation.md)).
8. **Stop** — on approval, stop and leave the pull request for the maintainer, who
   merges at the merge gate. On failure or exhaustion, escalate per the same
   conventions.

## Hard rules

- Never starts work without a command; never claims a second ticket.
- Never merges; never bypasses the escalation policy; never edits the brief to make a
  failure go away.
- The implementer never publishes; the coordinator publishes.
- The coordinator itself writes no implementation code — that is the implementer's job.

## Failure

Any repeated failure, exhausted round, or undecided blocker goes through
[review and escalation](../conventions/review-and-escalation.md): status comment, label
correction, worktree preserved, maintainer informed. A coordinator never silently
abandons a ticket.
