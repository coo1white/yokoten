Fixed

The tool-call guard reads a heredoc body as commands only when a shell reads it: the program
of the command that holds the `<<` (after `env`, `sudo`, `nice` and the other wrappers), or a
command it pipes into. A body that `cat > file`, `tee`, `node -` or `gh ... --body-file -` reads
is data, so a PR body that names a release command is no longer refused. A file named `sh`
no longer counts as a shell, and a pipe left open at the line end still does (#196).
