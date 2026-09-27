# Research: Matt Pocock's `implement` skill and its use of subagents

- **Requested by:** maintainer critique session — "could the coordinator loop have been a thin wrapper (worktree → pi + implement → push → PR)?"
- **Question:** How does Matt Pocock's `implement` skill actually work, especially its use of subagents? What does a thin wrapper around it get for free, and which of the coordinator loop's mechanisms would it lack?
- **Date:** 2026-09-26
- **Method:** primary sources only — the `mattpocock/skills` repository (cloned and read at commit `c55ee46`, main, 2026-09-18), including every `SKILL.md`, its human-facing docs pages (`docs/engineering/*.md`, which document known gaps and field reports), and the repo's own CLAUDE.md. Every claim cites file and line.

## Verdict up front

The premise of the question is half wrong, in an instructive way. The **shipped** `implement` skill uses **no subagents at all** — it is 15 lines of prompt that implement one ticket in the current branch (`skills/engineering/implement/SKILL.md`, lines 1–15). The subagent orchestration lives in **`implement-spec`**, which is explicitly beta: "excluded from the plugin … can change or disappear without warning" (`skills/in-progress/README.md`). `implement-spec` reads as an early, prompt-only sketch of the same problem afk-kit's coordinator loop solves — task-graph frontier, implementer subagents in per-ticket worktrees, a merger, a single spec PR.

Pocock's own docs enumerate, as known gaps and field reports, nearly every failure mode afk-kit's mechanics were built to close. A thin wrapper gets the happy path and inherits all of the documented failure modes, fail-open. Whether those mechanics are worth their cost is the real critique question, and the answer depends entirely on whether sessions are attended or AFK.

## 1. Two skills called "implement"

| | `engineering/implement` (shipped) | `in-progress/implement-spec` (beta) |
| --- | --- | --- |
| Size | 15 lines (`SKILL.md` lines 1–15) | 36 lines (`SKILL.md` lines 1–36) |
| Subagents | none | implementer, exploration, merger |
| Scope | one ticket, current branch | one spec → one PR |
| Worktrees | none; commits to current branch | one per implementer subagent (line 25) |
| PR | none ("Not built in" — `docs/engineering/implement.md` line 61) | draft PR, marked ready at the end (lines 23, 33) |
| Status | in the Claude Code plugin | not in the plugin; may "change or disappear without warning" (`skills/in-progress/README.md`) |

The shipped skill's whole text (lines 6–15): implement what the spec/tickets describe; use `/tdd` "at pre-agreed seams"; "Run typechecking regularly, single test files regularly, and the full test suite once at the end. Once done, use /code-review to review the work. Commit your work to the current branch."

## 2. What the shipped `implement` does in one run

Five beats (`docs/engineering/implement.md`, lines 29–35): read the ticket; drive `/tdd` at the seams; typecheck often; full suite once; run `/code-review`, then commit to the current branch. It deliberately "never reopens the plan" (line 7) and "does not re-validate the shape of what it was handed, so a badly-structured map or a horizontally-layered ticket gets built as written" (line 93).

## 3. What it does not do — the docs' own admissions

These are Pocock's documented gaps, not inferences:

- **No completion step, no tracker writes.** "It ends at the commit and never touches the work item … does not tick the `- [ ]` boxes … If nothing gets closed, nothing ever becomes visibly unblocked" — on a dependency chain the frontier never advances without the human (`docs/engineering/implement.md` line 53).
- **No parallelism, and shared-checkout sessions actively collide.** "Batch dispatch across a ticket queue and subagent fan-out are both requested repeatedly, and neither exists." A field report: "a `git commit --amend` in one session landing on another session's commit, a stash vanishing from `refs/stash`, and commits landing on the wrong branch, all in a single afternoon across three issues … Git worktrees are the community workaround … If you want parallelism today, you are assembling it yourself" (line 57).
- **No PR mode.** "Not built in. It commits straight to the current branch, which several people find too eager: the code lands before they have had a chance to verify it works" (line 61).
- **Fail-open issue resolution.** "`#2` is resolved against whatever numbered list the agent can see … confident rather than fail-closed" (line 75).
- **Review-before-commit reviews an empty diff.** `code-review` reviews `git diff <fixed-point>...HEAD`; `implement` runs it before committing, so "there is nothing in that diff to review. Multiple people have reported this and it is unfixed on both sides" (lines 79–81). The docs also note self-review bias: "an agent reviewing the code it just wrote is biased toward its own solution" (line 83).
- **No readiness gate.** Trust in upstream planning is explicit: "It sits downstream of the planning skills and trusts them" (line 93).

