Fixed

`install` no longer stops when `~/.codex/hooks.json` or `~/.gemini/settings.json` won't
parse, or when its `hooks` key isn't an object of event lists. It prints one line that
names the file, such as "skipped Codex CLI: can't read ~/.codex/hooks.json", leaves the
file as it was, runs every other step, and exits 1 at the end. `init` does the same for a
project's `.codex/hooks.json` and `.gemini/settings.json`. `doctor` now also says it
can't read a file whose `hooks` key is the wrong type, instead of failing or calling the
hooks missing (#248).
