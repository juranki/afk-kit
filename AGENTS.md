# Agent Working Agreement

This repository captures the design of a development workflow. It contains no
implementation: do not create skill, extension, or source files here. Changes to
this repository are documentation changes.

## Read before writing

Read the documentation router in `docs/README.md`, the model frame in
`system-intent/README.md`, the [workflow ontology](system-intent/ontologies/agent-delivery-workflow.md),
and any playbook, convention, or ADR touching the change before editing.

When guidance conflicts, use this order:

1. The workflow ontology
2. The system-intent frame, characters, and stories
3. Accepted ADRs in `docs/adr/`
4. Playbooks and conventions under `docs/`
5. This file

Do not silently resolve a material conflict. Ask, or record the decision as an ADR.

## Vocabulary and skills

- Use ontology terms exactly (`Coordinator`, `Claim`, `Merge gate`, `Escalation`, …).
  Changing an invariant is an ontology change; make it there, not in prose.
- **`system-intent-modeling`** — when changing the model frame, characters, or stories.
- **`domain-ontologies`** — when changing domain language or invariants.
- **`domain-modeling`** — when recording an ADR or editing `CONTEXT.md`.
- **`writing-for-agents`** — when editing this file, or authoring the skills this
  design describes.

## Git

The canonical remote is `github.com/juranki/afk-kit` (private). Until afk-kit's own
tooling exists, documentation changes commit directly to `main`; once it exists, this
repository should dogfood the branch-per-issue and review-before-merge discipline it
prescribes.
