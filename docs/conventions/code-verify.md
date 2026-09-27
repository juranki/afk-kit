# Code verify standard

How afk-kit's own code is proven — the order tests are written in, the layers,
the toolchain, and the canonical command every afk-kit brief's **Verify
commands** field cites. Resolved on
ticket #12. Target repositories define their own verify commands in their
briefs; this standard governs afk-kit's own tickets. The
[package verify commands](package-verify.md) remain canonical for package work.

## Tests come first

Implementation on afk-kit tickets is test-first: the change starts with the
failing test that pins the new behaviour or bug, then the code that makes it
pass (the installed `tdd` skill runs the loop). The layers below govern what
must be proven; this rule governs the order it is written in.

## The four layers

Every piece of afk-kit code is verified at exactly one layer, so no ticket
invents its own notion of "tested".

| Layer | Covers | How |
| --- | --- | --- |
| **L1 Unit** | Deterministic decision logic — readiness parsing, branch naming, pull-request shaping, and package resources | `bun test` — offline, no git, no network |
| **L2 Seam-integration** | Coordinator mechanics (claim + worktree + branch, push + PR) and confinement spawn wrapping against faked seams | `bun test` with real subprocesses: `git` against a local bare repo, a stubbed `gh` on `PATH`, and a fake srt manager at its library port |
| **L3 Live smoke** | Runtime integration that requires a real pi process | No current command; the retired vendored-dispatch smoke was removed with ticket #41 |
| **L4 Proof run** | The only true end-to-end | ticket [#21](https://github.com/juranki/afk-kit/issues/21) — a real ticket carried from `implement #n` to a human-merged pull request |

## Faking the seams (L2)

Coordinator operations run the real binaries; tests swap the **environment**,
never the code:

- **git** — a `git init --bare` fixture directory is the remote; clone, branch,
  commit, and push run for real against it.
- **gh** — a stub executable injected via `PATH` records argv and emits canned
  JSON (the same PATH-shim trick the
  [R5 confinement prototype](../../prototype/r5-confinement/) proved).
- **srt** — a fake manager at the library port records the compiled task policy and
  returns the command to a real shell subprocess. The separate
  [`bun run confinement:smoke`](package-verify.md#4-confinement-pin-smoke) upgrade gate
  runs the pinned srt artifact against the live host and network.

This exercises the real command surface, which is exactly the thing that
breaks.

## Harness rules

- Tests are **colocated** as `*.test.ts` beside the code or public package seam
  they test. The pi manifest loads only its listed extensions and skills, so tests
  never load at runtime.
- **Prototype directories are outside the sweep.** `prototype/*/run/` holds
  throwaway evidence from experiments; its fixtures intentionally fail or
  violate format (e.g. r45-sdk-spawn's seeded ticket-drill bug) and are
  evidence, not product code. `bunfig.toml` excludes `prototype` from test
  discovery and `biome.jsonc` from lint/format.
- Every deterministic decision gets L1 tests; every coordinator operation gets L2.
- **No coverage-percentage gate.** The layer rules above are the gate; nothing
  ceremonial sits on top.

## Toolchain and the canonical command

- **Test runner:** `bun test` (bun 1.3.14; TS native, zero config, no extra
  devDependency).
- **Lint + format:** Biome (`@biomejs/biome`), the recommended preset, formatter
  at defaults — tabs and double quotes, which house style already matches.
  Rules are added only when one bites, each with a comment in `biome.jsonc`.
- **Dead dependencies, code, exports:** knip, entry points mirroring the pi
  manifest; peer dependencies are runtime-provided by pi.

Every afk-kit brief's **Verify commands** cites by default:

```bash
bun install && bun run verify
```

where `verify` runs `bun test --pass-with-no-tests && biome check . && knip`
(the flag keeps the canonical command green until the first tests land).
Area-specific extras stack on top of the default: use the
[package verify commands](package-verify.md) for manifest/install work and add an
L3 smoke when runtime integration requires a real pi process.
