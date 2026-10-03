# Issue lifecycle

Canonical state and label policy for target repositories. The triage states come from
Matt Pocock's `triage` skill; the workflow states are afk-kit's addition. Label strings
below assume GitHub; per-repo mappings live in each repo (tenant-kit:
`docs/agents/triage-labels.md`).

## States and labels

| State | Label | Set by | Meaning |
| --- | --- | --- | --- |
| Needs triage | `needs-triage` | triage | Maintainer must evaluate. |
| Needs info | `needs-info` | triage, coordinator (escalation) | Waiting on a maintainer decision. |
| Ready for agent | `ready-for-agent` | preparation, triage | Judgment that intent is specified for unattended work and dependencies understood; not guaranteed `afk` acceptance (see the [brief standard](../brief-template.md)). |
| Ready for human | `ready-for-human` | planning session | A human must implement it. |
| Won't fix | `wontfix` | maintainer | Will not be actioned. |
| In progress | `in-progress` | coordinator (claim) | Claimed and being implemented. |
| In review | `in-review` | coordinator (PR opened) | Pull request open; review loop or human review under way. |

## Target repository setup

Repos must create every label they use. Matt Pocock / Wayfinder setup provisions
triage labels, but does not provision AFK's `in-progress` and `in-review` workflow
labels. AFK also applies `needs-info` during Escalation; ensure it exists even if
triage setup was run previously.

Inspect the target repository's labels with `gh label list` (or `gh label list
--limit 1000` for a large label set). From that repository's checkout, run only the
commands for labels that are missing:

```bash
gh label create "in-progress"
gh label create "in-review"
gh label create "needs-info"
```

Implementation preflight reads the repository's complete label list and refuses
before semantic Readiness or Claim if any of these three labels are missing. It
reports all missing names together with setup commands. It never creates or alters
repository labels, and existing labels do not replace the Issue's triage-state or
live Claim checks.

## Transitions

```text
needs-triage ──triage──▶ needs-info | ready-for-agent | ready-for-human | wontfix
needs-info   ──maintainer replies──▶ needs-triage
ready-for-agent ──claim (assign + in-progress)──▶ in-progress
in-progress  ──PR opened──▶ in-review
in-review    ──request-changes──▶ in-progress        (fix round, capped)
in-review    ──maintainer merges──▶ closed
in-progress | in-review ──escalation──▶ needs-info | ready-for-agent
```

## Claim semantics

- The claim is atomic: **assign the issue to the maintainer account and apply
  `in-progress` together**. An issue with an assignee and `in-progress` is claimed and
  is no longer claimable.
- The maintainer account is the **authenticated `gh` user** of the session running the
  claim.
- Only a coordinator claims, and only from the claimable, and only on a
  maintainer's command.

## Readiness and live Claim safeguards

Preparation and triage set `ready-for-agent` without a mandatory assessment/comment
or two-pass label gate. On invocation, a successful semantic Readiness check produces
an immutable prepared brief before Claim. Needs clarification and assessment failure
are distinct diagnostics; neither permits Claim or automatically corrects labels.
Captured discussion is collected once, with no later content-freshness gate or
reassessment. Live label/state checks, active Claim exclusion, native blocker status,
and atomic Claim remain separate and deterministic.

## Claim and publish refusals

This section records the legacy coordinator-operation surface; broad pivot
reconciliation remains with [Task: reconcile the record — ADRs, ontology, AGENTS.md,
playbooks](https://github.com/juranki/afk-kit/issues/53). It does not reinstate
ADR 0012's embedded assessment or planning gates.

The claim and publish ops (the coordinator mechanics extension) enforce these
semantics as code; their refusals use the house marker pattern. Canonical
marker vocabulary:

- `READINESS_REFUSAL` — historical body-template refusal marker. Current readiness
  policy is [ADR 0016](../adr/0016-agentic-readiness-and-prepared-brief.md): assessment
  precedes Claim, distinguishing Needs clarification from assessment failure; both
  refuse without Claim. Output/diagnostic implementation follows the readiness
  successor, not this legacy marker description.
- `CLAIM_REFUSAL` — the issue is already claimed (an assignee, or a leftover
  `in-progress` marker with no assignee), a competing claim appeared mid-claim, a
  step failed, or compensation itself failed. Compensation failures name the
  **leftover state** explicitly (e.g. `assigned to <maintainer>`, `labeled
  in-progress`, `worktree <path> / branch <branch>`); a maintainer clears it.
- `PUBLISH_REFUSAL` — the branch already has an open PR (named), a verify command
  failed in the worktree (named, nothing pushed), a step failed, or compensation
  itself failed.
- `HANDOFF_REFUSAL` — a step of the handoff operation failed. Nothing is undone:
  the PR stays open, the pushed branch stays put, and the refusal names what
  completed and what stands. The Run escalates; the Escalation preserves the PR,
  branch, and worktree.
- `ESCALATION_FAILURE` — the escalation itself could not complete a step (the
  CLI's internal-failure exit). Every step is still attempted; the failure names
  what completed and what stuck. The preserved artifacts are untouched.

Discipline, identical for both ops:

- Steps run in order; **failure at any step compensates the steps before it**, in
  reverse order, leaving no half-claim and no half-published PR.
- A publish compensation closes the just-opened PR (with a comment saying so) and
  deletes the pushed remote branch.
- The claim order is: assign → verify the sole claim → apply `in-progress` → create
  the worktree and branch from `main`.
- The publish order is: verify commands → push → open the PR (review requested from
  the maintainer) → apply `in-review` → remove `in-progress` (applied first, removed
  second, so the issue is never momentarily unlabeled while a PR is open).

## Engine operation refusals

The Engine's narrow operations (`engine/`, ticket #58) enforce the same semantics as
the claim and publish ops, with two refinements:

- `bootstrapDraftPr` and `pushCandidate` refuse with `PUBLISH_REFUSAL` — they are the
  publish mechanics reshaped. `bootstrapDraftPr` accepts an existing open **draft** PR
  for the branch (deterministic identity: one PR per branch) and refuses a ready one;
  it never touches the ticket's labels. `pushCandidate` pushes additively only — a
  non-fast-forward remote refuses naturally, nothing is ever forced.
- `handOffPr` — record the final evidence in the PR body, mark the draft ready, apply
  `in-review`, remove `in-progress` (same applied-first/removed-second order), and
  never request a review from the PR author. A failed handoff compensates nothing
  destructively (`HANDOFF_REFUSAL`); the Run escalates and the Escalation preserves
  the artifacts ([review and escalation](review-and-escalation.md)).
- `escalateRun` posts the status comment, applies `needs-info`, and removes only the
  workflow labels the ticket actually carries. The assignee, PR, branch, worktree,
  and run evidence are never touched. An incomplete escalation is an
  `ESCALATION_FAILURE`.

## Who may move what

- Preparation and triage set triage states.
- Coordinators move only their own claimed ticket through `in-progress` / `in-review`
  and back, per the [escalation policy](review-and-escalation.md).
- The maintainer may override any state at any time; coordinators flag unusual
  transitions and ask before proceeding.
