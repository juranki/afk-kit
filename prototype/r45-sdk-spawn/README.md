# PROTOTYPE — r45: one SDK-driven implementer spawn

**Throwaway.** Answers wayfinder ticket
[#45](https://github.com/juranki/afk-kit/issues/45) ("Prototype: one SDK-driven
implementer spawn") on map
[#43](https://github.com/juranki/afk-kit/issues/43). Expect it to be deleted
once its findings are folded into the engine design.

## Question

Can the deterministic engine drive an implementer session through the pi SDK
(in-process `createAgentSession`/`prompt()`), and what of the vendored fork
survives as libraries?

## What it does

One command, ~2 model calls on `zai/glm-5.3-flash` (pennies):

1. Builds a scratch git repo (a buggy `add(a, b)` + failing `bun test`) and a
   worktree on branch `afk/demo-ticket`.
2. Materializes the fork's R5 confinement **reused as a library** from
   `extensions/subagent/confinement.ts` (shim + pinned gitconfig).
3. Creates an in-process session via `createAgentSession` with the model pinned
   to `zai/glm-5.3-flash`, tools limited to read/edit/grep/find/ls plus a
   **confined bash** built with `createBashToolDefinition` whose `spawnHook`
   applies `buildConfinedEnv` per subprocess.
4. **Cancel drill**: prompts something unbounded, aborts it after ~4 s, then
   re-prompts the same session with the real task (proves lifecycle:
   prompt → abort → idle → prompt again).
5. **Real task**: fix the bug, verify with `bun test`, commit; then a required
   `git push` drill that must be refused by the shim (proves confinement rides
   in-process).
6. Every session event is streamed to `run/events.jsonl` (the trust-but-verify
   trace); the final transcript goes to `run/messages.json`; engine-side verify
   (`bun test`, `git status`, refusal extraction) prints a FINDINGS summary.

## Run

```sh
bun prototype/r45-sdk-spawn/main.ts
```

Inspect `run/events.jsonl` and `run/messages.json` afterwards. Findings land on
the ticket, not here.
