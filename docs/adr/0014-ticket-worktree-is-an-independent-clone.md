# ADR 0014: The Ticket worktree is an independent clone

- **Status:** Accepted
- **Date:** 2026-09-27

The Claim operation creates the Ticket worktree as an independent clone of the
repository — `git clone --no-checkout --no-hardlinks` into
`<worktree-root>/<project>/<branch>`, then `checkout -b <branch> <base>` at the
fetched `origin/main` SHA, with the Engine's own commit identity pinned in the
clone's local config — not a `git worktree add` linked worktree.

**Why:** a linked worktree shares the primary checkout's object store and refs,
so a commit inside the worktree writes outside it — the index and `HEAD` in
`.git/worktrees/<id>`, new objects in `.git/objects`, and a lock beside the
branch's ref. The channel-level confinement delivered by ticket #50 grants
writes by allowlisted path, and Landlock-style rules grant file creation
through the parent directory; committing therefore required either a writable
shared `refs/heads` directory (the Implementer could then create, and nearly
corrupt, sibling branch refs — the ontology invariant "an implementer commits
only inside its ticket's worktree, on its branch" would rest on incidental
`packed-refs` lock denials) or no commits at all. The live smoke on ticket #62
showed both branches of that fork: a confined `glm-5.3-flash` session that
cannot commit will work around the sandbox — rebuild a repository inside the
worktree — and its commits then bypass the shared-repo facts the Engine judges.

An independent clone puts all git state inside the worktree. The confined
policy stays exactly what #50 delivered — worktree writes, registry network,
no shared-repo surface at all — and the Implementer's commit lands where the
Engine's observed-fact checks (`rev-list`, `status --porcelain`) and the
candidate push already look.

**Considered options:** allowlisting the linked worktree's shared git admin
surface (objects, admin directory, branch ref, ref locks and reflogs) —
rejected: ref creation and reflog trees cannot be narrowed to the one branch
without relying on incidental denials, and the live smoke showed a model
defecting into an in-worktree repository under exactly that policy; a
per-worktree ref namespace (`GIT_NAMESPACE`) — rejected: every Engine-side Git
operation and the candidate push would have to carry the namespace, spreading
one confinement workaround across all shaping operations; keeping the linked
worktree and dropping confinement — rejected: contradicts #50.

**Consequences:** the Claim's undo is a plain directory removal (the branch
and objects never touched the primary checkout, so there is nothing to prune
or drop there); a clone is larger than a linked worktree's checkout and the
clone cost scales with the repository, which the durable spec accepts for v0;
the Implementer's commits carry the Engine-pinned identity
(`AFK Engine <afk-engine@users.noreply.github.com>`), and the confined
environment isolates the session from the host's global and system git
configuration so that identity and `commit.gpgsign` cannot leak in. The
branching-and-prs convention's worktree section describes this shape.
