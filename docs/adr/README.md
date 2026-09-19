# Architecture decisions

Decisions that shape the afk-kit workflow and its future implementation, recorded as
short ADRs (per the `domain-modeling` skill format). Each records *that* a decision was
made and *why*.

| Decision | Status | Scope |
| --- | --- | --- |
| [ADR 0001: Per-issue coordinators](0001-per-issue-coordinators.md) | Accepted | Session architecture, parallelism, claim safety |
| [ADR 0002: Human merge gate](0002-human-merge-gate.md) | Accepted | Merge authority, reviewer's role |
| [ADR 0003: Wrap Matt Pocock's skills](0003-wrap-matt-pocock-skills.md) | Accepted | Relationship to the installed skill set |
| [ADR 0004: Flash-first model routing](0004-flash-first-model-routing.md) | Accepted | Model per role, promotion deferral |
| [ADR 0005: No planning orchestrator skill](0005-no-planning-orchestrator-skill.md) | Accepted | Planning-session composition |
| [ADR 0006: Extensions for mechanics, skills for judgment](0006-extensions-for-mechanics-skills-for-judgment.md) | Accepted | Implementation split for the future toolkit |
| [ADR 0007: Vendored subagent mechanism](0007-vendored-subagent-mechanism.md) | Accepted | Delegation substrate, implementer confinement, timeouts |
| [ADR 0008: System-intent shape as the domain-doc convention](0008-system-intent-shape-as-domain-doc-convention.md) | Accepted | Where domain docs live for the wrapped skills |
| [ADR 0009: Cede "Frontier" to wayfinder](0009-cede-frontier-to-wayfinder.md) | Accepted | Ontology term rename, seam vocabulary |
| [ADR 0010: Retire the design-only policy](0010-retire-the-design-only-policy.md) | Accepted | Repo policy: implementation lives here, git discipline |
| [ADR 0011: Merge guard is session-bound client-side enforcement](0011-merge-guard-session-bound-client-side-enforcement.md) | Accepted | Merge refusal at the session's tool boundary |
| [ADR 0012: Brief enforcement is a deterministic readiness check](0012-brief-enforcement-readiness-check.md) | Accepted | Readiness check as the form of brief enforcement |
| [ADR 0013: The coordinator skill carries judgment; an agentic review catches drift](0013-coordinator-skill-carries-judgment-agentic-drift-review.md) | Accepted | Skill/doc split, drift-avoidance mechanism |
