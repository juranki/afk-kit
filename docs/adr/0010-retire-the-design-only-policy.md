# ADR 0010: Retire the design-only policy

- **Status:** Accepted
- **Date:** 2026-09-14

The working agreement forbade creating skill, extension, or source files in this
repository, casting afk-kit as documentation-only. The charted map
([#5](https://github.com/juranki/afk-kit/issues/5)) makes the toolkit itself the
work: the vendored, hardened subagent mechanism, the coordinator mechanics, the
agent definitions, and the coordinator skill (ADR 0006's mechanics/judgment split),
shipped as a user-level pi package. Implementation therefore lives in this repository
next to the design that governs it, and the policy flips: afk-kit is
**design + toolkit**.

**Considered options:** a separate implementation repository was rejected — the
wrapped skills' per-repo configuration already lives here (ADR 0008), dogfooding
requires the toolkit's tracker, design, and code in one seam, and splitting them
would duplicate label vocabulary, conventions, and review setup across two repos.
Deferring the flip until code exists was rejected: the first implementation tickets
(#11 onward) cannot start under a policy that forbids their output.

**Consequences:** AGENTS.md, the README, and the docs router describe
design + toolkit. Until the coordinator loop is minimally viable, changes commit
directly to `main` (the map's execution override); after that, the repository is
dogfooded through the branch-per-issue and review-before-merge discipline the
toolkit itself prescribes. The model frame is unchanged: its system boundary
excludes the toolkit's internal design, so the domain docs keep describing the
workflow, not the code.
