# Review and escalation

The review loop, its caps, and what happens when work cannot proceed. Implements the
ontology's escalation invariants; the numbers here are policy ([ADR 0006](../adr/0006-extensions-for-mechanics-skills-for-judgment.md)
anticipates them becoming deterministic guardrails).

## The review leg

- Input: the **pushed** pull-request diff (post-push review; whether an additional
  pre-push round adds value is an open question in the model frame).
- The `reviewer` subagent (`glm-5.3`) may run the brief's verify commands and returns a
  structured verdict: **approve**, or **request-changes** with severity-ranked findings.
  The verdict's wire format — the fenced JSON block and its schema, including the
  `blocker`/`major`/`minor` severity ladder and unparseable-as-escalation — is owned by
  the toolkit's fork: [`extensions/subagent/verdict.ts`](../../extensions/subagent/verdict.ts)
  and the [reviewer agent definition](../../extensions/subagent/agents/reviewer.md)
  ([ADR 0007](../adr/0007-vendored-subagent-mechanism.md), ticket #18).
- Findings go to a fresh implementer in the same worktree; the fix is pushed; the
  reviewer reviews again.

## Caps

| Bound | Value | Applied to |
| --- | --- | --- |
| Issues in flight | 3 | Coordinator sessions the maintainer runs in parallel. Self-enforced. |
| Automatic review rounds | 2 | Reviewer request-changes → implementer fix cycles per pull request. |
| Failed implementer attempts | 3 | Verify-command failures on the same ticket before escalation. |

## Escalation

Triggered by: the attempt cap; the round cap with findings unresolved; or anything the
coordinator cannot decide. Escalation behavior, in order:

1. **Status comment on the issue** — what was tried, what broke, where the worktree
   and branch are. Always.
2. **Label correction** — `needs-info` if a maintainer decision is missing;
   `ready-for-agent` if the brief is fine and the failure is technical.
3. **Preserve the worktree and branch** — nothing is deleted or reset.
4. **Report to the maintainer** — the coordinator session surfaces the escalation and
   stops touching the ticket.

A coordinator never silently abandons a ticket, and never rewrites a brief to make a
failure disappear.

## The merge gate

- A pull request reaches the maintainer only after a reviewer approval — the reviewer
  is a filter, so human attention lands on clean work.
- The maintainer reviews and may overrule the agent's approval for any reason; their
  review is recorded on the pull request ([ADR 0002](../adr/0002-human-merge-gate.md)).
- Only the maintainer merges. Once merged, the issue closes and the coordinator's
  worktree may be removed.
