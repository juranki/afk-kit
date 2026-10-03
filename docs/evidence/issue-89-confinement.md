# Issue #89: confined Go verification and Git proof

Executed 2026-10-03 on Linux 6.12.111, Go 1.27.1, GCC 14.2.0, Bun 1.4.2,
with the pinned `@anthropic-ai/sandbox-runtime` 0.0.77 and real bubblewrap/network
isolation. This is a host-capability smoke, not a model session or end-to-end Run.

## Before and after

The added real Git probe first reproduced an unchanged tracked `.env.example` as
modified, followed by `unsupported file type` / `cannot hash .env.example`. The
cold external-module probe first failed with `proxy.golang.org ... Forbidden`.
Allowlisting revealed srt's overridden `/tmp/claude` breaking cgo; redirecting the
inner shell's temporary directory fixed it. A deterministic cleanup regression
reproduced `EACCES` on Go's read-only module directories before disposal was fixed.

Review found declaration authority missing and unsafe metadata aliases. Added
regressions initially rejected the old automatic-example exemption and detected
post-initialization alias changes; captured explicit permissions and alias checks
now pass. Repository policy is documented in [ADR 0017](../adr/0017-declared-confinement-and-tool-scratch.md)
and the [setup convention](../conventions/implementer-confinement.md).

## Live verification

`bun run confinement:smoke` passed all 17 probes:

```text
PASS write inside worktree
PASS refuse write outside worktree
PASS refuse writes to HOME
PASS refuse writes to another Run
PASS host Git configuration and credentials remain unreadable
PASS refuse sensitive read
PASS tracked example and isolated Git config stay clean
PASS reach allowlisted domain
PASS refuse non-allowlisted domain
PASS confined staging and local commits use Engine identity
PASS designated caches and temp are writable outside the worktree
PASS cold Go dependency and verification
PASS Go caches do not dirty the tracked worktree
PASS preserve normal exit code
PASS Preflight checks Go acquisition and build before a cycle
PASS Preflight rejects unsupported Go with actionable diagnostics
PASS untracked examples remain protected
```

The disposable repository declares the three Go hosts and `.env.example` explicitly.
It verifies `github.com/google/uuid@v1.6.0` and a tiny C function using
`CGO_ENABLED=1 go test -mod=mod ./...`, with fresh task build/module caches. No host
module cache, credentials, or pre-provisioned dependencies are used. Fixture
`go.sum` generation is ignored intentionally; tracked sources and Git status stay
clean. Confined staging and commits use the local `AFK Engine` identity. Positive
Preflight repeats acquisition/native build in a fresh scratch task; negative
Preflight declares Go 999.0 and refuses before any implementation cycle.

Focused TypeScript checking of confinement, policy, Preflight and the smoke passes.
The repository has no canonical typecheck command; broad checking also encounters
existing errors in unrelated agent-runner, drive and Verify code. Deterministic
verification remains `bun install && bun run verify`, separate from this live proof.
Final `bun run verify`: 438 tests passed, zero failures; Biome, knip and documentation
drift verification passed.
