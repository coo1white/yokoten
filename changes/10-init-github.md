Added

`init` now reads GitHub through `gh` and says which standard labels and milestone it would
add; without `gh`, a sign-in or a GitHub remote it says what it skipped and still succeeds.
`init --github --yes` also gives a standard label that is there the standard colour and
description, and `--remove-default-labels` deletes GitHub's default labels outside the set.
The road's stage 2 has two new steps, `labels` and `milestone`, which full `doctor` reads
through `gh` (#10).
