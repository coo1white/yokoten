Fixed

A tool-call guard that crashed, ran out of memory or was killed let the command run,
because Claude Code, Codex and Gemini CLI block a call only on exit 2. The tool-call
hooks that `init`, `install` and the plugin write now turn any other exit, a signal
included, into exit 2, and stderr holds only this one line:
`` yokoten's guard failed (exit N), so the command is refused; run `yokoten doctor` ``.
Node's own error, such as a heap trace, and the shell's "Killed" line, which in bash
shows the whole command and its paths, are dropped. On exit 0 and 2 the guard's stdout
and stderr pass through unchanged. The guard also runs with a 256 MB heap, so a runaway
read aborts in seconds and is refused instead of swapping until the agent's hook
timeout. Two cases say one line and let the call go on, so that `yokoten doctor` can
still run: a missing runtime, and no `node` on the agent's PATH. The stop check and the
session doctor are unchanged. Run `yokoten install` and `yokoten init` again to get the
new hooks (#260).
