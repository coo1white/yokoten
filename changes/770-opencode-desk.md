Added

`yokoten desk opencode <folder> -- opencode run --standalone ...` runs OpenCode in a fenced desk on Linux, WSL2 and macOS (#770).
The desk points OpenCode's data, state and config folders into `<folder>.state`, and copies only the login rows of `opencode.db`.
The proxy lets OpenCode reach `opencode.ai`, the Go plan's API and its model list, and `NO_PROXY` names loopback so its private server can talk to itself.
