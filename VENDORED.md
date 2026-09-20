# Vendored: pi's `subagent` example extension

This directory tree is the vendored fork selected by
[ADR 0007](docs/adr/0007-vendored-subagent-mechanism.md): afk-kit's delegation
mechanism starts as pi's first-party example, then gains the hardening ADR 0007
lists (R5 confinement, R8 timeout/cancel, R2 per-agent thinking, R6 verdict).

## Provenance

- **Source:** `examples/extensions/subagent/` in `earendil-works/pi`
  (`packages/coding-agent/examples/extensions/subagent/` in the monorepo).
- **Upstream version:** pi 0.85.1 (`@earendil-works/pi-coding-agent` 0.85.1),
  the version verified at selection time ([ADR 0007](docs/adr/0007-vendored-subagent-mechanism.md)).
- **Upstream license:** MIT — Copyright (c) 2025 Mario Zechner. The full license
  text ships alongside the code as [`extensions/subagent/LICENSE`](extensions/subagent/LICENSE).
- **Local modifications:** none. The files below are byte-identical to upstream
  (sha256-verified at vendoring time; the checksums live in
  [`VENDORED.sha256`](VENDORED.sha256), keyed by upstream-relative paths so
  `sha256sum -c` runs directly against a pi checkout). Later fork tickets
  change them deliberately and must update the manifest to say so.

  Fork-modified so far (ticket #16, R8 wait/check + cancel + wall-clock cap +
  background watchdog, and R2 per-agent thinking; ticket #17, R5 implementer
  confinement; ticket #18, R6 verdict convention — divergence points listed
  in [`extensions/subagent/README.md`](extensions/subagent/README.md)):

  - `extensions/subagent/index.ts`
  - `extensions/subagent/agents.ts`
  - `extensions/subagent/README.md`
  - `extensions/subagent/agents/reviewer.md` (#18 — replaced in place by the
    shipped reviewer, which returns the JSON verdict; the upstream demo
    agent of the same name is gone)

  New afk-kit-owned files: `extensions/subagent/background.ts` (the wait/check
  machinery), `extensions/subagent/confinement.ts` (the R5 confinement:
  env allowlist, PATH shim, git pin), and `extensions/subagent/verdict.ts`
  (the R6 verdict convention's deterministic coordinator-side parse), with
  colocated tests `background.test.ts`, `confinement.test.ts`,
  `verdict.test.ts`, and `agents.test.ts`. The shipped roster gained
  `extensions/subagent/agents/implementer.md` (ticket #17) and replaced
  `extensions/subagent/agents/reviewer.md` (ticket #18) — afk-kit files, not
  upstream ones; the remaining `agents/*.md` (`planner`, `scout`, `worker`)
  and `prompts/*.md` are upstream-byte-identical and sha-tracked below.

## Files

| File | Upstream path |
| --- | --- |
| `extensions/subagent/index.ts` | `examples/extensions/subagent/index.ts` |
| `extensions/subagent/agents.ts` | `examples/extensions/subagent/agents.ts` |
| `extensions/subagent/README.md` | `examples/extensions/subagent/README.md` |
| `extensions/subagent/agents/*.md` | `examples/extensions/subagent/agents/*.md` |
| `extensions/subagent/prompts/*.md` | `examples/extensions/subagent/prompts/*.md` |
| `extensions/subagent/LICENSE` | *(not upstream — pi's MIT license text, added for attribution)* |

The repo-root [`VENDORED.sha256`](VENDORED.sha256) checksums every vendored file
against its upstream path; it sits outside the tree so the vendored directory stays
exactly upstream + `LICENSE`.

## Re-vendoring (upgrade to a newer pi)

```bash
PI=/.sprite/languages/bun/install/global/node_modules/@earendil-works/pi-coding-agent
cd /home/sprite/afk-kit
rm -r extensions/subagent
cp -a "$PI/examples/extensions/subagent" extensions/subagent
# restore extensions/subagent/LICENSE (not upstream)
# verify: from the upstream checkout,
#   cd "$PI" && sha256sum -c /home/sprite/afk-kit/VENDORED.sha256
# then diff against the previous vendored state and re-apply afk-kit's
# fork changes deliberately, per the fork-hardening tickets
```

## Packaging notes

- The example ships no `package.json`; afk-kit's root
  [`package.json`](package.json) is the package manifest. The `pi` key points
  the extension loader at `./extensions/subagent/index.ts` only — `agents.ts`
  is a module imported by `index.ts`, not an extension entry, and must not be
  listed.
- The example's `prompts/*.md` are a real pi resource type and are declared
  under `pi.prompts`; the `agents/*.md` sample definitions are **not** a pi
  resource type. The extension discovers them from `~/.pi/agent/agents/`
  (user scope, default) or `.pi/agents/` (project scope), exactly as upstream —
  see the vendored README's Installation section.
- Core pi packages the extension imports are declared as `peerDependencies`
  with `"*"` per pi's package docs; pi provides them at runtime.
- The vendored demo agents pin upstream models (e.g. `scout.md`'s
  `model: claude-haiku-4-5`) that may not exist in a given environment; scratch
  dispatches strip the `model:` line in a project-scope fixture — the procedure is
  step 3 of the [package verify commands](docs/conventions/package-verify.md).
  The shipped `implementer` and `reviewer` pin `glm-5.3-flash` and `glm-5.3`,
  which this environment's model store has (ADR 0004's routing).
