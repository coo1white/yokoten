// The CI test time (#479): a TAP report says how long a test run took and which tests
// were slow. This module judges that against a budget, with room for a busy runner, and
// says what to do when it is over: shards, in-process calls, one shared fixture, or a
// timing test with room for noise. Every piece of advice names the real files that
// caused it. It reads no process and no network, so a command, doctor and a test can
// use it alike.

import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** One test, by the name the report gives and its time in ms. */
export interface SpeedTest {
  name: string;
  ms: number;
}

/** One test run: its whole time and its tests. Shards are merged before they are judged. */
export interface SpeedReport {
  ms: number;
  tests: SpeedTest[];
}

/** One test file, as advice points at it. */
export interface TestSource {
  path: string;
  text: string;
}

/** What the user can do about a slow suite, and the files that caused it. */
export interface AdviceGroup {
  /** The cause, in a few words. */
  title: string;
  /** The files to open, relative to the repo root. */
  files: string[];
  /** What to do, in plain words. */
  text: string;
}

/** The budget of one CI job or shard, in seconds, on a quiet runner. */
export const SPEED_BUDGET = 180;

/** How much longer the same work may take on a busy runner before the run fails. */
export const LOAD_ROOM = 1.5;

/** How many slow tests or files one view names. */
const NAMED = 5;

/** How many test files to look at, and how much of each: a view must not read the world. */
const MAX_TEST_FILES = 300;
const MAX_TEST_BYTES = 100 * 1024;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/** How many of the slowest tests to match to files: the view names the slow ones anyway. */
const MAX_ATTRIBUTED = 100;

/** Folders that hold no project tests, or hold other tools' files. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.yokoten', 'dist', 'build', 'out', 'coverage', '.tmp', 'vendor']);

/** Whether a file name is one of a test file, for the languages a project may use. */
const isTestFile = (name: string): boolean =>
  /\.(?:test|spec)\.[^.]+$/.test(name) ||
  /(?:_test|_spec)\.(?:go|py|rb|rs|exs?|php|cs|fs|vb|java|kt|swift|lua|c|cc|cpp|h|hpp)$/.test(name) ||
  /^test_.*\.py$/.test(name);

/** The run's duration and each top-level test's, in ms, from a TAP report of node --test. */
export function readTapReport(tap: string): SpeedReport {
  const lines = tap.split('\n');
  const tests: SpeedTest[] = [];
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

/**
 * One report from several shard reports. The shards ran at the same time, so the wait is
 * the slowest one; the tests add up, because the slowest files may be in any shard.
 */
export function mergeReports(reports: SpeedReport[]): SpeedReport {
  return {
    ms: reports.reduce((most, report) => Math.max(most, report.ms), 0),
    tests: reports.flatMap((report) => report.tests),
  };
}

/** Every test file under `root`, relative to it and sorted, up to a cap. */
export function findTestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 10 || found.length >= MAX_TEST_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_TEST_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path, depth + 1);
      } else if (entry.isFile() && isTestFile(entry.name)) {
        found.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

/** The text of each test file, for matching a test's name to its file. */
export function readTestSources(root: string): TestSource[] {
  const sources: TestSource[] = [];
  let totalBytes = 0;
  for (const path of findTestFiles(root)) {
    if (totalBytes >= MAX_SOURCE_BYTES) break;
    try {
      const text = readFileSync(join(root, path), 'utf8');
      if (text.length > MAX_TEST_BYTES) continue;
      sources.push({ path, text });
      totalBytes += text.length;
    } catch {
      // A file that can't be read is no reason to fail the view; its tests are left unnamed.
    }
  }
  return sources;
}

/**
 * The test files that hold each test, by name, with the time of the tests found in each.
 * A test the report names but no file holds is left out: a guess would point at the wrong
 * file. Short names are skipped, because a common word matches too much. Only the slowest
 * tests are matched: a fast test is never the reason the suite is over its budget.
 */
export function testsByFile(tests: SpeedTest[], sources: TestSource[]): { path: string; ms: number; count: number }[] {
  const byFile = new Map<string, { ms: number; count: number }>();
  const slowest = [...tests].sort((a, b) => b.ms - a.ms).slice(0, MAX_ATTRIBUTED);
  for (const test of slowest) {
    if (test.name.length < 6) continue;
    const source = sources.find((candidate) => candidate.text.includes(test.name));
    if (!source) continue;
    const seen = byFile.get(source.path) ?? { ms: 0, count: 0 };
    seen.ms += test.ms;
    seen.count += 1;
    byFile.set(source.path, seen);
  }
  return [...byFile].map(([path, seen]) => ({ path, ...seen })).sort((a, b) => b.ms - a.ms);
}

/** A time in ms as plain words: a few ms, seconds, or minutes and seconds. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

export interface SpeedViewOptions {
  /** The budget of one job or shard, in seconds. */
  budgetSeconds?: number;
  /** The report of an earlier run, to say how the time changed. */
  previous?: SpeedReport;
  /** The project's test files, so a slow test can name its file. */
  sources?: TestSource[];
}

/** What the view says, and whether the run is over its budget. */
export interface SpeedView {
  isOver: boolean;
  lines: string[];
}

/**
 * The test time in plain words: the total against the budget, the slowest tests, the
 * share of the run that the slowest files hold, and the change since the last run when one
 * is given.
 * A run may take LOAD_ROOM more before it fails; the line says which side of the budget
 * it is on either way.
 */