## 4. `implement-spec`: the beta sketch of the coordinator problem

The in-progress skill (read in full; 36 lines) is the closest thing to the coordinator loop in the set:

- Tickets are "a **task graph** with blocking relationships … there is always a **frontier** of tickets which are ready to be grabbed" (line 11) — the same frontier idea afk-kit's ontology carries (renamed from wayfinder's usage per ADR 0009).
- "Implementer subagents should be run in the background where possible for **maximum concurrency**" (line 15).
- Each implementer works "in its own worktree, on its own branch" (line 25); a **merger subagent** merges each into the spec PR branch (line 27); the frontier change kicks off more implementers (line 29); a `/code-review` pass and one fix subagent run at the end (line 31); worktrees are cleaned up (line 35).

What even this sketch lacks, structurally: it is one session's prompt doing the scheduling (no per-issue session isolation, ADR 0001), the frontier advance depends on the model re-deriving it each run (the drift ADR 0006 warns about), no confinement of implementers (they hold full credentials), no atomic claim (two `implement-spec` sessions on one spec would collide exactly as the field report describes), no verify-before-publish gate, no caps, no escalation semantics, and the human merge gate is unenforced.

## 5. Subagents elsewhere in the set

- **`code-review`** runs its two axes (standards, spec) as "parallel sub-agents so they don't pollute each other's context", then aggregates (`skills/engineering/code-review/SKILL.md` lines 3, 11). This is the pattern afk-kit's reviewer generalizes onto the pushed diff.
- **`wayfinder`** carries the AFK/HITL distinction — "Every ticket is either **HITL** … or **AFK**, driven by the agent alone" (line 75) — fires parallel research subagents onto throwaway branches (line 115), and uses a claim-before-work rule: "**Claim it**: assign it to yourself before any work" (line 123). afk-kit's Claim and Escalation vocabulary descends from this family of ideas (ontology Sources).

## 6. What a thin wrapper would and would not get

The proposed wrapper: create a worktree for an issue → launch pi with `implement` in it → push a branch → open a PR.

| Mechanism | Wrapper provides? | Notes |
| --- | --- | --- |
| Worktree + branch | yes, in the script | the "community workaround" made deterministic (`docs/engineering/implement.md` line 57) |
| Implementation loop (tdd, typecheck, suite) | yes — `implement` itself | the skill's genuine strength |
| Push + PR | yes, in the script | but unconditional: no verify re-run before publish |
| Agent review | only what `/code-review` gives | runs on the working tree pre-commit (empty-diff bug, lines 79–81), self-review bias (line 83) |
| Atomic claim (no double-claim) | **no** | nothing in the skills claims anything except wayfinder's prompt-level "assign it to yourself" |
| Readiness gate on the brief | **no** | fail-open issue resolution is documented (line 75); "trusts them" (line 93) |
| Implementer confinement | **no** | implement runs with full shell and credentials; nothing sandboxes it |
| Verify-before-publish | **no** | "the code lands before they have had a chance to verify it works" (line 61) — the wrapper reproduces this unless it re-runs verify itself |
| Caps on fix loops | **no** | no round/attempt ceiling exists anywhere in the set |
| Escalation semantics | **no** | no status comment, no label correction, no stop condition |
| Human merge gate (enforced) | **no** | nothing prevents the session from merging its own PR |
| Tracker lifecycle (labels, comments, close) | **no** | "never touches the work item" (line 53) — the frontier never advances by itself |

## Sources

- `mattpocock/skills` at commit `c55ee46073ed923f86ce59a5eb3b6d895095d1b7` (main, 2026-09-18): `skills/engineering/implement/SKILL.md`; `skills/in-progress/implement-spec/SKILL.md`; `skills/in-progress/README.md`; `skills/engineering/code-review/SKILL.md`; `skills/engineering/wayfinder/SKILL.md`; `skills/engineering/to-tickets/SKILL.md` (line 65, frontier); `docs/engineering/implement.md`; `docs/engineering/code-review.md`; `CLAUDE.md` (bucket/promotion policy).
- Pocock's framing in the repo README: the skills exist against frameworks (GSD, BMAD, Spec-Kit) that "take away your control and make bugs in the process hard to resolve"; they are "small, easy to adapt, and composable" (`README.md`, "Skills For Real Engineers").
