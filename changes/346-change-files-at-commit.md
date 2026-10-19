Changed

`check` now reads each file in `changes/` the way `yokoten changelog` does. `check --staged` reads the staged ones. So the git hook stops a wrong change file at commit, not only in CI (#346).
