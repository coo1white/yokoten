Fixed

A run on `main` is never cancelled, even while it waits: every event other than a pull request gets its own concurrency group (#798).
