Added

The command guard now stops an agent from cancelling or deleting a GitHub Actions run.
That is `gh run cancel`, `gh run delete`, and the same call through `gh api` or `yokoten bot`.
A cancelled run turns a check red and blocks the merge. A deleted log is evidence gone.
Reading a run still works, and so does `gh run rerun`. Ask the owner to cancel or delete a run on the Actions page (#650).
