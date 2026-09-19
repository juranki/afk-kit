# ADR 0011: Merge guard is session-bound client-side enforcement

- **Status:** Accepted
- **Date:** 2026-09-19

The merge guard (R7) is afk-kit extension code that intercepts the session's tool
calls and refuses merge-capable invocations — `gh pr merge`, the pull-request merge
API, `git push` to `main` — with a structured `MERGE_GATE_REFUSAL` refusal whose
reason names the [merge gate](0002-human-merge-gate.md) and instructs
stop-and-report per the escalation convention. It binds **every pi session where
afk-kit is installed**: coordinators, subagent children (which spawn fresh pi
processes), and the maintainer's own interactive sessions. "Outside maintainer
action" therefore means the human's own hand outside any agent session: no agent
merges or pushes to `main`, even on the maintainer's command, and merging stays a
github.com-UI or plain-shell act. A session merging an open pull request has no
other guard and is the guard's primary target; a session pushing directly to
`main` is the secondary target, covered by the same hook.

**Why client-side:** coordinator sessions run `gh` under the maintainer's own
account, and GitHub's server-side rules bind accounts, not sessions — rulesets
cannot distinguish the maintainer's hand from an agent acting as the maintainer;
required approvals are structurally unavailable to a solo repository (pull-request
authors cannot approve their own pull requests); repository owners bypass branch
protection by default. Only enforcement at the session's tool boundary can carry
the merge half. For the direct-push half, a server-side ruleset may still be
recommended for target repositories as defense-in-depth — never required, since
per-repo setup is target-repo onboarding ([ADR 0008](0008-system-intent-shape-as-domain-doc-convention.md))
and would break afk-kit's own direct-to-main transition ([ADR 0010](0010-retire-the-design-only-policy.md)).

**Considered options:** a server-side ruleset or branch protection as the guard —
rejected: it cannot stop a same-account merge, and the toolkit cannot set up or
verify per-repo configuration; CI-based refusal — rejected: outside the model
frame's boundary (no CI system design), and no better at distinguishing
same-account actions; playbook discipline only — rejected: prompt-level rules
drift when the model re-derives them each run, which is why [ADR 0006](0006-extensions-for-mechanics-skills-for-judgment.md)
assigns the guard to deterministic code in the first place.

**Consequences:** the guard fires only when the loop has already misbehaved, so
its refusal must route back to the escalation convention rather than invite a
retry. The strength bar is stated honestly, matching the R5 prototype's
precedent: airtight within a loaded session, because every network-capable path
is a tool call at the hook's boundary; deliberate circumvention means editing or
uninstalling the toolkit itself between sessions, and that bypass chain is
documented, not hidden — accident-level-and-model-whim enforcement, not
adversarial enforcement. Binding every session costs the maintainer merges and
direct-to-`main` pushes from inside pi for as long as afk-kit is installed. The
implementation is its own ticket on the implementation map.
