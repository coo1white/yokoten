Added

The command guard now stops an agent from cancelling or deleting a GitHub Actions run.
That is `gh run cancel`, `gh run delete`, and the same call through `gh api` or `yokoten bot`.
A cancelled run turns a check red and blocks the merge. A deleted log is evidence gone.
Reading a run still works, and so does `gh run rerun`. Ask the owner to cancel or delete a run on the Actions page (#650).
A flag's value cannot hide the method, and a `repositories/<id>` path is the same call.
A path is read with `.` and `..` resolved, and `$1`, `$@` and `$*` count as the repo.
`gh alias set` and `gh alias import` are refused. Ask the owner to add an alias by hand.
A cluster of short options in `gh api` is refused, unless one option carries its value.
A shell variable cannot hide the method or the path of a run call.
`gh run` refuses a subcommand from the shell. Route words such as `repos` and `cancel` match in any case.
A `gh` command must be one that gh ships. Installing an extension, or setting an alias with `gh config`, is refused.
`gh extension exec` and `gh extension browse` are refused. One runs an extension. The other can install one.
A non-GET call is refused when the path after `repos/` or `repositories/` is only a variable.
