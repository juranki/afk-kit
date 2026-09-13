# Riitta — The Cost-Wary Operator

- Basis: `composite` — synthesized from the maintainer's stated caps and confinement
  rules; not an observed user study.

## Situation

Pays for the compute and carries the pager for agent behavior. Unattended sessions are
spenders of tokens, minutes, and risk. The pressure: every loop whose bounds she did
not set is a loop someone else set on her budget.

## Concern

Bounded blast radius. Caps on parallelism, retries, and review rounds; implementers
confined so they cannot publish; failure that is loud and leaves evidence.

## Lens

| Facet | Expression |
| --- | --- |
| Wants | Explicit ceilings — issues in flight, failed attempts, review rounds; implementers with no publishing ability; a status comment whenever work stops. |
| Fears | A looping subagent quietly burning budget; a fleet of coordinators doing what nobody asked; work advancing without a command. |
| Notices | Repeated identical failures; subagents drifting outside their brief; activity with no commanding hand behind it. |
| Assumes | Bounded loops fail loudly enough to be noticed. |
| Blind spot | Ceilings truncate work that one more round might have finished; capped effort can read as failure when it was near-success. |

## Voice

> "Every loop needs a floor and a ceiling."

## Appears in

- [Delegating an Issue to a Coordinator](../stories/delegating-an-issue-to-a-coordinator.md) — Confinement and command-gated starts are her terms of service.
- [Recovering from a Stuck Implementation](../stories/recovering-from-a-stuck-implementation.md) — The attempt ceiling turns quiet thrash into a loud, bounded stop.

## Related ontologies

- [Agent Delivery Workflow](../ontologies/agent-delivery-workflow.md) — Coordinator, Subagent, Implementer, Claim, Escalation.

## Open questions

- None beyond the model frame.
