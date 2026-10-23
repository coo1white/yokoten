Fixed

The guard now refuses the other ways an agent could lose your work: deleting the checkout (`rm -rf .` or `..`), `git clean`, `git checkout .` and `git restore .`, `git stash clear` and `git stash drop`, `git gc --prune=now`, `git prune --expire=now`, `git reflog expire`, `git filter-branch`, and moving the default branch with `git update-ref`, `git branch -f` or `git checkout -B`. It reads a shortened option as git does, so `--har` and `--del` are refused too (#828).
