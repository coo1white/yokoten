Added

`yokoten ci-health` and the `actions-health.yml` workflow watch a repo's Actions: every 30 minutes, one pinned issue, `CI health`, shows failed or cancelled runs on `main`, failed checks on open pull requests, slow workflows, queue waits, and branches that both passed and failed. The `board` workflow no longer starts a run for each issue event, so a queued run is no longer replaced and shown as cancelled (#647).
