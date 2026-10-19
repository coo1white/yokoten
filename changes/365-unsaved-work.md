Added

`doctor` and the session note list the work that is only on this machine (#365).
That is uncommitted changes, commits not pushed, stashes, a stale `index.lock` and a repo on a tmpfs.
Full `doctor` also lists worktrees that are merged or gone, and worktree folders that are missing.
Each note gives the one command that saves the work. Doctor only reads, and a note never fails it.
