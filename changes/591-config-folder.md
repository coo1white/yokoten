Security

A worker can no longer clear the worker list to drop its worker role. The guard now refuses a worker that changes, moves or removes yokoten's config folder (`~/.config/yokoten`), which holds the worker list and the bot's keys. This covers a shell command, an edit, a `find` that deletes, a hard link, git and downloads (`curl -o`, `wget -O`). It also covers a glob, a variable or a symlink that leads to the folder, and a folder that holds it, such as `rm -rf ~/.config`. A worker can still read the files there. The lead still marks and unmarks worktrees (#591).
