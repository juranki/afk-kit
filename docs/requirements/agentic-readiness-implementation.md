# Agentic readiness implementation seams

This is a navigation/handoff record for [Task: implement and verify agentic readiness
and prepared briefs](https://github.com/juranki/afk-kit/issues/84), not an alternate
specification. The implementation is now carried by #84; see [shipped verification
evidence](../evidence/issue-84-readiness.md). The table below preserves the record
update's original seam inventory, not a replacement runtime contract. [ADR 0016](../adr/0016-agentic-readiness-and-prepared-brief.md),
the [brief standard](../brief-template.md), and the [confirmed
resolution](https://github.com/juranki/afk-kit/issues/82#issuecomment-5960837807)
own the contract. No assessment code or proof Run is part of the record update.

## Current seams to reconcile

| Surface | Existing assumption / successor work |
| --- | --- |
| `engine/implement.ts`, `extensions/readiness/gh.ts` | Body-only collection/check becomes captured discussion and targeted repository evidence plus a read-only assessment before Claim. Keep deterministic start and live coordination checks separate. |
| `extensions/readiness/{brief,check,index}.ts`, `package.json` pi extension entry | Source-template parser/tool still implements superseded ADR 0012. Reconcile its public description and behavior with semantic readiness, without adding a planning gate. Artifact structure validation is not source-author validation. |
| `engine/agents/`, `engine/preflight.ts`, `engine/agent-runner.ts`, `engine/seams.ts` | Introduce the separate package-owned read-only assessor session and Engine-mediated tracker reads; pin/validate required resources at package paths. Bound assessment to 15 minutes and the Run limit, with no Verify execution or implementation capability. |
| `engine/runs/{store,events,projection,status,reconcile}.ts` | The existing immutable body snapshot/hash must distinguish captured sources, identities, revision, assessment output, and the prepared brief. Preserve evidence for all pre-Claim refusal classes; no content-freshness or reassessment gate. |
| `engine/prompt.ts`, `engine/agents/{implementer,spec-reviewer}.md` | Same prepared brief and captured evidence to both roles; mark binding requirements versus guidance. Implementer validates assumptions and may depart from guidance with evidence; Spec Review cannot promote recommendations into requirements. |
| `engine/{cycle,review,drive,pr-ops}.ts` | Consume prepared criteria/Verify commands rather than re-deriving contracts from mutable Issue bodies. Independent Verify, Review machinery, cycles, handoff, and Merge gate remain unchanged. |
| `README.md`, package description, agent definitions, tests | Explain actual shipped behavior after implementation. Reconcile body-only examples/fixtures and readiness diagnostics under test-first code verification; do not mistake this documentation contract for implementation evidence. |

The listed paths are navigation hints, not a mandated module layout or binding list
of touched files. Implementation must inspect actual code and follow the
[code verify standard](../conventions/code-verify.md).

## Durable v0 specification amendment

The [durable v0 loop specification](https://github.com/juranki/afk-kit/issues/46)
originally treated the Issue body as the immutable brief and retained deterministic
readiness parsing. Those assumptions are replaced by the
[confirmed agentic readiness resolution](https://github.com/juranki/afk-kit/issues/82#issuecomment-5960837807)
and ADR 0016: one captured discussion/evidence set and one prepared immutable brief,
with semantic assessment before Claim. This is an amendment, not a rewrite of the
original resolution or its cycle/Verify/Review/Merge-gate policies.

Broader pivot retirement records, historical Coordinator skill reconciliation, and
unrelated lifecycle/cap documentation remain with [Task: reconcile the record — ADRs,
ontology, AGENTS.md, playbooks](https://github.com/juranki/afk-kit/issues/53).
