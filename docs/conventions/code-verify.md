# Code verify standard

How afk-kit's own code is proven — the order tests are written in, the layers,
the toolchain, and the canonical command every afk-kit brief's **Verify
commands** field cites. Resolved on
ticket #12. Target repositories define their own verify commands in their
briefs; this standard governs afk-kit's own tickets. The
[package verify commands](package-verify.md) remain canonical for package and
vendored-integrity work.

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
| **L1 Unit** | The fork's decision logic — verdict parsing (R6), status-file handling and cancel mapping (R8), shim rule evaluation (R5) | `bun test` — offline, no git, no network |
| **L2 Seam-integration** | Coordinator mechanics (claim + worktree + branch, push + PR, merge guard) against faked seams | `bun test` with real `git` against a local bare repo and a stubbed `gh` on `PATH` |
| **L3 Live smoke** | A real child `pi` dispatch through the vendored mechanism | `scripts/smoke-dispatch.sh` — manual, run when dispatch-path code changes; never part of `bun run verify` |
| **L4 Proof run** | The only true end-to-end | ticket [#21](https://github.com/juranki/afk-kit/issues/21) — a real ticket carried from `implement #n` to a human-merged pull request |

## Faking the seams (L2)

Coordinator operations run the real binaries; tests swap the **environment**,
never the code:

- **git** — a `git init --bare` fixture directory is the remote; clone, branch,
  commit, and push run for real against it.
- **gh** — a stub executable injected via `PATH` records argv and emits canned
  JSON (the same PATH-shim trick the
  [R5 confinement prototype](../../prototype/r5-confinement/) proved).

This exercises the real command surface, which is exactly the thing that
breaks.

## Harness rules

- Tests are **colocated** as `*.test.ts` beside the code they test. The pi
  manifest loads only its listed extensions and prompts, so tests never load at
  runtime.
- Every fork addition's decision logic gets L1 tests; every coordinator
  operation gets L2.
- **Vendored upstream code is not unit-tested.** Its integrity is owned by
  `sha256sum -c VENDORED.sha256` and the package verify commands; only the
  seams afk-kit changes get tests.
- The implementer shim's **allow/refuse matrix is exercised as subprocess tests
  under `bun test`**, whatever language the hardened shim is written in (the
  prototype is shell; ADR 0007 leaves the form open): spawn a shim'd `PATH`,
  attempt allowed and refused commands, assert the `CONFINEMENT_REFUSAL`
  markers.
- **No coverage-percentage gate.** The rule is the two bullets above, and
  nothing ceremonial on top.

## Toolchain and the canonical command

- **Test runner:** `bun test` (bun 1.3.14; TS native, zero config, no extra
  devDependency).
- **Lint + format:** Biome (`@biomejs/biome`), the recommended preset, formatter
  at defaults — tabs and double quotes, which house style already matches.
  Rules are added only when one bites, each with a comment in `biome.jsonc`.
- **Dead dependencies, code, exports:** knip, entry points mirroring the pi
  manifest; peer dependencies are runtime-provided by pi.
- **Scope boundary:** Biome and knip exclude the vendored tree today. When the
  fork modifies a vendored file, that file is already off `VENDORED.sha256` —
  it leaves the exclusions and gets linted. Re-scoping the sha manifest itself
  is the first fork-modifying ticket's job (#16 is first in line).

Every afk-kit brief's **Verify commands** cites by default:

```bash
bun install && bun run verify
```

where `verify` runs `bun test --pass-with-no-tests && biome check . && knip`
(the flag keeps the canonical command green until the first tests land).
Area-specific extras
stack on top of the default: the sha check for vendored-file work, the
[package verify commands](package-verify.md) for manifest/install work, the L3
smoke for dispatch-path work.
