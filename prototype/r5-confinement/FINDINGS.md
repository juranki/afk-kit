# Findings — implementer confinement shim (prototype for #10)

Built and run 2026-09-14 against pi 0.85.1, model `glm-5.3-flash`, in this
repository's worktree. `demo.sh` is the evidence; artifacts land in `/tmp/r5-demo`.
This file proposes resolutions for the four open mechanics questions in #10. The
resolution becomes the spec [#17](https://github.com/juranki/afk-kit/issues/17)
implements.

## What the demo showed

| # | Check | Result |
| --- | --- | --- |
| 1 | token/secret/key env vars inside confinement | none found |
| 2 | credential helpers: real vs pinned config | real config routes git credentials through `gh auth git-credential`; pinned config has none |
| 3 | `gh` on PATH | refused, exit 126, `CONFINEMENT_REFUSAL` line on stderr |
| 4 | `git push` / `git commit` | push refused (exit 126); commit works |
| 5 | **slip**: git `!`-alias | alias shells out via `/usr/lib/git-core/git` — bypasses the PATH shim; the push died only on missing credentials |
| 6 | **slip**: absolute path `/usr/bin/gh`-style | real `gh` answered `api user` with real creds from `~/.config/gh/hosts.yml` |
| 7 | **slip**: absolute-path `git push` | reached real git; stopped only by the config pin (no helper, `GIT_TERMINAL_PROMPT=0`) |
| 8 | **slip**: credential files | `~/.config/gh/hosts.yml` and `~/.gitconfig` readable by the child; nothing blocks reads |
| 9 | child `pi -p` through confinement | created file, **committed** (`aab06a3`), push and `gh` refused with verbatim refusal quotes; refusal log captured both |
| 10 | allowlist: same task, `--tools read` | pi refuses the tool calls before the shim is even involved — read-only child cannot write a file |

The child run is the R5 requirement demonstrated end to end: local commit yes,
publishing no, structured report of what happened.

## The four mechanics questions — proposed resolutions

### 1. Env-filter list

The demo strips a denylist (`GH_*`/`GITHUB_*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`,
`*_KEY`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `GIT_SSH*`, `NODE_OPTIONS`, `BASH_ENV`, …).
Denylist is the wrong long-term shape — it rots with every new secret kind.

**Proposal for #17:** the fork constructs the child env as a **curated allowlist** —
`PATH`, `HOME`, `TERM`, `LANG`, `TMPDIR`, plus the few variables pi's own startup
needs (discover once, freeze the list) — and then *adds* the confinement exports,
which matter more than any removal:

- `GIT_CONFIG_GLOBAL=<pinned file>` (identity in, credential helpers out)
- `GIT_CONFIG_NOSYSTEM=1`
- `GIT_TERMINAL_PROMPT=0`

### 2. Shim placement: PATH order vs git wrapper

PATH-order stubs demo'd (a `gh` refuse-all, a `git` wrapper refusing `push`). The
demo also shows what placement cannot buy: absolute paths bypass the shim (§6, §7)
and git's `!`-aliases shell out through git-core, re-entering the real binary (§5).
A "git wrapper" placed *inside* git (hooks, exec-path tricks) fares no better —
git-core shell-outs are exactly the escape.

**Proposal:** keep the PATH shim as the cheap universal layer — it is what produces
the loud, machine-readable refusal on the ordinary path — and treat the
**gitconfig pin** as the layer that actually cuts off credentials on the default
path. Neither is enforcement; see the bypass chain below for what that implies.

### 3. Failure mode: refuse vs escalate

Refuse **at the child**: fail closed, exit 126, one stderr line beginning
`CONFINEMENT_REFUSAL` (demo'd). A child has no channel to escalate through except
its structured result — so escalation is the *coordinator's* move, made when the
result shows refusals. **Proposal for #17:** the fork already pipes child stderr;
scan the result for `CONFINEMENT_REFUSAL` markers and surface a `refusals` field in
the structured result. Coordinator policy: a refusal is a report line, not an
exception — refusals are *normal* for a confined implementer (the demo child
narrated them and finished its task). The demo's refusal log shows the hook works.

### 4. Allowlist composition

Three independent layers, demo'd separately:

| Layer | Governs | Demo |
| --- | --- | --- |
| frontmatter `tools` → `--tools` | which pi tools the child may call at all | §10: read-only child cannot write |
| PATH shim | what its processes may do | §3, §4 |
| gitconfig pin | what its processes can authenticate as | §2, §7 |

They compose; neither subsumes another. **Proposal:** keep all three, and make
confinement a **per-agent-definition property** (e.g. a `confinement: implementer`
frontmatter field), not a property of the spawn in general — the reviewer (R6) must
*read the pull-request diff*, i.e. needs `gh` reads. Either the coordinator hands
the reviewer the diff as text (no `gh` needed; simplest), or the reviewer runs
unconfined. The implementer is the only agent that gets the shim + pin.

## Verified bypass chain (the honest part)

Each link proven in-session; composing them is left as an exercise for a malicious
child, which is the point:

1. `!`-alias or absolute path → real git (demo §5–7).
2. `git -c credential.helper='!…'` inline config overrides the pin — helper ran
   (`HELPER-INVOKED-VIA-C`); so does the child's own writable **repo-local** config
   (`HELPER-INVOKED-VIA-LOCAL`).
3. A helper is an arbitrary shell command and the credential file is readable:
   `-c credential.helper='!…wc -c < ~/.config/gh/hosts.yml…'` printed
   `TOKEN-FILE-REACHABLE bytes=206`.

Composed: a deliberately hostile child can publish. **The shim stops accidents, not
adversaries.** What it does deliver: credentials never ride in the environment, the
ordinary publish paths fail loudly and immediately, and every refusal is detectable.

**Open policy question for the maintainer (R5-hardening scope):** is
accident-level confinement acceptable, or must R5 demand an OS boundary — a
separate uid for children (credential files unreadable) or a container/network
namespace? The separate-uid option is cheap on a single-tenant machine and closes
links 2–3 of the chain; it costs per-machine setup, which tensions with R10
(user-level install, project-agnostic). Recommendation: accept accident-level
confinement for the toolkit's v1 — the reviewer and the human merge gate (ADR 0002)
are the backstops for adversarial behavior, and the ontology's "never publishes"
invariant describes the *behavior contract*, enforced to the depth the threat model
requires — but record the decision explicitly in #17 either way.

## Carry-over into #17's implementation

1. Env: allowlist + git-pin exports, built in the fork at the spawn seam
   (`spawn(command, args, {cwd, shell:false, env})` — the example passes no `env`
   today; children inherit everything).
2. Shim: generate the stub dir per child in a temp directory (not a shared
   checkout-relative `shim.d/`), prepend to the child's PATH env value.
3. Refusals: `CONFINEMENT_REFUSAL` stderr marker → `refusals` field in the
   structured result; coordinator reports, never alarms.
4. Allowlist: `--tools` passthrough unchanged; add `confinement` frontmatter field;
   reviewer gets the diff from the coordinator.
