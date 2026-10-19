Fixed

`check --history` in a shallow clone (actions/checkout's default) no longer says
`ok (every commit on every branch)`. It can't see the older commits there, so it scans
nothing and fails with one finding, `shallow-history`, which says to use
`fetch-depth: 0` in actions/checkout or run `git fetch --unshallow`. The finding shows in
`--json`, and in the annotations and the job summary in GitHub Actions (#266).
