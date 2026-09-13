# afk-kit system intent

## Intended outcome

Let a solo maintainer turn intent into merged software changes while spending personal
attention only where it is decisive — specifying work, commanding its start, and judging
its landing — with unattended, per-issue agent sessions doing the bounded labor in
between, verifiably and reversibly.

## System boundary

This model covers the delivery workflow's concepts and policies: triage and ticket
readiness, per-issue coordination, subagent delegation, agent review, escalation, and
the human merge gate. It includes the journeys that pressure those: preparing tickets,
delegating an issue, failing loudly, and landing a change.

It excludes the internal design of any agent runtime or subagent mechanism (selection
recorded in [ADR 0007](../docs/adr/0007-vendored-subagent-mechanism.md)), the
implementation of the toolkit itself,
the product domain of any target repository, CI system design, cost accounting beyond
the policy of bounded loops, and multi-maintainer governance.

## Planning question

Can work specified well enough in one planning session be carried to a reviewable pull
request by per-issue coordinator sessions — without the maintainer touching the code —
while the maintainer alone decides when work starts and when it lands?

The model covers the ticket-preparation, delegation, failure-and-escalation, and
review-and-merge journeys. Other delivery concerns are included only where they
constrain those journeys.

## Artifacts

### Ontologies

- [Agent Delivery Workflow](ontologies/agent-delivery-workflow.md) — Establishes who may start, do, review, and land work; what makes a ticket safe for an unattended agent; and how work returns to a human.

### Characters

- [Salla — The Context-Protecting Maintainer](characters/salla.md) — Exposes the cost of incomplete briefs and of becoming a bottleneck inside the loop.
- [Eero — The Skeptical Merger](characters/eero.md) — Exposes why an agent's approval can filter but never replace human review.
- [Riitta — The Cost-Wary Operator](characters/riitta.md) — Exposes the need for caps, confinement, and loud failure in unattended work.

### Stories

- [Preparing Tickets for Delegation](stories/preparing-tickets-for-delegation.md) — Connects grilling, ticket slicing, and brief completeness at the planning-session boundary.
- [Delegating an Issue to a Coordinator](stories/delegating-an-issue-to-a-coordinator.md) — Connects the start command, claim, confined implementation, and the stop for human review.
- [Recovering from a Stuck Implementation](stories/recovering-from-a-stuck-implementation.md) — Connects attempt ceilings, escalation, and honest triage states after failure.
- [Landing a Change Under the Merge Gate](stories/landing-a-change-under-the-merge-gate.md) — Connects checklist-driven human review with the right to overrule agent approval.

## Open questions

- **Implementer promotion.** Implementers start on `glm-5.3-flash`; promoting them to
  `glm-5.3` on demonstrated struggle is anticipated but the rules are deferred until
  evidence exists (see [ADR 0004](../docs/adr/0004-flash-first-model-routing.md)).
- **Pre-push review.** The reviewer examines the pushed pull-request diff; whether an
  additional pre-push round adds value is unresolved. Affects
  [review and escalation conventions](../docs/conventions/review-and-escalation.md).
- **Persistence of grill outcomes.** Decisions from a planning session that exceed the
  ticket brief persist as ontology or frame updates, or as ADRs, in the target repo —
  never as a `CONTEXT.md` glossary (see
  [ADR 0008](../docs/adr/0008-system-intent-shape-as-domain-doc-convention.md)). The
  session mechanics — who writes the update, and when — remain open. Affects the
  [planning playbook](../docs/playbooks/planning-session.md).
- **Brief conformance in review.** Whether the reviewer should explicitly check the
  diff's touched areas against the brief's declared areas, rather than leaving that to
  the human, is unresolved. Affects the
  [merge-gate story](stories/landing-a-change-under-the-merge-gate.md).

## Sources

- Grilling interview with the maintainer (this repository's origin session), which
  settled the decisions recorded in [docs/adr/](../docs/adr/).
- tenant-kit agent configuration: `docs/agents/issue-tracker.md` and
  `docs/agents/triage-labels.md` — triage vocabulary and GitHub tracker conventions.
- Matt Pocock's engineering skills (`triage`, `to-tickets`, `implement`, `grill-me`,
  `grill-with-docs`), installed at `~/.pi/agent/skills` — the wrapped baseline.
- pi coding agent documentation and examples (`extensions`, `subagent`) — factual basis
  for the mechanism requirements.
- Characters and stories are composite and hypothetical, synthesized from the
  maintainer's stated working practice; they are not observed user studies.
