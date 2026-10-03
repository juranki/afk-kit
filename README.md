# afk-kit

**afk-kit is an "AFK" (away-from-keyboard) delivery toolkit for
[pi](https://github.com/earendil-works/pi), a coding agent harness.** It lets a solo
maintainer hand software work to unattended agent sessions while keeping personal
attention only where it is decisive: a human **starts** each piece of work and
**merges** it — everything in between is delegated.

## The workflow

1. **Planning session** (human-led): issues from GitHub are triaged and specified into
   *tickets* — Issues with clear, bounded intent and understood dependencies.
   `ready-for-agent` records preparation/triage judgment, not guaranteed acceptance
   by `afk`; no source template or two-pass label gate is required. See the
   [planning playbook](docs/playbooks/planning-session.md).
2. **Coordinator Run** (one per Issue, explicit `afk implement <issue-number>`):
   [semantic readiness](docs/adr/0016-agentic-readiness-and-prepared-brief.md) assesses
   captured discussion and repository evidence, preparing an immutable Agent brief
   before Claim. Human-owned intent remains authoritative; implementation guidance
   is not a requirement. See the [Coordinator playbook](docs/playbooks/coordinator-session.md).
   - a confined **Implementer** writes and commits locally, never publishes;
   - the Engine executes independent Verify and pushes the candidate draft PR;
   - independent Standards and Spec Reviews gate handoff within three
     Implement–Review Cycles. Only the Maintainer merges.
3. **Merge gate** (human): on approval the coordinator stops and the maintainer reviews
   and merges. Any failure or stuck loop **escalates** loudly instead of continuing
   silently.

The vocabulary and invariants of this workflow live in the
[Agent Delivery Workflow ontology](system-intent/ontologies/agent-delivery-workflow.md).

## The repo is half design doc, half toolkit

| Path | What it is |
| --- | --- |
| [`system-intent/`](system-intent/) | Model frame: the [Agent Delivery Workflow ontology](system-intent/ontologies/agent-delivery-workflow.md) (terms + invariants), fictional characters, and user stories that pressure-test the design |
| [`docs/`](docs/) | ADRs, playbooks, conventions, and implementation requirements |
| [`skills/`](skills/) | The outgoing `coordinator` skill, pending reconciliation under the pivot map ([ADR 0013](docs/adr/0013-coordinator-skill-carries-judgment-agentic-drift-review.md)) |
| [`engine/`](engine/) | Deterministic delivery CLI, package-owned assessment/implementation/review sessions, and durable Run evidence |
| [`extensions/`](extensions/) | Shared tracker, Git, brief-projection, and PR-shaping libraries; no prompt-facing extensions are installed |
| [`prototype/`](prototype/), [`scripts/`](scripts/) | Throwaway prototypes and verification support |

**Stack:** TypeScript on **Bun**, packaged as a pi-package with the `afk` CLI and package-owned agents,
linted with Biome, dead-code-checked with Knip. POSIX-only.

**Design philosophy:** deterministic code enforces mechanics; prompt-driven skills
carry judgment. The current [pivot map](https://github.com/juranki/afk-kit/issues/43)
is moving orchestration into a traceable coordinator engine on a guard-rail stack.

## Target repository setup

Pocock / Wayfinder setup alone does not provision AFK workflow labels. Before
`afk implement`, ensure `in-progress`, `in-review`, and `needs-info` exist; see the
[label setup commands](docs/conventions/issue-lifecycle.md#target-repository-setup).
Preflight reports all missing labels without creating or changing them.

## Status

**Pivot in progress.** The SDK-driven Engine CLI is implemented; its real proof Run
is still pending under [Map: The pivot — deterministic coordinator on a guard-rail
stack](https://github.com/juranki/afk-kit/issues/43). Semantic readiness ships as a
separate read-only assessor with bounded Engine-mediated source reads, structured
outcomes, and an immutable prepared handoff. Template enforcement and its installed
`readiness_check` tool are retired. [Verification evidence](docs/evidence/issue-84-readiness.md)
includes live assessment smokes; it is not the end-to-end proof Run.
The outgoing Coordinator skill is not packaged. Broader historical pivot records
remain with [Task: reconcile the record — ADRs, ontology, AGENTS.md,
playbooks](https://github.com/juranki/afk-kit/issues/53).

Start with [system-intent/README.md](system-intent/README.md), the model frame;
[docs/README.md](docs/README.md) routes everything else.

## License

MIT — see [LICENSE](LICENSE).
