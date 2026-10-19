Fixed

`doctor` exits 0 when the only steps left on the road are to do, not now or can't check.
It exits 1 on a problem: a failed self-test, or a core-rules, tree or machine line marked
MISSING. `install` ends with the `alias yokoten=…` line for your shell profile when no
`yokoten` on your PATH runs the installed copy. `update <dir>` says when the folder does not
exist. `init --github --yes` exits 1 when it skipped GitHub (no `gh`, no sign-in or no
GitHub remote), and the skip names `init --github --yes` as the command to run (#208).
