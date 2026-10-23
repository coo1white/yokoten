// The linear-work check the tests share (#754). It is not a test file, so importing it
// registers no tests twice. It lives here, not in test/ (full) or src/ (the package ships src/).
import assert, { AssertionError } from 'node:assert/strict';
import { measureWork } from '../src/rules/message.ts';

/** How far the step count may grow for 8x the input. Linear is about 8x. Quadratic is about 64x. */
const MAX_GROWTH = 12;

/** One read this long, or longer, is a hang. It fails at once. */
const HANG_MS = 30_000;

/** Wall-clock growth at or over this fails, after one retry. */
const SMOKE_GROWTH = 100;

/**
 * Proves `read` does linear work (#754). It counts steps on an input of `size` and on
 * one of 8 times that. More than about 8 times fails. The count does not depend on the
 * runner. A scan that counts nothing fails.
 */
export const assertLinear = (name: string, make: (n: number) => string, read: (input: string) => void, size = 1 << 16): void => {
  const steps = (n: number): number => {
    const input = make(n);
    const count = measureWork(() => read(input));
    assert.ok(count > 0, `${name}: counted no work`);
    return count;
  };
  const base = steps(size);
  const big = steps(8 * size);
  const shown = Math.round(big / base);
  assert.ok(shown <= MAX_GROWTH, `${name}: ${big} steps for 8x the input of ${base} steps, ${shown}x; linear is about 8x`);
};

/** One input shape for assertLinearEach: what assertLinear takes, as one object. */
export type LinearCase = { name: string; make: (n: number) => string; read: (input: string) => void };

/** assertLinear for many shapes. One pass each, at `size` and at 8 times that. */
export const assertLinearEach = (cases: LinearCase[], size: number): void => {
  const failures: string[] = [];
  for (const shape of cases) {
    try {
      assertLinear(shape.name, shape.make, shape.read, size);
    } catch (error) {
      const message = error instanceof AssertionError ? error.message : '';
      if (!message.includes('linear is about 8x') && !message.includes('counted no work')) throw error;
      failures.push(message);
    }
  }
  if (failures.length > 0) assert.fail(failures.join('\n'));
};

/** A clock in ms. The smoke control passes a simulated one. The real smoke passes none. */
type Clock = { now: () => number };

/**
 * One wall-clock check (#754). Growth under 100 times passes. Over that, it measures
 * once more and then fails. One read of 30 seconds or more fails at once, with no retry.
 */
export const assertWallSmoke = (name: string, make: (n: number) => string, read: (input: string) => void, size: number, clock?: Clock): void => {
  const elapsed = (n: number): number => {
    const input = make(n);
    const start = clock ? clock.now() : performance.now();
    read(input);
    const ms = (clock ? clock.now() : performance.now()) - start;
    assert.ok(ms < HANG_MS, `${name}: ${ms.toFixed(0)} ms for ${input.length} chars, a hang`);
    return ms;
  };
  const judge = () => {
    const base = elapsed(size);
    const ms = elapsed(8 * size);
    // A zero base would make the ratio NaN. The floor is only for that division.
    return { base, ms, growth: ms / Math.max(base, 1e-9) };
  };
  const first = judge();
  if (first.growth < SMOKE_GROWTH) return;
  const again = judge();
  const shown = Math.round(again.growth);
  assert.ok(again.growth < SMOKE_GROWTH, `${name}: ${again.ms.toFixed(2)} ms for 8x the input of ${again.base.toFixed(2)} ms, ${shown}x; a 100x blow-up`);
};
