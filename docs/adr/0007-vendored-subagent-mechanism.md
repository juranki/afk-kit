# Vendored subagent mechanism

- **Status:** Accepted
- **Date:** 2026-09-13

The toolkit's delegation half is a **vendored fork of pi's example `subagent`
extension** (`examples/extensions/subagent/`, MIT): one child `pi --mode json -p
--no-session` process per subagent task, markdown-frontmatter agent definitions,
per-task `cwd`, parallel dispatch, and per-task usage reporting. The fork adds the
hardening the safety-critical requirements demand (gaps listed below). The
candidate survey and the full R1–R10 comparison are on
[issue #1](https://github.com/juranki/afk-kit/issues/1). Coordinator-side mechanics —
atomic claim + worktree + branch, push + pull request, the merge guard — are afk-kit
extension code per [ADR 0006](0006-extensions-for-mechanics-skills-for-judgment.md):
no surveyed candidate provides them, and the vendored mechanism competes with none of
them.

**Why this shape:** the child's full command line, tools allowlist, and environment are
assembled in code afk-kit owns, at spawn time, per task. That spawn seam is the only
honest place to confine an implementer (R5) deterministically, and process-per-task
gives the child a real pi startup inside the issue worktree (R3) instead of a session
inheriting the parent's loaded resources. In-process candidates run subagents inside
their own runners, where confinement would depend on their internals and their
worktree/run state systems (branches, schedules, stores) would sit beside the
coordinator's (R7).

**Considered options:**

- *Adopt a third-party delegation package* — `pi-subagents` (nicobailon),
  `@tintinweb/pi-subagents`, `pi-subagents-j0k3r` — rejected: subagents run as
  in-process sessions, so the spawn seam is not ours (R5 depends on their internals);
  their own state systems compete with the coordinator's (R7); tintinweb's worktree
  isolation is extension-owned, throwaway (`pi-agent-*` branches), and by its own docs
  "a directive, not a sandbox".
- *`pi-fairy-tales`* — the only candidate with real, fail-closed guard rails —
  rejected: it is a whole harness (memory, compaction, quests, TUI), conflicting with
  the minimal mechanics/judgment split of ADR 0006.
- *External subagent CLI* (`pi-subagent`, codex-pi-agents) — rejected: unlicensed,
  not a pi package, single maintainer, and it explicitly ships no sandbox.
- *Use pi's example as-is* — rejected: no per-subagent timeout or cancel (R8), no
  confinement path (R5); and as a shipped example it carries no compatibility promise,
  so owning the code costs nothing extra.

**Consequences — gaps and how they close (all in the vendored fork):**

- **R5 (implementer confinement).** Children spawn with a stripped environment — no
  GitHub credentials — and a PATH shim that refuses `gh` and `git push` while allowing
  `git commit`; the frontmatter tools allowlist passes through the existing `--tools`
  argv. Exact shim mechanics are an implementation decision.
- **R8 (timeout/cancel).** Adopt the wait/check pattern from the
  `pi-subagent-tool` fork (MIT): a per-call wait cap returns
  `{status: "running", subagentId}` so the coordinator stays in control, with a
  per-task status file and a hang watchdog. *Amended 2026-09-14 after reading the
  fork's source ([research](../research/pi-subagent-wait-check.md)):* the fork
  proves the wait cap, the status file, and a hang watchdog that covers only its
  foreground/chain path. It has **no cancel (kill by id)**; its wait cap bounds the
  coordinator's call, not the child's lifetime; and the detached background tasks
  wait/check creates are never watched. Cancel, any task wall-clock cap, and
  background-path watchdog coverage are afk-kit's own work, built on the fork's
  seams (detached process group, `SIGKILL` → `killed` status mapping), and the
  vendored port must add the child-pid record any kill-by-id needs. The original
  text credited "a cancel (kill by id)" to the fork — that was design intent, not
  provenance.
- **R2 (per-agent thinking).** Add a `thinking` frontmatter field (the example only
  has dispatch-level thinking); `model` already satisfies [ADR 0004](0004-flash-first-model-routing.md).
- **R6 (verdict).** No candidate has a verdict primitive; the reviewer agent
  definition and a JSON verdict convention close it, parsed deterministically
  coordinator-side; an unparseable verdict escalates like any other failure.
- **Ownership.** afk-kit maintains the vendored code against pi's extension API
  (pi 0.85.1, MIT at selection time) and re-evaluates the third-party packages if that
  maintenance outweighs adoption.
- **Coordinator session location** (retired open question): coordinator sessions run
  in the **primary checkout**, for the whole session. The worktree cannot be the
  session's home: it does not exist when the session starts — claim + worktree + branch
  is one atomic operation the coordinator performs mid-session (R7) — and pi sessions
  are keyed to the working directory at startup with no supported way to re-key
  mid-session. The mechanism's `cwd` parameter pins each subagent to the worktree root,
  and the coordinator's deterministic operations take the worktree path as an explicit
  argument (`git -C <worktree> …`), so nothing depends on where the session sits.
  Consequence for [ADR 0001](0001-per-issue-coordinators.md): its decision stands, but
  its directory-keying rationale does not carry over — per-issue history is one named
  session file per run (`pi.setSessionName("issue-<n>")`), and `/resume` at the primary
  checkout mixes coordinators across issues, mitigated by those names.
