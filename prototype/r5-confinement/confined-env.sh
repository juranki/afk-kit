#!/usr/bin/env bash
# R5 confinement: run a command with a stripped environment and the shim PATH.
#
# Rough cut of the env object the vendored fork (afk-kit#17) must construct at the
# spawn seam, where pi's example subagent extension currently passes nothing —
# children inherit the coordinator's full environment.
#
# Usage: confined-env.sh <command> [args...]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ -x "$here/shim.d/git" ] || { echo "run ./make-shim.sh first" >&2; exit 1; }

# 1. Drop credential and injection vectors by pattern. A denylist over-strips;
#    the fork should grow this into a curated allowlist (see FINDINGS.md).
while IFS= read -r k; do
	case "$k" in
		GH_* | GITHUB_* | *TOKEN* | *SECRET* | *PASSWORD* | *_KEY | *_KEY_* | KEY_*) unset "$k" ;;
		SSH_AUTH_SOCK | GIT_ASKPASS | SSH_ASKPASS | GIT_SSH*) unset "$k" ;;
		GIT_CONFIG_COUNT | GIT_TERMINAL_PROMPT) unset "$k" ;;
		NODE_OPTIONS | BUN_OPTIONS | BASH_ENV | ENV) unset "$k" ;;
	esac
done < <(compgen -e)

# 2. Pin git's global config: identity in, credential helpers out.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$here/gitconfig"
export GIT_TERMINAL_PROMPT=0

# 3. Shim first on PATH. Advisory (absolute paths bypass it) — see FINDINGS.md.
export PATH="$here/shim.d:$PATH"

exec "$@"
