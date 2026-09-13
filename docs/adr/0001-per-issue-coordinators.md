# ADR 0001: Per-issue coordinators

- **Status:** Accepted
- **Date:** 2026-09-13

One coordinator session per issue, running in parallel as separate sessions, rather
than a single multi-issue coordinator with an internal scheduler. GitHub is the state:
claims and labels make progress visible, so no session-local scheduling or bookkeeping
is needed, and pi's working-directory-keyed sessions give each coordinator its own
history in its issue's worktree. The parallelism cap (3) becomes how many sessions the
maintainer opens, not something code enforces.

**Considered options:** a single coordinator working the frontier with N in-flight
issues was rejected — it adds a scheduler, internal state, and a bigger blast radius
per session, for no gain the per-issue model doesn't provide.

**Consequences:** duplicate-claim safety rests entirely on the atomic claim semantics
(assign + `in-progress`); nothing enforces the in-flight cap; a future auto-dispatcher
would be a new decision.
