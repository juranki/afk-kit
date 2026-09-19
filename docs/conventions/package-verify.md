# Package verify commands

How to verify afk-kit's package skeleton against pi 0.85.1 — the acceptance commands
from ticket #11, recorded here as the canonical reuse source for later briefs'
**Verify commands** field (see the [brief template](../brief-template.md)).

Vendored-file integrity is a separate, cheaper check: `sha256sum -c VENDORED.sha256`
run from the upstream pi checkout (see [VENDORED.md](../../VENDORED.md)).

## 1. Package registered user-level

```bash
pi install /home/sprite/afk-kit   # local path: referenced in place, written to ~/.pi/agent/settings.json
pi list
```

Expected: `pi list` shows afk-kit under User packages; `~/.pi/agent/settings.json`
gains `"packages": ["../../afk-kit"]` (relative to the settings file; resolves to the
repo). Durable git-source install once shipping:
`pi install git:github.com/juranki/afk-kit@<pinned-ref>`.

## 2. Vendored extension loads

```bash
mkdir -p /tmp/afk-kit-demo && cd /tmp/afk-kit-demo
pi -p --no-session "Reply with exactly: LOAD-OK"   # stderr must stay empty, exit 0
```

Expected: clean load, no warnings — user-scope packages load in any project with no
trust interaction (R10).

## 3. Scratch dispatch of the example's demo agent (scout)

This box has only zai/glm models; the vendored `scout.md` pins
`model: claude-haiku-4-5`, which would fail the child's `--model` argv. The scratch
fixture drops only that line (vendored files stay byte-identical); the child then
inherits the dispatching session's model:

```bash
mkdir -p /tmp/afk-kit-demo/.pi/agents
grep -v '^model:' $PI/examples/extensions/subagent/agents/scout.md > /tmp/afk-kit-demo/.pi/agents/scout.md
cd /tmp/afk-kit-demo
pi -p --no-session "Call the subagent tool exactly once with: agent=scout, agentScope=both, task='Count the top-level .md files in /home/sprite/afk-kit and report the count plus their names in one line.' Then report the subagent's final output verbatim and nothing else."
```

Expected: parent calls the vendored `subagent` tool → child `pi --mode json -p
--no-session` runs scout → returns the count and names of afk-kit's top-level `.md`
files.

## 4. Vendored `prompts/` registered

```bash
cd /tmp/afk-kit-demo && pi -p -nt --session-dir /tmp/afk-kit-probe "/scout-and-plan PROBE"
grep -o "Use the subagent tool with the chain parameter[^\"]*" /tmp/afk-kit-probe/*.jsonl | head -1
```

Expected: the session records the expanded template body, not the literal
`/scout-and-plan` — prompt templates load from the manifest and expand. (`-nt` keeps
the model tool-less so nothing actually dispatches.)
