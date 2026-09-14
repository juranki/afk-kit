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
- Only a coordinator claims, and only from the claimable, and only on a
  maintainer's command.

## Who may move what

- Planning sessions set triage states.
- Coordinators move only their own claimed ticket through `in-progress` / `in-review`
  and back, per the [escalation policy](review-and-escalation.md).
- The maintainer may override any state at any time; coordinators flag unusual
  transitions and ask before proceeding.
