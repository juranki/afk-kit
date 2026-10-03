# #87: selective governing instruction capture

Follow-up to [#84](https://github.com/juranki/afk-kit/issues/84), implementing
[#87](https://github.com/juranki/afk-kit/issues/87) under ADR 0016. The Maintainer
requested the existing `issue-84-task-implement-and-verify` branch and checkout.
Review fixed point: `457f32b45b252949f4ba46042a6c6aa53e55ff32`.

## Test-first receipts and coverage

Observed failures before the corresponding passing implementations:

- The start fixture with 70 unrelated nested `AGENTS.md` files captured unrelated
  sources and exhausted the 64-source budget. After limiting eager capture to root
  instructions and existing entry points, it prepares a grounded Agent brief and
  reaches the live Claim safeguard; the existing Claim still refuses without writes
  or an Implement–Review Cycle.
- Concurrent relevant-file reads initially omitted intermediate and nearest-directory
  instructions. Ancestor capture now completes before a relevant read succeeds.

The real-Git, stubbed-GitHub L2 fixtures additionally prove revision-pinned file and
instruction contents despite changed checkout files, tracked-inventory-only discovery,
shared ancestor/cache deduplication, sibling/descendant exclusion, explicit selective
instruction reads, absent instruction tolerance, and recoverable failures on required
instruction reads or genuine source/byte exhaustion. Required instructions governing
`docs/README.md` are included before assessment; unavailable instructions refuse before
Claim. Composition preserves governing evidence in the same immutable Agent brief
received by Implementer and Spec Reviewer, separately from non-binding guidance.

Pagination tests cover complete multi-page collection, short-page termination,
malformed responses, the 100-page bound, tracker byte-budget refusal, and earlier
comment-page receipts surviving a later failure. Both collection paths now use one
bounded helper. The shared Ready builder accepts captured source IDs, an established
Verify command with provenance, and explicit scenario overrides; assessment, start,
and composition retain their distinct behavior. L1 validates the grounded builder
output through the existing assessment validator.

## Verification

Executed with Bun 1.4.2:

- `bun install && bun run verify`: **PASS** — 421 tests across 33 files, 1,535
  assertions; Biome checked 76 files; Knip passed; the unchanged five-file drift
  corpus skipped model review.
- Targeted suites were run repeatedly during implementation and refactoring.
- Ad-hoc TypeScript checking of `engine/evidence.ts`, `extensions/readiness/gh.ts`,
  and `extensions/readiness/pagination.ts`: **PASS**.
- The broader ad-hoc check including touched tests reports 36 transitive diagnostics,
  exactly matching a clean archive of the starting commit. The repository has no
  configured typecheck gate; existing SDK, confinement, missing-type, and nullability
  errors are not reported as a successful repository-wide typecheck.

No package-owned SDK session or evidence-tool boundary changed, so no new L3 model
smoke was required. No proof Run, reassessment gate, budget increase, or Merge operation
was introduced.

## Independent code review

Two fresh read-only `zai/glm-5.3`, high-thinking sessions reviewed the complete change
in parallel, with only read/search tools enabled:

- **Standards: approve.** No documented-standard violations. Non-blocking heuristics
  concerned repeated Git fixture setup, string-valued pagination failure messages,
  inline entry-point naming, and the ancestor path-segment name. The reviewer also
  noted consumer-level coverage and helper placement as judgement calls, not breaches.
- **Spec: approve.** No blocking defects or scope creep. Non-blocking notes concerned
  then-pending canonical verification (completed above), entry-point ancestor capture,
  and duplicate failure strings from nested read propagation (existing fail-closed
  behavior retained).

Development receipts on the execution host: `/tmp/afk-87-verify.log`,
`/tmp/afk-87-standards-review.log`, `/tmp/afk-87-spec-review.log`, and
`/tmp/afk-87-{baseline,current}-types.log`. Only the Maintainer merges.
