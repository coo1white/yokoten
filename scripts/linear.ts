// The linear-time check the tests share (#315, #316). It is not a test file, so importing it
// registers no tests twice; it lives here, not in test/ (full) or src/ (the package ships src/).
import assert from 'node:assert/strict';

/**
 * Proves `read` takes linear time by how its time grows, not by a wall-clock limit, which
 * fails on a slow runner (#275, #315). It reads an input of size n and one of 8n: linear time
 * grows about 8x, quadratic about 64x, so more than 24x fails. The small size takes the best of
 * three runs, and the big one gets two more tries, so one pause does not count; 30 s catches a hang.
 */
export const assertLinear = (name: string, make: (n: number) => string, read: (input: string) => void, n = 1 << 16) => {
  const time = (input: string) => {
    const start = performance.now();
    read(input);
    return performance.now() - start;
  };
  const small = make(n);
  const big = make(8 * n);
  // Below 1 ms the timer and the JIT are noise; a quadratic read of 8n still takes far longer.
  const base = Math.max(1, Math.min(time(small), time(small), time(small)));
  let ms = Infinity;
  for (let i = 0; i < 3 && ms > 24 * base; i++) {
    ms = Math.min(ms, time(big));
    assert.ok(ms < 30_000, `${name}: ${ms.toFixed(0)} ms for ${big.length} chars, a hang`);
  }
  assert.ok(ms <= 24 * base, `${name}: ${ms.toFixed(1)} ms for 8x the input of ${base.toFixed(1)} ms, ${(ms / base).toFixed(0)}x; linear is about 8x`);
};
