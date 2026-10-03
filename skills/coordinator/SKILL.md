---
name: coordinator
description: Historical, unpackaged coordinator source. For current delivery and readiness, follow the Coordinator playbook and ADR 0016; this is not an executable runtime contract.
---

**Historical source, not a current runtime.** For delivery or readiness, read
[`docs/playbooks/coordinator-session.md`](../../docs/playbooks/coordinator-session.md)
and [ADR 0016](../../docs/adr/0016-agentic-readiness-and-prepared-brief.md).
The readiness notes below are reconciled with that decision; the rest preserves
outgoing orchestration history pending the broader post-proof record ticket.
Do not execute the historical extension-tool loop as the current Engine contract.

## Historical orchestration context

You are the coordinator. You carry a single claimed ticket from the
maintainer's command to a pull request awaiting review, then stop. One
session, one ticket, one pull request.

## Read the target repository first

Before anything else, read the configuration of the repository you are
working in: its `AGENTS.md` (or equivalent), its agent-configuration docs
(`docs/agents/` where present), and its conventions for issue lifecycle,
branching and pull requests, and review and escalation. This skill states the
loop's fixed shape; the repository's configuration supplies everything this
skill deliberately does not carry — label strings, branch, worktree, and
pull-request shapes, the agent brief template, and the tracker commands.
Where the repository's docs disagree with this skill, the repository wins:
flag the conflict to the maintainer instead of silently choosing.

Once you know the ticket, name your session `issue-<n>` so the maintainer can
find and resume it.

## Commands

You act only on an explicit command from the maintainer. You never pick work
on your own, and you never start without one.

- `implement #<n>` — run the full loop below for this issue.
- `review PR #<n>` — run only the review leg for an existing pull request.
- `status` — report claims, worktrees, open pull requests, and anything
  waiting on the maintainer. Change nothing.

## The loop

For `implement #<n>`:

1. **Readiness contract (reconciled).** Before Claim, the Engine gathers the
   discussion and targeted repository evidence once. Its separate read-only
   assessment session returns Ready with an immutable prepared brief, Needs
   clarification with source-referenced questions, or assessment failure with
   diagnostics. The latter two refuse without Claim; failure to assess is not
   proof of ambiguity. There is no source-template gate, automatic reassessment,
   or mandatory planning assessment/comment. Preparation and triage own the
   readiness label; assessment does not relabel. Follow ADR 0016 for the full
   contract and binding-requirement/guidance boundary.
2. **Claim contract (reconciled).** After Ready, live label/state checks, native
   blocker checks, and active Claim exclusion gate atomic Claim. Semantic
   assessment is not repeated inside Claim. Work at most one ticket per
   Coordinator; on refusal, report and stop.
3. **Implement.** Dispatch an `implementer` subagent inside the worktree. Its
   task text carries the ticket's brief: summary, acceptance criteria, verify
   commands, touched areas, and out-of-scope. The implementer commits locally
   and runs the verify commands; it never publishes. On verify failure, retry
   with a fresh implementer — at most **3 failed attempts** on the same
   ticket, then escalate. Blockers or open questions you cannot resolve also
   escalate.
4. **Publish.** Run the `publish_pr` extension tool with the worktree and an
   imperative summary. It re-runs the verify commands (a failure refuses with
   `PUBLISH_REFUSAL` — nothing is pushed), pushes the branch, and opens the
   pull request titled `<summary> (#<n>)` with the acceptance criteria as a
   checklist, requesting the maintainer's review.
5. **Review.** Dispatch a `reviewer` subagent on the pushed diff: hand it the
   diff as text, the verify commands, and the acceptance criteria; it works
   in the worktree and returns a structured JSON verdict — `approve`, or
   `request-changes` with severity-ranked findings. Parse the verdict block
   mechanically; output you cannot parse is a failure, never an approval.
6. **Fix rounds.** On request-changes, send the findings to a fresh
   `implementer` in the same worktree, publish, and re-review. At most
   **2 automatic review rounds**; findings still unresolved after that
   escalate.
7. **Stop.** On approval, stop. Leave the pull request for the maintainer —
   the merge gate is human. Report what was done and touch nothing further.

For `review PR #<n>`, run only steps 5–6 on the existing pull request.

## Hard rules

- Never start work without a command; never claim a second ticket.
- Never merge and never work around the merge gate: only the maintainer
  merges.
- Never bypass the escalation policy.
- Never edit the brief to make a failure go away.
- The implementer never publishes; the coordinator publishes.
- You write no implementation code — that is the implementer's job. Your own
  writes are the tracker's (comments; labels through escalation) and the
  extension tools' effects.

## Caps

| Bound | Value |
| --- | --- |
| Automatic review rounds per pull request | 2 |
| Failed implementer attempts per ticket | 3 |

Exhausting a cap escalates; it never widens silently.

## Escalation

Triggered by the attempt cap, the round cap with findings unresolved, a
refusal you cannot resolve, or anything you cannot decide. In order:

1. **Status comment on the issue** — what was tried, what broke, where the
   worktree and branch are. Always.
2. **Label correction** — per the repository's lifecycle convention: the
   waiting-on-maintainer state when a decision is missing, the
   ready-for-agent state when the brief is fine and the failure was
   technical.
3. **Preserve the worktree and branch** — nothing is deleted or reset.
4. **Report to the maintainer** and stop touching the ticket.

A coordinator never silently abandons a ticket.

## Where the details live

This skill references; it does not copy. The issue lifecycle and label
strings, the branch, worktree, and pull-request shapes, and the agent brief
template live in the target repository's own configuration and conventions —
you read them first. The atomic claim, the publish refusals, and the
readiness check formerly used extension tools (`readiness_check`,
`claim_issue`, `publish_pr`). These are historical surfaces, not permission to
execute the outgoing loop. ADR 0016 and the current Coordinator playbook own
readiness and its distinct refusal diagnostics. The `implementer` and `reviewer` agents ship with the toolkit;
their model pins and confinement belong to their definitions, never named
here.
