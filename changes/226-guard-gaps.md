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
