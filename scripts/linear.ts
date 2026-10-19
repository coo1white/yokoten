// The linear-time check the tests share (#315, #316). It is not a test file, so importing it
// registers no tests twice; it lives here, not in test/ (full) or src/ (the package ships src/).
import assert from 'node:assert/strict';

/**
 * Proves `read` takes linear time by how its time grows, not by a wall-clock limit, which
 * fails on a slow runner (#275, #315). It reads an input of `size` and one of 8x that: linear time
 * grows about 8x, quadratic about 64x, so more than 24x fails. Each size takes its fastest read
 * of several: a GC or JIT pause lands on some reads, not all, and a total over many reads grew
 * past 24x on a 4 GB machine from GC alone (#321). 30 s on one read catches a hang.
 */
export const assertLinear = (name: string, make: (n: number) => string, read: (input: string) => void, size = 1 << 16) => {
  const fastest = (input: string, reps: number) => {
    let best = Infinity;
    for (let i = 0; i < reps; i++) {
      const start = performance.now();
      read(input);
      best = Math.min(best, performance.now() - start);
      assert.ok(best < 30_000, `${name}: ${best.toFixed(0)} ms for ${input.length} chars, a hang`);
    }
    return best;
  };
  const small = make(size);
  const big = make(8 * size);
  // Enough reads of the small input to add up to about 20 ms, from 3 to 64.
  const reps = Math.min(64, Math.max(3, Math.ceil(20 / Math.max(fastest(small, 1), 0.01))));
  // Below 0.5 ms a read is not yet in its steady state: cache effects alone showed 27x on a
  // 0.12 ms read (#326). A quadratic read of 8x the size still takes far longer.
  const base = Math.max(0.5, fastest(small, reps));
  const ms = fastest(big, reps);
  assert.ok(ms <= 24 * base, `${name}: ${ms.toFixed(2)} ms for 8x the input of ${base.toFixed(2)} ms, ${(ms / base).toFixed(0)}x; linear is about 8x`);
};
