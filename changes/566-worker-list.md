Added

The worker mark survives `.git` being moved away: `yokoten worker mark` also keeps the worktree path on a worker list outside the worktree, and `yokoten worker unmark` (lead only) clears it (#566).
