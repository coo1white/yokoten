Fixed

`install` no longer stops when `~/.codex/hooks.json` or `~/.gemini/settings.json` won't
parse, or when a key it edits has the wrong type. It prints one line that names the file,
such as "skipped Codex CLI: can't read ~/.codex/hooks.json (make it valid JSON, ...)" or
"skipped Codex CLI: ~/.codex/hooks.json has an unexpected shape (`hooks.PreToolUse` should
be a list of objects)", leaves the file as it was, runs every other step, and exits 1 at
the end. Only the events yokoten adds are checked, so other keys under `hooks`, such as
Gemini CLI's `hooks.disabled`, are kept. `init` does the same for a project's
`.codex/hooks.json` and `.gemini/settings.json`. `doctor` names the same problem instead
of failing or calling the hooks missing (#248).
