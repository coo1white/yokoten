Fixed

A refused tag push or release now names the command that starts your agent, such as
`YOKOTEN_RELEASE_APPROVAL=1 codex`. It used to say `claude` in every agent. Copilot CLI
can't be told apart from Claude Code, so that message adds "or your agent's command".
Muse Code passes its hooks only a short list of variables and is not known to pass
`YOKOTEN_RELEASE_APPROVAL`. So in Muse Code, the message says to release outside it.
