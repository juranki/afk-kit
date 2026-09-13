# ADR 0004: Flash-first model routing

- **Status:** Accepted
- **Date:** 2026-09-13

The coordinator and implementer run on `glm-5.3-flash` (the coordinator at a lower
thinking level); the reviewer runs on `glm-5.3`. The reviewer is the quality gate, and
a cheap reviewer is false economy. Implementer promotion to `glm-5.3` on demonstrated
struggle is anticipated; promotion rules are deferred until evidence exists.

**Considered options:** everything on `glm-5.3` (higher cost, no perceived benefit for
orchestration) and everything on `glm-5.3-flash` (review risk) were rejected.

**Consequences:** the mechanism must support per-agent model configuration (requirement
R2); promotion rules, once observed, become an update to this ADR or the coordinator
playbook.
