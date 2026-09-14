# R5 confinement shim — prototype

Rough cut for [#10](https://github.com/juranki/afk-kit/issues/10): the implementer
confinement demanded by R5 and [ADR 0007](../../docs/adr/0007-vendored-subagent-mechanism.md),
built cheaply so the mechanics can be reacted to. The resolution becomes the spec the
R5 hardening ticket ([#17](https://github.com/juranki/afk-kit/issues/17)) implements.

## Files

| File | Role |
| --- | --- |
| `make-shim.sh` | Builds `shim.d/` — a `gh` stub that refuses everything, a `git` wrapper that refuses `push` and passes the rest to the real binary — plus a pinned `gitconfig` (identity in, credential helpers out). |
| `confined-env.sh` | Runs a command with a stripped environment, the pinned git config, and the shim first on PATH. This is the shape of the env object the vendored fork must pass to `spawn()`. |
| `demo.sh` | The demonstration: refusals, `git commit` working, what slips through, and two child `pi -p` runs through confinement. |
| `FINDINGS.md` | What the demo showed and the proposed resolution for the four open mechanics questions. |

## Run it

```bash
./demo.sh                    # artifacts in /tmp/r5-demo (override: R5_DEMO_WORK=...)
```

## What it is not

A sandbox. The PATH shim is advisory — absolute paths bypass it (the demo shows one),
and the network is untouched. Confinement here means: no credentials in the child's
reach by the ordinary paths, and loud, machine-readable refusals on the ordinary
publish verbs. See FINDINGS.md for the honest list and the enforcement question this
leaves open.
