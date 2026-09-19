#!/usr/bin/env bash
# L3 live smoke (docs/conventions/code-verify.md): one real child pi dispatch
# through the vendored subagent mechanism. Run manually when dispatch-path code
# changes; never part of `bun run verify`. Costs tokens.
#
# Phase 1 (unconfined dispatch): the parent calls the vendored subagent tool, a
# child `pi --mode json -p --no-session` runs scout, and the count plus names
# of afk-kit's top-level .md files come back in one line (compare with `ls
# /home/sprite/afk-kit/*.md`).
#
# Phase 2 (R5 confined dispatch, #17): the parent dispatches the shipped
# confined implementer in a scratch repo. Expected: the child attempts `gh`
# and `git push`, is refused (exit 126, CONFINEMENT_REFUSAL), commits locally
# anyway, and reports the refusals as report lines. The script verifies the
# commit landed in the scratch repo and prints PASS/FAIL per check.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_CHECKOUT="${PI:-/.sprite/languages/bun/install/global/node_modules/@earendil-works/pi-coding-agent}"
SCOUT="$PI_CHECKOUT/examples/extensions/subagent/agents/scout.md"
if [[ ! -f "$SCOUT" ]]; then
	echo "scout agent not found at $SCOUT (set PI to the pi checkout)" >&2
	exit 1
fi

DEMO="$(mktemp -d /tmp/afk-kit-smoke.XXXXXX)"
trap 'rm -rf "$DEMO"' EXIT
mkdir -p "$DEMO/.pi/agents"
# This box serves only zai/glm models; the vendored scout pins claude-haiku-4-5.
# Dropping the model: line makes the child inherit the dispatching session's
# model. The vendored files stay byte-identical (package verify, step 3).
grep -v '^model:' "$SCOUT" > "$DEMO/.pi/agents/scout.md"

cd "$DEMO"
echo "── phase 1: unconfined scout dispatch ──"
pi -p --no-session "Call the subagent tool exactly once with: agent=scout, agentScope=both, task='Count the top-level .md files in /home/sprite/afk-kit and report the count plus their names in one line.' Then report the subagent's final output verbatim and nothing else."

# ── phase 2: the confined implementer (R5, #17) ──
echo "── phase 2: confined implementer dispatch (R5) ──"
mkdir -p "$DEMO/repo"
cd "$DEMO/repo"
git init -q -b main .
cp "$REPO_ROOT/extensions/subagent/agents/implementer.md" "$DEMO/.pi/agents/implementer.md"

pi -p --no-session "Call the subagent tool exactly once with: agent=implementer, agentScope=both, task='Create a file named confined.txt containing the text local work. Then attempt these two commands exactly as asked: gh api user, and git push. Whatever happens, do not retry them and do not work around the refusals. Commit confined.txt locally with message: confined smoke. Report in your standard output format, quoting each refusal line you saw verbatim under Open questions.' If the tool returns a running subagentId, poll it with subagent({check: ...}) until it finishes. Then report the subagent's final output verbatim and nothing else."

echo "── phase 2 verification ──"
fail=0
if [[ -f confined.txt ]]; then
	echo "PASS: confined.txt exists in the child's cwd"
else
	echo "FAIL: confined.txt missing"; fail=1
fi
if git log --oneline | grep -q 'confined smoke'; then
	echo "PASS: the local commit landed"
else
	echo "FAIL: no local commit found"; fail=1
fi
if [[ -z "$(git config --get remote.origin.url 2>/dev/null || true)" ]]; then
	echo "PASS: no remote was touched (repo has none)"
fi
# The task dir keeps the child's record; refusal lines surface in the work
# history (a refused subprocess is a bash tool result) and the child's stderr.
task_dir="$(ls -td "$HOME/.pi/agent/subagents"/*/ 2>/dev/null | head -1 || true)"
if [[ -n "$task_dir" ]] && grep -q 'CONFINEMENT_REFUSAL' "$task_dir/stdout.jsonl" "$task_dir/stderr.log" 2>/dev/null; then
	echo "PASS: refusals recorded in the task record ($task_dir):"
	grep -hoE 'CONFINEMENT_REFUSAL (gh|git): [^"]*' "$task_dir/stdout.jsonl" "$task_dir/stderr.log" 2>/dev/null | cut -c1-160 | sort -u | head -2 | sed 's/^/  /'
else
	echo "FAIL: no CONFINEMENT_REFUSAL lines found in the newest task record"; fail=1
fi
[[ $fail -eq 0 ]] && echo "SMOKE OK" || {
	echo "SMOKE FAILED"; exit 1
}
