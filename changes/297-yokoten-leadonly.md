Fixed

A worker can no longer change `.yokoten/`, the copy of yokoten that a project's hooks and
CI run. `.yokoten/**` is now in the default `leadOnly` list, so the tool-call guard stops
a worker's edit there and `check --staged` refuses a worker's commit that changes it. Before,
a worker could turn off the checks it works under (#297).
