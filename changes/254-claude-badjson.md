Fixed

`install` no longer stops when `~/.claude/settings.json` won't parse, or when a key it
edits has the wrong type: its top level, `hooks`, or the SessionStart and PreToolUse lists
it adds to. It prints one line, such as "skipped Claude Code: can't read
~/.claude/settings.json (make it valid JSON, ...)" or "skipped Claude Code:
~/.claude/settings.json has an unexpected shape (`hooks.PreToolUse[0].hooks` should be a
list of objects)", leaves the file as it was, still adds the Codex and Gemini CLI hooks
and the rest, and exits 1 at the end. Both events are checked before either hook is
written, and other keys, such as another event under `hooks`, are kept. `init` does the
same for a project's `.claude/settings.json`, checking PreToolUse, Stop and `env`: the
tool-call hook, the stop check and TZ=UTC are skipped together, and every other step runs.
`doctor` names the same problem instead of calling the session-start doctor missing (#254).
