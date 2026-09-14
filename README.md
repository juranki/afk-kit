# afk-kit

Design capture for a personal development workflow: prepare agent-ready tickets in
planning sessions, and let per-issue agent coordinators implement and review the work
while the human keeps the start and merge gates.

**Status: design only.** No skills or extensions are implemented in this repository.
The subagent mechanism is selected: a vendored, hardened fork of pi's example
`subagent` extension ([ADR 0007](docs/adr/0007-vendored-subagent-mechanism.md)),
evaluated against the requirements in
[docs/requirements/subagent-mechanism.md](docs/requirements/subagent-mechanism.md).

Start with [system-intent/README.md](system-intent/README.md), the model frame;
[docs/README.md](docs/README.md) routes everything else.

## License

MIT — see [LICENSE](LICENSE).
