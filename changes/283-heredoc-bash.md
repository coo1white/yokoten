Fixed

The tool-call guard now reads heredocs and shell input the way bash runs them. A heredoc
written `<<$'EOF'` or `<<$"EOF"` ends at `EOF`, and a line `EOF\r` no longer ends a body that
bash keeps reading, so the commands after it are checked. What a command prints, handed to a
shell, is read as commands: `bash <(...)`, `source <(...)`, `. <(...)`, `bash -c "$(...)"` and
`eval "$(...)"`, and an `if`, a loop or a `case` piped to a shell, as a `{ }` group already
was. A loop fed by a heredoc that runs each line (`while read l; do eval "$l"; done`) reads the
heredoc as commands. `xargs git` takes what comes in as git's words, and `env -S` reads
`${NAME}` as empty. The reads stay linear in the length of the command.
