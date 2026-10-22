Security

A worker can no longer clear the worker list to drop its worker role (#591). The worker list and the bot's keys are in yokoten's config folder (`~/.config/yokoten`). The guard refuses a worker's command or edit that changes, moves or removes that folder or a file in it. A folder that holds it counts too, such as `rm -rf ~/.config`. A worker can still read the files there. The lead still marks and unmarks worktrees.

The guard no longer tries to read every way bash can spell a path. A worker now works in a box:

- `cd` takes one plain path that stays inside the worker's worktree. `pushd`, `popd`, `cd -P`, `set -P` and `set -o physical` are refused. A plain path has only letters, digits, `.`, `_`, `/`, `-` and a leading `~`. A `cd` in a subshell, a pipe or the background is refused.
- `$'...'` and `${...@...}` are refused.
- Settings before a command, after `env`, or in `export` (`NAME=` and `NAME+=`) come from a short list: `TZ`, `CI`, `NODE_ENV`, `NO_COLOR`, `FORCE_COLOR`, `DEBUG`, `LANG` and `LC_ALL`. Options to `env`, `read`, `printf -v` and `eval` are refused.
- git takes no option before its subcommand (`--no-pager` is fine). `git config` only reads, and `--output` is refused.
- `less` and `file` may not write a file (`less -o`, `--log-file`, `file -C`).
- `alias` definitions are refused, and so is a `find -L` that changes files or runs a program.
- A command that does more than read may not name a path that is or holds the config folder. The guard resolves each path word the way the kernel does: one part at a time, following a symlink before a later `..`. So `link/../yokoten` counts. It expands globs itself (`l*/workers`, `*/*`, `link/../*/*`). It reads an attached short-option value (`-olink/workers`, `-Clink`) and `$PWD`. A part it can't read (`$x`, `$(...)`) may be empty or any name, so it counts when any name in its place reaches the folder. It refuses `~name` and the paths `/proc/self`, `/proc/<id>/cwd`, `/proc/<id>/root`, `/proc/<id>/fd` and `/dev/fd`.
- Any worker command is refused if it uses the directory stack (`~0`, `~+N`, `~-`, `$OLDPWD`).
- A worker may not make a link into the config folder with `ln -s` or `cp -s`.
- A recursive writer (`-r`, `-a`, rsync `-K`) may not run over a folder that holds such a link, up to 6 folders deep.
- Also refused: a symlink-following read (`find -L`, `grep -R`, `ls -L`) piped into `xargs`, `alias`, `hash -p`, and `enable` with an option.
- `chmod`, `chown` and `chgrp` may not take `-L` or `-H`.
- A command that names the home config folder, a glob such as `~/.c*/yokoten` too, passes only when every program in it only reads. A repo's own `.config/` folder is not the home one.

Known limits: the guard reads command text only.

- A script the worker writes and then runs (`node x.mjs`) is out of its reach. So is inline code, such as `node -e`, `awk`, or a `sed` script with `w`.
- A program the worker runs (`npm test`, a build tool) can follow links on its own.
- Links that come inside an archive or a patch (`tar -x`, `unzip`, `git apply`) are not checked.
- The folder scan stops after 6 folders deep or 5,000 entries, and skips `.git` and `node_modules`.
- The guard errs toward refusing. In a worktree that holds a link into the config folder, a path with a `$x` part is refused. A message such as `-m "~wip"` is refused too.

The real lock is the operating system sandbox (issue #589).
