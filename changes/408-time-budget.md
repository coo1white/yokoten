Changed

The hooks start faster (#408, record 0013). A copy of yokoten (`install`, `init`) now runs
a prebuilt bundle of its code. A hook no longer loads and type-strips about 45 `.ts` files.
Each command loads only its own code, and the guard starts its worker first. On a WSL 2
laptop, a guard call went from about 100 ms to 75 ms. A session start went from 105 ms to
90 ms, and the commit check from 80 ms to 60 ms. `scripts/bench.ts` measures them, and CI
fails when one goes over its budget.
