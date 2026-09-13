# Agent brief template

A ticket may carry the `ready-for-agent` label only when every field below is satisfied
and **Open questions** is empty. This template extends the brief conventions of the
installed `triage` skill (`AGENT-BRIEF.md`); where that skill's guidance and this
template disagree, this template wins for issues destined for afk-kit coordinators.

Apply it in the target repository's tracker so the brief travels with the issue.

## The fields

| Field | Must satisfy |
| --- | --- |
| **Summary** | One or two sentences in the target repo's domain vocabulary. A stranger could say what changes. |
| **Acceptance criteria** | Behavior-level and verifiable. Each criterion is independently checkable and becomes a PR checklist item. |
| **Verify commands** | The exact commands (build, test, lint) whose passing defines done. The implementer runs these; the maintainer can rerun them. |
| **Blocked by / blocks** | Every edge to other tickets. Missing edges make the frontier lie. |
| **Touched areas** | Files, directories, and the relevant ontologies, ADRs, or stories the change may touch. Declares the blast radius the reviewer checks against. |
| **Out of scope** | What this ticket deliberately does not do. Keeps implementers from gold-plating past the chosen edge. |
| **Open questions** | Must be **empty**. If anything is unresolved, the ticket is not ready for an agent: keep it in `needs-info` (maintainer decides) or `ready-for-human` (human implements). |

## Skeleton

```markdown
## Agent brief

**Summary:** <one or two sentences>

**Acceptance criteria:**
- [ ] <verifiable behavior>
- [ ] <verifiable behavior>

**Verify commands:**
- `<command>`
- `<command>`

**Blocked by:** #<n>, #<n>
**Blocks:** #<n>

**Touched areas:** <paths>, <ontology/ADR/story references>

**Out of scope:** <what this ticket does not do>

**Open questions:** none
```

## Relationship to the workflow

- Satisfying this template is the exit criterion of a planning session's slice (see the
  [planning playbook](playbooks/planning-session.md)) — there is no other gate.
- The reviewer and the maintainer both read the brief against the diff: the checklist
  items come from **Acceptance criteria**, and the surprise test comes from
  **Touched areas** (see the [merge-gate story](../system-intent/stories/landing-a-change-under-the-merge-gate.md)).
