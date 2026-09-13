# ADR 0003: Wrap Matt Pocock's skills

- **Status:** Accepted
- **Date:** 2026-09-13

afk-kit wraps the installed Matt Pocock engineering skills rather than forking them:
planning composes `/triage`, `/grill-with-docs`, `/grill-me`, `/to-tickets`, and
`/to-spec` as they ship, and afk-kit adds only what they lack — brief enforcement, the
coordinator loop, and the workflow conventions recorded here.

**Considered options:** forking the skills into the afk-kit package was rejected — they
evolve upstream, and their per-repo configuration seams (`docs/agents/issue-tracker.md`,
`triage-labels.md`, the setup skill) already provide the integration points afk-kit
needs.

**Consequences:** afk-kit must not assume skill internals beyond their documented
contracts; upstream behavior changes arrive automatically and may require convention
updates here.
