Fixed

A worker can no longer move a lead-only file away. `check --staged` now runs the lead-only
and fix-task test checks on the old path of a move or copy as well as the new one, so
`git mv AGENTS.md notes.md` by a worker is refused the same as `git rm AGENTS.md`, and a
fix task can't move a test. Moving any other file still passes, and the lead can move
lead-only files. The privacy check still reads only the new copy. In a merge, a move that
the other branch made is not the worker's; a move made during the merge is (#259).
