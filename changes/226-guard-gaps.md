Fixed

The tool-call guard closes five gaps in how it reads commands. The string that `ssh host '...'`
and `flock file -c '...'` run is read after their options and host, for blocked programs and the
core rules. A `case` pattern such as `python3)` or `python3|py)` is no longer taken for a program;
the commands after it still are. `env` with `S` among combined short flags, or `--split-string`
cut short (`--split`), has its string read. A redirect before the program (`>out`, `2>&1`, `< in`)
no longer hides it, and `> sh cat <<EOF` is data. A heredoc in a group or subshell whose output is
piped into a shell, as in `{ cat <<EOF; } | bash` or `( cat <<EOF ) | sh`, also over several
lines, is read as commands; with its output sent to a file it stays data (#226).

A command the guard cannot read is now refused with exit 2 ("yokoten could not read this
command"), never let through. A quoted or escaped `case` is no keyword, and a pattern holding a
separator is read as commands. A heredoc on `exec` alone or a bare redirect is read as commands.
`env -S` strings count for the core rules too. A chain of `find -exec find` and a command of 100k
words are read in a fraction of a second. A hooks folder counts only when its pre-commit runs
`yokoten check` on a line of its own, at the top level, and stops the commit when the check fails;
`.husky/<other>` is judged by its own pre-commit, values git expands (`~`, `%(prefix)`) are
refused, and so is a change in a command that also moves repo (`cd`, `pushd`, `GIT_DIR=`,
`GIT_WORK_TREE=`, `--worktree`).

The guard's work on one command is bounded. Each construct is read once: an unclosed `$(`,
`<(`, `((`, backtick or `"` is no longer read again at each level, which ran node out of
memory on a 300-byte command and let it through. Every read of a command shares one budget
(20 steps a character), and a command over it is refused. A pipeline of 8000 heredocs is read
in a fraction of a second, not 12 s. A hooks folder counts only when git runs its pre-commit:
an executable file (and for husky, `.husky/_/pre-commit` too) whose first line names sh,
bash, dash or zsh. The pre-commit is read as the shell reads it: lines joined by `\`, a quote
across lines, a line after `||`, `&&` or `|` are not a check line of their own; the check
takes only `--staged` and `--json`; `return` counts as `exit`, and `set +e` ends `set -e`.
The check line may run through `pnpm exec`, `yarn`, `bunx` or `npx --no`, follow
`npx lint-staged &&`, end in `|| exit $?`, `;` or a comment, and names yokoten itself, not
`./fake-yokoten`. `env -S` reads its `\_`, `\t` and `\c` escapes. A heredoc right after a
group (`{ read -r a; } <<EOF`) is the group's input. `env -C`, `env --chdir`, `builtin cd` and
`GIT_COMMON_DIR=` move repo, and `source /dev/stdin` or `. /dev/fd/N` runs its input.
