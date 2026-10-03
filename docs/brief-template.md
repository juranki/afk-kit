# Agent brief standard

Human-owned source intent lives in the Issue discussion and linked decisions, not in
mandatory template syntax. Preparation and triage establish semantic clarity; the
[Readiness check](adr/0016-agentic-readiness-and-prepared-brief.md) synthesizes a
separate immutable Agent brief on invocation. Missing headings do not justify refusal.
This standard governs that prepared handoff, not the author's Issue formatting.

## Prepared brief contents

| Content | Contract |
| --- | --- |
| Intent, scope, exclusions | Clear outcome and bounded work, using the repository's domain vocabulary. |
| Acceptance criteria | Meaningful, verifiable consequences of settled intent; derivation is allowed, invention of product decisions is not. |
| Verify commands | At least one concrete command, what it verifies, and provenance in repository guidance/configuration or settled intent. For afk-kit the default is `bun install && bun run verify` ([code verify standard](conventions/code-verify.md)); see also [package verification](conventions/package-verify.md). |
| Dependencies and decisions | Understood dependencies agreeing with native edges, and necessary decisions settled by the captured discussion. |
| Repository context | Relevant files, interfaces, patterns, tests, and governing constraints; targeted evidence, not an architectural audit. |
| Guidance and assumptions | Separately identified likely touch points, suggested approaches, and assumptions for the Implementer to validate. |
| Provenance | References tying binding requirements to captured evidence; source identities and repository revision persist with the Run. |

## Authority

**Binding:** settled intent, scope, acceptance criteria, constraints, and established
Verify commands. **Non-binding:** repository findings, likely touch points, suggested
approaches, and assumptions. Guidance does not acquire Maintainer authority by being
included in the brief. In particular, likely touched areas are not automatically a
binding path allowlist.

The Implementer and Spec Reviewer receive the same prepared brief and access to
captured evidence. The Implementer need not repeat broad discovery, but inspects code
it changes and validates assumptions. Departures from guidance need evidence;
requirements cannot be altered. Later meaningful contradictions Escalate rather than
being silently reinterpreted. Spec Review must not promote recommendations into
Maintainer requirements.

## Verification and snapshot

Readiness does not execute commands or prove the unchanged baseline green. Surface
known unavailable credentials/infrastructure that would prevent verification. The
Engine executes the immutable Verify commands independently after implementation.

Capture sources once after invocation and persist them, their references/identities,
repository revision, assessment output, and the prepared brief. No subsequent
content-freshness gate or automatic reassessment is imposed in v0. Live labels,
blockers, and Claim exclusion remain separate coordination safeguards. Output
structure validation applies to the agent's artifact, never the Issue author's syntax.

## Optional source-authoring aid

Preparation skills may use this outline or their own format. Its absence is not a
readiness failure, and it adds no mandatory planning assessment/comment step:

```markdown
## Intended outcome
<what changes and why>

## Scope and exclusions
<bounds and deliberate non-goals>

## Acceptance criteria
- <verifiable behavior>

## Verification
<known commands and references, if established>

## Dependencies and settled decisions
<links; keep semantic dependencies consistent with native edges>

## Context
<relevant discussion, repository guidance, known assumptions>
```

See the [planning playbook](playbooks/planning-session.md) for preparation and
[Coordinator playbook](playbooks/coordinator-session.md) for invocation.
