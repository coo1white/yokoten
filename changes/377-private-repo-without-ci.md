Added

A private repo can adopt yokoten without CI (#377). `init` reads the repo's visibility
through `gh`, and on a private repo it says that the workflows use Actions minutes.
`init --no-ci` adds `"ci"` to `"notNow"` in `yokoten.json`, writes no workflow and no
Dependabot config, and removes those files while they are still the kit's copy. With
`"notNow"` `ci`, a later `init` (or `init --github --yes`) writes them no more. The
steps that need CI (`tests`, `ci`, `titles`) wait with it, so the road can be finished.
Full `doctor` says once what is not checked without CI, and from stage 5 reminds you to
end the choice when the repo goes public. `check --pr <number>` reads one pull request
through `gh`, so you can check it before a merge. Not in this change: `init --github`
still writes the project files too; that is left for a later issue.
