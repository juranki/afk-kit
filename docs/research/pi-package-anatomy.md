# Research: pi package anatomy (ticket #8)

Question: What is the canonical structure of a pi package that ships extensions,
skills, and agent definitions, and how does user-level install work on pi 0.85.1?

All findings verified against pi 0.85.1 primary sources — its shipped documentation,
its compiled source, and its first-party examples — installed at
`/.sprite/languages/bun/install/global/node_modules/@earendil-works/pi-coding-agent/`
(abbreviated `$PI` below). Verified locally: `$PI/package.json` reports version 0.85.1
and `pi --version` returns 0.85.1.

## 1. The package manifest

A pi package is an npm package whose `package.json` carries a `pi` key, or that uses
convention directories with no manifest at all (`$PI/docs/packages.md`, "Creating a Pi
Package" / "Package Structure").

- Manifest fields are exactly four resource types: `extensions`, `skills`, `prompts`,
  `themes`. Confirmed in source: `$PI/dist/core/pi-manifest.js` defines
  `RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"]` and ignores
  everything else under `pi`. **There is no `agents` resource type on 0.85.1** — see §4.
- Manifest values are arrays of paths relative to the package root. Arrays support glob
  patterns and `!exclusions`; positive globs discover visible paths in lexical order;
  dot-prefixed paths must be listed directly; globs do not traverse symlinks
  (`packages.md`).
- Optional gallery metadata: `keywords: ["pi-package"]` for discoverability, plus
  `pi.video` / `pi.image` previews (`packages.md`).
- With no `pi` manifest, pi auto-discovers from convention directories at the package
  root (`packages.md`):
  - `extensions/` — `.ts` and `.js` files
  - `skills/` — recursive `SKILL.md` folders, plus top-level `.md` files as skills
  - `prompts/` — `.md` files
  - `themes/` — `.json` files
- Dependencies (`packages.md`, "Dependencies"): runtime deps go in `dependencies`
  (pi runs `npm install` — a production install, `--omit=dev`, so `devDependencies` are
  unavailable at runtime, per `$PI/docs/extensions.md`, "Available Imports"). Core pi
  packages imported by extensions must be in `peerDependencies` with `"*"`:
  `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`. Other pi
  packages must be bundled via `bundledDependencies` and referenced through
  `node_modules/` paths.
- First-party working examples (all with `"pi": { "extensions": ["./index.ts"] }`,
  `"type": "module"`, and plain `dependencies`): `$PI/examples/extensions/{gondolin,sandbox,with-deps,custom-provider-anthropic}/package.json`.
  None of them uses peerDependencies entries or a `skills` key — the full-facet manifest
  shape is documented but not exercised by a shipped example.

## 2. Recommended afk-kit package layout

afk-kit ships extensions (coordinator mechanics), skills (the workflow playbooks), and
agent definitions (the subagent roster, R2). Mapping to pi's anatomy:

```
afk-kit/
├── package.json            # name, private, type:module, pi manifest, dependencies
├── extensions/
│   └── index.ts            # default-export factory(pi: ExtensionAPI); registers tools/commands
├── agents/
│   ├── implementer.md      # frontmatter: name, description, tools, model; body = system prompt
│   └── reviewer.md
├── skills/
│   ├── wayfinder/SKILL.md  # one dir per skill, agentskills.io standard
│   └── .../SKILL.md
└── docs/, system-intent/   # existing prose, inert to pi
```

- `extensions/` and `skills/` are auto-discovered even without a manifest, but declare
  them explicitly: `"pi": {"extensions": ["./extensions"], "skills": ["./skills"]}`.
  Explicit beats implicit because package filtering in settings narrows manifest entries,
  and the manifest documents the package's surface (`packages.md`).
- `agents/` is **not** a resource type pi understands; pi will ignore it. The extension
  must load it (see §4). Shipping it as a plain package directory works: the extension
  reads its own files relative to the compiled extension module (`import.meta.url`),
  which resolves correctly under any install location. The docs document no helper API
  for "my own package root" — this is our code to write (the shipped subagent example
  uses `parseFrontmatter` from `@earendil-works/pi-coding-agent` for the YAML side).
- Skills follow the Agent Skills standard pi implements: directory + `SKILL.md` with
  `name` (1–64 chars, `[a-z0-9-]`) and `description` (≤1024 chars) required; pi warns
  but loads on most violations; skills without a description are not loaded; pi does not
  require `name` to match the directory (`$PI/docs/skills.md`).
- Existing precedent in this very install: the user-level skills tree
  `~/.pi/agent/skills/` holds one directory per skill with `SKILL.md`, matching §1's
  convention-directory rules (observed locally, 25 skill directories).

## 3. User-level install (R10)

R10 (`docs/requirements/subagent-mechanism.md`): "Installs user-level as part of the
afk-kit package; project-agnostic across target repositories."

Commands (`packages.md`, "Install and Manage"; verified against `pi install --help`,
`pi config --help`):

- `pi install <source>` installs and writes **user settings** by default:
  `~/.pi/agent/settings.json`. `-l` writes project settings (`.pi/settings.json`)
  instead. `-e/--extension` runs a package once from a temp dir without installing.
- `pi remove`, `pi list` (installed packages from settings), `pi update --extensions`
  / `--all` (update packages; pinned refs are never moved, only reconciled),
  `pi config` (TUI to enable/disable individual resources; Tab toggles global vs
  project).

Sources and where they land (`packages.md`, "Package Sources"; paths confirmed in
`$PI/dist/core/package-manager.js`):

| Source | Settings entry | User-level location |
| --- | --- | --- |
| npm | `npm:@scope/pkg@1.2.3` | `~/.pi/agent/npm/node_modules/<pkg>` |
| git | `git:github.com/user/repo@v1` | `~/.pi/agent/git/<host>/<path>` (clone) |
| local path | `/abs/or/./rel` | not copied; referenced in place |

For afk-kit — a private GitHub repo — the git source is the fit:
`pi install git:github.com/juranki/afk-kit@<ref>`. On install and on every
`pi update --extensions` reconciliation, pi resets/cleans the clone and runs
`npm install` when `package.json` exists (`packages.md`, git bullets). Refs are pinned
tags or commits; moving to a new ref is itself an explicit
`pi install git:...@new-ref`.

Why user-level satisfies R10's "project-agnostic":

- User-scope packages load in **every** project with no trust interaction. Only
  *project*-local resources (`.pi/`, project `.agents/skills`) sit behind the trust
  gate — interactive prompt, or `defaultProjectTrust` (`ask`/`always`/`never`) in
  non-interactive modes (`$PI/docs/settings.md`, "Project Trust"; `usage.md`,
  "Context Files" area). Installing at user scope sidesteps per-repo trust entirely.
- Dedup rule: the same package in both scopes → project entry wins, unless it has
  `autoload: false`, which applies it as a delta over the global entry; identity is
  package name (npm), repo URL sans ref (git), or resolved absolute path (local)
  (`packages.md`, "Scope and Deduplication"). A target repo can therefore override or
  filter afk-kit resources locally without duplicating the install.

Startup loading order and gating worth knowing: user/global extensions load before
project trust is resolved; project-local extensions only load after trust
(`$PI/docs/extensions.md`, `project_trust` event, line ~355). Async extension factories
are awaited before startup continues (extensions.md, "Writing an Extension").

## 4. Agent definitions are not a pi resource type — the subagent pattern

pi 0.85.1 has no native "agents" concept in packages (§1, source-confirmed). The
canonical precedent is pi's own first-party subagent example
(`$PI/examples/extensions/subagent/`), which is also the leading candidate in
`docs/requirements/subagent-mechanism.md`:

- Layout: `index.ts` (extension entry), `agents.ts` (discovery), `agents/*.md`
  (definitions), `prompts/*.md` (workflow prompt templates — a *real* pi resource type).
- Agent file format (`agents/reviewer.md`): YAML frontmatter `name`, `description`,
  `tools` (comma string or array; both accepted), `model`; body = system prompt.
  Parsed with `parseFrontmatter` from `@earendil-works/pi-coding-agent`
  (`agents.ts`, lines ~18–44 and ~76–89).
- Discovery (`agents.ts`, `discoverAgents`): user scope `<agentDir>/agents`
  (`~/.pi/agent/agents/` via `getAgentDir()`), project scope nearest `.pi/agents/`
  walking up from cwd. Required frontmatter: `name` + `description` (string-typed,
  else file skipped silently). This mirrors the requirement-R2 fields exactly.
- The example has **no `package.json`** — it predates/omits packaging and is symlinked
  into `~/.pi/agent/extensions/subagent/` per its README. Afk-kit should do better:
  wrap the mechanism in a real package (§2) so `pi install` manages it.
- Note the docs' own framing that this example is a candidate to vendor, not a
  supported pi feature: "shipped under pi's `examples/extensions/subagent/`"
  (`docs/requirements/subagent-mechanism.md`).

Unspecified by docs and resolved by our own choice: loading `agents/*.md` from inside
the installed package (no pi helper for "package-relative resources outside the four
types"); whether afk-kit should *also* mirror definitions to `~/.pi/agent/agents/` for
compatibility with the upstream example's discovery path — recommend not; one source of
truth.

## 5. Extension registration constraints

Binding constraints the coordinator-mechanics and fork-hardening tickets must respect
(all from `$PI/docs/extensions.md` unless noted):

### Lifecycle and timing

- An extension is a **default-exported factory** receiving `ExtensionAPI`; sync or
  async — async factories are awaited before startup continues (before `session_start`,
  `resources_discover`, provider flush).
- Factories may run in invocations that never start a session. **No background
  resources (processes, sockets, watchers, timers) from the factory**; defer to
  `session_start` or first use, and register an idempotent `session_shutdown` handler.
- `pi.registerTool()` works during load *and* after startup (from `session_start`,
  handlers) — new tools are immediately callable without `/reload`.
- Extensions are loaded via jiti; TypeScript works without a build step.

### Commands (`pi.registerCommand(name, options)`)

- Duplicate command names across extensions are **all kept**, with numeric invocation
  suffixes in load order (`/review:1`, `/review:2`). Afk-kit should use names unlikely
  to collide (e.g. `claim`, `merge-gate` are risky-generic — consider a prefix).
- Options: `description`, `handler(args, ctx)`, optional `getArgumentCompletions`
  returning `AutocompleteItem[] | null`.
- `pi.getCommands()` exposes all slash commands (extensions first, then prompt
  templates, then skills) with canonical provenance in `sourceInfo`
  (`scope: user|project|temporary`, `origin: package|top-level`); the docs explicitly
  say to use `sourceInfo`, never name/path parsing, to infer ownership — relevant if
  fork-hardening adds command-introspection tests.

### Tools (`pi.registerTool(definition)`)

- Definition: `name`, `label`, `description`, `parameters` (TypeBox `Type.Object`),
  `execute(toolCallId, params, signal, onUpdate, ctx)` returning
  `{ content: [...], details }`. Progress streams via `onUpdate`.
- Registering a tool with a **built-in name overrides it** (`read`, `bash`,
  `powershell`, `edit`, `write`, `grep`, `find`, `ls`) with an interactive warning;
  `--no-builtin-tools` drops built-ins entirely. Override must match the built-in's
  exact result shape including `details` type; renderer slots (`renderCall`/
  `renderResult`) fall back to the built-in independently; `promptSnippet`/
  `promptGuidelines` are **not** inherited.
- Tools run **in parallel** by default; any file-mutating tool must wrap its
  read-modify-write in `withFileMutationQueue(absolutePath, …)` or lose writes against
  concurrent `edit`/`write`.
- `promptGuidelines` bullets are appended flat without tool-name prefix — each bullet
  must name its own tool.
- Tool `execute` errors: throw; pi catches, reports to the LLM with `isError: true`,
  and execution continues. Extension-level errors are logged, agent continues;
  `tool_call` handler errors block the tool (fail-safe).

### Mode and UI constraints

- Extensions run in every mode; TUI-only APIs must be gated on `ctx.mode === "tui"`,
  dialog/notification-capable APIs on `ctx.hasUI`. Print (`-p`) and JSON modes have
  `ctx.hasUI === false`; RPC's `ctx.ui.custom()` returns `undefined`. The coordinator
  mechanics must work headless (subagents run `pi -p` style), so no UI dependence on
  the dispatch path.
- `before_agent_start` can chain-modify the system prompt and inspect
  `systemPromptOptions.contextFiles` (AGENTS.md files loaded) and `.skills` — the
  supported seam if afk-kit ever needs to inject context, since AGENTS.md itself is
  not a package-shippable resource (pi loads AGENTS.md/CLAUDE.md from
  `~/.pi/agent/AGENTS.md`, parent dirs, and cwd only — `usage.md`, "Context Files").

## 6. What the docs leave unspecified

Stated plainly, so downstream tickets don't assume:

1. **No `agents` manifest type.** Shipping the subagent roster inside the package and
   discovering it package-relatively is afk-kit's code to own (§4).
2. **No package-relative resource helper.** Nothing in the documented API resolves
   "files next to my extension"; `import.meta.url` is the implicit answer.
3. **Command name character rules** (e.g. whether `:` in a registered name is legal)
   are not documented; the `:N` suffixing implies colons occur, but don't rely on it.
4. **A full multi-resource package example** (extensions + skills + prompts in one
   manifest) is documented but not shipped as a first-party example; the glob/negation
   semantics are prose-only.
5. **`peerDependencies` behavior on git installs** (afk-kit's case) is specified in
   prose but not exercised by examples; expect `npm install --omit=dev` to run in the
   clone and treat peer deps as provided by pi itself.
6. **Skill frontmatter `allowed-tools`** is marked experimental in `$PI/docs/skills.md`;
   do not build R5's confinement on it — confinement belongs to the subagent
   mechanism's tool allowlist + spawn flags, not skill frontmatter.

## Sources

- `$PI/docs/packages.md` — manifest, convention dirs, sources, install locations,
  filtering, scope/dedup
- `$PI/docs/extensions.md` — locations, factory lifecycle, `registerTool`,
  `registerCommand`, `getCommands`, override rules, mutation queue, mode behavior,
  error handling, `project_trust`
- `$PI/docs/skills.md` — skill structure, frontmatter, validation, discovery
- `$PI/docs/settings.md`, `$PI/docs/usage.md` — trust model, settings scopes,
  AGENTS.md loading
- `$PI/dist/core/pi-manifest.js`, `$PI/dist/core/package-manager.js` — resource-field
  allowlist and install path confirmation (0.85.1 source)
- `$PI/examples/extensions/subagent/` — agent-definition pattern (agents.ts,
  agents/*.md, README)
- `$PI/examples/extensions/{gondolin,sandbox,with-deps}/package.json` — real manifests
- `pi install --help`, `pi config --help`, `pi --version` (0.85.1, run locally)
- This repo: `docs/requirements/subagent-mechanism.md` (R2, R5, R7, R10)
