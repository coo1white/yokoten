// Tests for src/commands/advice/machine.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir, runChild } from '../../repo/helpers.ts';
import {
  addMachine,
  fetchMachineCommits,
  findMachine,
  isPublicRepoUrl,
  machineBranch,
  machineCloneDir,
  machineStartScript,
  machinesFile,
  probeMachines,
  readLoad,
  readMachines,
  removeMachine,
  startMachineTask,
  type Machine,
  type MachineRunner,
} from '../../../src/commands/advice/machine.ts';

const clockRunner = (stdout: string, code = 0): MachineRunner => () => ({ code, stdout, stderr: '' });

test('machine: add writes a private file, shows no target, and refuses a duplicate or an unknown machine', () => {
  const sandbox = makeSandbox();
  const folder = makeTempDir('second-machine-');
  const added = addMachine(sandbox.env, 'wsl', { folder, nice: 5, maxAgents: 2, memoryMb: 512 });
  assert.equal(typeof added, 'object', 'the machine is added');
  assert.equal((added as Machine).name, 'wsl');
  const file = machinesFile(sandbox.env);
  assert.ok(file, 'a home folder has a machines file');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the target stays private');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /"wsl"/);
  assert.match(text, /"target"/, 'the target is kept in the file, never in output');
  assert.match(addMachine(sandbox.env, 'wsl', { folder }) as string, /already added/);
  assert.match(addMachine(sandbox.env, 'Bad Name', { folder }) as string, /machine name/);
  assert.match(findMachine(sandbox.env, 'mac') as string, /no machine called mac/);
  assert.match(removeMachine(sandbox.env, 'mac'), /no machine called mac/);
  assert.equal(readMachines(sandbox.env).length, 1);
  assert.equal(removeMachine(sandbox.env, 'wsl'), 'removed wsl');
  assert.deepEqual(readMachines(sandbox.env), []);
});

test('machine: only a public repo URL is cloned; a name or token in it is refused', () => {
  assert.equal(isPublicRepoUrl('https://example.com/acme/repo.git'), true);
  assert.equal(isPublicRepoUrl('git@example.com:acme/repo.git'), true);
  assert.equal(isPublicRepoUrl('https://a-user:a-token@example.com/acme/repo.git'), false);
  assert.equal(isPublicRepoUrl('https://user@example.com/acme/repo.git'), false);
  assert.equal(isPublicRepoUrl('file:///tmp/repo'), false);
});

test('machine: reach and load come from uptime, and a machine that is down says so', () => {
  const sandbox = makeSandbox();
  addMachine(sandbox.env, 'wsl', { folder: makeTempDir('second-machine-') });
  addMachine(sandbox.env, 'mac', { folder: makeTempDir('second-machine-') });
  const runner: MachineRunner = (machine) => machine.name === 'wsl'
    ? { code: 0, stdout: 'load average: 0.10, 0.20, 0.30\n', stderr: '' }
    : { code: null, stdout: '', stderr: '' };
  assert.deepEqual(probeMachines(sandbox.env, runner), [
    { name: 'mac', isReachable: false, load: '' },
    { name: 'wsl', isReachable: true, load: '0.10 0.20 0.30' },
  ]);
  assert.equal(readLoad('10:00 up 1 day, load averages: 1,23 2,34 3,45'), '1,23 2,34 3,45');
  assert.equal(readLoad('no load here'), '');
});

test('machine: start checks the sign-in first, then clones, then runs the desk under nice with a cap', () => {
  const sandbox = makeSandbox();
  const folder = makeTempDir('second-machine-');
  const machine = addMachine(sandbox.env, 'wsl', { folder, nice: 7, maxAgents: 2, memoryMb: 512 }) as Machine;
  const scripts: string[] = [];
  const runner: MachineRunner = (_, script) => {
    scripts.push(script);
    return { code: 0, stdout: 'started 4242\n', stderr: '' };
  };
  const started = startMachineTask(machine, { issue: '603', vendor: 'claude-code', model: 'model-a', repoUrl: 'https://example.com/acme/repo.git' }, runner);
  assert.deepEqual(started, { name: 'wsl', issue: '603', branch: '603-machine', pid: 4242 });
  const script = scripts[0];
  assert.match(script, /nice -n 7/);
  assert.match(script, /ulimit -v 524288/, '512 MB is a 512 * 1024 KB cap');
  assert.match(script, /'yokoten' 'desk' 'claude-code'/);
  assert.match(script, /git clone --depth 1/);
  assert.ok(script.indexOf('.claude') < script.indexOf('git clone'), 'no sign-in means no clone');
  assert.equal(machineCloneDir(machine, '603'), join(folder, 'issue-603'));
  assert.equal(machineBranch('603'), '603-machine');
  assert.equal(machineStartScript(machine, { issue: '603', vendor: 'claude-code', model: 'm', repoUrl: 'https://example.com/a/b' }, ['claude', '-p', 'hi']).includes('git checkout -B'), true);
});

