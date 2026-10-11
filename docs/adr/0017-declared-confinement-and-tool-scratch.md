# ADR 0017: Declare confinement permissions and isolate tool scratch

- **Status:** Accepted
- **Date:** 2026-10-03

Issue [#89](https://github.com/juranki/afk-kit/issues/89#issuecomment-5969488814)
settled that confined Go verification needs bounded public dependency access and
private tool scratch outside tracked files, and that tracking does not authorize
reading protected examples. Extend ADR 0014's worktree-only/registry-only policy with
per-Run task-owned scratch and explicit Maintainer-owned `.afk/confinement.json`
declarations, validated and captured before Claim; delegated edits never broaden a
Run's captured hosts or example exemptions. Keep the independent clone, local Git
identity, no shared-repository writes, and Merge gate unchanged.

Choose allowlisted online Go acquisition rather than offline pre-provisioning: cold
module/build probes and real sandbox verification demonstrate an environment that
works without host caches or credentials. Exact supported public hosts include Go's
proxy, checksum service and archive redirect host; no direct VCS fallback or wildcard
permission is granted. `storage.googleapis.com` is a host-wide shared-infrastructure
grant, a deliberate limitation of the runtime's host-based policy, not unrestricted
networking. With no declaration, dependency network and example exemptions are empty.

Only declared root `.env.*` examples that are tracked, regular and singly linked may
remain readable; `.env`, undeclared examples and home credentials stay protected.
Tracked protected files refuse before Claim rather than exposing contents or
presenting Git with masked character devices. Global/system Git configuration is
isolated, not unmasked. Bounded Preflight probes cover scratch, Git, configured Go
acquisition and a minimal native build, not full project Verify commands. See the
[setup and diagnostics convention](../conventions/implementer-confinement.md).
