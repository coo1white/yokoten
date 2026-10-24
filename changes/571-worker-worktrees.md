Added

Worker worktrees now live in `.worktrees/<issue>/` inside the project, git-ignored,
where a restart can't wipe them. `yokoten init` adds `.worktrees/` to `.gitignore`. The
layout check skips it. The guard reads a path under it from that worktree, so a
lead-only file there is still lead-only. `doctor` names `.worktrees/` in the fix when a
worktree sits in a temp folder. The `dispatch` skill makes the worktree there, never
under `/tmp`, and says workers run on the lead's model unless the owner names
another (#571).
