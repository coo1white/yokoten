Fixed

`check --staged` no longer checks the wrong bytes after `git replace`. It read each staged
file through replace refs, so replacing a staged blob that holds a secret with a clean one
let the commit through with the secret in it. Every read of repo content now ignores
replace refs: the pre-commit check, the history check, and the diffs and files that
`check --pr` reads. `check --history` also fails with its grafts finding when
`GIT_GRAFT_FILE` names a grafts file outside `.git` (#294).
