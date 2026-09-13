# ADR 0002: Human merge gate

- **Status:** Accepted
- **Date:** 2026-09-13

Only the maintainer merges. The reviewer subagent filters — its approval determines
what reaches human review — but never replaces the maintainer's review, and the
maintainer may overrule an approval for any reason. Coordinators stop at
"pull request awaiting review".

**Considered options:** auto-merge on agent approval plus green CI was considered and
rejected — accountability for what lands on main must stay human, and the reviewer's
judgment is cheap relative to the risk it would absorb.

**Consequences:** the maintainer's review attention is the throughput ceiling; relaxing
the gate for low-risk paths would be a new ADR.
