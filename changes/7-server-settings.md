Added

The road's stage 5 has three server steps: `protection` (rulesets on the default branch
and `v*` tags), `merge-settings` (squash only, delete branch on merge) and
`security-settings`. Full `doctor` reads them through `gh api`, and only reads. Without
`gh`, a sign-in, the network or a GitHub remote, a step says "can't check", never done. A
session never calls the network. The `server` list now shows only the settings outside
the road: forgotten branches, and what to check by hand when nothing could be read (#7).
