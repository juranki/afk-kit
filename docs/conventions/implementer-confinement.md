# Implementer tool environment

The Implementer's shell uses an allow-only filesystem and network policy. A Ticket
Worktree remains the only repository write surface; task-owned tool scratch space is
an additional, bounded write surface, not permission to write HOME or arbitrary host
paths.

## Scratch and Git

Each confined task creates a private `afk-task-tools-*` directory outside the Worktree.
Temporary files, Go build/module caches, GOPATH, and XDG cache/config directories live
there. These paths are pinned rather than inherited from the caller. srt's default
shared `/tmp/claude` write surface is denied; `TMPDIR` is also set inside the wrapped
shell because srt overrides the outer environment. Disposal removes scratch space,
including Go's read-only module directories, without following symlinks.

Global and system Git configuration use `/dev/null`, and interactive authentication
is disabled. The Worktree's Engine-pinned local identity still applies
([ADR 0014](../adr/0014-ticket-worktree-is-an-independent-clone.md)). Credential
variables are not inherited, and protected home paths remain unreadable.

Root `.env` and `.env.*` files stay protected. The sole example exemption is a regular,
tracked root `.env.example`: its conventional non-secret configuration placeholders
remain readable, so masking does not change its type or Git status. An untracked
example, symlink, or hardlink alias receives no exemption. Actual secrets must never be placed in
this example. Other tracked protected files refuse before Claim: masking their
contents would make Git status/hash operations unreliable, while exposing them is
not an acceptable workaround. Remove such secrets from tracking before a Run.

## Go acquisition policy

Choose online, explicitly allowlisted dependency acquisition rather than relying on
warm host caches. Alongside `registry.npmjs.org`, the Implementer may reach:

- `proxy.golang.org` — module proxy;
- `sum.golang.org` — checksum verification;
- `storage.googleapis.com` — module archive redirects from the proxy.

This last host is shared infrastructure, not a path-scoped permission; the runtime
restricts hosts rather than URL paths. No wildcard or unrestricted network grant is
used. Direct VCS fallback, private registry credentials, and arbitrary custom proxies
are not enabled. `GOPROXY` has no `direct` fallback; `GOSUMDB` remains enabled. Host Go
configuration is disabled (`GOENV=off`), telemetry is disabled, and `GOTOOLCHAIN=local`
requires an already compatible installed toolchain. A newer compatible Go is valid;
installing a project's exact suggested toolchain is not automatically necessary.

## Early diagnostics and proof

Before Claim, Preflight executes confined temporary/cache writes and an isolated Git
configuration read. For a repository with root `go.mod`, it copies public `go.mod` and
optional `go.sum` into a scratch fixture, runs `go version`, `go mod download`, and a
minimal `go test ./...` build under the same policy, with a two-minute timeout. Missing
or incompatible Go, blocked acquisition, and unusable native build environments
refuse with output and remediation hints, without consuming an implementation cycle.
Local module replacements unavailable in that fixture also refuse explicitly; this
probe does not claim to validate every project-specific Verify command or native
library dependency. The prepared Agent brief's Verify commands still define done.

`bun run confinement:smoke` exercises the real pinned sandbox with cold Go caches,
an external module, native build tools, tracked examples, untracked secrets, clean
Git status, and successful/unsupported Go Preflight. It needs Go, Git, Linux sandbox
prerequisites and outbound HTTPS; it remains separate from deterministic seam tests.
See [package verification](package-verify.md#5-confinement-pin-smoke).