test('machine: a missing sign-in copies nothing; an unknown vendor and a private URL are refused', () => {
  const sandbox = makeSandbox();
  const machine = addMachine(sandbox.env, 'wsl', { folder: makeTempDir('second-machine-') }) as Machine;
  const refused = startMachineTask(machine, { issue: '603', vendor: 'claude-code', model: 'm', repoUrl: 'https://example.com/a/b' }, clockRunner('', 4));
  assert.match(refused as string, /no claude-code sign-in on wsl/);
  assert.match(refused as string, /Nothing was copied to it/);
  assert.match(startMachineTask(machine, { issue: '603', vendor: 'antigravity', model: 'm', repoUrl: 'https://example.com/a/b' }, clockRunner('')) as string, /in a desk/);
  assert.match(startMachineTask(machine, { issue: '603', vendor: 'claude-code', model: 'm', repoUrl: 'https://user:token@example.com/a/b' }, clockRunner('')) as string, /public repo/);
  assert.match(startMachineTask(machine, { issue: 'x', vendor: 'claude-code', model: 'm', repoUrl: 'https://example.com/a/b' }, clockRunner('')) as string, /number/);
});

test('machine: fetch brings a second folder\'s commits into the lead\'s repo, and an unknown machine is refused', () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, 'README.md'), 'the start\n');
  sandbox.git('add', 'README.md');
  assert.equal(sandbox.git('commit', '-q', '-m', 'start').status, 0);
  const folder = makeTempDir('second-machine-');
  const clone = join(folder, 'issue-12');
  const cloned = runChild('git', ['clone', '-q', sandbox.repo, clone], { cwd: folder, env: sandbox.env });
  assert.equal(cloned.status, 0, cloned.stderr);
  runChild('git', ['config', 'user.name', 'Test'], { cwd: clone, env: sandbox.env });
  runChild('git', ['config', 'user.email', 'test@example.com'], { cwd: clone, env: sandbox.env });
  runChild('git', ['checkout', '-B', '12-machine'], { cwd: clone, env: sandbox.env });
  writeFileSync(join(clone, 'work.txt'), 'work from the second machine\n');
  runChild('git', ['add', 'work.txt'], { cwd: clone, env: sandbox.env });
  const committed = runChild('git', ['commit', '-q', '-m', 'from the second machine'], { cwd: clone, env: sandbox.env });
  assert.equal(committed.status, 0, committed.stderr);
  const want = runChild('git', ['rev-parse', 'HEAD'], { cwd: clone, env: sandbox.env }).stdout.trim();
  addMachine(sandbox.env, 'wsl', { folder });
  const machine = findMachine(sandbox.env, 'wsl') as Machine;
  assert.equal(fetchMachineCommits(sandbox.repo, machine, '12', sandbox.env), 'fetched 12-machine from wsl into refs/remotes/machine/wsl/12-machine');
  const got = runChild('git', ['rev-parse', 'refs/remotes/machine/wsl/12-machine'], { cwd: sandbox.repo, env: sandbox.env }).stdout.trim();
  assert.equal(got, want);
  assert.match(findMachine(sandbox.env, 'mac') as string, /no machine called mac/);
  assert.match(fetchMachineCommits(sandbox.repo, machine, '99', sandbox.env), /could not fetch issue #99 from wsl/);
});

test('machine: the command adds, lists without the target, starts, fetches and refuses an unknown machine', async () => {
  const sandbox = makeSandbox();
  const folder = makeTempDir('second-machine-');
  const added = await sandbox.call(['machine', 'add', 'wsl', '--folder', folder, '--nice', '5']);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /added wsl/);
  assert.ok(!added.stdout.includes(folder), 'the folder is not printed');
  const listed = await sandbox.call(['machine', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(!listed.stdout.includes(folder), 'the target is not in JSON');
  const statuses = JSON.parse(listed.stdout).machines;
  assert.equal(statuses[0].name, 'wsl');
  assert.equal(statuses[0].isReachable, true);
  const unknown = await sandbox.call(['machine', 'start', 'mac', '603', '--vendor', 'claude-code', '--model', 'model-a']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no machine called mac/);
  const deskRefused = await sandbox.call(['machine', 'start', 'wsl', '603', '--vendor', 'antigravity', '--model', 'model-a']);
  assert.equal(deskRefused.status, 1);
  assert.match(deskRefused.stderr, /in a desk/);
  const badFetch = await sandbox.call(['machine', 'fetch', 'mac', '603']);
  assert.equal(badFetch.status, 1);
  assert.match(badFetch.stderr, /no machine called mac/);
});
