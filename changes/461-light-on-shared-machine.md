Added

`yokoten doctor` now reports what one guard call costs on this machine, in one line: `guard: 90 ms per command (60 ms CPU)`, the wall time and the CPU time of a real run. A session start does not run it (#461).

New `yokoten test` runs the tests light for a machine other work shares: `node --test` under `nice -n 10` (not on Windows), with the concurrency at most half the cores and one per GB of free memory, and at least 1. It is on by default; `YOKOTEN_LIGHT_TESTS=0` or `--heavy` turns it off (#461).
