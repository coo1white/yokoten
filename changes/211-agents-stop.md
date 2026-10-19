Added

The stop check now runs in Codex and Gemini CLI: `init` writes a Codex `Stop` hook and a
Gemini CLI `AfterAgent` hook, and `hook --stop --agent codex|gemini` reads them. `install`
writes the session-start doctor and the command guard to `~/.codex/hooks.json` and
`~/.gemini/settings.json`. `doctor --session --agent gemini` prints the JSON that Gemini
CLI reads. The guide says how each tool trusts a hook, and that Gemini CLI's strict
environment sanitization hides the worker role (#211).
