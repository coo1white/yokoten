Added

`yokoten speed` shows how long a test run took. It names the slowest tests and the share of the run that the slowest test files hold. It fails when the run passes its time budget. Over the budget, it gives advice grouped by cause, each naming the project's own files. A new Node project whose test script runs `node --test` gets the check in its tests job: three shards, `fail-fast: false`, and a 180 s budget (#479). Doctor shows the time budget as advice: a project with tests already in place does not fall back a stage because its CI does not keep the test time yet.
