Changed

The hooks start faster (#408, record 0013). The agent hooks now run `bin/yokoten.mjs`,
which needs no type stripping, and keep Node's compile cache in the user's cache folder.
Run `yokoten init` (and `yokoten install`) again to move older hooks to it; `yokoten.ts`
still works. Each command loads only its own code, the guard starts its worker first, and
doctor asks git each question once. On a WSL 2 laptop, a guard call takes about 0.63 times
as long as before, and a session start about 0.7 times. `scripts/bench.ts` measures the
hooks, and CI fails when one goes over its budget.
