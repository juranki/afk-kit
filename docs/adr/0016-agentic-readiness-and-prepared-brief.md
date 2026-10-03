# ADR 0016: Agentic readiness and the prepared implementation brief

- **Status:** Accepted
- **Supersedes:** [ADR 0012](0012-brief-enforcement-readiness-check.md)
- **Source:** [Grilling: agentic readiness and the prepared implementation brief — confirmed resolution](https://github.com/juranki/afk-kit/issues/82#issuecomment-5960837807)

The body-only template check rejected clear intent while leaving semantic ambiguity
undetected. Readiness is now a judgment about the captured Issue discussion and
repository evidence, producing an immutable Agent brief before Claim. Human-owned
source intent remains authoritative; agent synthesis is a handoff artifact, not
permission to invent product decisions. This preserves [ADR 0006's
judgment/mechanics principle](0006-extensions-for-mechanics-skills-for-judgment.md):
semantic assessment stays prompt-driven; collection, output validation, live
coordination safeguards, and the delivery loop stay deterministic.

## Assessment contract

After invocation, collect the Issue body, all comments, native dependencies, relevant
linked Issues/decisions, repository instructions, and targeted affected code, tests,
and docs. Follow links selectively for intent, scope, dependencies, and verification;
no unbounded crawl or architectural audit. Assess the discussion as a whole for a
clear conclusion, not special Maintainer endorsement wording. Historical suggestions,
rejected options, and absent headings do not themselves block readiness. Invocation
expresses the Maintainer's belief that the Issue is clear, not authority to invent a
conclusion.

Assess outcome, bounded scope/exclusions, meaningful verifiable acceptance criteria,
settled necessary decisions, contradictions, understood dependencies, and concrete
Verify commands. Current code differing from requested behavior is normally the
change, not a blocking contradiction. Missing implementation detail alone is not a
reason to refuse; unresolved scope choices, infeasibility, conflicting governing
constraints, or meaningful unresolved alternatives are. Semantic dependency
declarations must agree with native edges: disagreement refuses with evidence, never
silently edits edges. Live blocker status is a separate deterministic safeguard.

Use a separate package-owned read-only assessment agent session, with Engine-mediated
tracker reads and read-only repository access. It cannot edit files, mutate tracker
state, implement, or execute Verify commands. Its budget is 15 minutes, also bounded
by the overall Run limit; it consumes no Implement–Review Cycle. v0 has no automatic
reassessment loop.

Outcomes:

- **Ready:** a concise, complete, repository-grounded prepared Agent brief.
- **Needs clarification:** specific unresolved questions/contradictions with source
  references; refuse before Claim.
- **Assessment failure:** unavailable relevant evidence, exhausted budget, timeout,
  runtime failure, or malformed output; also refuse before Claim. Diagnostic failure
  is not proof of missing human decisions.

## Handoff and snapshot

The [brief standard](../brief-template.md) defines contents and provenance. Derive
acceptance criteria only as testable consequences of settled intent. Discover Verify
commands from repository guidance/configuration with provenance; establish at least
one concrete command. No baseline-green proof or command execution is required at
readiness. Surface known unavailable credentials/infrastructure preventing verification.

Persist gathered sources, source references/identities, repository revision,
assessment output, and one immutable prepared brief. Collect once after invocation;
carry that captured context through the Run. There is no later content-freshness
comparison, content-change invalidation gate, or automatic reassessment.

Implementer and Spec Reviewer receive the same brief and access to captured evidence.
Binding intent, scope, criteria, constraints, and established Verify commands are
separate from non-binding repository findings, likely touch points, suggested
approaches, and assumptions. The Implementer inspects changed code and validates
assumptions; it may depart from guidance with evidence, not alter requirements.
Later meaningful contradictions Escalate. Spec Review cannot promote assessor
recommendations into Maintainer requirements. The Engine executes immutable Verify
commands independently after implementation.

Deterministic label/state checks, active Claim exclusion, native blocker checks,
atomic Claim, confinement, execution limits, independent Verify, and the human Merge
gate remain. Deterministic output validation checks the agent's artifact, not the
Issue author's formatting. Existing Reviewer machinery is unchanged except for its
prepared-brief/evidence input boundary.

## Preparation and consequences

Wayfinder, to-spec, and to-tickets prepare Issues; triage processes other incoming
Issues. `ready-for-agent` records that preparation/triage judgment, not guaranteed
acceptance by `afk`. No mandatory assessment/comment or two-pass planning label gate
is added. Known open blockers remain a separate Claimability concern.

**Considered options:** retain source-template enforcement — rejected because syntax
is not readiness; require a new planning assessment gate — rejected because it
duplicates preparation; freshness checking and automatic reassessment — not adopted
in v0, which intentionally carries one captured discussion through the Run.

This decision replaces only the body-only brief/readiness assumptions of the
[durable v0 specification](https://github.com/juranki/afk-kit/issues/46). Its cycles,
independent Verify and Reviews, and human Merge gate remain unchanged. Readiness
implementation follows [Task: implement and verify agentic readiness and prepared
briefs](https://github.com/juranki/afk-kit/issues/84); broader post-proof pivot
reconciliation remains with [Task: reconcile the record — ADRs, ontology, AGENTS.md,
playbooks](https://github.com/juranki/afk-kit/issues/53).
