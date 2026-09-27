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

Expected: the remaining package extensions load cleanly, with no warnings or trust
interaction, and the reply is `LOAD-OK`.

## 3. Retired subagent surfaces stay absent

```bash
cd /home/sprite/afk-kit
bun test package.test.ts
```

Expected: the package manifest registers neither the retired `subagent` extension nor
its prompts, and `extensions/subagent/` does not exist.
