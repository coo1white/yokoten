// Tests for src/commands/advice/speed.ts: `yokoten speed` (#479).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';

const tapReport = (totalMs: number, tests: [string, number][]): string =>
  ['TAP version 13', ...tests.flatMap(([name, ms], index) => [`# Subtest: ${name}`, `ok ${index + 1} - ${name}`, '  ---', `  duration_ms: ${ms}`, "  type: 'test'", '  ...']), `# duration_ms ${totalMs}`, ''].join('\n');

test('speed: under the budget exits 0 and says so (#479)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('tests.tap', tapReport(60_000, [['rounds each line', 40_000], ['keeps order', 10_000]]));
  sandbox.write('test/cart.test.ts', "test('rounds each line', () => {});\ntest('keeps order', () => {});\n");
  const result = await sandbox.call(['speed', 'tests.tap', '--budget', '100']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^The tests took 1 min, under the budget of 100 s\./);
  assert.match(result.stdout, /The slowest tests:\n- 40\.0 s: rounds each line/);
  assert.match(result.stdout, /1 test file holds 83% of the run:[\s\S]*test\/cart\.test\.ts \(2 tests\)/);
  assert.doesNotMatch(result.stdout, /What you can do:/, 'a fast run gets no advice');
});

test('speed: over the budget exits 1 and advice names the real file (#479)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('tests.tap', tapReport(40_000, [['builds the repo again', 39_000]]));
  sandbox.write('test/setup.test.ts', "test('builds the repo again', () => { execFileSync('git', ['init']); });\n");
  sandbox.write('.github/workflows/ci.yml', 'jobs:\n  tests:\n    steps:\n      - run: npm test\n');
  const result = await sandbox.call(['speed', 'tests.tap', '--budget', '10']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /past the room a busy runner needs \(50%\)/);
  assert.match(result.stdout, /What you can do:/);
  assert.match(result.stdout, /The same fixture is built again and again: build it once per test process and copy it, instead of making it for each test\.\n {2}test\/setup\.test\.ts/);
  assert.match(result.stdout, /One job does everything: split the tests into shards, and set `fail-fast: false`[\s\S]*\.github\/workflows\/ci\.yml/);
});

test('speed: a folder of shard reports is judged by the slowest shard (#479)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('reports/one.tap', tapReport(20_000, [['first test', 19_000]]));
  sandbox.write('reports/two.tap', tapReport(10_000, [['second test', 9_000]]));
  const result = await sandbox.call(['speed', 'reports', '--budget', '30']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^The tests took 20\.0 s, under the budget of 30 s\./);
  assert.match(result.stdout, /The slowest tests:\n- 19\.0 s: first test\n- 9\.0 s: second test/);
});

test('speed: a missing report, an empty folder and a bad budget are reasons, not crashes (#479)', async () => {
  const sandbox = makeSandbox();
  const missing = await sandbox.call(['speed', 'missing.tap']);
  assert.deepEqual([missing.status, missing.stdout], [1, '']);
  assert.match(missing.stderr, /^yokoten speed: .*missing\.tap is not there\./);
  sandbox.write('reports/readme.txt', 'no report here\n');
  const empty = await sandbox.call(['speed', 'reports']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no \.tap report in .*reports/);
  const budget = await sandbox.call(['speed', 'tests.tap', '--budget', '0']);
  assert.equal(budget.status, 1);
  assert.match(budget.stderr, /--budget needs a number of seconds above 0, not 0/);
  const none = await sandbox.call(['speed']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /give it a TAP report file, or a folder of them/);
});

test('speed: in Actions the view goes into the job summary (#479)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('tests.tap', tapReport(10_000, [['a quick test', 1_000]]));
  const summary = join(sandbox.repo, 'summary.md');
  const result = await sandbox.call(['speed', 'tests.tap', '--budget', '100'], { extra: { GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(summary, 'utf8'), /^### Test time\n\nThe tests took 10\.0 s, under the budget of 100 s\./);
});

// The entry, once, as a person runs it: the rest of this file calls the command in-process (#475).
test('speed: the command runs through the entry, and exits 1 over the budget (#479)', () => {
  const sandbox = makeSandbox();
  sandbox.write('tests.tap', tapReport(40_000, [['a slow test', 39_000]]));
  const result = sandbox.run(['speed', 'tests.tap', '--budget', '10']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^The tests took 40\.0 s, over the budget of 10 s by 30\.0 s/);
});
