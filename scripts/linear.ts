// The linear-time check the tests share (#315, #316). It is not a test file, so importing it
// registers no tests twice; it lives here, not in test/ (full) or src/ (the package ships src/).
import assert from 'node:assert/strict';

/** How much the time may grow for 8x the input: linear is about 8x, quadratic about 64x. */
const MAX_GROWTH = 24;

/** The least time the small read of a shape takes, so that a pause of a few ms is not read as growth (#474). */
const MIN_BASE_MS = 20;

/**
 * Proves `read` takes linear time by how its time grows, not by a wall-clock limit, which
 * fails on a slow runner (#275, #315). It reads an input of `size` and one of 8x that: linear time
 * grows about 8x, quadratic about 64x, so more than 24x fails. Each size takes its fastest read
 * of several: a GC or JIT pause lands on some reads, not all (#321). The two sizes take turns,
 * so a runner that slows down for a while slows both, not only the big one (#343). Over the
 * limit, it measures again and fails only when that round is over too: a quadratic read is over
 * every time, a noisy runner is not. 30 s on one read catches a hang.
 */
// The clock is there for the controls, which pass a simulated one; the real checks pass none.
export const assertLinear = (name: string, make: (n: number) => string, read: (input: string) => void, size = 1 << 16, clock: { now: () => number } = performance) => {
  const time = (input: string) => {
    const start = clock.now();
    read(input);
    const ms = clock.now() - start;
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

/** One input shape for assertLinearEach: what assertLinear takes, as one object. */
export type LinearCase = { name: string; make: (n: number) => string; read: (input: string) => void };

/**
 * assertLinear for many shapes at once, at a fraction of the cost (#442). assertLinear gives
 * each shape about 20 ms of small reads, and as many big ones: some 200 ms a shape, however
 * small the input, so 180 shapes took minutes. Here the shapes take turns instead: each round
 * reads every shape small, then big, and two rounds keep each shape's fastest read (three in the second round below). A pause
 * or a slow spell lands on one read of one shape, not on both of it. Each shape is read
 * once first, cold, and that read is not timed. `size` is where each shape starts, and the first
 * round reads it as it is: cheap, and a linear shape passes there. A shape over 24x goes to a
 * second round (#474): at a base of 4 ms, one pause of 100 ms read as 32x on a busy runner. The
 * shape is grown by 2x to 4x a step, up to 64x `size`, until its small read takes MIN_BASE_MS;
 * from 20 ms, a fastest-of-3 read is steady, and a limit of 24 has room for the rest (linear 8x,
 * quadratic 64x). It fails only when it is over 24x there too. The growth stops early when a step
 * costs far more than its size, so a quadratic read is not grown into minutes. The few shapes in
 * the second round pay for it; the many that pass do not (see the controls in
 * test/repo/architecture.test.ts).
 */
// The clock is there for the controls, which pass a simulated one; the real checks pass none.
export const assertLinearEach = (cases: LinearCase[], size: number, baseMs = MIN_BASE_MS, clock: { now: () => number } = performance) => {
  const time = (shape: LinearCase, input: string) => {
    const start = clock.now();
    shape.read(input);
    const ms = clock.now() - start;
    assert.ok(ms < 30_000, `${shape.name}: ${ms.toFixed(0)} ms for ${input.length} chars, a hang`);
    return ms;
  };
  const prepare = (shape: LinearCase, n: number) => ({ shape, n, small: shape.make(n), big: shape.make(8 * n) });
  type Prepared = ReturnType<typeof prepare>;
  const shapes = cases.map((shape) => prepare(shape, size));
  for (const { shape, small } of shapes) time(shape, small);
  // The second round: grow the shape until its small read takes MIN_BASE_MS. The fastest of 2 reads
  // steps it, so one pause does not stop it early.
  const grow = ({ shape, n, small }: Prepared): Prepared => {
    let last = Math.min(time(shape, small), time(shape, small));
    while (last < baseMs && n < 64 * size) {
      const step = Math.min(4, Math.max(2, Math.ceil((1.25 * baseMs) / Math.max(last, 0.05))));
      n = Math.min(n * step, 64 * size);
      small = shape.make(n);
      const now = Math.min(time(shape, small), time(shape, small));
      // A read that costs far more than its size is not linear: stop growing, the measure fails it.
      const superlinear = last >= 2 && now > 2 * step * last;
      last = now;
      if (superlinear) break;
    }
    return prepare(shape, n);
  };
  const measure = (list: Prepared[], rounds: number) => {
    const fast = list.map(() => ({ small: Infinity, big: Infinity }));
    for (let round = 0; round < rounds; round++) {
      list.forEach(({ shape, small, big }, i) => {
        fast[i].small = Math.min(fast[i].small, time(shape, small));
        fast[i].big = Math.min(fast[i].big, time(shape, big));
      });
    }
    // The same floor as assertLinear: below 0.5 ms a read is not in its steady state (#326).
    return list.map((entry, i) => ({ entry, base: Math.max(0.5, fast[i].small), ms: fast[i].big, growth: fast[i].big / Math.max(0.5, fast[i].small) }));
  };
  const over = measure(shapes, 2).filter((result) => result.growth > MAX_GROWTH);
  if (over.length === 0) return;
  const still = measure(over.map((result) => grow(result.entry)), 3).filter((result) => result.growth > MAX_GROWTH);
  if (still.length === 0) return;
  assert.fail(still.map(({ entry, base, ms, growth }) => `${entry.shape.name}: ${ms.toFixed(2)} ms for 8x the input of ${base.toFixed(2)} ms, ${growth.toFixed(0)}x; linear is about 8x`).join('\n'));
};
