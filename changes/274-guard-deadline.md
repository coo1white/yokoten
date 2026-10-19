Fixed

The tool-call guard now reads each call in a worker thread with a deadline of 5 seconds
(`YOKOTEN_GUARD_DEADLINE_MS` changes it). Claude Code, Codex and Gemini CLI let a call
through when a hook runs past their timeout, so a command that took the guard too long
to read used to run unchecked. Past the deadline, or when the guard fails while reading,
the hook now stops it and refuses the call with exit 2 and `unreadable-command` (#274).