export function speedView(report: SpeedReport, { budgetSeconds = SPEED_BUDGET, previous, sources = [] }: SpeedViewOptions = {}): SpeedView {
  const budgetMs = budgetSeconds * 1000;
  const isOver = report.ms > budgetMs * LOAD_ROOM;
  const room = Math.round((LOAD_ROOM - 1) * 100);
  const took = formatDuration(report.ms);
  const lines: string[] = [];
  if (report.ms > budgetMs) {
    lines.push(`The tests took ${took}, over the budget of ${budgetSeconds} s by ${formatDuration(report.ms - budgetMs)}, ${isOver ? 'past' : 'inside'} the room a busy runner needs (${room}%).`);
  } else {
    lines.push(`The tests took ${took}, under the budget of ${budgetSeconds} s.`);
  }
  const slowest = [...report.tests].sort((a, b) => b.ms - a.ms).slice(0, NAMED);
  if (slowest.length) lines.push('', 'The slowest tests:', ...slowest.map((test) => `- ${formatDuration(test.ms)}: ${test.name}`));
  const files = testsByFile(report.tests, sources);
  if (files.length) {
    const known = files.reduce((sum, file) => sum + file.ms, 0);
    const half: typeof files = [];
    let covered = 0;
    for (const file of files) {
      half.push(file);
      covered += file.ms;
      if (covered >= known / 2) break;
    }
    const named = half.slice(0, NAMED);
    // Only the slowest tests are matched to a file, so the sum is a share of the run, not
    // half of it. A file's tests can run at the same time, so their sum can pass the run
    // itself: a share over 100% is not a number the run can show (#479).
    const shown = named.reduce((sum, file) => sum + file.ms, 0);
    const count = named.length === 1 ? '1 test file holds' : `${named.length} test files hold`;
    const list = named.map((file) => `- ${formatDuration(file.ms)}: ${file.path} (${file.count === 1 ? '1 test' : `${file.count} tests`})`);
    if (shown > report.ms) {
      const which = named.length === 1 ? 'its' : 'their';
      lines.push('', `${count} more test time than the run: ${which} tests add up to ${formatDuration(shown)}, and the run took ${formatDuration(report.ms)} (tests in a file can run at the same time).`, ...list);
    } else {
      const share = report.ms > 0 ? Math.round((shown / report.ms) * 100) : 0;
      lines.push('', `${count} ${share}% of the run:`, ...list);
    }
  }
  if (previous) {
    const change = report.ms - previous.ms;
    const word = Math.abs(change) < 1000 ? 'about the same time as the last run' : `${formatDuration(Math.abs(change))} ${change > 0 ? 'longer' : 'shorter'} than the last run`;
    lines.push('', `Since the last run: ${word} (${formatDuration(previous.ms)}).`);
  }
  return { isOver, lines };
}

/** The files whose text matches `pattern`, in no order, up to a cap. */
const filesMatching = (sources: TestSource[], pattern: RegExp): string[] =>
  sources.filter((source) => pattern.test(source.text)).map((source) => source.path).slice(0, MAX_TEST_FILES);

/** The files that took the most time first: advice opens the ones that caused the slow run. */
function orderFiles(files: string[], slowFiles: string[]): string[] {
  const order = new Map(slowFiles.map((path, index) => [path, index]));
  return [...files].sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
}

/** A shard: a matrix key named `shard`, or a runner flag (`--test-shard`, `--shard`). */
const SHARDS = /--(?:test-)?shard\b|^[ \t]*shard[ \t]*:/m;

/** Workflows that run the tests in one job, with no shard: a matrix of operating systems
 * runs the whole suite on each, so it is not a shard (#479). */
export function workflowsWithoutShards(root: string): string[] {
  const dir = join(root, '.github', 'workflows');
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      let text = '';
      try {
        text = readFileSync(join(dir, name), 'utf8');
      } catch {
        return false;
      }
      const runsTests = /^[ \t]*-?[ \t]*run:.*\b(?:test|pytest|vitest|jest|rspec|phpunit)\b/m.test(text);
      return runsTests && !SHARDS.test(text);
    })
    .map((name) => `.github/workflows/${name}`);
}

/**
 * Advice grouped by what the user can do, each group naming the files that show the
 * cause. No group when nothing matches: doctor and CI stay quiet about a fast suite.
 * `sources` is passed by the caller that already read the test files.
 */
export function speedAdvice(root: string, sources: TestSource[] = readTestSources(root), slowFiles: string[] = []): AdviceGroup[] {
  const groups: AdviceGroup[] = [];
  const names = (pattern: RegExp) => orderFiles(filesMatching(sources, pattern), slowFiles).slice(0, NAMED);
  const child = names(/\b(?:execFileSync|execFile|execSync|spawnSync|spawn|fork)\s*\(/);
  if (child.length) groups.push({ title: 'Tests start a process per call', files: child, text: 'call the code in the test process, and keep one or two real end-to-end tests' });
  const fixtures = names(/\bgit\s+init\b|['"]git['"]\s*,\s*\[[^\]]*['"]init['"]/);
  if (fixtures.length) groups.push({ title: 'The same fixture is built again and again', files: fixtures, text: 'build it once per test process and copy it, instead of making it for each test' });
  const timing = names(/\b(?:performance|Date)\.now\s*\(/).filter((path) => sources.find((source) => source.path === path)?.text.includes('assert'));
  if (timing.length) groups.push({ title: 'Timing tests flake on a busy runner', files: timing, text: 'measure the best of several runs, and leave room for noise, instead of one wall-clock sample' });
  const workflows = workflowsWithoutShards(root);
  if (workflows.length) groups.push({ title: 'One job does everything', files: workflows, text: 'split the tests into shards, and set `fail-fast: false` so one red shard does not cancel the rest' });
  return groups;
}
