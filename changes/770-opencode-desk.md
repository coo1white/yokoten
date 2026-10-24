Added

`yokoten desk opencode <folder> -- opencode run --standalone ...` runs OpenCode in a fenced desk on Linux, WSL2 and macOS (#770).
The desk points OpenCode's data, state and config folders into `<folder>.state`, and copies only the login rows of `opencode.db`; `kv` stays out, because it holds the model catalog and background job messages, not a login.
The desk shows `~/.opencode/bin`, where the program is, and nothing else of `~/.opencode`.
The proxy lets OpenCode reach `opencode.ai`, the Go plan's API and its model list.
`NO_PROXY` names loopback for that agent only, because its private server talks to itself there.
On macOS the desk starts nothing for OpenCode until the lead adds `--allow-loopback`: the server picks its own port, so the profile would have to open every loopback port. Linux and WSL2 need no choice; their network is the desk's own.
