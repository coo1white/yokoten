// Tests for src/setup/advice/ci-speed.ts: the test time against a budget (#479).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import { findTestFiles, formatDuration, LOAD_ROOM, mergeReports, readTapReport, readTestSources, SPEED_BUDGET, speedAdvice, speedView, testsByFile, workflowsWithoutShards } from '../../../src/setup/advice/ci-speed.ts';

/** A TAP report as Node's test runner writes it, with the tests in the order given. */
const tapReport = (totalMs: number, tests: [string, number][]): string =>
  [
    'TAP version 13',
    ...tests.flatMap(([name, ms], index) => [`# Subtest: ${name}`, `ok ${index + 1} - ${name}`, '  ---', `  duration_ms: ${ms}`, "  type: 'test'", '  ...']),
    `# duration_ms ${totalMs}`,
  ].join('\n');

/** A project with the files given, each path under the new folder. */
const project = (files: Record<string, string>): string => {
  const root = makeTempDir('yokoten-speed-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

test('speed: the report gives the run time and each test, and a cut report is a reason (#479)', () => {
  const tap = tapReport(30_000, [['install: the copy runs', 4200.5], ['names: a # in a name', 0.4], ['check: a slow one', 12_000]]);
  assert.deepEqual(readTapReport(tap), { ms: 30_000, tests: [{ name: 'install: the copy runs', ms: 4200.5 }, { name: 'names: a # in a name', ms: 0.4 }, { name: 'check: a slow one', ms: 12_000 }] });
  assert.throws(() => readTapReport('TAP version 13\nok 1 - cut off\n'), /no '# duration_ms' line/);
});

test('speed: shards ran at once, so the wait is the slowest one and the tests add up (#479)', () => {
  const one = readTapReport(tapReport(20_000, [['a slow test', 19_000]]));
  const two = readTapReport(tapReport(12_000, [['another test', 11_000]]));
  assert.deepEqual(mergeReports([one, two]), { ms: 20_000, tests: [{ name: 'a slow test', ms: 19_000 }, { name: 'another test', ms: 11_000 }] });
});

test('speed: under the budget says so, and names the slowest tests (#479)', () => {
  const report = readTapReport(tapReport(60_000, [['slow one', 40_000], ['quick one', 500], ['middle one', 10_000]]));
  const view = speedView(report, { budgetSeconds: 100 });
  assert.equal(view.isOver, false);
  assert.equal(view.lines[0], 'The tests took 1 min, under the budget of 100 s.');
  const slow = view.lines.slice(view.lines.indexOf('The slowest tests:') + 1, view.lines.indexOf('The slowest tests:') + 3);
  assert.deepEqual(slow, ['- 40.0 s: slow one', '- 10.0 s: middle one']);
});

test('speed: over the budget says by how much, and six equal files name three that take half (#479)', () => {
  const names = ['alpha test one', 'beta test two', 'gamma test three', 'delta test four', 'epsilon test five', 'zeta test six'];
  const sources = names.map((name, index) => ({ path: `test/file-${index}.test.ts`, text: `test('${name}', () => {});` }));
  const report = readTapReport(tapReport(60_000, names.map((name) => [name, 10_000] as [string, number])));
  const view = speedView(report, { budgetSeconds: 10, sources });
  assert.equal(view.isOver, true);
  assert.match(view.lines[0], /^The tests took 1 min, over the budget of 10 s by 50\.0 s, past the room a busy runner needs \(50%\)\.$/);
  assert.ok(view.lines.includes('3 test files take half of the time:'));
  assert.ok(view.lines.includes('- 10.0 s: test/file-0.test.ts (1 test)'));
  assert.deepEqual(testsByFile(report.tests, sources).length, 6);
});

test('speed: the room a busy runner needs is the margin, and a change over it fails (#479)', () => {
  const over = readTapReport(tapReport(SPEED_BUDGET * 1000 * 1.5 + 1, [['a test', 1]]));
  assert.equal(speedView(over).isOver, true);
  const inside = readTapReport(tapReport(SPEED_BUDGET * 1000 * 1.5 - 1, [['a test', 1]]));
  assert.equal(speedView(inside).isOver, false);
  assert.match(speedView(inside).lines[0], /inside the room a busy runner needs/);
  assert.equal(LOAD_ROOM, 1.5);
});

test('speed: a previous report says how the time changed (#479)', () => {
  const report = readTapReport(tapReport(60_000, [['a test', 1]]));
  assert.match(speedView(report, { previous: { ms: 50_000, tests: [] } }).lines.at(-1) ?? '', /^Since the last run: 10\.0 s longer than the last run \(50\.0 s\)\.$/);
  assert.match(speedView(report, { previous: { ms: 60_200, tests: [] } }).lines.at(-1) ?? '', /^Since the last run: about the same time as the last run/);
});

test('speed: advice names the real test files and the workflow that holds one job (#479)', () => {
  const root = project({
    'test/one.test.ts': "test('builds the repo', () => { execFileSync('git', ['init']); });\n",
    'test/two.test.ts': "test('starts node', () => { spawnSync(process.execPath, ['x']); });\n",
    'test/three.test.ts': "test('runs fast', () => { const at = performance.now(); assert.ok(performance.now() - at < 5); });\n",
    'test/four.test.ts': "test('is plain', () => { assert.equal(1, 1); });\n",
    '.github/workflows/ci.yml': 'jobs:\n  tests:\n    steps:\n      - run: npm test\n',
  });
  const groups = speedAdvice(root, undefined, ['test/two.test.ts']);
  const byTitle = new Map(groups.map((group) => [group.title, group]));
  assert.deepEqual(byTitle.get('Tests start a process per call')?.files, ['test/two.test.ts', 'test/one.test.ts'], 'the file that took longer comes first');
  assert.deepEqual(byTitle.get('The same fixture is built again and again')?.files, ['test/one.test.ts']);
  assert.deepEqual(byTitle.get('Timing tests flake on a busy runner')?.files, ['test/three.test.ts']);
  assert.deepEqual(byTitle.get('One job does everything')?.files, ['.github/workflows/ci.yml']);
  assert.match(byTitle.get('One job does everything')?.text ?? '', /fail-fast: false/);
});

test('speed: a workflow with shards is left alone, and a fast project gets no advice (#479)', () => {
  const sharded = project({ '.github/workflows/ci.yml': 'jobs:\n  tests:\n    strategy:\n      matrix:\n        shard: [1, 2, 3]\n    steps:\n      - run: node --test --test-shard=${{ matrix.shard }}/3\n' });
  assert.deepEqual(workflowsWithoutShards(sharded), []);
  const named = project({ '.github/workflows/ci.yml': 'jobs:\n  tests:\n    steps:\n      - run: go test ./...\n' });
  assert.deepEqual(workflowsWithoutShards(named), ['.github/workflows/ci.yml']);
  const clean = project({ 'test/plain.test.ts': "test('is plain', () => { assert.equal(1, 1); });\n" });
  assert.deepEqual(speedAdvice(clean), []);
});

test('speed: test files are found by name, and a time reads in plain words (#479)', () => {
  const root = project({
    'test/one.test.ts': '',
    'src/two.spec.ts': '',
    'pkg/three_test.go': '',
    'tools/test_four.py': '',
    'src/five.ts': '',
    'node_modules/pkg/six.test.ts': '',
  });
  assert.deepEqual(findTestFiles(root), ['pkg/three_test.go', 'src/two.spec.ts', 'test/one.test.ts', 'tools/test_four.py']);
  assert.deepEqual(readTestSources(root).map((source) => source.path), ['pkg/three_test.go', 'src/two.spec.ts', 'test/one.test.ts', 'tools/test_four.py']);
  assert.equal(formatDuration(400), '400 ms');
  assert.equal(formatDuration(4200), '4.2 s');
  assert.equal(formatDuration(365_000), '6 min 5 s');
  assert.equal(formatDuration(120_000), '2 min');
});
