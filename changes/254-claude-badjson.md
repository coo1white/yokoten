Fixed

`install` no longer stops when `~/.claude/settings.json` won't parse, when its top level
isn't an object, or when its `hooks` or `env` key is the wrong type. It prints one line,
"skipped Claude Code: can't read ~/.claude/settings.json", leaves the file as it was,
still adds the Codex and Gemini CLI hooks and the rest, and exits 1 at the end. `init`
does the same for a project's `.claude/settings.json`: the tool-call hook, the stop check
and TZ=UTC are skipped together, and every other step runs. `doctor` says it can't read
`~/.claude/settings.json` instead of calling the session-start doctor missing (#254).
