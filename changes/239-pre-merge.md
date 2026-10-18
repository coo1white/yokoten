Fixed

A merge that git commits itself (`git merge --no-ff` without a conflict) now gets the
commit check. git runs `pre-merge-commit` for it, not `pre-commit`, so `init` writes
`.githooks/pre-merge-commit`, or adds the check to the project's own (husky:
`.husky/pre-merge-commit`). `doctor`'s `commit-check` step wants both hooks, and names
the one that is missing (#239).
