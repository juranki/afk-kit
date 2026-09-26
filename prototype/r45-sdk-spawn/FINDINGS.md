# FINDINGS — r45: one SDK-driven implementer spawn

Answers wayfinder ticket [#45](https://github.com/juranki/afk-kit/issues/45).
Prototype: throwaway, `main.ts` + two probes, run on 2026-09-24 against
`@earendil-works/pi-coding-agent` 0.85.x, model `zai/glm-5.3-flash` (ADR 0004),
in-process — no pi subprocess anywhere.

## The answer

**Yes — the engine can drive the implementer in-process through the SDK**, and
the vendored fork survives almost intact as libraries. One genuine surprise
surfaced (finding 3) and it shapes the engine's cap/retry design.

## 1. Session lifecycle — works as documented

- `createAgentSession({ cwd, model, thinkingLevel, tools, customTools, sessionManager })`
  creates the session; `session.prompt(task)` **resolves when the run
  finishes** — through 6 tool calls and ~132 s of work, no polling.
- **Timeouts**: engine-side `setTimeout` + `session.abort()` is the wall-clock
  cap shape. `prompt()` resolves (does not hang, does not reject-unhandled);
  `turn_end` carries `stopReason: "aborted"`; `agent_end`/`agent_settled`
  follow; the session is idle afterwards.
- **Cancellation**: `session.abort()` on an idle-pending or running session is
  clean. At the tool layer (probe-abort.ts) a killed subprocess surfaces as a
  thrown `Command aborted`; the group is SIGKILLed (`killProcessTree`), so a
  capped command cannot leave stragglers.
- **Re-prompting after abort works** — but see finding 3 before relying on it.
- `session.dispose()` ends the session. `SessionManager.inMemory(cwd)` keeps
  the session file out of the worktree (the engine writes its own trace — see
  finding 5); a file-backed manager is available if the session JSONL itself
  is wanted.

## 2. Confinement — the fork's R5 rides in-process via `spawnHook`

No child process means no child *environment* — but the SDK exports
`createBashToolDefinition(cwd, { spawnHook })`, and the hook rewrites
`{ command, cwd, env }` per subprocess. The fork's `buildConfinedEnv` slots in
unchanged:

```ts
const confinedBash = createBashToolDefinition(worktree, {
	spawnHook: (ctx) => ({ ...ctx, env: buildConfinedEnv(ctx.env, material) }),
});
```

Proven live: the implementer's `git push` was refused by the shim (exit 126,
`CONFINEMENT_REFUSAL` line), `materializeConfinement` and `extractRefusals`
imported from `extensions/subagent/confinement.ts` unmodified. **Env allowlist
surprise, benign**: `exposeSessionEnvironment` (default) injects `PI_*` vars
into every subprocess; the allowlist already drops them.

**Pin surprise — custom tools are allowlisted by name.** Passing
`customTools: [bash]` while omitting `"bash"` from `tools` silently yields a
session with **no bash at all** (first run: the implementer edited and
*narrated* commands it couldn't run). The allowlist filters custom tools too;
listing `"bash"` in `tools` makes the confined custom definition override the
built-in by name. The engine must pin this in its construction code — it fails
silent, not loud.

## 3. The surprise: an aborted prompt contaminates the session

The cancel drill aimed to abort a long generation. It aborted *earlier* than
planned (the model hadn't started), `prompt()` resolved cleanly — and the
drill's user message **stayed in the session transcript**. The next prompt's
agent run saw *both* user messages, judged the cancelled instruction still
binding ("Task says run exactly sleep 90 && echo done. Do it first.") and
executed it — 90 s of ghost work the engine never asked for, visible only
because the trace kept everything.

Consequences for the engine:

- **Never re-prompt a session after an abort.** A capped/failed attempt must
  start a fresh session (fresh `SessionManager.inMemory`), or the retry
  inherits abandoned instructions. This dovetails with the ≤3-attempt cap:
  attempt-in-place would compound the contamination.
- An in-flight `prompt()` cannot be "taken back" textually — abort stops the
  *run*, not the *record*.

## 4. Fork disposition (what survives as libraries)

| Fork piece | Fate in the engine |
| --- | --- |
| `confinement.ts` (allowlist, shim, gitconfig pin, refusal extraction) | **Survives as-is**, imported by the engine at its bash-tool construction |
| `verdict.ts` parse | Survives; reviewer-side, untouched by this prototype |
| `background.ts` (spawn/wait/check/cancel/watchdog, JSON-mode argv) | **Replaced** — its reason to exist was the process boundary; SDK sessions remove it (≈870 lines) |
| `index.ts` TUI/dispatch/parallel/chain | Replaced — the engine's loop is deterministic code, not extension UI |
| `agents.ts` frontmatter discovery | Partially survives: agent *definitions* (prompts, tools, thinking) still want a file format |

## 5. Traceability — the trust-but-verify store is just the event stream

`session.subscribe` delivers every event (message deltas, tool calls with
args, tool results, refusals, lifecycle, stop reasons). Writing them as JSONL
gave a complete run record (351 events, `run/events.jsonl`) from which the
whole session reconstructs; `session.messages` snapshots the authoritative
transcript (`run/messages.json`). Engine-side verification stayed independent:
`bun test` exit 0 in the worktree, `git status` clean, the commit present —
the engine never trusted the model's "done" claim.

## Run stats

One scratch worktree, one session, two prompts: 4 s drill (aborted) + 132 s
task, 351 events, `zai/glm-5.3-flash`, trivial cost. Artifacts: `run/`
(gitignored), probes `probe-abort.ts` (tool-layer abort) and `probe-shell.ts`
(confined-env timing control).
