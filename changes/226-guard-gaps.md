Fixed

The tool-call guard closes five gaps in how it reads commands. The string that `ssh host '...'`
and `flock file -c '...'` run is read after their options and host, for blocked programs and the
core rules. A `case` pattern such as `python3)` or `python3|py)` is no longer taken for a program;
the commands after it still are. `env` with `S` among combined short flags, or `--split-string`
cut short (`--split`), has its string read. A redirect before the program (`>out`, `2>&1`, `< in`)
no longer hides it, and `> sh cat <<EOF` is data. A heredoc in a group or subshell whose output is
piped into a shell, as in `{ cat <<EOF; } | bash` or `( cat <<EOF ) | sh`, also over several
lines, is read as commands; with its output sent to a file it stays data (#226).
