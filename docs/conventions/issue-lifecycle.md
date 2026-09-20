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
| Ready for agent | `ready-for-agent` | planning session | Brief complete, blockers known (see the [brief template](../brief-template.md)). |
| Ready for human | `ready-for-human` | planning session | A human must implement it. |
| Won't fix | `wontfix` | maintainer | Will not be actioned. |
| In progress | `in-progress` | coordinator (claim) | Claimed and being implemented. |
| In review | `in-review` | coordinator (PR opened) | Pull request open; review loop or human review under way. |

Repos must create every label they use — tenant-kit currently lacks `needs-info`,
`ready-for-human`, `in-progress`, and `in-review` on GitHub.

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

## Claim and publish refusals

The claim and publish ops (the coordinator mechanics extension) enforce these
semantics as code; their refusals use the house marker pattern. Canonical
marker vocabulary:

- `READINESS_REFUSAL` — the embedded readiness check failed; the claim refuses,
  claiming nothing ([ADR 0012](../adr/0012-brief-enforcement-readiness-check.md)).
- `CLAIM_REFUSAL` — the issue is already claimed (an assignee, or a leftover
  `in-progress` marker with no assignee), a competing claim appeared mid-claim, a
  step failed, or compensation itself failed. Compensation failures name the
  **leftover state** explicitly (e.g. `assigned to <maintainer>`, `labeled
  in-progress`, `worktree <path> / branch <branch>`); a maintainer clears it.
- `PUBLISH_REFUSAL` — the branch already has an open PR (named), a verify command
  failed in the worktree (named, nothing pushed), a step failed, or compensation
  itself failed.

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

## Who may move what

- Planning sessions set triage states.
- Coordinators move only their own claimed ticket through `in-progress` / `in-review`
  and back, per the [escalation policy](review-and-escalation.md).
- The maintainer may override any state at any time; coordinators flag unusual
  transitions and ask before proceeding.
