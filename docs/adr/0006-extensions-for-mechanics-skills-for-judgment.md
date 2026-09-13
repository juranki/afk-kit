# ADR 0006: Extensions for mechanics, skills for judgment

- **Status:** Accepted
- **Date:** 2026-09-13

Anything that must happen identically every time becomes deterministic extension code —
atomic claim + worktree + branch, push + open-PR, the merge guard, the caps. Anything
requiring judgment stays prompt-driven in skills — the coordinator's orchestration
policy, review interpretation, planning composition. This split governs all future
implementation in afk-kit.

**Considered options:** implementing the whole workflow as skills (prompt-only) was
rejected — mechanical steps drift when the model re-derives them each run; implementing
judgment as code was rejected — it ossifies decisions that should stay legible and
editable.

**Consequences:** the toolkit ships as a pi package with both resource types; the
subagent mechanism selection ([requirements](../requirements/subagent-mechanism.md))
must fit this split, with R5 and R7 as its safety-critical core.
