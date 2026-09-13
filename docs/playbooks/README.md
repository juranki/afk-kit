# Playbooks

Playbooks describe how the workflow's two session types are run. They carry judgment
("what to do when"), not domain rules — those live in the ontology — and not fixed
policy numbers — those live in conventions and ADRs.

- [Planning session](planning-session.md) — human-led; turns subject matter into
  ready-for-agent tickets.
- [Coordinator session](coordinator-session.md) — one session per issue; carries a
  claimed ticket from command to pull request.

Nothing here is implemented yet; until it is, a human runs these sessions by hand using
the installed skills.
