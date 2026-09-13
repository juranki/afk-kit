# ADR 0008: System-intent shape as the domain-doc convention

- **Status:** Accepted
- **Date:** 2026-09-13

Repositories this workflow touches keep their domain documentation in the
system-intent shape — ubiquitous language in `system-intent/ontologies/`, indexed by
the model frame in `system-intent/README.md` — instead of the root `CONTEXT.md`
glossary the wrapped Matt Pocock skills create by default. The mapping is direct:
glossary ↔ ontology ubiquitous language, `CONTEXT-MAP.md` ↔ the ontology index in the
model frame, `docs/adr/` unchanged; characters, stories, and the frame are additive,
since the skills only consume vocabulary.

The mechanism is the skills' per-repo configuration seam, not a fork:
`docs/agents/domain.md` (seeded by the setup skill, then hand-edited) declares where
domain docs live and forbids glossary creation, and `AGENTS.md` routes model work to
`system-intent-modeling` and `domain-ontologies`, reserving `domain-modeling` for
ADRs. afk-kit itself is configured this way. If the soft override proves leaky — a
writer skill still creating or appending a `CONTEXT.md` — the fallback is a
per-project skill unload via `.pi/settings.json` skill patterns.

**Considered options:** patching or forking the installed skills to hardcode the
convention was rejected — it contradicts [ADR 0003](0003-wrap-matt-pocock-skills.md)
(wrap, don't fork) and forfeits upstream evolution. Keeping a root `CONTEXT.md`
alongside the ontology was rejected — two canonical wordings of the same terms would
drift.

**Consequences:** every writer skill that would lazily create a glossary
(`domain-modeling` via `grill-with-docs`, `triage`,
`improve-codebase-architecture`) relies on repo-local instructions to aim at the
ontology instead, so `docs/agents/domain.md` must be written when a repo is onboarded
(one issue per repo). Planning-session outcomes that outlive the ticket brief persist
as ontology or frame updates, or as ADRs — never as a `CONTEXT.md`.
