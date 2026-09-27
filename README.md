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
   [coordinator playbook](docs/playbooks/coordinator-session.md); its shipped runtime
   form is the [`coordinator` skill](skills/coordinator/SKILL.md).
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
| [`skills/`](skills/) | The outgoing `coordinator` skill, pending reconciliation under the pivot map ([ADR 0013](docs/adr/0013-coordinator-skill-carries-judgment-agentic-drift-review.md)) |
| [`extensions/`](extensions/) | Deterministic readiness and coordinator-operation extensions; the merge-guard extension was retired by [ticket #49](https://github.com/juranki/afk-kit/issues/49), the vendored `subagent` extension by [ticket #41](https://github.com/juranki/afk-kit/issues/41) |
| [`prototype/`](prototype/), [`scripts/`](scripts/) | Throwaway prototypes and verification support |

**Stack:** TypeScript on **Bun**, packaged as a pi-package (extensions and skills),
linted with Biome, dead-code-checked with Knip. POSIX-only.

**Design philosophy:** deterministic code enforces mechanics; prompt-driven skills
carry judgment. The current [pivot map](https://github.com/juranki/afk-kit/issues/43)
is moving orchestration into a traceable coordinator engine on a guard-rail stack.

## Status

**Pivot in progress.** Implementation of the toolkit happens in this repository
([ADR 0010](docs/adr/0010-retire-the-design-only-policy.md)). The vendored `subagent`
extension, demo prompts, and packaged agent roster have been removed; the package does
not currently provide delegation. [Map: The pivot — deterministic coordinator on a
guard-rail stack](https://github.com/juranki/afk-kit/issues/43) is replacing the outgoing
agentic coordinator path with an SDK-driven CLI. ADR 0007 and the existing coordinator
playbook remain historical/current-design context until the map's reconciliation work
records the pivot.

Start with [system-intent/README.md](system-intent/README.md), the model frame;
[docs/README.md](docs/README.md) routes everything else.

## License

MIT — see [LICENSE](LICENSE).
