# Research: srt as the confinement layer (ticket #44)

Question: Can [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime)
(srt, Apache-2.0) replace afk-kit's argv-level confinement shim as the process-layer
guard of the guard-rail stack ([#42](https://github.com/juranki/afk-kit/issues/42),
Proposal A)?

All claims verified against primary sources: the srt repository at commit `ddbeb74`
(2026-09-21, cloned for this research), the published npm package
`@anthropic-ai/sandbox-runtime@0.0.77` (installed and executed on this box), the srt
issue tracker via the GitHub API (2026-09-26), and first-party npm registry metadata.
Run-state claims marked **[smoke]** were reproduced first-hand on this box (Debian 13
Lima VM) during this research; commands and outputs are summarized in §6.

**Answer: adopt, as a library embed with an exactly-pinned npm version and an upgrade
smoke test.** On this box srt provably closes the exact hole the argv shim misses
(arbitrary-domain `curl` exfil), enforces filesystem write-allow and read-deny at the OS
level, and runs unprivileged with one apt install. Its beta status is real but bounded:
the failure modes that matter for afk-kit live in the CLI wrapper, which library
embedding bypasses, and are all catchable by the pin-and-verify ritual recommended in §7.

## 1. What srt is and how it enforces on Linux

srt wraps arbitrary processes with OS-level filesystem and network restrictions, without
a container, as both a CLI (`srt`) and a library (`SandboxManager`) — README, intro and
"As a library". License Apache-2.0 (`package.json` `license`; npm metadata). Runtime
engines: node ≥ 20.11.0 (`package.json` `engines`).

- **Network (Linux)**: the sandbox's network namespace is removed entirely
  (`--unshare-net`); all traffic must exit through HTTP and SOCKS5 proxies running
  host-side inside the srt process, reached over Unix domain sockets bridged into the
  sandbox by socat (README "Network Isolation Architecture"; `src/sandbox/linux-sandbox-utils.ts:1160`).
  Because there is no interface inside the namespace, a process that strips its proxy
  environment and dials directly has nothing to dial — this is structural, not
  cooperation-based (README "Known Limitations" describes the complementary case:
  programs ignoring the env vars simply cannot reach the internet). **[smoke]** Verified:
  with `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` unset, bash `/dev/tcp/example.com/443`
  is blocked.
- **Filesystem (Linux)**: writes are allow-only (default: nothing writable; srt binds
  `--ro-bind / /` then `--bind`-carves the `allowWrite` paths);
  reads are deny-then-allow (default: all reads allowed, `denyRead` hides paths via
  tmpfs/`/dev/null` masks). Precedence is deliberately opposite: `allowRead` beats
  `denyRead`; `denyWrite` beats `allowWrite` (README "Filesystem Isolation";
  `linux-sandbox-utils.ts:1947,2012,2556`).
- **Mandatory denies**: shell rc files, `.gitconfig`/`.gitmodules`, `.ripgreprc`,
  `.mcp.json`, `.vscode/`, `.idea/`, `.claude/commands|agents`, `.git/hooks/`,
  `.git/config` are write-blocked even inside `allowWrite`, by default, found via a
  ripgrep scan to `mandatoryDenySearchDepth` (default 3, max 10) (README "Mandatory Deny
  Paths"; `sandbox-utils.ts:527`). Ancestors of protected paths are pinned against
  rename (`EBUSY`), and `mv`/`ln` between top-level directories fails `EXDEV`
  (README "Pinned directories").
- **Unix sockets**: blocked by default via a seccomp BPF filter (`socket(AF_UNIX)` →
  `EPERM`, plus `io_uring` syscalls against the same bypass), applied by a vendored
  static `apply-seccomp` binary (x64/arm64) inside a nested user+PID+mount namespace
  with non-dumpable PID 1 (README "Unix Socket Restrictions"). `allowUnixSockets` is
  ignored on Linux (seccomp cannot filter by path).
- **Resolved-address guard**: allowlists match by name, so before dialing an allowed
  hostname the proxy resolves it once and refuses addresses in a denied set — loopback,
  link-local, multicast, the host's own interface addresses, cloud metadata endpoints,
  `deniedDomains` IP literals, and caller-supplied `deniedResolvedAddresses` (README
  "Resolved-address check").
- **Credentials**: a `credentials` config section can deny or mask env vars and files —
  masked values become per-session sentinels that the host proxy substitutes back to the
  real bytes on egress (`src/sandbox/sandbox-schemas.ts` `CredentialRestrictionConfig`;
  `src/sandbox/sandbox-config.ts` credential schemas).

## 2. Maturity and API stability of the beta

The README's own label: "**Beta Research Preview** … APIs and configuration formats may
evolve." The numbers behind it:

- **Cadence**: 73 npm releases from 2025-10-20 (0.0.1) to 2026-09-18 (0.0.77) — about
  6.6 per month, weekly-to-biweekly (npm registry `time` metadata). A v0.0.78 release
  issue is already open (srt#577). Repo created 2025-10-20; 5,347 stars; 239 open
  issues; last push 2026-09-26 (GitHub API `repos/anthropics/sandbox-runtime`).
- **Stability contract**: none. Every version is 0.0.x — semver's "anything may
  change". Config validation has already tightened mid-beta in ways that convert
  previously-inert configs into hard errors (srt#536: deny globs with trailing
  separators went from silently-no-op to rejected at validation). Unknown top-level
  config keys are **silently ignored today** — `SandboxRuntimeConfigSchema` is a plain
  `z.object` without `.strict()` (`src/sandbox/sandbox-config.ts:1105`), and rejecting
  them is still an open issue (srt#492, srt#517). A typo'd compiled config would
  therefore fail open until that lands.
- **What beta has already broken for adopters** (srt issue tracker; issue numbers are
  srt's unless noted):
  - **Exit-code integrity** — srt#602: when the wrapped command dies by signal, the CLI
    exits 0 (SIGINT/SIGTERM) or 1 (others), so a caller cannot distinguish success from
    a killed command. Confirmed in the shipped 0.0.77 artifact:
    `dist/cli.js` maps `signal === 'SIGINT' || signal === 'SIGTERM'` to
    `process.exit(0)` (cli.js, `child.on('exit')` handler). One argv-form reproduction
    on this box returned 143 instead — the discrepancy is unresolved upstream; treat
    signal-death exit codes as unreliable until pinned and re-tested. Affects afk-kit
    directly: verify-command exit codes are the ontology's definition of done
    (workflow ontology invariant: "An implementer's change is done only when its
    ticket's verify commands pass").
  - **Signal handling** — srt#603: on Linux, one Ctrl-C kills the child even when the
    child handles SIGINT (0.0.76/0.0.77).
  - **A release-train breakage at scale** — srt#498: inside rootless containers /
    nested user namespaces with `--cap-drop ALL`, the seccomp layer's nested namespace
    dies (`write /proc/self/uid_map: Operation not permitted`), which "removes the Bash
    tool entirely" for Claude Code 2.1.220–2.1.236 (quoting claude-code#89478). The
    cautionary tale cuts both ways: an *embedded snapshot* of srt broke consumers for
    sixteen releases — pinning alone is not protection; a verify gate is (§3, §7).
  - **Host bubblewrap-version coupling** — srt#580: bubblewrap 0.4.x (what RHEL 8/9
    ship) refused to *start* on profiles with duplicate file mounts; fixed by
    de-duplicating mounts, and `checkDependencies()` now warns below 0.5.0. The
    profile a config compiles to is sensitive to the host's bwrap version.
  - **Violation observability on the CLI path is absent** — srt#582: the CLI never
    reads recorded network denies and never starts the filesystem violation monitor
    (`enableLogMonitor` defaults false and cli.js omits it). A denied operation is just
    the child's raw EPERM/EACCES on stderr. **[smoke]** Reproduced: a `denyRead`-blocked
    `cat` prints "Permission denied" with zero violation information surfaced.
  - **Observability parity gap (library)** — srt#511: on Linux, `denyRead` blocks are
    enforced but produce no violation event (the seccomp observer only traps
    write-intent opens). Writes are observed; reads are not.
  - **Proxy-layer correctness bugs, mostly fixed in-train** — body substitution broke
    GitHub release uploads with 400 Bad Content-Length (srt#543), denial responses
    destroyed still-uploading requests (srt#538), non-Latin-1 upstream headers crashed
    the proxy (srt#490, fix srt#491), CONNECT tunnels truncated responses on upstream
    close (srt#606), IPv4-mapped loopback bypassed the loopback rule breaking
    dual-stack gRPC (srt#494), a mux port shared across `cluster` workers caused
    intermittent 407s (srt#458).
- **Responsiveness**: external bug reports in this list were fixed within days to
  weeks on the standing release train (e.g. srt#491, srt#537, srt#555, srt#505, srt#504
  all closed; many by PRs referencing the reporter's analysis). The project is under
  active, well-instrumented hardening: capability drops for root callers (srt#505),
  typed wrap-time profile errors (srt#553), settings-file write protection (srt#587,
  srt#493), pinning ancestors of deny paths (srt#514).
- **Production pedigree**: developed for Claude Code (README intro; Claude Code
  sandboxing docs linked from the README), i.e. the mechanism is exercised daily by the
  largest agent fleet, and its failures are publicly triaged — the strongest available
  maturity signal short of a stable release.

## 3. Vendored pinned copy vs npm dependency (map #42, open question 3)

Facts that bear on the choice:

- The npm tarball is **self-contained**: it ships the prebuilt `apply-seccomp` binaries
  (`vendor/seccomp/`), the JVM proxy agent jar, and the Windows helper, with only four
  small runtime dependencies — `@pondwader/socks5-server` (MIT), `commander` (MIT),
  `node-forge` (BSD-3-Clause OR GPL-2.0), `zod` (MIT) — licenses all acceptable
  (`package.json` `files`/`dependencies`; licenses read from the installed packages).
  **[smoke]** `npm install @anthropic-ai/sandbox-runtime@0.0.77` completed with 0
  vulnerabilities and ran out of the box.
- A source/vendor fork buys reproducibility that an **exact pin** (`--save-exact`, no
  caret, plus lockfile) equally provides, at none of the maintenance cost. Against
  ~6.6 upstream releases per month, a fork rots quickly; the security fixes land
  continuously (§2) and a fork must chase them by hand.
- The Claude Code incident (srt#498) shows the real control is not *how you vendor* but
  **a verify gate that runs a smoke profile against the pinned artifact** before the
  pin is allowed to move — an embedded snapshot was itself the breakage vector there.
- afk-kit precedent: the repo already vendored one beta dependency wholesale (the pi
  subagent fork, ADR 0007) and the map's "Not yet specified" list already flags the
  cost of unpicking it. That precedent argues against repeating the pattern for a
  faster-moving dependency.

**Conclusion**: npm dependency, exact-pinned, no range; an upgrade is a deliberate bump
plus re-run of the §6 smoke set. Vendoring is the fallback only if a needed fix is
unreleased or upstream stalls.

## 4. Runtime prerequisites on this box

Verified directly (Debian 13 "trixie", Lima VM, kernel 6.12, x86_64):

| Requirement | Status on this box | Source |
| --- | --- | --- |
| bubblewrap | Was **absent**; `sudo apt-get install bubblewrap` → 0.12.0 (Debian 13 repo). ≥ 0.5.0 avoids the srt#580 class; `checkDependencies()` warns below 0.5.0. | apt; srt#580 |
| socat | Present: 1.8.0.3 | apt |
| ripgrep | Present: 14.1.1 | apt |
| Unprivileged user namespaces | Allowed: `kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=15394`, `unshare --user --map-root-user` succeeds. Runs fine as uid 1000 — afk-kit sessions are non-root, so the root-only `CAP_SETFCAP` requirement (README "Running as root"; srt#534 refuses at start-up) does not apply. | this box |
| AppArmor userns restriction | Not applicable (that is an Ubuntu 24.04+ default; Debian 13 unaffected). README "Ubuntu 24.04+ note". | README |
| Host-side proxy operation | Proxies start inside the srt process at `initialize()` and listen on Unix sockets; nothing to configure or run separately. **[smoke]** Worked first-run inside this VM, including through its NAT. | README; smoke |
| Seatbelt / sandbox-exec | macOS-only — N/A on this Linux box; the Linux backend is the only relevant one. | README "Platform Support" |
| Node | v24.21.0 ≥ required 20.11.0 | this box; package.json |
| Privilege to install | Passwordless sudo available for the one-time `apt-get install bubblewrap`. | this box |

Total privileged setup: one apt install. After that the whole path is unprivileged.

## 5. Expressing per-task allowlists and compiling at the spawn seam

**Config shape** (`SandboxRuntimeConfig`, `src/sandbox/sandbox-config.ts`; README
"Configuration"):

```json
{
  "network": { "allowedDomains": ["api.github.com", "*.github.com"], "deniedDomains": [] },
  "filesystem": { "denyRead": ["~/.ssh"], "allowRead": [],
                  "allowWrite": ["/worktree"], "denyWrite": [".env"] },
  "credentials": { "env": {...}, "files": {...} },
  "ignoreViolations": { "*": ["/usr/bin"] }
}
```

Semantics: network is allow-only (empty `allowedDomains` = no network; `:port`
suffixes; `*.example.com` wildcards; bare `*` deny only); writes allow-only; reads
deny-then-allow. Domain validation rejects protocols, paths, and over-broad wildcards
(`*.com`) at schema time (`sandbox-config.ts` `isValidDomainPattern`).

**Library API at the seam** (`ISandboxManager`, `src/sandbox/sandbox-manager.ts:2422+`):

- `initialize(config, askCallback?, enableLogMonitor?)` — session-scoped; starts the
  host-side proxies once.
- `wrapWithSandbox(command, binShell?, customConfig?, abortSignal?, {commandId, commandText})`
  → returns the wrapped command string to spawn; `wrapWithSandboxArgv` for real-argv
  form (srt#499). **`customConfig` is the per-invocation override point**: on Linux it
  can tighten `filesystem.{allowWrite,denyWrite,denyRead,allowRead}` and
  `network.allowedDomains` per command (code at `sandbox-manager.ts:1656–1705`; the
  Windows backend is the one that throws on per-exec fs overrides — README Windows
  limitations).
- `reset()` tears the session down.
- The manager is a module-level singleton (`let config` at
  `sandbox-manager.ts:132`) — one config per process. afk-kit's shape (one implementer
  per SDK session process, one ticket's worktree) matches: initialize at session start,
  wrap every shell invocation, reset at exit.
- Violation surfacing requires the library path: `enableLogMonitor=true` at
  `initialize()` plus `SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr)`
  / `getViolationsForCommand(commandId)` (README "Violation attribution"; srt#582 for
  why the CLI does not do this). `commandId` should be a unique per-invocation id, not
  the command text (keys compare on their first 100 characters — README).

**Compilation from a task brief**: the agent brief already carries the inputs the
config needs (brief standard: summary, acceptance criteria, verify commands, blocking
edges, touched areas, out-of-scope):

- `touched areas` → `allowWrite` (worktree + `/tmp`); Linux write entries must be
  **literal paths** (globs skipped: README "Path Syntax (Linux)") — brief touched areas
  are concrete directories, so the constraint fits.
- `verify commands` → the union of hosts they fetch → `allowedDomains` (e.g. registry
  hosts); default is deny-all, so anything unlisted fails loudly instead of leaking.
- Always: `denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", ".env-class"]`, mandatory denies
  for free, `credentials` masking for the GitHub token if a task must read it.
- Unknown keys are silently ignored until srt#492/#517 land — the seam's config
  compiler should validate against the exported `SandboxRuntimeConfigSchema` itself and
  fail closed on its own typos rather than rely on upstream strictness.

## 6. Failure modes

**What it provably stops** — **[smoke]**, run on this box against the published 0.0.77
package with bwrap 0.12.0 (settings: `allowedDomains: ["api.github.com","github.com"]`,
`allowWrite: ["/tmp/srt-smoke/work"]`, `denyRead` on a secret file):

| Probe | Result |
| --- | --- |
| `curl https://api.github.com` (allowed) | HTTP 200 through the proxy |
| `curl https://example.com` (not allowed) | `CONNECT tunnel failed, response 403` — blocked |
| `curl https://ifconfig.me` (exfil-class, not allowed) | blocked, 403 |
| proxy env vars stripped, bash `/dev/tcp/example.com/443` | BLOCKED — no interface in the namespace; cooperation is not required |
| write inside `allowWrite` | succeeds |
| write outside `allowWrite` | `Read-only file system`, srt exit 1 |
| read a `denyRead` file | `Permission denied`, srt exit 1 |
| wrapped `bash -c 'exit 7'` | srt exits 7 (normal failure codes propagate) |

This is exactly the class the argv shim provably missed — "argv-level (PATH shim
refusing `gh`/`git push`, env strip) … never blocked `curl -X POST api.github.com`"
([#42](https://github.com/juranki/afk-kit/issues/42)). By design it additionally stops:
mandatory-deny writes inside the worktree (`.bashrc`, `.git/hooks`, …), Unix-socket IPC
(seccomp), rename/rmdir of pinned deny-path ancestors, cross-top-level `mv`/`ln`, and
sandbox-to-host process addressing (PID namespaces; README "Unix Socket Restrictions",
"Pinned directories"). The resolved-address check closes DNS-rebinding-to-metadata and
loopback aim-through-allowed-name (README "Resolved-address check").

**What it does not stop**:

- **Exfiltration through an allowed domain.** srt's own warning: "allowing `github.com`
  lets a process push to any repository", plus domain fronting (README "Security
  Limitations"). Allowlists must be as narrow as the verify commands actually require;
  srt filters destinations, not intent.
- **Signal-death exit integrity on the CLI path** (srt#602, §2) — an afk-kit watchdog
  that SIGTERMs a hung verify would read success if that path were used. Library
  embedding avoids it structurally: the embedder spawns and reaps the wrapped command
  itself, and its own `child.on('exit')` sees `(code, signal)` directly
  (`wrapWithSandbox` returns a string to spawn, not a managed child).
- **Environments that strip user-namespace capabilities** (rootless containers with
  `--cap-drop ALL`: srt#498) — seccomp layer dies; `enableWeakerNestedSandbox` exists
  but "considerably weakens security" (README Security Limitations). afk-kit's target
  (a Lima/VM host, unprivileged) is not affected, but the constraint belongs in any
  portability note.
- **Inherited Unix-socket fds** survive the seccomp block (README limitation);
  `parentProxy`/`mitmProxy` routes delegate the address check to that hop (README).
- **Read denials are enforced but not observed** on Linux (srt#511) — the violation
  store under-reports on the read side; the child still gets EACCES, so the block
  itself holds.

**False-positive surface** (the constraint from the merge-guard flood, #40/#42: guards
must not breed crippling false positives):

- Anything a verify run writes outside `allowWrite` fails: tool caches, test artifacts
  to `$HOME`. srt softens the common cases by default (stdio, `/tmp/claude`,
  `~/.npm/_logs`, `~/.claude/debug` writable without listing; dropped under a covering
  `denyRead` — README "Filesystem Configuration"). Compile-time: add per-task paths
  observed from violations — the violation store (library mode) names them.
- Programs that ignore proxy env vars cannot reach the network (they fail; they do not
  escape — the namespace is gone). JVM tools are bridged by the injected javaagent
  (README "Implementation Details"); jlink'd runtimes without `java.instrument` refuse
  to start unless `JAVA_TOOL_OPTIONS` is unset for the command.
- Linux path-glob narrowing: `allowWrite`/`denyWrite` take literals only; `denyRead`
  globs expand at wrap time to what exists — a file created later under a matched
  directory is not covered (README "Path Syntax (Linux)"). A `denyRead` glob whose
  expansion cannot be listed hides the containing directory instead — hide-more-than-
  written is the failure direction (README; srt#607 budgets the walk).
- Wrap-time resource ceilings, all typed `LinuxSandboxProfileError`s (README; srt#553):
  > 9000 bwrap args (~3000 mounts), command line > 128 KiB, missing `O_TMPFILE`
  tmpdir — fail loudly at wrap, not mysteriously at run.
- Host-visible artifacts: `denyWrite` on absent paths creates empty read-only
  placeholder mount points on the host while a sandbox lives (the `.git/config.lock`
  "existence is meaning" caveat — README; srt#524 fixed the killed-process leak).
- Bubblewrap-version coupling of compiled profiles (srt#580, §2) — pin the host's bwrap
  alongside the npm pin.

## 7. Adoption recommendation

**Adopt srt as the process-layer guard of the guard-rail stack, replacing the argv
shim — as a library embed, on an exactly-pinned npm version, behind an upgrade smoke
test.** Evidence: (a) it provably closes the shim's hole class on this box, today,
unprivileged, with one apt install (§6); (b) its enforcement model (allow-only writes,
deny-all network, namespace-removed egress, mandatory denies) is the channel-level form
of exactly what ADR 0007's R5 tried to do in argv (§1); (c) its beta risks are
enumerated and mostly live in the CLI wrapper and edge environments that library
embedding and afk-kit's target host avoid (§2, §6); (d) the vendored-fork alternative
costs more than the pin-and-verify ritual it would duplicate, and the repo's own
vendored-fork precedent is already flagged as unpacking cost on the map (§3).

Concretely, in adoption order:

1. **Depend on `@anthropic-ai/sandbox-runtime` at an exact version** (no range), and
   make the §6 smoke set (allowed 200 / denied 403 / write EROFS / read EACCES / exit
   propagation) a package-verify step that gates every pin bump. This resolves map #42
   open question 3: exact pin + smoke gate, not a vendored fork.
2. **Embed the library, not the CLI**: `initialize()` once per implementer process at
   the existing R5 spawn seam; `wrapWithSandbox(…, {commandId})` per shell invocation;
   `enableLogMonitor=true`; `annotateStderrWithSandboxFailures` for the implementer's
   stderr; `reset()` on session end. The spawn seam survives — srt is the mechanism
   *at* that seam (#42).
3. **Compile the config from the brief deterministically** (§5) and validate it against
   the exported schema with unknown-key rejection of our own, until upstream strictness
   lands (srt#492/#517).
4. **Track four upstream issues as adoption blockers or fast-follows**: srt#602
   (signal exit codes — re-verify on the pinned version at integration), srt#582
   (mooted by library embedding), srt#511 (read-side violations), srt#492/#517
   (schema strictness).
5. **Keep the boundary honest**: srt stops accidents, not adversaries — exfil through
   an *allowed* domain is sanctioned by the allowlist itself (srt's own warning). The
   server layer (branch protection, human merge gate, ADR 0002) and the tracker layer
   (Claim, caps, loud failure) carry what the process layer must not.

## Sources

- srt repository, commit `ddbeb74` (2026-09-21): `README.md`; `package.json`;
  `src/sandbox/sandbox-config.ts`; `src/sandbox/sandbox-schemas.ts`;
  `src/sandbox/sandbox-manager.ts`; `src/sandbox/linux-sandbox-utils.ts`;
  `src/utils/config-loader.ts`; `src/index.ts`.
- Published package `@anthropic-ai/sandbox-runtime@0.0.77` (npm): installed 2026-09-26
  on this box; `dist/cli.js` exit-handler read from the installed artifact.
- npm registry metadata: version list and publish timestamps for
  `@anthropic-ai/sandbox-runtime` (73 versions, 2025-10-20 → 2026-09-18).
- srt issue tracker via GitHub API, 2026-09-26: issues #458, #490, #492, #494, #498,
  #511, #517, #524, #534, #536, #538, #543, #553, #577, #580, #582, #587, #602, #603,
  #606, #607 (titles/states/bodies as cited in §2 and §6).
- Local environment probes (this box, 2026-09-26): `which bwrap`, `bwrap --version`,
  `unshare --version/--user`, `sysctl kernel.unprivileged_userns_clone`,
  `user.max_user_namespaces`, `apt-cache policy bubblewrap socat ripgrep`,
  `/etc/os-release`, `node --version`.
- afk-kit primary sources: [#42](https://github.com/juranki/afk-kit/issues/42)
  (guard-rail stack proposal, shim gap, open question 3), [#40](https://github.com/juranki/afk-kit/issues/40)
  (diagnosis), [ADR 0007](../adr/0007-vendored-subagent-mechanism.md) (R5 spawn seam),
  [ADR 0002](../adr/0002-human-merge-gate.md) (merge gate),
  [system-intent/ontologies/agent-delivery-workflow.md](../../system-intent/ontologies/agent-delivery-workflow.md)
  (verify-commands-done invariant), [docs/conventions/package-verify.md](../conventions/package-verify.md)
  (dependency-verification convention), [docs/brief-template.md](../brief-template.md)
  (brief fields compiled in §5).
