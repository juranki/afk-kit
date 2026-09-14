# Recovering from a Stuck Implementation

- Basis: `composite` — an illustrative scene synthesized from the maintainer's stated
  escalation policy.

## Scene

An implementer fails the same verify commands for the third time on ticket #15. The
coordinator stops rather than rounds again: a status comment lands on the ticket — what
was tried, what broke, where the worktree is — the label returns to `ready-for-agent`,
and the worktree is kept. Salla, away from the keyboard, reads the summary on her phone
and decides the brief under-specified a migration edge: the ticket moves to
`needs-info`, because the next move is hers, not an agent's.

## User stories

1. **As Riitta, a cost-wary operator, I want attempts to have a ceiling so that failure is loud and bounded rather than endless.**

2. **As Salla, a context-protecting maintainer, I want an escalation to tell me what was tried, what broke, and where the worktree is, so that I can decide without re-deriving the situation.**

3. **As Salla, I want the ticket's state to name its truth after escalation so that the claimable stays honest.**

4. **As Salla, I want the abandoned worktree preserved so that partial work is inspectable rather than discarded.**

## Characters

- [`Riitta`](../characters/riitta.md) — The ceiling makes failure loud and bounded.
- [`Salla`](../characters/salla.md) — Decides from the escalation summary alone.

## Ontology touchpoints

- [`Agent Delivery Workflow`](../ontologies/agent-delivery-workflow.md) — Escalation, Verify commands, Triage state, Coordinator, Claimable.

## Open questions

- Whether a later coordinator may reuse an escalated ticket's worktree and branch, or
  always starts fresh, is unresolved (see the model frame's open questions).
