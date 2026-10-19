Fixed

`check --pr` now checks the labels the way the rule says. A pull request needs one type label
and one tier label, and the tier label must match the `tier:` line in the body. Before, any one
label passed. A type label is a title type or a common name for one (`bug` for `fix`,
`enhancement` for `feat`). `tier: B` counts as `tier B`. Each missing or wrong label gets its own
message. `init --github --yes` now also makes the labels `tier A`, `tier B` and `tier C`,
and doctor's `labels` step expects them (#225).
