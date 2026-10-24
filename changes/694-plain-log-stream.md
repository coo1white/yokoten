Added

The board streams a runner's plain text log when it finds no session log (#694).
The status file may name that log in an optional `log` field.
The path must resolve inside the worktree or the runtime's log folder.
Only new lines show, and every line is masked like a session line.
OpenCode workers use this log until the board can read their sessions.
