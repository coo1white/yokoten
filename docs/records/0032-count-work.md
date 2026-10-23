# 0032 Linear scans are judged by the work they count

Status: accepted
Date: 2026-10-23 (UTC)

## Context

The linear-time tests failed on CI twice on 2026-10-23. Both times the same code
passed every local run. One failure was 28 times on macOS, in PR #722. The other was
27 times on Ubuntu, on main after PR #727. This was the eleventh issue of that class
(#321, #324, #343, #359, #442, #474, #493, #594, #605, #648).

Each earlier fix tuned the timing. More rounds, a bigger base, the fastest of several
reads, then CPU time instead of the wall clock. The next busy runner broke it again.
A shared runner cannot tell 8 times from 27 times when the small case takes half a
millisecond.

[0016](0016-fast-tests.md) said the controls use a simulated clock, and the real checks
keep the wall clock. This record replaces that bullet only. The rest of 0016 stands.

## Decision

- **The tests count work, not time.** Each scanner calls `noteWork`. The guard's
  `spend` is one of those calls. Counting stays off until a test calls `measureWork`.
  A real read then pays one null check.
- **Eight times the input may cost about eight times the steps.** The limit is 12
  after rounding. A quadratic scan is about 64 times and fails. A scan that counts
  nothing fails too.
- **One wall-clock smoke test remains.** Growth under 100 times passes. Over that,
  it measures once more and then fails. A read of 30 seconds or more fails at once.
  The other linear tests do not read the clock.

## Options not taken

- **Another timing tune.** Eleven of those already failed on the next busy runner.
- **A wall clock inside every linear test.** That is the check that flaked.
- **A new file under `src/rules/`.** That folder is already at the cap of 7. The
  counter lives in `message.ts`, which every scanner can already import.

## Consequences

- The same input gives the same count on every machine and every run.
- A regex that backtracks, or a string built in a loop, can still be slow. The step
  count does not see work inside one call. The smoke test and the work budget are
  the backstops for that.
- A scan that hits its budget on the large input only can look linear. The budget
  stays the runtime backstop.
- A new scanner that can multiply work calls `noteWork` inside the loop. A scan
  that forgets fails the zero-work check.
- The count showed a real re-read: a quote and a backtick nested past the depth
  limit were scanned again on every repeat. The depth limit now says the closer
  was not found, so the caller reads that tail once.
