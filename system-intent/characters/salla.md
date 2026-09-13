# Salla — The Context-Protecting Maintainer

- Basis: `composite` — synthesized from the maintainer's stated working practice in the
  origin interview; not an observed user study.

## Situation

Solo maintainer of small repositories, working in bursts. Each deliberate context switch
into implementation detail costs a whole session of scarce attention. The pressure: more
ideas than evenings, and every hour spent steering an agent mid-flight is an hour not
spent specifying the next piece of work.

## Concern

Protects uninterrupted attention. Planning should be her only creative act inside the
codebase; implementation should arrive as reviewable proposals that never require her to
re-enter the code mid-flight.

## Lens

| Facet | Expression |
| --- | --- |
| Wants | Briefs so complete that delegation succeeds on the first attempt; one command to start an issue; pull requests queued for judgment, not questions. |
| Fears | Becoming the bottleneck inside the loop — answering mid-implementation questions; half-specified tickets burning agent time and her patience. |
| Notices | Open questions left in a brief; verify commands that do not run; a diff that does not match its acceptance criteria. |
| Assumes | A well-briefed ticket is sufficient for an unattended agent to finish. |
| Blind spot | Parallel coordinators still converge on one reviewer — her; coordination and review overhead grows with the number of issues in flight. |

## Voice

> "If I have to explain it mid-implementation, the ticket wasn't ready."

## Appears in

- [Preparing Tickets for Delegation](../stories/preparing-tickets-for-delegation.md) — The brief is her delegation contract; open questions must block readiness.
- [Delegating an Issue to a Coordinator](../stories/delegating-an-issue-to-a-coordinator.md) — One command in, a reviewable pull request out, no steering.
- [Recovering from a Stuck Implementation](../stories/recovering-from-a-stuck-implementation.md) — Escalation must be decidable from a status comment alone.
- [Landing a Change Under the Merge Gate](../stories/landing-a-change-under-the-merge-gate.md) — Sent-back work returns through the loop, not to her desk.

## Related ontologies

- [Agent Delivery Workflow](../ontologies/agent-delivery-workflow.md) — Maintainer, Agent brief, Ready-for-agent, Coordinator, Merge gate, Frontier.

## Open questions

- Whether planning sessions must also pre-answer per-ticket model or cost questions, or
  whether those stay global policy (see the model frame's open questions).
