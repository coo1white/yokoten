Fixed

`install` no longer creates `~/.codex` and `~/.gemini` for people who don't use Codex or
Gemini CLI: it writes their user hooks only when that folder already exists, and
otherwise says it skipped them. `doctor` now reports those user hooks, the session-start
doctor and the command guard, once `~/.codex` or `~/.gemini` exists, as
`codex-user-hook` and `gemini-user-hook`. It compares each hook with what `install` would
write, so an old one is out of date rather than ok, and a file it can't parse says so. A
missing or old one is a note and never changes the exit code. `explain codex-hook` and
`explain gemini-hook` name the stop check as well as the tool-call guard (#211).
