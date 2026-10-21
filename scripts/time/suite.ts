// The suite's time budget (#475). The test job writes a TAP copy of node --test's report to
// a file; this reads how long the run took and its slowest tests, adds them to the job
// summary, and exits 1 when the run took longer than the budget.
//
//   node scripts/time/suite.ts <tap file>                against the budget, 180 s
//   node scripts/time/suite.ts <tap file> --budget 90    another budget, in seconds
//
// The budget is for one CI shard: a third of the test files, four at a time. A runner can be
// twice as slow as another, so the budget sits well above the slowest shard seen (about
// 110 s, Node 22): it catches a suite that drifts back to slow, not a slow runner. The stable
// check is the child-process cap in test/repo/architecture.test.ts; this one is the backstop.
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The budget of one CI shard, in seconds. */
export const SUITE_BUDGET = 180;

/** How many of the slowest tests the summary names. */
const SLOWEST = 5;

/** The run's duration and each top-level test's, in ms, from a TAP report of node --test. */
export function readReport(tap: string): { ms: number; tests: { name: string; ms: number }[] } {
  const lines = tap.split('\n');
  const tests: { name: string; ms: number }[] = [];
  let ms: number | undefined;
  lines.forEach((line, index) => {
    const total = /^# duration_ms ([\d.]+)$/.exec(line);
    if (total) ms = Number(total[1]);
    const result = /^(?:not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/.exec(line);
    if (!result || lines[index + 1] !== '  ---') return;
    for (let at = index + 2; at < lines.length && lines[at] !== '  ...'; at++) {
      const own = /^ {2}duration_ms: ([\d.]+)$/.exec(lines[at]);
      if (own) tests.push({ name: result[1].replace(/\\(.)/g, '$1'), ms: Number(own[1]) });
    }
  });
  if (ms === undefined) throw new Error("the report has no '# duration_ms' line: write it with --test-reporter=tap --test-reporter-destination=<file>, and let the run finish");
  return { ms, tests };
}

/** Whether the run in `tap` is over `budget` seconds, and the summary to print. */
export function judgeSuite(tap: string, budget = SUITE_BUDGET): { isOver: boolean; text: string } {
  const { ms, tests } = readReport(tap);
  const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;
  const isOver = ms > budget * 1000;
  const slowest = tests.toSorted((a, b) => b.ms - a.ms).slice(0, SLOWEST);
  const text = [
    isOver
      ? `The tests took ${seconds(ms)}, over the budget of ${budget} s. Find what made them slow: most often a new child process per test (use sandbox.call), or a large stress input.`
      : `The tests took ${seconds(ms)}, under the budget of ${budget} s.`,
    ...(slowest.length ? ['', 'The slowest tests:', ...slowest.map((test) => `- ${seconds(test.ms)}: ${test.name}`)] : []),
  ].join('\n');
  return { isOver, text: `${text}\n` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { budget: { type: 'string', default: String(SUITE_BUDGET) } } });
  const budget = Number(options.budget);
  try {
    if (positionals.length !== 1) throw new Error('give it one file: the TAP report of node --test');
    if (!(budget > 0)) throw new Error(`--budget needs a number of seconds above 0, not ${options.budget}`);
    const { isOver, text } = judgeSuite(readFileSync(positionals[0], 'utf8'), budget);
    process.stdout.write(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Test time\n\n${text}`);
    process.exitCode = isOver ? 1 : 0;
  } catch (err) {
    process.stderr.write(`yokoten suite time: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
