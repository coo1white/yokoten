Fixed

`yokoten explain` with no id now lists the ids on stdout and exits 0, as its help says.
With `--json` it prints `{ "ids": [...] }`. An unknown id is still an error and exits 1.
The top-level help now says `adopt` takes `--json` too (#247).
