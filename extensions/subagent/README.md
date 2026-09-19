# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

> **afk-kit fork (ADR 0007).** This directory started as pi's first-party
> `examples/extensions/subagent/` (MIT, pi 0.85.1 — see
> [`LICENSE`](LICENSE) and [`../../VENDORED.md`](../../VENDORED.md) for
> provenance). Tickets #16–#18 harden it, so `index.ts`, `agents.ts`, and
> this README have **diverged from upstream** and left the sha manifest
> (`VENDORED.sha256` now covers only the still-byte-identical files).
>
> Divergence points so far (ticket #16, R8 + R2):
>
> - **Non-blocking dispatch with wait/check** (adapted from the pattern
>   proven by the pi-subagent-tool fork —
>   [research](../../docs/research/pi-subagent-wait-check.md)). Single and
>   parallel dispatch spawn **detached** children and block only up to
>   `wait` seconds (default 180; `0` = return immediately, negative = wait
>   forever; `background: true` ≡ `wait: 0`), then return
>   `{status: "running", subagentId}`. Recover the result with
>   `subagent({check: "<id>"})` (`history: "full"` for the whole stream).
> - **Cancel, kill by id** — `subagent({cancel: "<id>"})` SIGTERMs the
>   task's process group, then SIGKILLs survivors after a 5 s grace. The
>   child leads its own group (detached spawn), so the wrapper and the pi
>   grandchild die together. The fork this pattern came from has no cancel;
>   the child pid/pgid record it would require is recorded in each task's
>   `status.json` here.
> - **Per-task wall-clock cap** — bounds the *task's* lifetime, not just a
>   call's wait: a task exceeding it is killed and finished as `timeout`.
>   The wait/check pattern's cap bounds only the coordinator's call.
> - **Hang watchdog on the detached background path** — the proven watchdog
>   covered only the foreground/chain path. Here the module watchdog checks
>   every running task's `stdout.jsonl` size/mtime; no output for 5 minutes
>   → SIGKILL, status `killed`. A task past its wall clock finishes
>   `timeout`; an explicit cancel finishes `cancelled`.
> - **Per-task status file** — `~/.pi/subagents/<id>/status.json` (override
>   with `PI_SUBAGENT_DIR`), with `pid`/`pgid`, written tmp-then-rename.
>   A generated runner wrapper records `done`/`failed` even if the parent
>   session is gone. Tunables: `PI_SUBAGENT_WAIT_S`, `PI_SUBAGENT_POLL_MS`,
>   `PI_SUBAGENT_WATCHDOG_MS`, `PI_SUBAGENT_STALE_MS`, `PI_SUBAGENT_MAX_MS`,
>   `PI_SUBAGENT_TERM_GRACE_MS`.
> - **Parallel** spawns all members detached (upstream's attached
>   concurrency-limited loop is gone); progress streams as aggregate
>   updates, and a hit wait cap returns the per-member id table.
> - **Chain stays foreground** — sequential and streaming, Ctrl+C abort
>   escalates TERM→KILL as upstream. Fix carried from the research: a
>   signal-killed child resolves as failure (`code ?? 1` plus signal
>   mapping), not upstream's silent success (`code ?? 0`).
> - **R2 per-agent thinking** — a `thinking` frontmatter field (`off` …
>   `max`) sets the agent's thinking level; the dispatch-level thinking is
>   the fallback, inherited only when the agent also inherits the dispatch
>   model.
> - **POSIX only** — the runner wrapper is bash (upstream spawned the child
>   directly).
> - **R5 implementer confinement (#17)** — the production form of the
>   prototype in [`../../prototype/r5-confinement/`](../../prototype/r5-confinement/).
>   Confinement is a **per-agent-definition property**: an agent whose
>   frontmatter carries `confinement:` spawns confined; the shipped
>   [`implementer`](agents/implementer.md) is the only one. Three independent
>   layers, composed at the spawn seam (both the detached background path and
>   the foreground chain path):
>   1. **Env allowlist + git pin** — the child env is built, not inherited:
>      `PATH`, `HOME`, `TERM`, `LANG`, `TMPDIR`, the proxy/TLS-root variables,
>      nothing else (model credentials ride pi's config store under `HOME`, not
>      env), plus `GIT_CONFIG_GLOBAL` pointing at a pinned per-child gitconfig
>      (identity in, credential helpers out), `GIT_CONFIG_NOSYSTEM=1`,
>      `GIT_TERMINAL_PROMPT=0`.
>   2. **PATH shim** — per-child `gh` stub (refuse all, exit 126) and `git`
>      wrapper (refuse `push`, exec through to the real binary otherwise),
>      prepended to the child's PATH. Every refusal prints one stderr line
>      beginning `CONFINEMENT_REFUSAL`.
>   3. **Tools allowlist** — unchanged `--tools` argv passthrough.
>   The material lives in the task dir on the background path (inspectable
>   evidence alongside the task record) and a cleaned-up temp dir on the
>   chain path. **Scope: accident-level, decided 2026-09-19** — the shim
>   stops accidents, not adversaries (the verified bypass chain in
>   [`../../prototype/r5-confinement/FINDINGS.md`](../../prototype/r5-confinement/FINDINGS.md));
>   the reviewer and the human merge gate are the backstops.
>   The child's `CONFINEMENT_REFUSAL` stderr lines surface as a `refusals`
>   field in the structured result and in the tool text and check output —
>   report lines, never errors: refusals are normal for a confined
>   implementer; the coordinator publishes.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── background.ts        # The wait/check background machinery (R8)
├── confinement.ts       # Implementer confinement: env allowlist, PATH shim, git pin (R5)
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   ├── worker.md        # General-purpose (full capabilities)
│   └── implementer.md   # Ticket implementation, confined (R5)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents in untrusted projects. Trusted projects skip the additional prompt. Set `confirmProjectAgents: false` to disable confirmation.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
confinement: implementer
---

System prompt for the agent goes here.
```

When `model` is omitted, the subagent inherits the dispatching session's active model and thinking level.

A non-empty `confinement` field spawns the agent confined (R5): env allowlist + pinned gitconfig, and a PATH shim refusing `gh` and `git push`. The value names the confinement profile; one profile ships, so any non-empty value gets it — a typo over-confines rather than under-confines. The agent's `CONFINEMENT_REFUSAL` stderr lines come back as a `refusals` field on the structured result.

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |
| `implementer` | Writes and verifies one ticket's change; **confined** — local commits only, no publishing (R5, #17) | glm-5.3-flash (ADR 0004) | read, edit, write, bash, ls, find, grep |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
