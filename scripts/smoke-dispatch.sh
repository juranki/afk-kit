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
#
# Phase 3 (R6 verdict round, #18): the parent dispatches the shipped reviewer
# on a scratch diff fed in the task text (the decided convention: the
# coordinator hands over the pushed diff; the reviewer never fetches). The
# child's final output is parsed with the fork's real parseVerdict
# (extensions/subagent/verdict.ts); the round passes only if the verdict is
# parseable — approve or request-changes.
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

# ── phase 3: the reviewer's verdict round (R6, #18) ──
echo "── phase 3: reviewer verdict round on a scratch diff (R6) ──"
mkdir -p "$DEMO/review"
cd "$DEMO/review"
git init -q -b main .
cat > lib.js <<'EOF'
function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
module.exports = { countWords };
EOF
git add lib.js
git -c user.name=smoke -c user.email=smoke@example.com commit -qm "base: countWords"
cat > lib.js <<'EOF'
function countWords(text) {
  if (typeof text !== "string") return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}
module.exports = { countWords };
EOF
git add lib.js
git -c user.name=smoke -c user.email=smoke@example.com commit -qm "guard countWords against non-string input"
cp "$REPO_ROOT/extensions/subagent/agents/reviewer.md" "$DEMO/.pi/agents/reviewer.md"

task_before="$(ls -td "$HOME/.pi/agent/subagents"/*/ 2>/dev/null | head -1 || true)"
{
	cat <<'EOF'
Review this pushed diff for one review round.

The brief's verify command (run it exactly as written, from your working directory): bun -e 'const {countWords} = require("./lib.js"); if (countWords("a b c") !== 3 || countWords(42) !== 0) process.exit(1)'

## Pushed diff

```diff
EOF
	git diff HEAD~1..HEAD
	cat <<'EOF'
```

Return your review notes and end with the verdict JSON block, exactly as your instructions specify.
EOF
} > "$DEMO/review-task.md"

pi -p --no-session "Call the subagent tool exactly once with: agent=reviewer, agentScope=both, task=$(cat "$DEMO/review-task.md"). If the tool returns a running subagentId, poll it with subagent({check: ...}) until it finishes. Then report the subagent's final output verbatim and nothing else."

task_after="$(ls -td "$HOME/.pi/agent/subagents"/*/ 2>/dev/null | head -1 || true)"
if [[ -z "$task_after" || "$task_after" == "$task_before" ]]; then
	echo "FAIL: no new subagent task record for the reviewer dispatch"; fail=1
else
	echo "PASS: reviewer task record at $task_after"
	TASK_STDOUT="$task_after/stdout.jsonl" VERDICT_TS="$REPO_ROOT/extensions/subagent/verdict.ts" bun -e '
import { readFileSync } from "node:fs";
const { parseVerdict } = await import(process.env.VERDICT_TS);
const events = readFileSync(process.env.TASK_STDOUT, "utf-8").split("\n").filter(Boolean);
let finalText = "";
for (const line of events) {
	let event;
	try { event = JSON.parse(line); } catch { continue; }
	const message = event.message;
	if (message?.role === "assistant") {
		for (const part of message.content ?? []) {
			if (part.type === "text") finalText = part.text;
		}
	}
}
if (!finalText) { console.log("FAIL: no assistant text in the reviewer task record"); process.exit(1); }
console.log("child final output: " + finalText.length + " chars");
const parsed = parseVerdict(finalText);
if (!parsed.ok) {
	console.log("FAIL: verdict unparseable — " + parsed.reason);
	process.exit(1);
}
console.log("PASS: parseable verdict — " + parsed.verdict.verdict + ", " + parsed.verdict.findings.length + " finding(s)");
for (const finding of parsed.verdict.findings) {
	console.log("  [" + finding.severity + "] " + (finding.file ?? "?") + (finding.line ? ":" + finding.line : "") + " — " + finding.summary);
}
' || fail=1
fi

[[ $fail -eq 0 ]] && echo "SMOKE OK" || {
	echo "SMOKE FAILED"; exit 1
}
