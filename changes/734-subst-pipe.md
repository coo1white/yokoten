Fixed

The guard refuses a download piped into `$(…)`, backticks or `<(…)` when that runs a shell or `sudo -s` (#734).
