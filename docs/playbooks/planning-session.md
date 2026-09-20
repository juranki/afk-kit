# Planning session

A human-led session that turns subject matter into tickets an unattended agent can
complete. One planning session is the only place work gets specified; its exit
criterion, per slice, is the brief.

## Composition

There is no fixed orchestration ([ADR 0005](../adr/0005-no-planning-orchestrator-skill.md)):
the flow is shaped by the subject matter. Compose the installed skills as the work
demands:

- **`/triage`** — for incoming issues and requests; moves them through the triage
  states using the target repo's label vocabulary.
- **`/grill-with-docs` or `/grill-me`** — to stress-test a plan or decision before
  slicing; the resulting decisions feed the briefs.
- **`/to-tickets`** — to break a plan or spec into tracer-bullet slices with blocking
  edges, published to the tracker.
- **`/to-spec`** — when a design needs prose before it can be sliced.

## Exit criteria, per ticket

A ticket leaves the session as `ready-for-agent` only when:

1. Its brief satisfies every field of the [agent brief template](../brief-template.md),
   including an **empty** Open questions field — proven by the readiness check, the
   afk-kit extension tool ([ADR 0012](../adr/0012-brief-enforcement-readiness-check.md)),
   run around applying the label: a **pre-apply run** must pass every inspection
   except at most `triage-labels` failing as `ready-for-agent` absent; apply the
   label, then a **confirm run** passing all inspections is the exit proof. A failed
   confirm run sends the ticket back — remove the label, fix, run again.
2. Every blocking edge is declared (native tracker dependencies where available, as in
   tenant-kit's `docs/agents/issue-tracker.md`).
3. Labels follow the target repo's mapping of the triage states.

A ticket that cannot satisfy these leaves the session honestly: `needs-info` when a
maintainer decision is missing, `ready-for-human` when a human must implement it.

## Hints

- Use the target repo's domain vocabulary so tickets speak its language, and respect
  its reading order (tenant-kit's AGENTS.md precedence, for example).
- Prefer prefactoring slices first — make the change easy, then make the easy change.
- Wide refactors are the exception: expand–contract, as `/to-tickets` prescribes.

## Non-goals

- No implementation in a planning session: no commits to target repositories, only
  tracker writes.
- No coordinator work: nothing is claimed or implemented from within planning.
