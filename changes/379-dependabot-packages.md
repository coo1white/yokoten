Added

`init` now writes a `dependabot.yml` that also updates the project's own packages, not
only the actions CI runs (#379). It looks for the manifest and lock files at the root and
one folder down: npm, bun, cargo, pip, uv, gomod, bundler, nuget, maven, gradle, composer,
mix, pub and swift. Each one it finds gets one block with the same monthly schedule,
7-day cooldown, one group and the `chore` prefix. A stack at the root gets `/` only, so a
Cargo or npm workspace opens one pull request. A `dependabot.yml` or `dependabot.yaml`
that is already there is kept as it is. `init` then names the ecosystems it does not
update. The change is in `kit/`, so every project gets it on its next `init`; a project
that already has the file only sees the line that names what is missing.
