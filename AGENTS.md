# Agent Working Agreement

This repository holds the design of a development workflow and the toolkit that
implements it ([ADR 0010](docs/adr/0010-retire-the-design-only-policy.md)): skills,
extensions, agent definitions, and tests are created here under the same discipline as
the design docs.

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
- **`domain-modeling`** — when recording an ADR.
- **`writing-for-agents`** — when editing this file, or authoring the skills this
  design describes.

## Git

The canonical remote is `github.com/juranki/afk-kit`. Until the coordinator loop is
minimally viable (map issue
[#5](https://github.com/juranki/afk-kit/issues/5)), changes commit directly to
`main`; after that, this repository is dogfooded through the branch-per-issue and
review-before-merge discipline the toolkit itself prescribes.

## Agent skills

### Issue tracker

GitHub Issues in this repo, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See
`docs/agents/triage-labels.md`.

### Domain docs

Domain docs live in `system-intent/` (model frame, ontology, characters, stories);
there is no root `CONTEXT.md`. See `docs/agents/domain.md`.
