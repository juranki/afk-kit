# ADR 0005: No planning orchestrator skill

- **Status:** Accepted
- **Date:** 2026-09-13

Planning sessions have no fixed orchestrating skill. The flow — triage, grilling,
slicing to tickets, or writing a spec first — is composed per subject from the
individual installed skills, because the subject matter legitimately shapes the flow.

**Considered options:** a `/plan-session` pipeline skill chaining triage → grill →
to-tickets was considered and rejected: it would freeze a workflow that benefits from
variation, for consistency the brief template already provides.

**Consequences:** planning sessions have no enforced process gate; the shared exit
criterion is the [agent brief](../brief-template.md) — completeness there is what makes
a ticket `ready-for-agent`, not obedience to a pipeline.
