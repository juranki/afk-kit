# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

## No CONTEXT.md in this repo

Domain meaning lives in the **system-intent model**, not in a root `CONTEXT.md` or
`CONTEXT-MAP.md`. Do not look for them; do not create them. The ontology under
`system-intent/ontologies/` is the glossary's home.

## Before exploring, read these

- **`docs/README.md`** — the documentation router; it decides where a topic's canonical home is.
- **`system-intent/README.md`** — the model frame: intended outcome, system boundary, planning question.
- **`system-intent/ontologies/`** — the ontology: concepts, relationships, invariants.
  [Agent Delivery Workflow](../../system-intent/ontologies/agent-delivery-workflow.md)
  is canonical for workflow vocabulary.
- **`system-intent/characters/`** and **`system-intent/stories/`** — stakes and desired
  behavior; read what is relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

## When domain language is created or changed

- **`system-intent-modeling`** owns the model frame, characters, stories, and
  cross-artifact coherence.
- **`domain-ontologies`** owns ontology format and authoring/review workflows; ontology
  work inside the model selects `system-intent/ontologies/` as the root.
- Record load-bearing decisions as ADRs (see AGENTS.md's working agreement).
- Do not record ontology terms in a `CONTEXT.md`, and do not let ontologies depend on
  characters, stories, or the model README.

## Use the ontology's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a
hypothesis, a test name), use the term as defined in the ontology. Don't drift to
synonyms the ontology explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're
inventing language the project doesn't use (reconsider) or there's a real gap (note it
for `domain-ontologies`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently
overriding:

> _Contradicts ADR-0005 (no planning orchestrator skill), but worth reopening because…_
