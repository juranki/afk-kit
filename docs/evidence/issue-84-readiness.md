# #84: agentic readiness verification

Implements [#84](https://github.com/juranki/afk-kit/issues/84) against ADR 0016 and
[#82's confirmed resolution](https://github.com/juranki/afk-kit/issues/82#issuecomment-5960837807).
This is assessment/Engine evidence, not #52's end-to-end proof Run or permission to merge.

## Test-first receipts

Observed red tests before their passing implementations:

- `engine/readiness.test.ts`: no assessment validator module, then grounded structured
  handoff validation, malformed/unreferenced output refusal and dependency discrepancies.
- `engine/evidence.test.ts`: no collection module; later the explicit linked-decision/native
  dependency test failed until first-hop decision/prerequisite collection was implemented.
  A later-page failure test also exposed lost earlier comment pages; bounded tracker
  response receipts now retain gathered pages and identities before any later failure.
- `engine/implement.test.ts`: a non-template request stopped at readiness instead of
  reaching live Claim; now comments establish a separate prepared brief before Claim.
- `engine/assessment.test.ts`: delayed reads changed the snapshot after timeout; now
  cancellation/closure freezes captured evidence. Repeated assessment formerly overwrote
  sources and threw EEXIST; now it refuses without a second collection or changed artifacts.
- `engine/agent-runner.test.ts`: the SDK session exposed the intended tools but received
  pi's generic coding prompt; explicit loader initialization now installs the package role.
- `engine/claim.test.ts`: live open blockers/changed labels/closed state, including an
  open blocker beyond truncated native edges, could Claim; all now refuse before writes.
- `engine/pr-ops.test.ts`: PRs re-derived requirements from the mutable body, then still
  re-read that body; now prepared requirements and only live title/labels are consumed.
- `engine/prompt.test.ts`: guidance authority was unspecified; both roles now share the
  brief/evidence and explicitly keep guidance non-binding and later contradictions Escalated.
- `engine/cycle.test.ts`: Verify ignored structured commands; now established commands
  execute verbatim, including shell backticks, independently of Markdown projections.
  A declared binding-intent contradiction formerly retried three cycles; it now returns
  the existing `escalate` Cycle outcome immediately, preserving ordinary failure/cap policy.
- `engine/config.test.ts`: assessor implementation capabilities passed preflight; now the
  role/model/thinking/tool pins are checked and only `read_evidence` is allowed.
- `extensions/readiness/gh.test.ts`: truncated edges were incomplete and cancellation
  failed to terminate a tracker subprocess; pagination and abortable reads now pass.
- `package.test.ts`: the obsolete template-check tool was still installed; it is retired.

L2 uses real Git/local bare remotes, PATH-shimmed gh, scripted SDK sessions and the
existing fake confinement port. `engine/composition.test.ts` proves the same persisted
brief/evidence reaches Implementer and Spec Reviewer, independent Verify succeeds,
no Issue-body freshness read occurs, existing handoff/escalation exits remain 0/2/3,
and no Merge operation is introduced. Refusals retain evidence without Claim or cycles.

## L3: real package-owned assessment sessions

Executed with Bun 1.4.2, pi SDK 0.85.1, `zai/glm-5.3`, high thinking:

```bash
bun scripts/readiness-smoke.ts --fixtures
bun scripts/readiness-smoke.ts 84
```

| Input | Expected / observed | Captured sources | Model tool calls |
| --- | --- | --- | --- |
| Non-template greeting request, historical configurable/name alternatives rejected in comments; current code/test says Goodbye, conclusion says Hello | Ready / Ready | 6 | 2 × `read_evidence` |
| Meaningful Hello/Hola choice explicitly still open | needs-clarification / needs-clarification | 6 | 2 × `read_evidence` |
| Clear greeting change but discussion says wait for #83 absent from native edges | needs-clarification / needs-clarification | 6 | 2 × `read_evidence` |
| Real juranki/afk-kit#84 at `43dd670ef1694116819c65129c9f4c7b4e6ede63` | Ready / Ready | 14 | 6 × `read_evidence` |

The real-tracker assessment captured #84/body/comments/native edges, closed predecessor
#83, the full #82 discussion/confirmed decision, root instructions and entry-point docs,
ADR 0016, implementation requirements, code-verify guidance and targeted Engine/readiness
code. The fixture sessions also read the actual greeting source and test. Their
repository status remained unchanged; tracker argv contained only Engine-owned API GET
reads. SDK boundary tests independently assert the active tool set is exactly
`[read_evidence]`, with no edit/write/bash/Verify or ambient extension capability.

Raw receipts (owner-only directories on the execution host):

| Scenario | Evidence directory | SHA-256 of complete SDK event stream |
| --- | --- | --- |
| settled | `/tmp/afk-readiness-settled-MJF4kY` | `e44cacd650f76d11d8b9d27bf34477cf55aec0a2a64f3b125f914d929f038d5e` |
| unresolved | `/tmp/afk-readiness-unresolved-JBFi4v` | `2e7fef7c96ed61b946f2e5d8ae4bc32b1c76a73fc9d4b0b0b9f74dc16b040ce5` |
| missing edge | `/tmp/afk-readiness-missing-edge-bruIGr` | `9b341a0fbd1007042130ec9651cd90f6ba59510b37f97c9862c3265af8ddaef7` |
| real #84 | `/tmp/afk-readiness-smoke-rQllR8` | `9931b730f49a9e0c61c66a00d30519b37c03f9ad41941ca669a9f35c41d0170d` |

Each contains source contents/identities/revision, raw and validated assessment output,
streamed session evidence, and (for Ready) the prepared brief and hash. Engine Runs
retain these under `artifacts/readiness/`, outside repositories. The Run-root legacy
`brief.md`/hash is only the initial Issue-body source snapshot, never the handoff.
No content-change comparison or automatic reassessment is added.

## Limits and verification

Collection is bounded to 64 captured sources / 2 MB source contents; full discussion
pagination is bounded and never silently truncated. Native prerequisites and directly
cited decision-comment links are first-hop reads; other linked Issues and tracked
repository files are collected selectively through cached Engine reads. Unsupported or
unavailable relevant evidence is an assessment failure, never authority to proceed.
Assessment (including collection/session creation) has a 15-minute maximum, additionally
bounded by the remaining Run deadline; timeout cancels tracker/repository reads and
aborts the session, without Claim or implementation-cycle consumption.

Canonical `bun run verify`: **PASS** — final sweep: 406 tests across 33 files,
1,447 assertions; the initial complete sweep passed 404 tests / 1,441 assertions;
Biome checked 75 files; Knip passed; the change-gated drift reviewer agreed and
refreshed `scripts/drift-corpus.sha256`. The first full invocation hit the harness's
120-second command limit while the model-backed drift review was still running;
the complete rerun with a sufficient command timeout passed all stages.

Ad-hoc TypeScript checking was run repeatedly against changed entry points and a clean
`main` archive. The repository has no configured typecheck gate; transitive baseline
errors already exist (missing types, strict nullability, confinement/SDK signatures).
No new assessment/collection/validator errors remain; the runner's stale spawn type,
missing definition body, and optional assistant-text mismatch were corrected. These
baseline diagnostics are not hidden as a successful repository-wide typecheck.
The final ad-hoc transitive check reported 35 diagnostics versus 41 on clean `main`.

## Independent code review

Fixed point: `43dd670ef1694116819c65129c9f4c7b4e6ede63` (origin/main).
Separate fresh read-only Standards and Spec subagent sessions reviewed the complete
branch diff in parallel on `zai/glm-5.3`, high thinking. Both approved, with no blocking
findings. Standards identified a stale confinement-smoke anchor (fixed) and non-blocking
refactoring heuristics; Spec identified an artifact reference that could name an absent
source file on early budget refusal (fixed by referencing the existing stage directory).
Review-stage tests additionally hardened partial-page evidence retention and explicit
post-Claim contradiction Escalation. A final pass reviews those deltas before PR handoff.
