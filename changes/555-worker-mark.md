Fixed

A worker in Muse Code, or in any agent that passes its hooks no `YOKOTEN_ROLE`, is now
treated as a worker. The lead marks the worker's worktree with the new
`yokoten worker mark <dir>`, and the `dispatch` skill does it for each worktree. The guard
reads the mark for every agent. A worker can't push, and can't remove or change the mark.
`git worktree remove` removes the mark with the worktree (#555).
