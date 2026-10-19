Fixed

`install` and `bot` now refuse an unknown option, like every other command. Before,
`yokoten install --dry-run` installed. `bot` takes no options of its own and passes
everything after `--` on unchanged (#203).

The guide and `docs/server.md` now say what the code does: the required checks are `ci`
and `pr`, a section lists the security switches, and the guide lists the
`yokoten.json` keys, the environment variables and every `--json` shape (#203).
