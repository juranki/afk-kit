# Planning session

A human-led session that turns subject matter into tickets an unattended agent can
complete. Wayfinder, to-spec, and to-tickets prepare Issues; triage processes Issues
arriving from other sources. Its exit criterion is clear, bounded source intent, not
an agent-prepared handoff or obedience to template syntax.

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
- **`/wayfinder`** — when the route to a destination still contains decisions.

## Exit criteria, per ticket

A ticket leaves the session as `ready-for-agent` only when:

1. The discussion establishes a clear outcome, bounded scope and exclusions,
   meaningful verifiable acceptance criteria, necessary settled decisions, and an
   understood verification path. No meaningful product question or contradiction
   remains. The [brief standard](../brief-template.md) is an authoring aid, not a
   required source format.
2. Every blocking edge is declared (native tracker dependencies where available, as in
   tenant-kit's `docs/agents/issue-tracker.md`).
3. Labels follow the target repo's mapping of the triage states.

`ready-for-agent` records preparation/triage judgment, not guaranteed acceptance by
`afk`. Do not add a mandatory assessment-and-comment step or a pre-apply/confirm
label gate. On invocation, the Coordinator assesses the captured discussion and
prepares its own immutable handoff ([ADR 0016](../adr/0016-agentic-readiness-and-prepared-brief.md)).
Known open blockers affect Claimability separately; they do not make settled intent
ambiguous.

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
