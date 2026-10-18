Fixed

`check --staged` with nothing staged, even in a repo with no commits, no longer reports
the commit time. It notes that nothing is staged and exits 0. The commit hook still
checks the time of an empty commit or an amend (#208).

`check --history` now names the commit that added a file with a hit:
`notes.md @ <commit>`, not only its blob. When it can't find the commit, it keeps the
blob and gives the `git log --find-object` command (#208).
