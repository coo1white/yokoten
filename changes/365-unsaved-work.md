Added

`doctor` and the session note list the work that is only on this machine (#365).
That is uncommitted changes, commits not pushed, stashes and a stale `index.lock`.
It names a repo on a tmpfs, or under the temp folder that the system may empty on restart.
A worktree there is named when it holds work at risk; the rest get one line in full `doctor`.
Full `doctor` also lists worktrees that are merged or gone, and worktree folders that are missing.
Each note gives the one command that saves the work. Doctor only reads, and a note never fails it.
A session spends at most one second on this, and says when it stopped early.
