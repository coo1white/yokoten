Fixed

`doctor` run from a project's `.yokoten/` copy, as in CI and the hooks, now checks the
core rules in `AGENTS.md` instead of always saying "can't compare". The copy now keeps the
kit's `AGENTS.md`, and `init` refreshes it with the rest of the copy. `update` from the
copy compares with, and writes, the kit the project vendored (#145).
