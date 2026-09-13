# Subagent mechanism — requirements

Input for a dedicated investigation session that selects the subagent mechanism for
afk-kit coordinators. Candidates include pi's example `subagent`
extension (shipped under pi's `examples/extensions/subagent/`) and any other existing
extensions; the investigation
session evaluates candidates against every requirement below and records the choice as
a new ADR. Gaps in a chosen candidate must be listed explicitly, not absorbed silently.

These requirements were settled in the origin grilling session; the mechanism itself is
deliberately unresolved.

## Requirements

| # | Requirement |
| --- | --- |
| R1 | Spawn child agent processes with isolated contexts; return a structured (JSON) result to the caller. |
| R2 | Per-agent configuration via markdown frontmatter: name, description, model, tools allowlist, system prompt. The shipped roster is `implementer` (`glm-5.3-flash`) and `reviewer` (`glm-5.3`). |
| R3 | The delegation tool accepts a working directory — subagents run inside the issue's worktree. |
| R4 | Dispatch up to 3 subagents in parallel. |
| R5 | The implementer has no publishing ability: no `gh`, no push, no pull requests, no tracker writes. It commits locally in the worktree only and returns a structured result (status, commits, files touched, open questions). |
| R6 | The reviewer reads the pull-request diff, may run the verify commands, and returns a structured verdict: approve, or request-changes with severity-ranked findings. |
| R7 | Coordinator-side operations are separate from subagents and deterministic: claim issue + create worktree + create branch as one atomic operation; push + open pull request as another; a merge guard that blocks merging outside maintainer action. |
| R8 | A stuck subagent can be timed out or cancelled; the coordinator keeps control throughout. |
| R9 | Per-subagent token/cost reporting (nice-to-have). |
| R10 | Installs user-level as part of the afk-kit package; project-agnostic across target repositories. |

## Evaluation guidance for the selection session

- Assess every candidate against every requirement; a partial fit is a finding, not a
  failure — record which requirement is unmet and how badly.
- R5 and R7 are the safety-critical set: confinement of the implementer and the atomic,
  deterministic coordinator operations. Prefer candidates that satisfy these natively;
  weigh wrappers that add them.
- R2's per-agent model field is what makes [ADR 0004](../adr/0004-flash-first-model-routing.md)
  implementable without code changes; treat its absence as a significant gap.
- Record the decision and any gaps as a new ADR in `docs/adr/`, and update the open
  questions in `system-intent/README.md` that this selection retires.
