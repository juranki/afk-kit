#!/usr/bin/env bash
# L3 live smoke (docs/conventions/code-verify.md): one real child pi dispatch
# through the vendored subagent mechanism. Run manually when dispatch-path code
# changes; never part of `bun run verify`. Costs tokens.
#
# Expected: the parent calls the vendored subagent tool, a child `pi --mode
# json -p --no-session` runs scout, and the count plus names of afk-kit's
# top-level .md files come back in one line (compare with `ls
# /home/sprite/afk-kit/*.md`).
set -euo pipefail

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
pi -p --no-session "Call the subagent tool exactly once with: agent=scout, agentScope=both, task='Count the top-level .md files in /home/sprite/afk-kit and report the count plus their names in one line.' Then report the subagent's final output verbatim and nothing else."
