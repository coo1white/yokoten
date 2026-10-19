Internal

The linear-time tests in `test/rules/guards.test.ts` check how the time grows from n to 8n (at most
24x), like the ones in `test/setup/road.test.ts`, instead of a 1 s or 2 s wall-clock limit that a slow CI
runner can miss (#316). The shared check, `assertLinear`, moves to `scripts/linear.ts`.
