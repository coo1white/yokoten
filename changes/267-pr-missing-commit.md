Fixed

`check --pr` no longer crashes with git's raw error when the pull request's base or head
commit is not in the checkout, as in a depth-1 clone. It now gives one finding,
`pr-commits`, that names the missing commit and says to use `fetch-depth: 0` in
actions/checkout. Two commits with no common commit get the same finding. `check --pr` and
`check --issue` also give one finding, `ci-event`, when the event file is missing, is not
valid JSON or is not a JSON object. Each of these exits 1, prints valid JSON with `--json`,
and writes the job summary. A label that is null or has no name is skipped (#267).
