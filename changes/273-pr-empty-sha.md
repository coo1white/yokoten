Fixed

`check --pr` no longer passes when the pull request event has no base or head commit id.
An empty, missing or non-text `base.sha` or `head.sha` used to give an empty diff, so the
file rules saw nothing. It now gives one finding, `pr-commits`, that names the missing
commit id and says to run the check on a real `pull_request` event. It exits 1 and prints
valid JSON with `--json` (#273).
