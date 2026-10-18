Fixed

A merge that git commits itself (`git merge --no-ff` without a conflict) now gets the
commit check. git runs `pre-merge-commit` for it, not `pre-commit`, so `init` writes
`.githooks/pre-merge-commit`, or adds the check to the project's own (husky:
`.husky/pre-merge-commit`). `doctor`'s `commit-check` step wants both hooks, and names
the one that is missing; when only `pre-merge-commit` is missing, it says merge commits
are not checked. A hook without the execute bit counts as not checked, because git skips
it (not on Windows), and `init` makes it executable. For a hook in a project's own folder
that does not exist yet, the advice gives the `#!/bin/sh` line and `chmod +x` (#239).
