Fixed

A new pull request no longer shows a failed or cancelled `pr` check while its labels and milestone are being added. `yokoten bot -- gh pr create` opens it as a draft and marks it ready once they are on; the `pr` check skips a draft and no longer cancels an earlier run, so it runs once on the whole pull request (#645).
