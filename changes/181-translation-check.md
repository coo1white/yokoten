Fixed

A translation is no longer called current when another pull request changed only the English. A commit that changes both files no longer hides an English-only commit before it, whichever pull request merges first. Only a commit that changes only the translation catches up (#181).

In a shallow clone, `check` now answers for each translation whose history the clone holds. One note for the run names how many it could not check. It never calls one behind or current by mistake (#181).
