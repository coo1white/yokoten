Fixed

Muse Code in a worker's own `git clone`, such as a desk, now runs as a worker. Muse passes its hooks no `YOKOTEN_ROLE`, and the guard did not read the worker mark in a clone's `.git`, so it saw a lead. `yokoten worker mark <dir>` now also marks a plain clone, except a checkout the lead works in or one with worktrees (#672).

A worker can no longer drop the mark by removing or replacing the folder that holds `.git` (`rm -rf "$PWD"`, `rsync --delete` into it). A worker can no longer run `yokoten worker mark` either. The lead marks a clone from its own checkout, and a caller's `GIT_DIR` no longer moves the mark into another checkout.
