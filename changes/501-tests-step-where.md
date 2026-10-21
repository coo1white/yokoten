Fixed

The tests step in doctor now says where the CI job goes. It names `.github/workflows/yokoten.yml` and shows the job to add on one line. It says to copy the pinned `uses:` lines from the other jobs. It says to add `tests` to the `needs` list of the `ci` job. The job runs `npm test` when package.json has a test script. Otherwise it holds a placeholder for your own test command (#501).
