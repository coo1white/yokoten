Added

`yokoten trust` turns on yokoten's guard in Codex, Grok CLI, Copilot CLI and Muse Code. `yokoten init` asks once on a terminal, writes only yokoten's entries, and names the command when no terminal can answer; `yokoten trust --undo` removes only what it wrote (#661). For Codex, a hook is yokoten's only when its command is exactly the one yokoten writes: a hook a repo ships beside it is never trusted. A hook edited after trust stays off, and doctor says to run `yokoten init`, which puts yokoten's command back.
