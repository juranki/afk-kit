# Coordinator session

A Coordinator carries one ticket from the Maintainer's explicit command to a pull
request awaiting human review, then stops. The current runtime is a deterministic
Engine Run, governed by the [durable v0 specification](https://github.com/juranki/afk-kit/issues/46)
as amended for readiness by [ADR 0016](../adr/0016-agentic-readiness-and-prepared-brief.md).

## Commands

- `afk implement <issue-number>` — one Issue, bare integer only.
- `afk status [issue-number]` — observe Run state and evidence.

The Engine never chooses work autonomously or merges. Attended skills handle work
outside the ticket path. The source `skills/coordinator/SKILL.md` is an outgoing,
unpackaged historical artifact, not the runtime contract; its broader reconciliation
remains with [Task: reconcile the record — ADRs, ontology, AGENTS.md,
playbooks](https://github.com/juranki/afk-kit/issues/53).

## Before Claim

1. **Preflight and collection.** Validate deterministic start prerequisites. Gather
   the Issue body, all comments, native dependencies, relevant linked Issues/decisions,
   repository instructions, and targeted affected code/tests/docs once after
   invocation. Follow relevant links selectively, not through an unbounded crawl.
2. **Readiness check.** A separate package-owned read-only assessment agent evaluates
   the captured discussion for clear outcome, bounded scope/exclusions, meaningful
   verifiable criteria, necessary settled decisions, contradictions, understood
   dependencies, and concrete Verify commands. It uses Engine-mediated tracker reads
   and read-only repository access; no writes, tracker mutations, implementation, or
   Verify execution. Limit: 15 minutes within the overall Run budget; no cycle consumed
   and no automatic reassessment loop in v0.
3. **Persist and validate the handoff.** Ready produces one immutable
   [prepared Agent brief](../brief-template.md). Persist captured sources, identities,
   repository revision, assessment output, and the brief. Validate the agent's output
   structure deterministically, never source-author template syntax.
4. **Claim.** Only after Ready and live coordination safeguards pass: label/state
   checks, native open blockers, active Claim exclusion, and atomic Claim per
   [issue lifecycle](../conventions/issue-lifecycle.md). Do not repeat semantic
   assessment inside Claim. Create the branch/worktree per
   [branching and PRs](../conventions/branching-and-prs.md).

Read discussion as a whole: settled conclusions may emerge among suggestions and
rejected alternatives without special endorsement wording. Invocation is the
Maintainer's belief that intent is clear, not authority to invent missing decisions.
Missing headings and implementation details alone are not ambiguity. Differences
between current code and desired behavior normally describe the requested change;
unresolved scope, infeasibility, or conflicting governing constraints refuse.
Semantic dependency declarations must agree with native edges; disagreement refuses
with evidence, without silently editing edges. Live blocker status remains separate.

## Pre-Claim refusal

- **Needs clarification:** name specific unresolved alternatives, questions, or
  contradictions, with captured source references; no Claim.
- **Assessment failure:** unavailable relevant evidence, budget exhaustion, timeout,
  runtime failure, or malformed output; no Claim. Do not report tool failure as proof
  of missing human decisions.

Both are durable `refused` Runs. Readiness does not relabel the Issue or add a planning
gate. `ready-for-agent` expresses preparation/triage judgment, not guaranteed `afk`
acceptance. Surface known unavailable credentials/infrastructure preventing
verification; at least one concrete Verify command must be established, but assessment
neither runs it nor proves the baseline green.

## Delivery after Ready

The existing v0 delivery policy is unchanged:

1. Bootstrap a draft PR; keep the Ticket `in-progress`.
2. Launch at most three fresh Implementer sessions (one launch consumes one
   Implement–Review Cycle), confined to the Ticket worktree with local commits only.
3. Independently execute immutable Verify commands; on success push the additive
   candidate and run independent Standards and Spec Reviews. Both must approve.
4. Carry failed-cycle feedback into the next fresh Implementer; meaningful
   contradictions Escalate immediately rather than silently redefining intent.
5. On approval, hand off the ready PR to the Maintainer at the Merge gate; on failure
   or exhaustion, Escalate and preserve evidence and work artifacts.

Implementer and Spec Reviewer share the same prepared brief and access to captured
sources. Binding requirements remain distinct from guidance and assumptions: inspect
changed code, validate assumptions, and justify departures from guidance with evidence.
Spec Review cannot elevate assessor suggestions into Maintainer requirements.

The captured discussion and brief persist unchanged through the Run; there is no
later content-freshness comparison, invalidation gate, or automatic reassessment.
Live coordination safeguards, confinement, execution limits, independent Verify,
existing Reviewer machinery, and the human Merge gate remain intact. The
[durable v0 specification](https://github.com/juranki/afk-kit/issues/46) owns cycle,
Review, interruption, handoff, and Escalation details pending broader reconciliation.

## Implementation status

Semantic assessment ships through `engine/assessment.ts`, the package-owned
`readiness-assessor`, and bounded Engine-mediated evidence reads. See [implementation
evidence](../evidence/issue-84-readiness.md). `artifacts/readiness/` retains the source
snapshot/revision, streamed SDK events, structured assessment, prepared brief and its
hash. The legacy Run-root `brief.md`/hash retains only the initial Issue body;
it is not the prepared handoff. No prompt-facing template-check tool is installed.
The end-to-end proof Run remains with #52.
