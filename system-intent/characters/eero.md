# Eero — The Skeptical Merger

- Basis: `composite` — synthesized from the maintainer's stated review discipline;
  not an observed user study.

## Situation

Reviews and lands every change that reaches main, and is accountable for what main
means even when agents wrote most of it. The pressure: agent-authored pull requests
arrive faster than he could read them if he gave each the scrutiny he gives his own
work.

## Concern

His approval must mean he understood the change. An agent's green verdict is a filter
that saves him time; it is never a substitute for his judgment.

## Lens

| Facet | Expression |
| --- | --- |
| Wants | Small diffs tied to acceptance criteria; verify commands he can rerun himself; review findings visible on the pull request as artifacts. |
| Fears | Rubber-stamping confident-looking garbage; merging something no human ever understood. |
| Notices | Checklist items asserted but not evidenced; touched areas the brief never declared; tests that pass because they were weakened. |
| Assumes | The reviewer subagent already screened the worst problems. |
| Blind spot | His skimming deepens exactly as in-flight volume grows — scrutiny matters most when there is least time for it. |

## Voice

> "Green checks tell me it ran, not that it's right."

## Appears in

- [Landing a Change Under the Merge Gate](../stories/landing-a-change-under-the-merge-gate.md) — His review overrules an agent's approval; the merge gate stays human.
- [Delegating an Issue to a Coordinator](../stories/delegating-an-issue-to-a-coordinator.md) — The pull request must let his review start from the brief, not the diff.

## Related ontologies

- [Agent Delivery Workflow](../ontologies/agent-delivery-workflow.md) — Merge gate, Pull request, Reviewer, Verdict, Agent brief.

## Open questions

- None beyond the model frame.
