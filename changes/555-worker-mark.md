Fixed

A worker in Muse Code, or in any agent that passes its hooks no `YOKOTEN_ROLE`, is now
treated as a worker. The lead marks the worker's worktree with the new
`yokoten worker mark <dir>`, and the `dispatch` skill does it for each worktree. The guard
reads the mark for every agent, and treats a `.git` link it can't read as marked. For a
worker, `git push`, `yokoten bot`, `gh pr create`, a write through `gh api` and a
git alias are refused. So are the plain ways to change the mark. It reads
text, so the real lock is the server and credentials kept from the worker.
`git worktree remove` removes the mark with the worktree (#555).
