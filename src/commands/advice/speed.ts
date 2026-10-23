// `yokoten speed`: the test time, against the project's budget (#479). It reads a TAP
// report from Node's test runner (one file, or a folder with one per shard), shows the
// total, the slowest tests and the test files they are in, and exits 1 when the run
// passes the budget plus the room a busy runner needs. When the run is over, it adds
// advice grouped by cause, each naming real files. CI calls it after the tests; the
// tests job `yokoten init` writes includes it.

import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeReports, readTapReport, readTestSources, SPEED_BUDGET, speedAdvice, speedView, testsByFile, type SpeedReport } from '../../setup/advice/ci-speed.ts';
import { hideHome } from '../../rules/privacy.ts';
import { type Invocation, parse, print, requireRoot, usage } from '../shared.ts';

/** Read one report, or every `.tap` file in a folder, sorted by name. */
function readReports(path: string): SpeedReport[] {
  let isFolder = false;
  try {
    isFolder = statSync(path).isDirectory();
  } catch {
    throw new Error(`${path} is not there.`);
  }
  if (!isFolder) return [readTapReport(readFileSync(path, 'utf8'))];
  const names = readdirSync(path).filter((name) => name.endsWith('.tap')).sort();
  if (!names.length) throw new Error(`no .tap report in ${path}.`);
  return names.map((name) => readTapReport(readFileSync(join(path, name), 'utf8')));
}

/** The view in the GitHub job summary too, when this runs in Actions. */
function writeSummary(invocation: Invocation, lines: string[]): void {
  const file = invocation.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `### Test time\n\n${hideHome(lines.join('\n'), invocation.env)}\n`);
  } catch (err) {
    print(invocation, [`yokoten speed: the job summary was not written: ${((err as Error).message ?? String(err)).split('\n')[0]}`], invocation.stderr);
  }
}

export function runSpeed(invocation: Invocation): number {
  const options = parse('speed', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const budgetText = options.values['--budget'];
  const budgetSeconds = budgetText === undefined ? SPEED_BUDGET : Number(budgetText);
  if (!(budgetSeconds > 0)) return usage(invocation, `--budget needs a number of seconds above 0, not ${budgetText}`);
  const [report] = options.positional;
  if (report === undefined) return usage(invocation, 'give it a TAP report file, or a folder of them');
  const root = requireRoot(invocation, invocation.cwd);
  if (root === null) return 1;
  let reports: SpeedReport[];
  try {
    reports = readReports(resolve(invocation.cwd, report));
  } catch (err) {
    print(invocation, [`yokoten speed: ${(err as Error).message}`], invocation.stderr);
    return 1;
  }
  const merged = mergeReports(reports);
  const sources = readTestSources(root);
  const view = speedView(merged, { budgetSeconds, sources });
  const lines = [...view.lines];
  if (view.isOver) {
    const slowFiles = testsByFile(merged.tests, sources).map((file) => file.path);
    const advice = speedAdvice(root, sources, slowFiles);
    if (advice.length) {
      lines.push('', 'What you can do:');
      for (const group of advice) lines.push('', `- ${group.title}: ${group.text}.`, `  ${group.files.join(', ')}`);
    }
  }
  print(invocation, lines);
  writeSummary(invocation, lines);
  return view.isOver ? 1 : 0;
}
