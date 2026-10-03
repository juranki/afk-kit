# Package verify commands

How to verify afk-kit's package skeleton against pi 0.85.1 — the acceptance commands
from ticket #11, recorded here as the canonical reuse source for later briefs'
**Verify commands** field (see the [brief template](../brief-template.md)).

The package no longer vendors pi's example `subagent` extension or registers its demo
prompts ([ticket #41](https://github.com/juranki/afk-kit/issues/41)). The package-manifest
test in `package.test.ts` guards that public boundary.

## 1. Package registered user-level

```bash
pi install /home/sprite/afk-kit   # local path: referenced in place, written to ~/.pi/agent/settings.json
pi list
```

Expected: `pi list` shows afk-kit under User packages; `~/.pi/agent/settings.json`
gains `"packages": ["../../afk-kit"]` (relative to the settings file; resolves to the
repo). Durable git-source install once shipping:
`pi install git:github.com/juranki/afk-kit@<pinned-ref>`.

## 2. Package extensions load

```bash
mkdir -p /tmp/afk-kit-demo && cd /tmp/afk-kit-demo
pi -p --no-session "Reply with exactly: LOAD-OK"   # stderr must stay empty, exit 0
```

Expected: the Engine-only package registers no prompt-facing extensions or skills,
produces no warnings or trust interaction, and the reply is `LOAD-OK`.

## 3. Retired subagent surfaces stay absent

```bash
cd /home/sprite/afk-kit
bun test package.test.ts
```

Expected: the package manifest registers neither the retired `subagent` extension nor
its prompts, and `extensions/subagent/` does not exist.

## 4. Readiness session smoke

```bash
bun run readiness:smoke --fixtures
bun run readiness:smoke 84
```

Requires real model credentials for the package-owned assessor pin. Fixtures prove a
non-template request settled in comments accepts historical alternatives and requested
code/test changes, while unresolved choices and missing dependency edges refuse. The
Issue-number form reads the real tracker and captured repository revision. Both retain
assessment/source/session evidence outside the repository and perform no Claim, Verify,
implementation or tracker mutation. See [#84 evidence](../evidence/issue-84-readiness.md).
These L3 smokes are separate from deterministic `bun run verify` and from #52's proof Run.

## 5. Confinement pin smoke

Run whenever the exact `@anthropic-ai/sandbox-runtime` pin changes. On Linux this
requires `bubblewrap`, `socat`, `ripgrep`, `curl`, Git, compatible Go/native build tools,
unprivileged user namespaces, and outbound HTTPS:

```bash
cd /home/sprite/afk-kit
bun run confinement:smoke
```

Expected: all probes pass — worktree writes and outside-write denial, protected reads,
clean declared tracked `.env.example` and isolated Git configuration, confined
staging/commits with Engine identity, allowlisted/denied network, designated scratch
writes with HOME/other-Run denial, cold Go/native dependency verification without
dirtying the Worktree, preserved exit codes, early Go environment diagnostics, and
protection of credentials and undeclared examples. See the [confinement policy](implementer-confinement.md).
This is a live host-capability and dependency upgrade gate, so it stays separate from
the deterministic `bun run verify` sweep.
