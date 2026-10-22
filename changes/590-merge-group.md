Added

The kit workflows are ready for a merge queue (#590). `yokoten.yml` and `pr.yml` also run on `merge_group`, so a queued merge runs the same required checks as a pull request. A merge group run has no pull request: `yokoten.yml` runs every job in full, and the `pr` job skips, which counts as green for the queue. Turn the queue on in the repo settings.
