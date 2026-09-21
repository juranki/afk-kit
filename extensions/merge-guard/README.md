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
  a repository-only push, or a bare `HEAD` refspec from the command's own
  directory when its current branch is `main`. A failed resolution stays
  undecided: the guard refuses only what it can name.

### The command's own directory (#38)

A head-dependent push is judged in the directory the command itself runs
in, not the session's working directory. The walk that finds that
directory is exact, and this is its whole contract:

- **A leading run of simple `cd [-L|-P] <plain-dir>` segments moves the
  directory** the one branch resolution runs in. The first segment is
  consumed whatever operator joins it to the rest of the command — `&&`,
  `||`, `;`, `|`, or a newline (`;` and a newline preserve the directory
  change in the shell just like `&&`, so `cd <worktree>; git push` decides
  in the worktree); further simple `cd`s extend the walk while joined by
  `&&`, relative targets resolved against the walk's progress. So `cd
  <worktree> && git push` from a main-checkout session is judged by the
  worktree's branch and passes, while the same push from a checkout on
  `main` refuses naming the branch actually resolved there.
- **The directory persists across interior commands** — it never resets:
  `cd <worktree> && git status && git push` still decides in the worktree.
- **A `cd` that appears after a real command is not tracked** — the
  session directory decides, even though the shell will have changed
  directory by push time. This residue fails in both directions, and both
  are accepted costs, not hidden holes: a session sitting in a main
  checkout false-refuses a worktree push led by the untracked `cd`
  (`git status && cd <worktree> && git push`); a session on a ticket
  branch false-passes a push that will really run in a main checkout
  (`git status && cd <main-checkout> && git push`).

Anything else keeps the undecided stance, refuse-only-what-you-can-name:
a leading `cd` whose target cannot be confidently read — a variable, a
subshell, quoting the string-level guard sees through only partially, no
target at all. `cd $WT && git push` passes undecided from any session,
including a checkout on `main`: the push does not run where the walk
ended, so the head is never resolved from a directory the command may not
run in. A resolution that fails (a broken directory, a `~` target) stays
undecided too. Undecided means the head-dependent verdict passes — the
guard never guesses a branch to refuse.

Redirection tokens (`2>&1`, `>build.log`, `>>file`, `2>file`, `<file`,
`&>file`, and bare `>`/`>>`/`<`/`2>`/`&>` plus their target) are stripped
before push parsing — parse hygiene, so a redirect can neither disguise a
bare push (the fail-open hole this closes) nor be mistaken for a refspec.
The strip is string-level and shares the documented over-matching residue
below: an operator-shaped token inside a quoted argument (a bare `>` in a
jq filter) strips too, and that changes no verdict.

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
