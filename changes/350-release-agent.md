Fixed

A refused tag push or release now names the command that starts your agent, such as
`YOKOTEN_RELEASE_APPROVAL=1 codex`. It used to say `claude` in every agent. Copilot CLI
can't be told apart from Claude Code, so that message adds "or your agent's command".
Muse Code passes no `YOKOTEN_RELEASE_APPROVAL` to its hooks. So in Muse Code, the message
says a release can't be approved there.
