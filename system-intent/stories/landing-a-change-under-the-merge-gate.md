# Landing a Change Under the Merge Gate

- Basis: `composite` — an illustrative scene synthesized from the maintainer's stated
  merge discipline.

## Scene

Two agent-approved pull requests wait for Eero. The first matches its checklist: the
diff touches only what the brief declared, and the verify commands rerun clean — he
merges. The second was approved by the reviewer even though it touches a module the
brief never declared. Eero sends it back with his reasoning recorded on the pull
request, and it returns through the bounded loop instead of consuming Salla's evening.

## User stories

1. **As Eero, a skeptical merger, I want the diff to declare its touched areas against the brief so that surprises surface before the merge, not after.**

2. **As Eero, I want verify commands I can rerun myself so that trust is checkable rather than granted.**

3. **As Eero, I want my review to be able to overrule an agent's approval so that accountability for main stays human.**

4. **As Salla, a context-protecting maintainer, I want sent-back work to return through the bounded coordinator loop, or reach me by escalation once the loop is spent, so that my attention goes to judgment rather than re-dispatch.**

## Characters

- [`Eero`](../characters/eero.md) — Reviews and merges; his verdict outranks the agent's.
- [`Salla`](../characters/salla.md) — Wants returns handled by the loop, not her desk.

## Ontology touchpoints

- [`Agent Delivery Workflow`](../ontologies/agent-delivery-workflow.md) — Merge gate, Pull request, Reviewer, Verdict, Review round, Agent brief.

## Open questions

- Whether the reviewer should explicitly check the diff's touched areas against the
  brief's declared areas, or whether that check stays with the human, is unresolved
  (see the model frame's open questions).
