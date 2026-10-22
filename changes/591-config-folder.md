Security

A worker can no longer clear the worker list to drop its worker role (#591). The worker list and the bot's keys are in yokoten's config folder (`~/.config/yokoten`). The guard refuses a worker's command or edit that changes, moves or removes that folder or a file in it. A folder that holds it counts too, such as `rm -rf ~/.config`. A worker can still read the files there. The lead still marks and unmarks worktrees.

The guard no longer tries to read every way bash can spell a path. A worker now works in a box:

- `cd`, `pushd` and `popd` take one plain path that stays inside the worker's worktree. A plain path has only letters, digits, `.`, `_`, `/`, `-` and a leading `~`. A `cd` in a subshell, a pipe or the background is refused.
- `$'...'` and `${...@...}` are refused.
- Settings before a command, after `env`, or in `export` come from a short list: `TZ`, `CI`, `NODE_ENV`, `NO_COLOR`, `FORCE_COLOR`, `DEBUG`, `LANG` and `LC_ALL`. Options to `env`, `read`, `printf -v` and `eval` are refused.
- git takes no option before its subcommand (`--no-pager` is fine). `git config` only reads, and `--output` is refused.
- `less` and `file` may not write a file (`less -o`, `--log-file`, `file -C`).
- A command that names the home config folder passes only when every program in it only reads. A repo's own `.config/` folder is not the home one.

Known limits: the guard reads command text. A script that the worker writes and then runs (`node x.mjs`) is out of its reach. The real lock is the operating system sandbox (issue #589).
