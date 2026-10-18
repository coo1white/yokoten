Fixed

The tool-call guard reads a heredoc body as commands only when a shell reads it: the program
of the command that holds the `<<` (after shell keywords such as `then` and `do`, and after
`env`, `sudo`, `nice`, `stdbuf`, `setsid` and the other launchers), or a command it pipes into.
A body that `cat > file`, `tee`, `node -` or `gh ... --body-file -` reads is data, so a PR body
that names a release command is no longer refused. A file named `sh` no longer counts as a
shell, and a pipe left open at the line end still does. When the program is one the guard does
not know, a shell anywhere in the command still counts (#196).
