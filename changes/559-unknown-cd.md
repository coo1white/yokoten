Fixed

A worker's relative write after a `cd` the guard can't follow is refused, including `git apply` of a named patch and a `git commit` that takes the staged or all changed files (#559, #465).
