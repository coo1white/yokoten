// Tests for src/host/light.ts and `yokoten test` (#461).

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSandbox } from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { doctor, guardCostCheck, type MachineProbe } from '../../src/setup/doctor.ts';
import { freeMemory, guardLine, isLight, measureRun, parseChildTimes, testCommand, testJobs } from '../../src/host/light.ts';

const GB = 1024 ** 3;

test('light: jobs are at most half the cores and one per GB free, and at least 1 (#461)', () => {
  assert.equal(testJobs(8, 4 * GB), 4);
  assert.equal(testJobs(8, 2.9 * GB), 2, 'one per whole GB');
  assert.equal(testJobs(8, 64 * GB), 4, 'half the cores');
  assert.equal(testJobs(2, 64 * GB), 1);
  assert.equal(testJobs(1, 64 * GB), 1, 'never 0');
  assert.equal(testJobs(16, 0.2 * GB), 1, 'little memory still runs');
});

test('light: free memory is MemAvailable when there is one, else what Node reports (#461)', () => {
  assert.equal(freeMemory(() => 'MemTotal: 4000000 kB\nMemFree: 100 kB\nMemAvailable: 2097152 kB\n'), 2 * GB);
  assert.ok(freeMemory(() => { throw new Error('no /proc'); }) > 0);
  assert.ok(freeMemory(() => 'nothing useful') > 0);
});

test('light: the test command is niced and capped; off, it is Node as it is (#461)', () => {
  const on = { light: true, jobs: 3, hasNice: true };
  assert.deepEqual(testCommand(['a.test.ts'], on), { file: 'nice', args: ['-n', '10', process.execPath, '--test', '--test-concurrency=3', 'a.test.ts'] });
  assert.deepEqual(testCommand([], { ...on, hasNice: false }), { file: process.execPath, args: ['--test', '--test-concurrency=3'] }, 'no nice (Windows): still capped');
  assert.deepEqual(testCommand(['a.test.ts'], { ...on, light: false }), { file: process.execPath, args: ['--test', 'a.test.ts'] });
});

test('light: YOKOTEN_LIGHT_TESTS=0 is the off switch; anything else leaves it on (#461)', () => {
  for (const off of ['0', 'false', 'OFF', ' no ']) assert.equal(isLight({ YOKOTEN_LIGHT_TESTS: off }), false, off);
  for (const on of [undefined, '', '1', 'yes']) assert.equal(isLight({ YOKOTEN_LIGHT_TESTS: on }), true, String(on));
});

test('light: yokoten test --print shows the command and the off switch; --heavy drops the cap (#461)', () => {
  const sandbox = makeSandbox();
  const light = sandbox.run(['test', '--print', '--', 'a.test.ts']);
  assert.equal(light.status, 0, light.stderr);
  assert.match(light.stdout, /^(nice -n 10 )?node --test --test-concurrency=\d+ a\.test\.ts\nlight: \d+ at once/);
  assert.match(light.stdout, /YOKOTEN_LIGHT_TESTS=0/);
  const heavy = sandbox.run(['test', '--print', '--heavy']);
  assert.equal(heavy.stdout, 'node --test\nthe light run is off\n');
  const off = sandbox.run(['test', '--print'], { extra: { YOKOTEN_LIGHT_TESTS: '0' } });
  assert.equal(off.stdout, 'node --test\nthe light run is off\n');
  assert.notEqual(sandbox.run(['test', '--nope']).status, 0, 'an unknown option is refused');
});

test('light: yokoten test runs the tests and returns their exit code (#461)', () => {
  const sandbox = makeSandbox();
  sandbox.write('ok.test.mjs', "import { test } from 'node:test';\ntest('fine', () => {});\n");
  sandbox.write('bad.test.mjs', "import { test } from 'node:test';\ntest('broken', () => { throw new Error('x'); });\n");
  const ok = sandbox.run(['test', '--', 'ok.test.mjs']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(sandbox.run(['test', '--', 'bad.test.mjs']).status, 1);
});

test('guard cost: the shell times line gives user plus system CPU of the child, and nothing else (#461)', () => {
  assert.equal(parseChildTimes('0m0.010s 0m0.020s\n0m0.060s 0m0.030s\n'), 90);
  assert.equal(parseChildTimes('no times here\n'), null);
  assert.equal(parseChildTimes(''), null);
  assert.equal(guardLine({ wallMs: 90.4, cpuMs: 60.2 }), '90 ms per command (60 ms CPU)');
  assert.equal(guardLine({ wallMs: 90.4, cpuMs: null }), '90 ms per command');
});

test('guard cost: a real run is measured in wall time and, off Windows, CPU time (#461)', () => {
  const sandbox = makeSandbox();
  const cost = measureRun([process.execPath, '-e', 'let n = 0; for (let i = 0; i < 3e7; i++) n += i; process.stdout.write(String(n))'], '', { cwd: sandbox.repo, env: sandbox.env });
  assert.ok(cost, 'it ran');
  assert.ok(cost.wallMs > 0);
  if (process.platform !== 'win32') assert.ok(cost.cpuMs !== null && cost.cpuMs > 0, 'the CPU time of the child is there');
  assert.equal(measureRun(['/no/such/program'], '', { cwd: sandbox.repo, env: sandbox.env })?.wallMs === undefined, process.platform === 'win32', 'a program that is not there is not a cost');
});

test('guard cost: full doctor reports it in one line, spawning the guard once; a session does not (#461)', () => {
  const sandbox = makeSandbox();
  const env = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' };
  let runs = 0;
  const machine = {
    readDiskSpace: () => ({ free: 100 * GB, size: 250 * GB }),
    readOwner: () => null,
    runProgram: () => { throw new Error('none'); },
    readText: () => null,
    writeText: () => {},
    uid: 1000,
    now: () => new Date('2026-10-20T08:30:00Z'),
    measureGuard: () => { runs++; return { wallMs: 90.2, cpuMs: 60.4 }; },
  } satisfies MachineProbe;
  const full = doctor(sandbox.repo, { env, config: DEFAULTS, machine });
  assert.ok(full.lines.includes('  ok      guard: 90 ms per command (60 ms CPU)'), full.lines.join('\n'));
  assert.equal(runs, 1);
  doctor(sandbox.repo, { env, config: DEFAULTS, machine, session: true });
  assert.equal(runs, 1, 'a session must start fast: no guard run');
  assert.equal(guardCostCheck(sandbox.repo, { ...machine, measureGuard: () => null }), null, 'a guard that cannot run: no line');
  assert.equal(guardCostCheck(sandbox.repo, { ...machine, measureGuard: undefined }), null, 'a machine that cannot measure: no line');
});
