Fixed

A tool-call guard that crashed, ran out of memory or was killed let the command run,
because Claude Code, Codex and Gemini CLI block a call only on exit 2. The tool-call
hooks that `init`, `install` and the plugin write now turn any other exit, a signal
included, into exit 2 with one line on stderr:
`` yokoten's guard failed (exit N), so the command is refused; run `yokoten doctor` ``.
The guard also runs with a 256 MB heap, so a runaway read aborts in seconds and is
refused instead of swapping until the agent's hook timeout. A missing runtime still says
its one line and lets the call go on, and the stop check and the session doctor are
unchanged. Run `yokoten install` and `yokoten init` again to get the new hooks (#260).
