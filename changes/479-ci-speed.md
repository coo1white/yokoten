Added

`yokoten speed` shows how long a test run took. It names the slowest tests and the test files that take half of the time. It fails when the run passes its time budget. Over the budget, it gives advice grouped by cause, each naming the project's own files. A new Node project whose test script runs `node --test` gets the check in its tests job: three shards, `fail-fast: false`, and a 180 s budget (#479).
