// The time budget of the hot paths (#408, record 0013). The guard runs before every tool
// call of every agent and doctor at every session start, so users feel each millisecond.
// This runs each hot entry the way its hook runs it, a few times, prints the median (p50),
// p95 and slowest run, and exits 1 when a median or a p95 is over its budget.
//
// It works in a temp folder, with HOME there too: `init` makes a new git repo and its
// vendored copy (.yokoten/). The entries run that copy, as the project hooks do: the agent
// hooks through yokoten.mjs, the git hook through yokoten.ts. The script lowers its own priority first (`nice`), and every run inherits it:
// other work on the machine comes first, and a median holds up to the noise.
//
//   node scripts/bench.ts                   10 runs of each entry, against the budget
//   node scripts/bench.ts --runs 30         more runs
//   node scripts/bench.ts --cli <file>      run another entry (an older checkout, say) for
//                                           every entry, in place of the copy; the budget
//                                           is not checked
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { setPriority, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GUARD_HEAP } from '../src/run/cli.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The budget of each entry, in ms, on a CI Linux runner (record 0013). */
const BUDGET: Record<string, { p50: number; p95: number }> = {
  'guard, Bash': { p50: 100, p95: 200 },
  'guard, Edit': { p50: 100, p95: 200 },
  'session start': { p50: 130, p95: 260 },
  'commit check': { p50: 150, p95: 300 },
};

const { values: options } = parseArgs({ options: { runs: { type: 'string', default: '10' }, cli: { type: 'string' } } });
const runs = Number(options.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs needs a whole number above 0, not ${options.runs}`);

try {
  setPriority(10);
} catch {
  // Not allowed here: run at the usual priority.
}

const base = mkdtempSync(join(tmpdir(), 'yokoten-bench-'));
const home = join(base, 'home');
const repo = join(base, 'repo');
for (const dir of [home, repo]) mkdirSync(dir);
// A clean environment, as in check-package: no real HOME and commit times in UTC. No
// NODE_COMPILE_CACHE: Node would then turn the cache on before the entry, which a hook
// does not do. The compile cache goes where yokoten puts it (bin/yokoten.mjs), here in the
// temp HOME; the first run of each entry fills it, as a user's first call does.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
};

function run(file: string, args: string[], input = ''): { ms: number; status: number | null; output: string } {
  const start = process.hrtime.bigint();
  const result = spawnSync(file, args, { cwd: repo, env, input, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}` };
}

function step(file: string, args: string[]): void {
  const result = run(file, args);
  if (result.status !== 0) throw new Error(`${[file, ...args].join(' ')} failed (exit ${result.status})\n${result.output}`);
}

/** The value at `share` (0.5 for the median) of the sorted times, by nearest rank. */
const rank = (sorted: number[], share: number) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];

let isOver = false;
try {
  step('git', ['init', '-q', '-b', 'main']);
  step('git', ['config', 'user.name', 'bench']);
  step('git', ['config', 'user.email', 'bench@example.com']);
  step(process.execPath, [join(ROOT, 'bin', 'yokoten.ts'), 'init']);
  writeFileSync(join(repo, 'README.md'), '# bench\n\nA project for the time budget.\n');
  step('git', ['add', '-A']);
  step('git', ['commit', '-q', '--no-verify', '-m', 'chore(repo): start']);
  // A staged change for the commit check.
  writeFileSync(join(repo, 'README.md'), '# bench\n\nA project for the time budget, with one more line.\n');
  step('git', ['add', 'README.md']);

  // The agent hooks run yokoten.mjs (#408); the git hook runs yokoten.ts.
  const hookCli = options.cli ? resolve(options.cli) : join(repo, '.yokoten', 'bin', 'yokoten.mjs');
  const cli = options.cli ? resolve(options.cli) : join(repo, '.yokoten', 'bin', 'yokoten.ts');
  const toolCall = (name: string, input: Record<string, string>) => JSON.stringify({ tool_name: name, tool_input: input, cwd: repo, hook_event_name: 'PreToolUse' });
  // Each as its hook runs it: the guard with the heap cap (src/run/cli.ts), the rest plain.
  const entries: { name: string; args: string[]; input?: string }[] = [
    { name: 'guard, Bash', args: [GUARD_HEAP, hookCli, 'hook'], input: toolCall('Bash', { command: 'ls -la' }) },
    { name: 'guard, Edit', args: [GUARD_HEAP, hookCli, 'hook'], input: toolCall('Edit', { file_path: join(repo, 'README.md'), old_string: 'bench', new_string: 'bench!' }) },
    { name: 'session start', args: [hookCli, 'doctor', '--session'] },
    { name: 'commit check', args: [cli, 'check', '--staged'] },
  ];
  const times = new Map(entries.map((entry) => [entry.name, [] as number[]]));
  // One run of each first, to fill the compile cache; then the entries take turns, so a
  // busy moment on the machine lands on all of them alike.
  for (let round = 0; round <= runs; round++) {
    for (const entry of entries) {
      const result = run(process.execPath, entry.args, entry.input);
      if (result.status !== 0) throw new Error(`${entry.name} exited ${result.status}\n${result.output}`);
      if (round > 0) times.get(entry.name)?.push(result.ms);
    }
  }

  const checked = !options.cli;
  process.stdout.write(`yokoten bench: ${runs} runs each, Node ${process.version}, ${process.platform}, ${options.cli ?? 'the copy init wrote'}\n`);
  process.stdout.write(`${'entry'.padEnd(14)} ${'p50'.padStart(6)} ${'p95'.padStart(6)} ${'max'.padStart(6)}   budget p50/p95\n`);
  for (const entry of entries) {
    const sorted = (times.get(entry.name) ?? []).toSorted((a, b) => a - b);
    const [p50, p95, max] = [rank(sorted, 0.5), rank(sorted, 0.95), sorted[sorted.length - 1]];
    const budget = BUDGET[entry.name];
    const over = checked && (p50 > budget.p50 || p95 > budget.p95);
    isOver ||= over;
    const ms = (value: number) => `${value.toFixed(0)}`.padStart(6);
    process.stdout.write(`${entry.name.padEnd(14)} ${ms(p50)} ${ms(p95)} ${ms(max)}   ${budget.p50}/${budget.p95}${over ? '  OVER' : ''}\n`);
  }
  if (isOver) process.stderr.write('yokoten bench: over the budget (record 0013). Find what the slow entry loads or runs: node --cpu-prof\n');
} catch (err) {
  process.stderr.write(`yokoten bench: ${(err as Error).message}\n`);
  isOver = true;
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exitCode = isOver ? 1 : 0;
