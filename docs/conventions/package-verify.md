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

## 5. Shipped roster loads package-relatively (#34)

pi's manifest has no `agents` resource; discovery reads the package's own
`extensions/subagent/agents/` (project > user > package precedence). From a
clean environment — a fresh `PI_CODING_AGENT_DIR` with only the credentials
copied in, no hand-copied agents — the shipped `implementer` must dispatch
with no fixture:

```bash
export CLEAN_PI=$(mktemp -d)
cp ~/.pi/agent/{auth.json,models.json} "$CLEAN_PI/"   # credentials only, no agents
PI_CODING_AGENT_DIR="$CLEAN_PI" pi install /home/sprite/afk-kit
mkdir -p /tmp/afk-kit-roster && cd /tmp/afk-kit-roster
PI_CODING_AGENT_DIR="$CLEAN_PI" pi -p --no-session "Call the subagent tool exactly once with: agent=implementer, task='Report your git branch and nothing else.' Then report the subagent's final output verbatim and nothing else."
```

Expected: the child runs the shipped `implementer` (confined, glm-5.3-flash)
without any agent hand-copied into `$CLEAN_PI/agents` — proof the roster
reaches the fork's `discoverAgents` from the installed package. A user-level
`~/.pi/agent/agents/implementer.md` shadows the shipped one by name, which is
the intended override path, not a workaround.
