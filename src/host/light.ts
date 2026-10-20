// Keep tests and the guard light on a shared machine (#461). Workers run test suites for
// hours; on a small box, five of them at once keep the load above the core count and starve
// everything else. `yokoten test` runs the tests niced and with a capped concurrency, and
// doctor reports what the guard costs per call. Safe by default (record 0014): on, with
// YOKOTEN_LIGHT_TESTS=0 or `yokoten test --heavy` as the off switch.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { availableParallelism, freemem } from 'node:os';
import { delimiter, join } from 'node:path';

const GB = 1024 ** 3;

/** The nice level a light run takes: below every normal process, above idle. */
export const NICE_LEVEL = 10;

/** The environment variable that turns the light run off. */
export const OFF_SWITCH = 'YOKOTEN_LIGHT_TESTS';

/**
 * How many test files to run at once: at most half the cores, at most one per GB of free
 * memory, and at least 1.
 */
export function testJobs(cores: number, freeBytes: number): number {
  return Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(freeBytes / GB)));
}

/** The memory a new process can use: MemAvailable on Linux (MemFree leaves out the cache), else what Node reports. */
export function freeMemory(readMeminfo: () => string = () => readFileSync('/proc/meminfo', 'utf8')): number {
  try {
    const kb = /^MemAvailable:\s+(\d+) kB/m.exec(readMeminfo())?.[1];
    if (kb) return Number(kb) * 1024;
  } catch {
    // Not Linux: use what Node knows.
  }
  return freemem();
}

/** Whether the light run is on: it is, unless YOKOTEN_LIGHT_TESTS is 0, false, off or no. */
export const isLight = (env: Record<string, string | undefined>): boolean => !['0', 'false', 'off', 'no'].includes((env[OFF_SWITCH] ?? '').trim().toLowerCase());

/** Whether an executable called `name` is on PATH. */
export function onPath(name: string, env: Record<string, string | undefined>): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/**
 * The command that runs the tests: Node's test runner on `words` (files, or other runner
 * options), with the concurrency capped and `nice` in front where it exists (not on
 * Windows). Light off: the runner as it is, with Node's own default.
 */
export function testCommand(words: string[], { light, jobs, hasNice }: { light: boolean; jobs: number; hasNice: boolean }): { file: string; args: string[] } {
  if (!light) return { file: process.execPath, args: ['--test', ...words] };
  const runner = ['--test', `--test-concurrency=${jobs}`, ...words];
  return hasNice ? { file: 'nice', args: ['-n', String(NICE_LEVEL), process.execPath, ...runner] } : { file: process.execPath, args: runner };
}

/** What one guard call cost: wall time, and CPU time (user plus system) when the system tells. */
export interface GuardCost {
  wallMs: number;
  cpuMs: number | null;
}

/** The plain line doctor shows. */
export const guardLine = (cost: GuardCost): string =>
  `${Math.round(cost.wallMs)} ms per command${cost.cpuMs === null ? '' : ` (${Math.round(cost.cpuMs)} ms CPU)`}`;

/** Reads the children line of POSIX `times` ("0m0.012s 0m0.008s"): user plus system, in ms. Null when it is not there. */
export function parseChildTimes(text: string): number | null {
  const last = text.trim().split('\n').at(-1) ?? '';
  const parts = [...last.matchAll(/(\d+)m([\d.]+)s/g)];
  if (parts.length !== 2) return null;
  return parts.reduce((sum, [, minutes, seconds]) => sum + (Number(minutes) * 60 + Number(seconds)) * 1000, 0);
}

/**
 * Runs `argv` once with `input` on stdin, as a guard hook would, and measures it. The CPU
 * comes from the shell's `times` for its waited-for child: no other portable way to see a
 * child's CPU from Node. Windows has no such shell; there the wall time stands alone.
 * Null when the program can't run.
 */
export function measureRun(argv: string[], input: string, options: { cwd: string; env: Record<string, string | undefined> }): GuardCost | null {
  const start = process.hrtime.bigint();
  const isPosix = process.platform !== 'win32';
  const result = isPosix
    ? spawnSync('sh', ['-c', '"$@" >/dev/null 2>&1; times', 'sh', ...argv], { ...options, input, encoding: 'utf8', timeout: 10_000 })
    : spawnSync(argv[0], argv.slice(1), { ...options, input, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  if (result.error || result.status === null) return null;
  return { wallMs, cpuMs: isPosix ? parseChildTimes(result.stdout ?? '') : null };
}

/** The cores Node may use. */
export const cores = (): number => availableParallelism();
