Added

`yokoten bot -- gh pr create` and `gh pr edit` now check the body before they send it
(#406). A body from `--body` or `--body-file` meets the same body rules as `check --pr` in
CI: the tier line, the sections, the linked issue, the change file, the `kit/` line, and
`tier: A` for files that CODEOWNERS owns. The rules read the files this branch changes
since `origin/main` (or `--base`), and the base branch's CODEOWNERS. On a problem nothing is
sent, and you see the same message CI gives. Labels and the milestone are still checked
in CI only.
