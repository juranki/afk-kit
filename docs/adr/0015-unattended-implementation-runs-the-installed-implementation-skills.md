# ADR 0015: Unattended implementation runs the installed implementation skills

- **Status:** Accepted
- **Date:** 2026-09-28

Attended implementation sessions in this repository work through the installed
implementation skills — `implement`, `tdd`, `codebase-design` ([ADR
0003](0003-wrap-matt-pocock-skills.md)). The engine's Implementer sessions ran with
skills discovery off (`noSkills: true`), so unattended implementation carried only a
one-line paraphrase of the test-first order and none of the skills' loop mechanics.
That divergence broke two things at once: the discipline's own standard
([code verify](../conventions/code-verify.md) named the installed `tdd` skill as the
mechanism), and the maintainer's feedback loop — intuition for a brief's
agent-readiness is built by watching attended sessions, and it transfers to unattended
runs only when both read the same text.

**Decision:** the Implementer session mounts the installed implementation skills at
the spawn seam. The pin is engine configuration — the role's definition frontmatter
names the skills (`skills:`), preflight resolves each name to its installed `SKILL.md`
through the SDK's own agent directory — so the engine sees exactly what an attended
session sees — and records the file's SHA-256 in the Run as evidence of the precise
text the session was given. The factory mounts them via `additionalSkillPaths` with
`noSkills: true`: discovery stays off, nothing ambient leaks into the confined
session, and the only skills present are the pinned ones. Reviewers mount nothing.
The Reviewer round and the publish gate are loop-owned steps: where a mounted skill's
text assigns work the loop owns elsewhere — reviewing the change, publishing it — the
Implementer definition says those steps are not the Implementer's. The mounted text
stays verbatim; the supersede is carried in the role's definition, which is its
contract.

**Considered options:** package-owned vendored copies of the skills — rejected: they
fork the wrapped set and end the parity that motivates this decision; the maintainer's
intuition loop is only honest while both halves read the same evolving text, and
forking re-introduces the drift [ADR 0003](0003-wrap-matt-pocock-skills.md) rejected
when it chose wrapping over forking. Keeping the paraphrase — rejected: it is the
discontinuity this decision retires. Enabling full skills discovery for engine
sessions — rejected: the host's whole skill set would vary an unattended run; the
spawn seam stays a closed world.

**Consequences:** a host running unattended implementation must have the pinned skills
installed — preflight refuses otherwise, as any unsafe start (a durable `refused`
Run). Upstream skill changes now arrive in unattended runs exactly as they already do
in attended ones — an accepted [ADR 0003](0003-wrap-matt-pocock-skills.md) consequence
— and each Run's evidence records which text it ran under. The skills arrive as
judgment, not enforcement: the loop still verifies outcome (verify commands, exit
codes), not the order tests were written in. The pin list lives with the engine
configuration and the flash-first model pins ([ADR
0004](0004-flash-first-model-routing.md)), validated at preflight beside the agent
definitions.
