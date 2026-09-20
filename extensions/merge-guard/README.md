# Merge guard

Session-bound, client-side enforcement of the merge gate
([ADR 0011](../../../docs/adr/0011-merge-guard-session-bound-client-side-enforcement.md),
ticket afk-kit #23): no agent session merges a pull request or pushes to
`main`, in every pi session where afk-kit is installed — coordinators,
subagent children (fresh pi processes), and the maintainer's own interactive
sessions. No arming, no per-session opt-in: a guard that must be armed can
silently fail to arm (ADR 0011).

## What it refuses

A `tool_call` hook inspects every `bash` and `powershell` invocation and
blocks merge-capable ones with a `MERGE_GATE_REFUSAL` refusal whose reason
names the gate ([ADR 0002](../../../docs/adr/0002-human-merge-gate.md)) and
instructs stop-and-report per the escalation convention:

- **`gh-pr-merge`** — any `gh pr merge` invocation, with any flags.
- **`merge-api`** — the pull-request merge endpoint
  (`repos/<o>/<r>/pulls/<n>/merge`, REST or as a URL), the GraphQL
  `mergePullRequest` mutation, and the branch-merge endpoint
  (`repos/<o>/<r>/merges`) when `base` names `main` — each only when the
  command also carries a network carrier (`gh api`/`gh graphql`, the GitHub
  API host, any URL), so grepping docs for these strings passes.
- **`push-to-main`** — `git push` variants whose destination is `main`:
  explicit `main`/`refs/heads/main` refspecs in any spelling (including
  deletes, forces, and `HEAD:main`), `--all` and `--mirror` (which carry
  `main`), and, resolved with one real `git rev-parse`, a bare `git push`,
  a repository-only push, or a bare `HEAD` refspec from a checkout whose
  current branch is `main`. A failed resolution stays undecided: the guard
  refuses only what it can name.

## What passes through

The legitimate publisher path is untouched: pushes to `issue-*` branches
(explicit refspecs, `--force-with-lease`, `-u`), PR creation, `gh pr view`
and other reads, the coordinator ops (`claim_issue`, `publish_pr`),
local `git merge`, `git pull`/`git fetch` of `main`. Other extensions' tools
(the subagent tool, readiness check, coordinator tools) are not shell
invocations and are simply not inspected; subagent children are bound by
their own loaded copy of this guard.

## The honest strength bar

Accident-level and model-whim enforcement, not adversarial enforcement —
matching [ADR 0011](../../../docs/adr/0011-merge-guard-session-bound-client-side-enforcement.md)
and the R5 confinement precedent. Within a loaded session it is airtight
against accident: every network-capable path is a shell tool call at the
hook's boundary. It is deliberately **not** resistant to a session that
goes out of its way, and the bypasses are documented, not hidden:

- **Editing or uninstalling the toolkit between sessions** — the documented
  bypass chain. The guard is code on disk; a session that edits afk-kit or
  removes it has left the gate's jurisdiction. Detection of that is the
  `VENDORED.sha256` manifest and review, not this hook.
- **The maintainer's own hand outside any session** — a plain terminal, or
  the github.com UI, is "outside maintainer action" by definition (ADR
  0011). The TUI's `!` shell escape is likewise the human's own verbatim
  command with no model in the loop; it is the maintainer's hand, not agent
  action, and does not pass the `tool_call` boundary.
- **Over-matching, not under-matching** — the guard matches command
  *strings*, so a command that merely contains a refused fragment (an
  `echo` or a grep of a literal `git push origin main`) refuses too. That
  false-positive class is a documented cost: rephrase the command.

Enforcement costs the maintainer in-session merges and direct-to-`main`
pushes for as long as afk-kit is installed — that is the point. Server-side
rulesets remain recommended (never required) for target repositories as
defense-in-depth for the direct-push half (ADR 0011).
