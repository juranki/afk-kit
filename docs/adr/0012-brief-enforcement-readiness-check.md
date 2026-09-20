# ADR 0012: Brief enforcement is a deterministic readiness check

- **Status:** Accepted
- **Date:** 2026-09-19

[ADR 0003](0003-wrap-matt-pocock-skills.md) charges afk-kit with adding brief
enforcement to the wrapped skills without forking them. Its form is a **readiness
check**: deterministic extension code — a registered tool callable in any session
where afk-kit is installed, the same mechanism as the subagent tool and the merge
guard — that inspects a ticket's brief and returns a structured pass or fail. It
verifies only the brief template's mechanical substrate, in four inspections:

1. every template field present and non-empty;
2. Open questions empty (the literal `none` counts as empty);
3. the triage label consistent — `ready-for-agent` present, no competing triage
   state alongside it;
4. blocked-by edges agreeing with the tracker's native dependencies, ignoring
   tickets named in Blocked by that have since closed; the Blocks line is required
   but not cross-checked (the claimable-critical direction is blocked-by).

At least one verify command is required — a ticket without one is ready for a
human, not an agent. The template is fixed to the shipped one; per-repo variation
waits for a second consumer, since target-repo onboarding is out of scope
([ADR 0008](0008-system-intent-shape-as-domain-doc-convention.md)).

Three gates consume it, per [ADR 0006](0006-extensions-for-mechanics-skills-for-judgment.md)'s
split: judgment stays prompt-side — whether acceptance criteria are truly
verifiable, whether the summary speaks the domain vocabulary, owned by the
planning skills and the reviewer — while mechanics become code. A planning session
runs the check before applying `ready-for-agent`; only a passing result may apply
the label. *Amended 2026-09-20 ([#24](https://github.com/juranki/afk-kit/issues/24)):*
because the triage-label inspection requires `ready-for-agent` present, the planning
run happens **around** applying the label, in two runs: a pre-apply run must pass
every inspection except at most `triage-labels` failing as `ready-for-agent` absent;
the session then applies the label, and a confirm run passing all inspections is the
exit proof — a failed confirm run removes the label and sends the ticket back. The
label's brief inconsistency between the runs harms nothing: nothing consumes it
except a claim, and every claim re-checks. A coordinator's loop step 1 runs it and refuses with a structured
`READINESS_REFUSAL` naming the failed inspections, leaving one comment on the
issue as the fix-trigger; it does not relabel — correcting the label belongs to
the planning session or the maintainer, and the harm of a briefly lying label is
bounded because every claim attempt re-checks. The atomic claim (R7) embeds the
check and refuses — claiming nothing — if it fails.

**Considered options:** template-plus-discipline only (no code) — rejected:
prompt-level rules drift when the model re-derives them each run, and the exit
criterion would stay an article of faith; a validation skill run at
planning-session exit — rejected for the same drift, dressed as a skill; layering
the check with a new judgment skill — rejected: brief-quality judgment already
lives in the wrapped planning skills ([ADR 0003](0003-wrap-matt-pocock-skills.md)),
and a new one would duplicate them.

**Consequences:** structural completeness is guaranteed; quality is not — a brief
can pass the check and still be badly written, and catching that remains planning's
and the reviewer's job. The refusal marker follows the house pattern
(`CONFINEMENT_REFUSAL`, `MERGE_GATE_REFUSAL`). The implementation is its own
ticket on the implementation map; the claim-op ticket grows the embed.
