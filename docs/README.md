# afk-kit documentation

This is the entry point for deciding where workflow information belongs and where to
find its canonical form. Follow links rather than copying claims between artifacts.

Nothing in this repository is implemented yet: playbooks describe how sessions are
*intended* to run once the skills and extensions exist; today the workflow is run by
hand, using the installed skills directly.

## Find information by task

| Question or task | Canonical home | Start here |
| --- | --- | --- |
| Why this workflow exists, what it covers, whose concerns shape it | System intent | [Model frame](../system-intent/README.md) |
| What a workflow term means or which invariant governs it | Ontology | [Agent Delivery Workflow](../system-intent/ontologies/agent-delivery-workflow.md) |
| How to run a planning session (tickets in, ready-for-agent out) | Playbooks | [Planning session](playbooks/planning-session.md) |
| How to run a coordinator session (one issue, command to pull request) | Playbooks | [Coordinator session](playbooks/coordinator-session.md) |
| Which label or state an issue carries, and who may move it | Conventions | [Issue lifecycle](conventions/issue-lifecycle.md) |
| How branches, worktrees, and pull requests are named and shaped | Conventions | [Branching and PRs](conventions/branching-and-prs.md) |
| What happens on review findings, repeated failure, or a blocked ticket | Conventions | [Review and escalation](conventions/review-and-escalation.md) |
| What a ready-for-agent issue must contain | Brief standard | [Agent brief template](brief-template.md) |
| What the subagent mechanism must do (baseline for [ADR 0007](adr/0007-vendored-subagent-mechanism.md)) | Requirements | [Subagent mechanism](requirements/subagent-mechanism.md) |
| Where the engineering skills' per-repo configuration lives | Agent skills | [`docs/agents/`](agents/) |
| Why a load-bearing choice was made | ADRs | [Decision index](adr/README.md) |

## Placement rules

- Domain meaning and invariants live in the ontology, never in playbooks or conventions.
- Numbers that are policy, not domain truth (caps, label strings, naming patterns), live
  in conventions and ADRs.
- Session-level judgment (what to do when) lives in playbooks; anything that must happen
  identically every time is destined for extension code once implementation begins.
- Per-repo configuration consumed by the installed engineering skills — issue tracker,
  triage labels, domain-doc routing — lives in `docs/agents/` (see
  [ADR 0008](adr/0008-system-intent-shape-as-domain-doc-convention.md)).
