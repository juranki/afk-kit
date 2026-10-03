# afk-kit documentation

This is the entry point for deciding where workflow information belongs and where to
find its canonical form. Follow links rather than copying claims between artifacts.

The toolkit is implemented here ([ADR 0010](adr/0010-retire-the-design-only-policy.md)).
The Engine CLI exists; semantic readiness is a confirmed contract awaiting its
implementation successor. Playbooks distinguish this contract from shipped behavior;
the broader pivot record and proof Run remain in progress.

## Find information by task

| Question or task | Canonical home | Start here |
| --- | --- | --- |
| Why this workflow exists, what it covers, whose concerns shape it | System intent | [Model frame](../system-intent/README.md) |
| What a workflow term means or which invariant governs it | Ontology | [Agent Delivery Workflow](../system-intent/ontologies/agent-delivery-workflow.md) |
| How to run a planning session (tickets in, ready-for-agent out) | Playbooks | [Planning session](playbooks/planning-session.md) |
| How to run a coordinator session (one issue, command to pull request) | Playbooks | [Coordinator session](playbooks/coordinator-session.md) |
| Which label or state an issue carries, and who may move it | Conventions | [Issue lifecycle](conventions/issue-lifecycle.md) |
| How branches, worktrees, and pull requests are named and shaped | Conventions | [Branching and PRs](conventions/branching-and-prs.md) |
| How afk-kit's own code is proven — test-first order, layers, toolchain | Conventions | [Code verify standard](conventions/code-verify.md) |
| What happens on review findings, repeated failure, or a blocked ticket | Conventions | [Review and escalation](conventions/review-and-escalation.md) |
| How human source intent becomes an immutable prepared handoff | Brief standard | [Agent brief standard](brief-template.md) |
| How semantic readiness is assessed before Claim | ADR / playbook | [ADR 0016](adr/0016-agentic-readiness-and-prepared-brief.md), [Coordinator session](playbooks/coordinator-session.md) |
| Which runtime/package seams must adopt the readiness contract | Implementation requirements | [Agentic readiness implementation](requirements/agentic-readiness-implementation.md) |
| What the retired subagent mechanism had to do (historical baseline for deprecated [ADR 0007](adr/0007-vendored-subagent-mechanism.md)) | Requirements | [Subagent mechanism](requirements/subagent-mechanism.md) |
| How the Coordinator runs in v0; outgoing skill status | Playbook / Engine | [Coordinator session](playbooks/coordinator-session.md), [`engine/`](../engine/) |
| Where the engineering skills' per-repo configuration lives | Agent skills | [`docs/agents/`](agents/) |
| Why a load-bearing choice was made | ADRs | [Decision index](adr/README.md) |

## Placement rules

- Domain meaning and invariants live in the ontology, never in playbooks or conventions.
- Numbers that are policy, not domain truth (caps, label strings, naming patterns), live
  in conventions and ADRs.
- Session-level judgment (what to do when) lives in playbooks; anything that must happen
  identically every time is destined for extension code once implementation begins.
- For still-shipped judgment-carrying skills, a playbook's runtime form never replaces
  its canonical documentation
  ([ADR 0013](adr/0013-coordinator-skill-carries-judgment-agentic-drift-review.md)):
  edit the playbook first, then reconcile its runtime form. The outgoing Coordinator
  skill is no longer packaged; the legacy drift-review script still compares its
  source with these docs. Broader source/check reconciliation stays with the post-proof
  pivot ticket, rather than making historical skill text override ADR 0016.
- Per-repo configuration consumed by the installed engineering skills — issue tracker,
  triage labels, domain-doc routing — lives in `docs/agents/` (see
  [ADR 0008](adr/0008-system-intent-shape-as-domain-doc-convention.md)).
