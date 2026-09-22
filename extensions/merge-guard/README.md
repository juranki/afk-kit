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

- **`gh-pr-merge`** — any `gh pr merge` invocation, with any flags —
  found at every position where a command actually begins: the segment's
  own command (past assignments, loop keywords like `do`/`then`, and
  wrappers that consume flag values — `sudo`, `env -u X`, `nice -n 5`,
  `timeout 10`), `xargs`'s trailing command, a `sh -c`/`bash -c` body,
  and `$()`/backtick spans. Merely quoting the phrase in a flag payload
  does not fire it; composing it out of sight does.
- **`merge-api`** — the pull-request merge endpoint
  (`repos/<o>/<r>/pulls/<n>/merge`, REST or as a URL), the GraphQL
  `mergePullRequest` mutation, and the branch-merge endpoint
  (`repos/<o>/<r>/merges`) when `base` names `main`. The fragment refuses
  only when its own segment is an actual network call: a `gh` invocation
  whose parsed subcommand is `api`/`graphql`, or a non-`gh` segment that
  carries a network carrier (the words `gh api`/`gh graphql`, the GitHub
  API host, any URL) — a `curl` of the endpoint, say — so grepping docs
  for these strings passes.
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
local `git merge`, `git pull`/`git fetch` of `main`. So are commands whose
flag payloads merely quote the trigger patterns — a `gh issue comment`
whose `--body` says `gh pr merge`, an inline `node -e` script containing
the endpoint path: payload text is data, not command (#36). Other
extensions' tools (the subagent tool, readiness check, coordinator tools)
are not shell invocations and are simply not inspected; subagent children
are bound by their own loaded copy of this guard.

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
- **Over-matching, not under-matching** — the `git push` check matches
  command *strings*, so a command that merely contains a refused fragment
  (an `echo` or a grep of a literal `git push origin main`) refuses too.
  That false-positive class is a documented cost: rephrase the command.
  The gh and API checks are the opposite (#36): they parse command
  *position* — the segment's own command, `xargs`'s trailing command, a
  `sh -c` body, `$()`/backtick spans — so flag-payload text — comment
  bodies, commit messages, inline scripts — is data, never command, and
  quoting merge vocabulary in a `--body` passes. Because substitution
  spans execute even inside a double-quoted payload, their text is
  scanned as command; a *single-quoted* span the shell would leave
  literal, or a JavaScript template literal inside an inline script, can
  therefore false-refuse — the same string-level residue class as the
  push check's, rephraseable the same way. Endpoint fragments are
  scanned only when the segment's parsed subcommand is
  `gh api`/`gh graphql`, or a non-`gh` segment carries a network carrier
  — so a URL pasted into a non-`gh` command's payload can still refuse,
  the residue of the string-level class. The flag tables those parses
  walk are hand-maintained, so the gh/API checks fail closed on the
  unknown (#36): a flag the guard does not recognize, anywhere before
  the parsed subcommand, marks the segment's resolution ambiguous and
  the ambiguity zone gets the raw fragment scan back — flag-decorated
  merge, merge-endpoint, and push-to-`main` spellings refuse even though
  they parsed to nothing. The cost is the mirror image of the push
  check's: an unrecognized flag plus quoted merge vocabulary in the same
  gh segment can false-refuse; rephrase by moving flags after the
  subcommand or attaching values with `=` (for example `--template=tpl`).

Enforcement costs the maintainer in-session merges and direct-to-`main`
pushes for as long as afk-kit is installed — that is the point. Server-side
rulesets remain recommended (never required) for target repositories as
defense-in-depth for the direct-push half (ADR 0011).
