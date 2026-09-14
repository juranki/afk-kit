#!/usr/bin/env bash
# Build the R5 confinement shim: shim.d/{gh,git} stubs + a pinned global gitconfig.
#
# Rough cut for afk-kit#10. The vendored fork (afk-kit#17) replaces this with the
# environment object it passes to spawn() at the child seam (ADR 0007); this script
# exists so the mechanics can be reacted to in isolation.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
shim="$here/shim.d"
mkdir -p "$shim"

# --- gh: refuse everything. Implementers have no GitHub access (R5). ---
cat > "$shim/gh" <<'EOF'
#!/usr/bin/env bash
# R5 confinement: gh is refused in full — no tracker writes, no PRs, no API.
line="CONFINEMENT_REFUSAL gh: 'gh $*' — implementers have no GitHub access (R5). The coordinator publishes."
echo "$line" >&2
if [ -n "${R5_REFUSAL_LOG:-}" ]; then printf '%s\n' "$line" >> "$R5_REFUSAL_LOG"; fi
exit 126
EOF
chmod +x "$shim/gh"

# --- git: allow local work, refuse publish verbs. ---
cat > "$shim/git" <<'EOF'
#!/usr/bin/env bash
# R5 confinement: git wrapper. Local work (status, add, commit, diff, log, ...)
# passes through to the real binary found behind this shim; publish verbs are refused.
self_dir="$(cd "$(dirname "$0")" && pwd)"

verb=""
for a in "$@"; do
	case "$a" in -*) ;; *) verb="$a"; break ;; esac
done

refuse() {
	line="CONFINEMENT_REFUSAL git: 'git $verb' is a publish verb (R5). Commit locally; the coordinator publishes."
	echo "$line" >&2
	if [ -n "${R5_REFUSAL_LOG:-}" ]; then printf '%s\n' "$line" >> "$R5_REFUSAL_LOG"; fi
	exit 126
}

case "$verb" in
	push) refuse ;;
esac

# Resolve the real git by scanning PATH, skipping this shim dir.
IFS=: read -ra dirs <<< "$PATH"
for d in "${dirs[@]}"; do
	[ "$d" = "$self_dir" ] && continue
	if [ -x "$d/git" ]; then exec "$d/git" "$@"; fi
done
echo "CONFINEMENT_REFUSAL git: no real git found behind shim" >&2
exit 127
EOF
chmod +x "$shim/git"

# --- pinned global gitconfig: identity only, no credential helpers. ---
# GIT_CONFIG_GLOBAL replaces the user's real global config for the child, which
# drops credential helpers — in this environment the helper routes to
# `gh auth git-credential` and would hand a push the token in ~/.config/gh/hosts.yml.
user_name="$(git config --global user.name 2>/dev/null || echo implementer)"
user_email="$(git config --global user.email 2>/dev/null || echo implementer@localhost)"
cat > "$here/gitconfig" <<EOF
# GIT_CONFIG_GLOBAL for confined implementers (R5). Replaces the real global
# config: identity in, credential helpers out.
[user]
	name = $user_name
	email = $user_email
[init]
	defaultBranch = main
[credential]
	helper =
EOF

echo "shim built: $shim (real git: $(command -v git), pinned gitconfig: $here/gitconfig)"
