# ADR 0012: The coordinator skill carries judgment; an agentic review catches drift

- **Status:** Accepted
- **Date:** 2026-09-19

The coordinator loop ships as skill text (judgment stays prompt-driven, per
[ADR 0006](0006-extensions-for-mechanics-skills-for-judgment.md)), and the split of the
[coordinator playbook](../playbooks/coordinator-session.md) is this: the `coordinator`
skill carries, as self-contained judgment text, the three commands (`implement #<n>`,
`review PR #<n>`, `status`), the loop's steps as shape with each step's mechanics
delegated, the hard rules (never merges, never claims twice, never edits the brief, the
implementer never publishes, the coordinator writes no implementation code), the
coordinator-side caps (2 automatic review rounds, 3 failed implementer attempts), the
escalation procedure, the stop condition, and an instruction to read the target
repository's agent configuration first. It omits the maintainer's 3-in-flight cap (that
is the maintainer's self-enforced session count, not the coordinator's behavior), all
per-repo mappings (label strings, branch/worktree/pull-request shapes, the brief
template), and every mechanical step (atomic claim, merge refusal) that belongs to
extension code per [ADR 0006](0006-extensions-for-mechanics-skills-for-judgment.md) and
[ADR 0011](0011-merge-guard-session-bound-client-side-enforcement.md) — the skill names
those by pointer. Model pins stay in the agent definitions per
[ADR 0004](0004-flash-first-model-routing.md); the skill names the `implementer` and
`reviewer` agents, never their models.

The conventions and the playbook remain canonical for humans; the skill is their
runtime form, not their replacement. Because carried text drifts from canon, drift is
caught mechanically — but not by a token list. Inside `bun run verify`
([ADR 0010](0010-retire-the-design-only-policy.md)'s toolkit discipline; the verify
layers of the code-verify standard), a **minimal agentic drift review** runs
change-gated: the script hashes the corpus — the coordinator skill, the workflow
conventions, and the coordinator playbook — against a committed hash record, and when
anything moved, spawns a `glm-5.3-flash` reviewer whose prompt cites this ADR as the
copy contract, states that the docs are canonical, and requires a strict JSON verdict:
`agree`, or `drift` with findings naming the skill claim and the doc it conflicts with.
A `drift` verdict fails verify with the findings printed; unparseable output fails
loudly. There is no maintained list of quoted tokens anywhere.

**Considered options:** a token-list consistency test (assert the skill's caps, label
strings, and command names match the conventions) — rejected: the list itself rots and
must be hand-maintained on every legitimate policy change, the exact brittleness it
exists to guard against, and it only ever catches the drift someone thought to list;
runtime reads of the conventions from the installed package clone (git installs land
the whole repo at a stable path) — rejected: it scatters the judgment across file reads
that target-repo sessions must not depend on, and leaves the skill non-self-contained;
generating the skill body from the docs at build time — rejected: it ossifies
judgment-carrying text behind a generator and hides the runtime form from the humans
who edit the docs; running the review in CI — rejected: outside the model frame's
boundary, and this repo has none.

**Consequences:** a model verdict can flake; a false positive blocks verify until the
wording is adjusted or the check re-run, and the existing failed-attempt cap and
escalation convention bound that loop — no special handling is added. The drift review
is afk-kit-internal: it verifies afk-kit's own docs, ships in afk-kit's verify, and is
never seen by target repositories. The ontology is not in the review corpus — the
conventions already implement its invariants, and ontology coherence remains the
system-intent modeling discipline's job, not a verify script's. The pattern (skill
carries judgment and safety-critical bounds, docs stay canonical, agentic review pins
their agreement) is the template for every judgment-carrying skill this package ships.
The implementation — the skill itself and its drift review — lands with the coordinator
skill v1 ticket on the implementation map.
