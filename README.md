# afk-kit

**afk-kit is an "AFK" (away-from-keyboard) delivery toolkit for
[pi](https://github.com/earendil-works/pi), a coding agent harness.** It lets a solo
maintainer hand software work to unattended agent sessions while keeping personal
attention only where it is decisive: a human **starts** each piece of work and
**merges** it — everything in between is delegated.

## The workflow

1. **Planning session** (human-led): issues from GitHub are triaged and specified into
   *tickets* — issues with a complete **agent brief** (summary, acceptance criteria,
   verify commands, blockers, touched areas, no open questions), enforced by a
   readiness check. See the
   [planning playbook](docs/playbooks/planning-session.md).
2. **Coordinator session** (one per issue, on explicit command): runs a readiness
   check, *claims* the ticket, creates a worktree + branch, then delegates. See the
   [coordinator playbook](docs/playbooks/coordinator-session.md).
   - an **implementer** subagent (cheap `flash` model) writes and verifies the change —
     it can commit locally but is *confined*: it cannot push, run `gh`, or publish;
   - the coordinator pushes and opens a pull request;
   - a **reviewer** subagent returns a structured verdict; at most two fix rounds.
3. **Merge gate** (human): on approval the coordinator stops and the maintainer reviews
   and merges. Any failure or stuck loop **escalates** loudly instead of continuing
   silently.

The vocabulary and invariants of this workflow live in the
[Agent Delivery Workflow ontology](system-intent/ontologies/agent-delivery-workflow.md).

## The repo is half design doc, half toolkit

| Path | What it is |
| --- | --- |
| [`system-intent/`](system-intent/) | Model frame: the [Agent Delivery Workflow ontology](system-intent/ontologies/agent-delivery-workflow.md) (terms + invariants), fictional characters, and user stories that pressure-test the design |
| [`docs/`](docs/) | 13 ADRs, playbooks (planning/coordinator sessions), conventions (issue lifecycle, branching, review/escalation, code-verify) |
| [`extensions/subagent/`](extensions/subagent/) | The code: a [vendored, hardened fork](VENDORED.md) of pi's `subagent` example extension (~4.2k lines TS) — non-blocking dispatch with wait/check, cancel, wall-clock caps, hang watchdogs, implementer confinement (env allowlist + git config pin + PATH shim), verdict parsing |
| [`prototype/`](prototype/), [`scripts/`](scripts/) | Throwaway prototypes and live smoke tests |

**Stack:** TypeScript on **Bun**, packaged as a pi-package (extension + prompt
templates), linted with Biome, dead-code-checked with Knip. POSIX-only.

**Design philosophy:** extensions enforce *mechanics* (readiness checks, confinement,
claims), skills carry *judgment*; confinement stops *accidents*, not adversaries — the
reviewer and the human merge gate are the real backstops.

## Status

**Design + toolkit.** Implementation of the toolkit happens in this repository
([ADR 0010](docs/adr/0010-retire-the-design-only-policy.md)); until the coordinator
loop ships, the workflow runs by hand using the installed skills. The subagent
mechanism is selected: a vendored, hardened fork of pi's example `subagent` extension
([ADR 0007](docs/adr/0007-vendored-subagent-mechanism.md)), evaluated against the
requirements in
[docs/requirements/subagent-mechanism.md](docs/requirements/subagent-mechanism.md).

Start with [system-intent/README.md](system-intent/README.md), the model frame;
[docs/README.md](docs/README.md) routes everything else.

## License

MIT — see [LICENSE](LICENSE).
