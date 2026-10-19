Fixed

The GitHub Action now runs `check --issue` on an `issues` event; the new `issue-check` input
(default `true`) turns it off. On `pull_request_target` it no longer stays silent about the
pull request check: it leaves a notice that the check runs on `pull_request`, since the
checkout there holds the base branch, not the pull request (#269).
