// The linear-time check the tests share (#315, #316). It is not a test file, so importing it
// registers no tests twice; it lives here, not in test/ (full) or src/ (the package ships src/).
import assert from 'node:assert/strict';

/** How much the time may grow for 8x the input: linear is about 8x, quadratic about 64x. */
const MAX_GROWTH = 24;

/**
 * Proves `read` takes linear time by how its time grows, not by a wall-clock limit, which
 * fails on a slow runner (#275, #315). It reads an input of `size` and one of 8x that: linear time
 * grows about 8x, quadratic about 64x, so more than 24x fails. Each size takes its fastest read
 * of several: a GC or JIT pause lands on some reads, not all (#321). The two sizes take turns,
 * so a runner that slows down for a while slows both, not only the big one (#343). Over the
 * limit, it measures again and fails only when that round is over too: a quadratic read is over
 * every time, a noisy runner is not. 30 s on one read catches a hang.
 */
export const assertLinear = (name: string, make: (n: number) => string, read: (input: string) => void, size = 1 << 16) => {
  const time = (input: string) => {
    const start = performance.now();
    read(input);
    const ms = performance.now() - start;
    assert.ok(ms < 30_000, `${name}: ${ms.toFixed(0)} ms for ${input.length} chars, a hang`);
    return ms;
  };
  const small = make(size);
  const big = make(8 * size);
  // Enough reads of the small input to add up to about 20 ms, from 3 to 64. The fastest of
  // 3 reads sets it: the first read is cold, and a busy runner slows any one read (#359).
  const calibrate = Math.min(time(small), time(small), time(small));
  const reps = Math.min(64, Math.max(3, Math.ceil(20 / Math.max(calibrate, 0.01))));
  const measure = () => {
    let fastSmall = Infinity;
    let fastBig = Infinity;
    for (let i = 0; i < reps; i++) {
      fastSmall = Math.min(fastSmall, time(small));
      fastBig = Math.min(fastBig, time(big));
    }
    // Below 0.5 ms a read is not yet in its steady state: cache effects alone showed 27x on a
    // 0.12 ms read (#326). A quadratic read of 8x the size still takes far longer.
    const base = Math.max(0.5, fastSmall);
    return { base, ms: fastBig, growth: fastBig / base };
  };
  const first = measure();
  if (first.growth <= MAX_GROWTH) return;
  const again = measure();
  assert.ok(
    again.growth <= MAX_GROWTH,
    `${name}: ${again.ms.toFixed(2)} ms for 8x the input of ${again.base.toFixed(2)} ms, ${again.growth.toFixed(0)}x (first round ${first.growth.toFixed(0)}x); linear is about 8x`,
  );
};
