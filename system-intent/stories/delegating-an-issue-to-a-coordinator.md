# Delegating an Issue to a Coordinator

- Basis: `composite` — an illustrative scene synthesized from the maintainer's stated
  delegation practice.

## Scene

Morning. Salla opens a coordinator session for tenant-kit and says "implement #12".
The coordinator claims the ticket — assignment and `in-progress` land together —
creates a worktree and branch, and delegates to an implementer confined to that
worktree. The verify commands pass; the branch is pushed; a pull request opens carrying
the brief's acceptance criteria as a checklist; a reviewer returns approve after one
round of minor findings. The coordinator stops and asks for review. Riitta, watching
the spend, notices that nothing needed her attention between the command and the pull
request.

## User stories

1. **As Salla, a context-protecting maintainer, I want a coordinator to act only when I command an issue so that no work starts without me.**

2. **As Salla, I want the claim visible on the tracker so that a second coordinator never duplicates the work.**

3. **As Riitta, a cost-wary operator, I want the implementer confined to the worktree with no publishing ability so that nothing leaves the machine unreviewed.**

4. **As Salla, I want the pull request to carry the brief's acceptance criteria as a checklist so that review starts from the brief, not the diff.**

5. **As Salla, I want the coordinator to stop and request my review after approval so that landing remains my act, not the loop's.**

## Characters

- [`Salla`](../characters/salla.md) — Commands the coordinator, then stays away.
- [`Riitta`](../characters/riitta.md) — Watches that the loop stays bounded and confined.

## Ontology touchpoints

- [`Agent Delivery Workflow`](../ontologies/agent-delivery-workflow.md) — Coordinator, Claim, Worktree, Implementer, Verify commands, Reviewer, Verdict, Pull request, Merge gate.

## Open questions

- The spawning mechanics, per-subagent working directory, and tool confinement depend
  on the mechanism selection (see the model frame's open questions).
