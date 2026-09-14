# Research: the wait/check pattern in pi-subagent-tool (wayfinder ticket #9)

- **Ticket:** [#9 — The wait/check pattern in pi-subagent-tool: timeout, status file, watchdog, cancel](https://github.com/juranki/afk-kit/issues/9)
- **Question:** [ADR 0007](../adr/0007-vendored-subagent-mechanism.md) adopts the wait/check pattern "proven by the `pi-subagent-tool` fork (MIT)" for R8 ("a stuck subagent can be timed out or cancelled; the coordinator keeps control throughout"). What exactly does that pattern do, and what does adopting it into the vendored `examples/extensions/subagent/` require?
- **Date:** 2026-09-14
- **Method:** primary sources only — the fork's actual source (cloned and read in full) and the vendored example's source (read in full). Every claim below cites file and line.

## Verdict up front

The fork is real, MIT, and derives from pi's example subagent extension. It **does** prove three of the four things ADR 0007 attributes to it: the per-call wait cap returning `{status: "running", subagentId}`, the per-task status file, and a hang watchdog. It does **not** implement **cancel (kill by id)** — no such parameter, code path, or README mention exists anywhere in the fork. Its hang watchdog also covers only the *foreground* dispatch path, not the background tasks the wait/check pattern itself creates. Both gaps are implementable on the seams the fork provides, but they are afk-kit's work, not a port of the fork's code. ADR 0007's sentence "a cancel (kill by id) the fork adds" overstates the source and should be corrected when the fork is written (or accepted as design intent, not provenance).

## 1. Locating the fork

GitHub search for `pi-subagent-tool` returns three repos; all three are MIT; none is a GitHub *fork* — the ADR's "fork" means a code fork of pi's example extension:

| Repo | MIT | Is the one? |
| --- | --- | --- |
| [alechacr/pi-subagent-tool](https://github.com/alechacr/pi-subagent-tool) | yes ([LICENSE](https://github.com/alechacr/pi-subagent-tool/blob/main/LICENSE)) | No — its README says it "packages the pi-mono `subagent` example extension" **as-is** (README, lines 1–6); no wait/check. |
| [san-tian/pi-subagent-tool](https://github.com/san-tian/pi-subagent-tool) | yes | No — packaging of the official example plus a `runtime.ts` helper; no wait/check (`subagentId` never appears in its source). |
| [KatouMegumi-dar/pi-subagent-tool](https://github.com/KatouMegumi-dar/pi-subagent-tool) | yes (LICENSE: "Copyright (c) 2026 KatouMegumi-dar") | **Yes.** README: "非阻塞设计：默认最多等 180s，超时返回 `{status:"running", subagentId}` … 稍后 `check` 回收结果" — exactly the ADR's fingerprint. |

Derivation from pi's example is verifiable in the code: identical file header comment, identical `formatTokens`/`formatToolCall`/`renderCall`/`renderResult` lineage, and an `agents.ts` that is pi's example file with edits (fork `agents.ts` vs `examples/extensions/subagent/agents.ts`: same `discoverAgents` shape; the fork adds `thinking` frontmatter and an `inline` source, imports the legacy `@mariozechner/pi-coding-agent` package name). The repo has two commits (`9e57dc8` initial feature, `306e603` cross-version install compat; `main` pushed 2026-08-16); `package.json` declares `"license": "MIT"` and peer deps `@earendil-works/pi-coding-agent >=0.80.0` / legacy `@mariozechner/pi-coding-agent >=0.67.0`.

All further citations are to `index.ts` of KatouMegumi-dar/pi-subagent-tool at commit `306e603` ("fork") and to `examples/extensions/subagent/index.ts` as vendored in pi 0.85.1 ("vendored"; 1,038 lines). Line numbers for the vendored file refer to the copy at `@earendil-works/pi-coding-agent@0.85.1`.

## 2. What the pattern does

### 2.1 Two state machines, not one

The pattern separates the **task's** lifecycle (persisted in the status file) from the **call's** lifecycle (how long the parent's tool call blocks). Conflating them is the main way to misread it.

**Task lifecycle — the `status` field of `status.json`** (fork 465–477 initial; 513–521 terminal; 425–447 runner script):

```
running ──exit 0──▶ done
   │
   ├──exit ≠ 0─────▶ failed
   │
   └──SIGKILL──────▶ killed   (exitCode 137; errorMessage "killed by poll watchdog" when the watchdog fired)
```

- `running` is written synchronously by the parent at spawn time (fork 464–477).
- `done`/`failed` are written **by the child wrapper itself**: the parent spawns `bash runner.sh <pi …>`, and a generated `runner.sh` captures the exit code and rewrites the status file via an inline `node -e` (fork 423–447, `ensureRunner`). The comment states why: "completion is recorded even if the parent pi process has already exited" (fork 421–423).
- A redundant in-parent `proc.on("exit")` handler calls `finalizeBackgroundStatus` if the wrapper somehow didn't (fork 486–489) — it maps `signal === "SIGKILL"` → `killed`/137 (fork 512–521). Notably nothing in the fork ever sends that SIGKILL to a background task: the mapping is a prepared seam, and the ADR's "cancel" was probably meant to occupy it.

There is **no `timeout` and no `cancelled` status** in the fork. Timeout is a property of the *call*, below.

**Call lifecycle — how long one `subagent` tool call blocks** (fork 33–37, 395–399):

```
dispatch ──▶ polling (read status.json every POLL_INTERVAL_MS)
   │                │
   │                ├─ status ≠ running ──▶ return final result
   │                └─ deadline reached ───▶ return {status:"running", subagentId}
   └─ wait: 0 / background: true ──────────▶ return {status:"running", subagentId} immediately
```

- `wait` parameter: default 180 s (`WAIT_DEFAULT_SECONDS`, fork 34); `0` = pure background; negative = wait forever ("legacy") (fork 30–37, 395–399, 906–912).
- **The wait cap caps the parent's blocking time, not the child's lifetime.** On deadline the child keeps running; the call returns control with the id (fork 496–511: `waitForSubagent` returns the still-`running` status at deadline; single-mode execute then renders `⏳ … [subagentId: <id>] … 稍后用 subagent({check: "<id>"})` — fork 1264–1276). If R8's "timed out" is read as *the task terminates after a wall-clock budget*, the fork does not provide that either; it must be added (§4, item 3).

### 2.2 The status file

- **Location:** `$PI_SUBAGENT_DIR || ~/.pi/subagents/<subagentId>/status.json` (fork 35, 83–96). Siblings in the same per-task directory: `stdout.jsonl` (the child's full `pi --mode json` event stream — also the source for work history), `stderr.log`, `prompt.md` (the task text), and `system-prompt.md` for background spawns (fork 86–96, 552–560).
- **`subagentId` format:** `<base36 timestamp>-<6 random chars>`, with optional group/step infix for parallel members (`t0`, `t1`… and group `grp`) (fork 77–81).
- **Initial contents** (fork 465–476): `{subagentId, agent, mode, step, task (≤2000 chars), status: "running", startedAt (ISO), exitCode: null, errorMessage: null}`. **Terminal additions** (fork 513–521, and runner script 431–443): `status`, `exitCode`, `finishedAt`, optional `errorMessage`.
- **Atomicity:** written tmp-then-rename; the parent's writes go through pi's `withFileMutationQueue` (fork 99–105); the runner's `node -e` does plain tmp+rename (fork 439–442).
- **Not persisted: the child's pid.** `spawnBackgroundSubagent` never records `proc.pid` (fork 448–494). This is the concrete obstacle to retrofitting kill-by-id onto the fork's files (§4, item 2).

### 2.3 The wait/check contract (how the Coordinator keeps control)

1. Parent calls `subagent({agent, task, wait?})`. Dispatch is **detached** (`detached: true`, `proc.unref()`, stdio redirected to file descriptors — fork 455–461), so the child survives the parent exiting and the event loop stays free.
2. The call polls `status.json` until terminal or deadline (single: fork 496–511, 1258–1264; parallel group: poll all member statuses in one loop — fork 1146–1163). During the wait it emits `onUpdate` progress ("⏳ running… 2m31s", fork 1258–1263).
3. On deadline: returns `{status:"running", subagentId}` plus a current work-history snapshot and an explicit instruction to re-check (fork 1264–1276). For parallel: group id + member ids + per-member status/timeline (fork 1164–1181).
4. Parent later calls `subagent({check: "<id>"})`: reads `status.json` + reconstructs the tool-call timeline from `stdout.jsonl` (`readWorkHistory`, fork 329–393; check branch fork 1012–1055), returning status, exit code, elapsed time, errors, timeline, and final output. `history:"full"` returns the complete message stream.
5. A module-level watcher (`startCompletionWatcher`, every 5 s, fork 40–75) scans in-memory `backgroundAgents` entries, and when a status file turns terminal fires `ctx.ui.notify` + clears the `ctx.ui.setStatus` footer (API verified present in pi 0.85.1: `dist/core/extensions/types.d.ts:76,80`).

### 2.4 The hang watchdog — and its scope

The watchdog lives in the **foreground** runner `runSingleAgent` (fork 585–790), which the fork retains **only for chain mode** (chain executes step-by-step, blocking, fork 1032–1101):

- A `setInterval` every `POLL_INTERVAL_MS` (500 ms, `PI_SUBAGENT_POLL_MS`) checks `proc.exitCode`/`proc.signalCode` instead of waiting on the `close` event (fork 713–742). The comment records the reason: a signal-killed child reports `exitCode === null`, so a close-only wait can deadlock.
- **Hang detection:** every stdout/stderr byte updates `lastOutputTs` (fork 689–699); if no output for `STALE_TIMEOUT_MS` (300 s default, `PI_SUBAGENT_STALE_MS`) → `proc.kill("SIGKILL")`, resolve exit **124**, `errorMessage: "subagent hung: no output for Ns, killed by poll watchdog"` (fork 729–736). It is a *no-progress* watchdog (staleness), not a wall-clock cap.
- A heartbeat re-emits `(running...)` every 2 s (fork 737–740).
- Exit-code repair: `close` resolves `code ?? 1` (fork 738–741 comment at 723–725) where the vendored example resolves `code ?? 0` (vendored 402) — i.e. the vendored example counts a signal-killed child as success; the fork fixed this.

**Scope caveat:** background tasks (the single/parallel paths the wait/check pattern actually uses) get **no** hang detection. Their stdout goes straight to a file descriptor — nothing monitors it (fork 455–461), and the 5 s completion watcher only reacts to terminal statuses (fork 53–75). A background child that produces output forever never finishes and is never killed. If R8's watchdog is meant to protect the Coordinator's *delegated* tasks, the fork proves the mechanism but not its application to the background path.

### 2.5 Cancel — what the fork actually has

- **No kill-by-id.** `check` (fork 1012–1055) only reads. There is no `cancel` parameter (schema fork 901–955), no kill call reachable from the tool surface, and no mention of cancel in the README. `proc.kill` appears exactly twice: the foreground watchdog (fork 734) and the foreground abort handler (fork 757–769).
- The only cancellation is the tool-call `AbortSignal` (user aborts the *call*): SIGTERM, then SIGKILL after 5 s (fork 760–769) — identical to the vendored example's existing handler (vendored 410–419). This kills the foreground child; for background tasks the signal is never wired, and the parent could have already returned.

## 3. Checking ADR 0007's claim against the source

| ADR 0007 attributes to the fork | Source verdict |
| --- | --- |
| "a per-task wait cap returns `{status:"running", subagentId}`" | **Confirmed.** `wait` param, 180 s default (fork 34, 395–399); running-return at deadline (fork 508–510, 1264–1276). |
| "with a status file" | **Confirmed.** `~/.pi/subagents/<id>/status.json`, atomic writes (fork 35, 83–105, 99–105). |
| "a hang watchdog" | **Confirmed for the foreground/chain path only** (fork 713–742). Background tasks — the ones the wait/check pattern creates — are unwatched. |
| "and a cancel (kill by id) the fork adds" | **Not present.** No cancel parameter or kill-by-id path exists (grep + full read of `index.ts` at `306e603`; README lists no cancel). Only the tool-call abort exists (fork 757–769). |

The license assumption holds (MIT in `LICENSE` and `package.json`). The "proven" claim holds for wait/check + status file; the watchdog is proven only half-way; cancel is design intent, not prior art.

## 4. Adaptation map: adopting the pattern into the vendored example

Target file: the vendored `examples/extensions/subagent/index.ts` (1,038 lines, imports `@earendil-works/*` at lines 9–23 — keep these; the fork's legacy-`@mariozechner` compatibility layer — local `StringEnum`, local `Message` — is unnecessary at pi 0.85.1, which the vendored example already imports directly, lines 13–14).

| # | Piece | Fork reference | Vendored anchor | Required work |
| --- | --- | --- | --- | --- |
| 1 | Ids, status dir, atomic status I/O | 33–37 (`WAIT_DEFAULT_SECONDS`, `SUBAGENT_DIR`), 77–96 (id/dir/path helpers), 99–105 (`writeJsonAtomic`), 107–123 (`readStatus[Sync]`) | none — new module-level section after constants (25–29) | Port nearly verbatim. Decide the directory: `~/.pi/subagents` is user-global; the Coordinator's status belongs in afk-kit-owned state (keep `PI_SUBAGENT_DIR`-style override). `withFileMutationQueue` is already imported (vendored line 17). |
| 2 | Detached spawn + runner wrapper | 421–447 (`ensureRunner`), 448–494 (`spawnBackgroundSubagent`, incl. initial status write + redundant exit handler) | `runSingleAgent` spawn at 344–348 is attached/piped; argv built inline at 297–310, 337–341 | Factor argv building out of `runSingleAgent` into a shared helper (fork's `buildSubagentArgs`, 543–582, is the reference shape). Add `pid`/`pgid` to the status record at spawn — **the fork omits it**, and kill-by-id is impossible without it. Spawn with `detached: true` (fork 459): on POSIX the child then leads its own process group, so cancel can `process.kill(-pgid, …)` to reach the `bash runner.sh` wrapper *and* the pi grandchild; killing the wrapper's pid alone orphans the grandchild. |
| 3 | Wait cap + running-return | 395–399 (`computeWaitMs`), 496–511 (`waitForSubagent`); single execute 1213–1291; parallel group loop 1146–1181 | single mode 688–710; parallel mode 604–686 | Replace both `await runSingleAgent` call sites with spawn-background + poll-status. Decide afk-kit's default cap (fork's 180 s is per-call, not per-task). For R8's "timed out" as task termination, add a wall-clock task cap in the poll loop that transitions to cancel (item 5) — the fork has no such cap. Consider keeping the vendored parallel path's streaming placeholders (`exitCode: -1`, 613–624) if live per-task streaming is wanted; the fork drops it (details materialize only at settle). |
| 4 | Check mode + work history | 329–393 (`readWorkHistory`, `formatTimeline`, `elapsedSince`), 1012–1055 (check branch), params `check`/`history` 914–929 | none — add `check`/`history` to `SubagentParams` (459–470), `hasCheck` to the mode-count validation (493–497), and the check branch at the top of `execute` (483) | Port nearly verbatim; `stdout.jsonl` parsing depends only on `pi --mode json` event shapes (`message_end`, `tool_result_end`) already parsed in the vendored example (365–398). |
| 5 | Cancel (kill by id) | **absent** — seam only: SIGKILL→`killed` mapping (512–521), detached spawn (459) | none — add `cancel: <id>` param; implement branch near check | New code: read `status.json` → must be `running`; `process.kill(-pgid, "SIGTERM")`, then SIGKILL after a grace period (fork's abort escalation at 760–769 is the timing reference); `finalizeBackgroundStatus(id, 137/143, "SIGTERM"|"SIGKILL", "cancelled by coordinator")` — consider adding a distinct `cancelled` status so the Coordinator can distinguish cancel from hang-kill. Depends on item 2's pid/pgid record. |
| 6 | Hang watchdog | 128–135 (tunables), 689–699 (`lastOutputTs` in data handlers), 713–742 (`pollTimer`) | data handlers 390–398; completion via `close` 401–405, `error` 406–409 | Insert `lastOutputTs` bookkeeping and the poll timer into `runSingleAgent` (which the fork keeps for chain). Then extend coverage to background tasks — the fork's gap: e.g. the 5 s watcher (item 7) additionally checks staleness of `stdout.jsonl` mtime/size per running task and performs the cancel of item 5. Without this, R8's watchdog never sees a delegated task. Also adopt the fork's `code ?? 1` close semantics (738–741) over the vendored `code ?? 0` (vendored 402). |
| 7 | Completion watcher (UI notify) | 40–75 (`startCompletionWatcher`, `backgroundAgents`) | none | Port if the coordinator session is interactive (it is, per ADR 0007's primary-checkout decision); `ctx.ui.notify`/`ctx.ui.setStatus` exist in 0.85.1 (`dist/core/extensions/types.d.ts:76,80`). If item 6 extends this watcher for staleness, merge the loops into one. |
| 8 | Params + tool description | schema 901–955; description 933–941 | `SubagentParams` 459–470; `registerTool` 472–481 | Add `wait`, `background`, `check`, `history`, `cancel` (afk-kit addition). Update the description so the parent model learns the non-blocking contract — the fork's description (933–941) is the reference text. |
| 9 | Render paths | `renderCall` check branch 1300–1307; rest identical lineage | `renderCall` 723, `renderResult` 767–1036 | Minimal: render `check`/`cancel` calls; `renderResult` needs no structural change if details shapes are preserved. |
| 10 | Leave alone (verified equivalent) | — | project-agent trust gate 500–537 uses `ctx.isProjectTrusted()` (fork 968–1007 replaced it with a bare confirm — keep the vendored, stricter version); `mapWithConcurrencyLimit` 219 — the fork never calls it in background paths (definition at fork 401 has no call site), so its parallel path spawns all ≤8 children at once despite the documented "concurrency ≤4"; if afk-kit wants a real concurrency cap for spawned children, it must re-introduce gating — the fork is not a reference here. |

## 5. Findings

1. **The referent exists and is MIT** — KatouMegumi-dar/pi-subagent-tool @ `306e603`, derived from pi's example extension. ADR 0007's license and provenance assumptions hold.
2. **Three of four pattern elements are proven by the source**: wait cap + running-return, status file, foreground hang watchdog — each traced to specific lines above.
3. **"A cancel (kill by id) the fork adds" is not in the fork.** Cancel must be written new; the fork supplies the seams (detached process group, SIGKILL→`killed` status mapping) but not the mechanism, and omits the pid record any kill-by-id needs. This should be recorded — either as an ADR correction or explicitly as design intent.
4. **"Timeout" is a property of the call, not the task, in this pattern.** The wait cap never terminates a child; the watchdog kills on *no output*, not on elapsed time. If R8 means a task wall-clock budget, the vendored fork adds it (item 3/5 of the map).
5. **The watchdog doesn't watch the background path.** The tasks most in need of it (delegated, detached, possibly outliving the call) are exactly the ones the fork never monitors. Extending staleness watching to background tasks is the largest piece of new design (item 6).
6. **Incidental fixes worth carrying:** signal-killed children must not resolve as success (`code ?? 0` at vendored 402 vs the fork's `code ?? 1`), and the project-agent trust gate should stay the vendored example's stricter `ctx.isProjectTrusted()` variant.

## Sources

- KatouMegumi-dar/pi-subagent-tool, commit `306e603` (main, pushed 2026-08-16): `index.ts` (1,621 lines), `agents.ts`, `README.md`, `LICENSE`, `package.json`, `test/smoke.test.cjs` — cloned from <https://github.com/KatouMegumi-dar/pi-subagent-tool> and read in full.
- Disambiguation: alechacr/pi-subagent-tool and san-tian/pi-subagent-tool (READMEs and source grep; `subagentId` absent from both).
- Vendored example: `@earendil-works/pi-coding-agent@0.85.1`, `examples/extensions/subagent/index.ts` (1,038 lines) and `README.md` — read in full.
- pi extension API: `@earendil-works/pi-coding-agent@0.85.1` `dist/core/extensions/types.d.ts` (lines 76, 80: `ui.notify`, `ui.setStatus`); `docs/extensions.md` (extension example table row `subagent/`).
- Ticket and requirement text: GitHub issue juranki/afk-kit#9; `docs/requirements/subagent-mechanism.md` (R8, line 24); `docs/adr/0007-vendored-subagent-mechanism.md` (R8 consequence).
