Fixed

Muse Code in a worker's own `git clone`, such as a desk, now runs as a worker. Muse passes its hooks no `YOKOTEN_ROLE`, and the guard did not read the worker mark in a clone's `.git`, so it saw a lead. `yokoten worker mark <dir>` now also marks a plain clone, except a checkout the lead works in or one with worktrees (#672).
