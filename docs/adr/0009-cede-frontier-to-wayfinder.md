# ADR 0009: Cede "Frontier" to wayfinder

- **Status:** Accepted
- **Date:** 2026-09-14

The word **Frontier** named two concepts: the ontology's repo-wide set of
ready-for-agent tickets with no open blockers and no active claim, and wayfinder's
map-scoped frontier query in the wrapped issue-tracker seam
(`docs/agents/issue-tracker.md`). AGENTS.md mandates exact ontology terms, so an agent
reading both artifacts had no signal they differ. The ontology term is renamed to
**Claimable**; the word "Frontier" now belongs solely to wayfinder's query, and a
boundary note in the ontology's Related-ontologies section marks the reuse.

**Considered options:** renaming the seam file's copy was rejected — it breaks
byte-identity with the upstream template (ADR 0003's wrap-don't-fork), and the word
survives in wayfinder's own prose regardless, so local purity was unattainable on that
side of the seam. Raising a rename upstream (`mattpocock/skills`) was rejected: the
upstream skills are established, and renaming there is not ours to ask. A
disambiguation note alone was rejected: it documents the collision instead of removing
it, leaving one word owning two concepts in afk-kit's own artifacts.

**Consequences:** afk-kit's artifacts say Claimable (ontology, frame, stories,
conventions, brief template); wayfinder sessions legitimately keep "Frontier query."
ADR 0001's prose ("working the frontier") is left as a historical record under the old
term. Future afk-kit writing must not reintroduce "Frontier" for the ontology concept.

_Recorded from the grilling interview on [issue #4](https://github.com/juranki/afk-kit/issues/4)._
