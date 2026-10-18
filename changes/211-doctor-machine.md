Fixed

`doctor` now reports the Codex and Gemini CLI user hooks that `install` writes, the
session-start doctor and the command guard, once `~/.codex` or `~/.gemini` exists. A
missing one is a note and never changes the exit code. `explain codex-hook` and
`explain gemini-hook` name the stop check as well as the tool-call guard (#211).
