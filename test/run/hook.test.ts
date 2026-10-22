// Tests for src/run/hook.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  CLI,
  makeSandbox,
  runChild,
} from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { SECRET } from '../../src/rules/secrets.ts';
import {
  AGENT_STATUS_FILE,
  bumpDoneTries,
  clearDoneTries,
  DONE_TRY_LIMIT,
  doneTryKey,
  doneWhenShell,
  guardDeadline,
  isWorkerType,
  judge,
  readDoneWhen,
  readStopFields,
  runDoneWhen,
  shortenOutput,
  startGuard,
  writeFailingChecks,
} from '../../src/run/hook.ts';

test('hook: blocks with exit 2 and a reason, allows with exit 0', async () => {
  const sandbox = makeSandbox();
  const tool = (tool_input: object) => JSON.stringify({ cwd: sandbox.repo, tool_input });
  const call = (tool_input: object, extra?: Record<string, string>) => sandbox.call(['hook'], { input: tool(tool_input), extra });
  // The entry, on a child (#475): exit 2 with the reason, and exit 0, through the real binary.
  let child = sandbox.run(['hook'], { input: tool({ command: 'git push --tags' }) });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /owner decides when to release/);
  child = sandbox.run(['hook'], { input: tool({ command: 'git status' }) });
  assert.equal(child.status, 0);
  let result = await call({ command: 'git push --tags' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /owner decides when to release/);
  assert.equal((await call({ command: 'git status' })).status, 0);
  // A heredoc body is data, unless a shell reads it (#105).
  assert.equal((await call({ command: "ego-browser nodejs <<'EOF'\nawait page.fill('#q', 'npm publish');\nEOF" })).status, 0);
  assert.equal((await call({ command: 'bash <<EOF\nnpm publish\nEOF' })).status, 2);
  assert.equal((await call({ file_path: join(sandbox.repo, 'AGENTS.md') })).status, 0);
  result = await call({ file_path: join(sandbox.repo, 'AGENTS.md') }, { YOKOTEN_ROLE: 'worker' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  // A worker subagent is a worker even in a lead session.
  result = await sandbox.call(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, agent_type: 'worker', tool_input: { file_path: 'CLAUDE.md' } }) });
  assert.equal(result.status, 2);
  // The user-level guard leaves files to the project.
  result = await sandbox.call(['hook', '--commands-only'], { input: tool({ file_path: 'CLAUDE.md' }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 0);
  assert.equal((await sandbox.call(['hook'], { input: 'not json' })).status, 0);
});

test('hook: a worker edit under .worktrees/<issue>/ reads from that worktree (#571)', () => {
  const sandbox = makeSandbox();
  const options = { root: sandbox.repo, config: DEFAULTS, env: { YOKOTEN_ROLE: 'worker' }, cwd: sandbox.repo };
  assert.equal(judge({ paths: ['.worktrees/571-x/AGENTS.md'], worker: false }, options)?.id, 'lead-only');
  assert.equal(judge({ paths: ['.worktrees/571-x/src/a.ts'], worker: false }, options), null, 'other files pass');
  assert.equal(judge({ paths: ['.worktrees/571-x/AGENTS.md'], worker: false }, { ...options, env: {} }), null, 'the lead passes');
});

// #408: the hook starts the guard's worker before it reads the call, so the two overlap.
test('hook: a guard started before the call judges it as judge does; one never used lets the process end (#408)', async () => {
  const action = { command: 'git push --tags', paths: [], worker: false };
  const options = { root: null, config: DEFAULTS, env: {}, cwd: process.cwd() };
  const guard = startGuard();
  await new Promise((wait) => setTimeout(wait, 50));
  const found = await guard.judge(action, options, 5000);
  assert.equal(found?.id, 'release');
  assert.deepEqual(found, judge(action, options));
  assert.equal(await startGuard().judge({ ...action, command: 'git status' }, options, 5000), null);
  // An unused worker does not keep node running: a hook that ends early just exits. A file,
  // not `-e`: a worker takes node's options, and `--input-type` would change how it starts.
  const sandbox = makeSandbox();
  const script = join(sandbox.home, 'unused-guard.mjs');
  writeFileSync(script, `(await import(${JSON.stringify(new URL('../../src/run/hook.ts', import.meta.url).href)})).startGuard();\n`);
  const result = runChild(process.execPath, [script]);
  assert.deepEqual([result.status, result.signal, result.stderr], [0, null, '']);
});

// The runtimes let a tool call through when the hook runs past their timeout, so a guard
// that reads too long is stopped and the call refused (#274).
test('hook: past the deadline the call is refused, in text and JSON (#274)', async () => {
  const sandbox = makeSandbox();
  const input = JSON.stringify({ cwd: sandbox.repo, tool_input: { command: `npm run build -- ${'--flag value '.repeat(200)}` } });
  const late = { YOKOTEN_GUARD_DEADLINE_MS: '1' };
  let result = await sandbox.call(['hook'], { input, extra: late });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^yokoten: the guard took longer than 1 ms to read this command\. .*Split the command into smaller ones\./);
  result = await sandbox.call(['hook', '--json'], { input, extra: late });
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.blocked, true);
  assert.equal(out.finding.id, 'unreadable-command');
  // The default deadline: a plain command passes, and the guard still blocks.
  const call = (command: string) => sandbox.call(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  assert.equal((await call('ls')).status, 0);
  assert.equal((await call('git push --force origin main')).status, 2);
  assert.equal((await sandbox.call(['hook'], { input, extra: { YOKOTEN_GUARD_DEADLINE_MS: 'soon' } })).status, 0, 'a bad value keeps the default');
  // The setting can never turn the deadline off, nor set a timer Node can't hold.
  for (const [value, ms] of [['', 5000], ['0', 5000], ['-5', 5000], ['0x10', 5000], ['1e9', 5000], ['2.5', 5000], ['Infinity', 5000], ['250', 250], ['90000', 30_000], ['3000000000', 30_000]] as const) {
    assert.equal(guardDeadline(value), ms, `YOKOTEN_GUARD_DEADLINE_MS=${value}`);
  }
});

test('hook: a command the guard reads too slowly is refused within the deadline (#274)', () => {
  const sandbox = makeSandbox();
  // A large command, still being read when a 1 ms deadline passes, however fast the reader:
  // the busy worker is stopped and the hook exits at once, in little memory. The deadline's
  // own message proves it fired; the test reads no clock, which a loaded machine slows (#436).
  const input = JSON.stringify({ cwd: sandbox.repo, tool_input: { command: `find . ${'-exec env '.repeat(30000)}` } });
  // A child, not in-process (#475): the heap limit is node's option, as the hook config runs it.
  const result = runChild('node', ['--max-old-space-size=256', CLI, 'hook'], { cwd: sandbox.repo, env: { ...sandbox.env, YOKOTEN_GUARD_DEADLINE_MS: '1' }, input });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /took longer than 1 ms/);
});

// The Stop event is shaped as Claude Code's hook docs show it (code.claude.com/docs/en/hooks#stop).
test('hook: bad JSON in yokoten.json gives the defaults and one line, and check still fails (#218)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{ "layout": ');
  const call = (command: string) => sandbox.call(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  const line = /^yokoten hook: yokoten\.json was ignored, so the defaults apply; the core checks still run\. yokoten\.json: [^\n]+\n/;
  let result = await call('git push --force');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, line);
  assert.match(result.stderr, /\nyokoten: [^\n]*force/);
  assert.ok(!result.stderr.includes(sandbox.repo), 'no absolute path');
  result = await call('git status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, line);
  assert.equal(result.stderr.split('\n').filter(Boolean).length, 1, 'one line');
  // check and doctor still see a config problem.
  result = await sandbox.call(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /yokoten\.json:/);
});

test('hook: a key with the wrong shape gets its default and one line; check names the key; an unknown key is a note (#228)', async () => {
  const sandbox = makeSandbox();
  // Positive control: before #228, this made the hook crash on an edit (exit 1, guard open).
  sandbox.write('yokoten.json', '{ "leadOnly": "x" }');
  const call = (toolInput: Record<string, string>) => sandbox.call(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: toolInput }), extra: { YOKOTEN_ROLE: 'worker' } });
  const line = /^yokoten hook: yokoten\.json "leadOnly" was ignored, so its default applies; the core checks still run\. yokoten\.json: "leadOnly" must be a list of text, such as [^\n]+\n/;
  for (const toolInput of [{ file_path: 'AGENTS.md' }, { command: 'git push --force' }] as Record<string, string>[]) {
    const result = await call(toolInput);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, line);
    assert.equal(result.stderr.match(/^yokoten hook:/gm)?.length, 1, 'one line');
  }
  let result = await sandbox.call(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check: yokoten\.json: "leadOnly" must be a list of text/);
  // An unknown key is a note, and check passes.
  sandbox.write('yokoten.json', '{ "colour": "blue" }');
  result = await sandbox.call(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten check: note: yokoten\.json: "colour" is not a key this version of yokoten knows/m);
  assert.equal((await call({ command: 'git status' })).stderr, '', 'the hook says nothing');
  // Every wrong key in one run.
  sandbox.write('yokoten.json', '{ "leadOnly": "x", "tests": 5, "notNow": null }');
  result = await sandbox.call(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check: yokoten\.json: 2 keys have the wrong shape:\n- "tests" must be [^\n]+\n- "leadOnly" must be /);
});

test('hook: a repo reached through a symlink gets the same file rules (#1)', async () => {
  const sandbox = makeSandbox();
  const link = join(sandbox.home, 'link');
  symlinkSync(sandbox.repo, link);
  const call = (file_path: string) => sandbox.call(['hook'], { input: JSON.stringify({ cwd: link, tool_input: { file_path } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal((await call(join(link, 'AGENTS.md'))).status, 2, 'absolute path through the link');
  assert.equal((await call('AGENTS.md')).status, 2, 'relative to a cwd through the link');
  assert.equal((await call(join(link, '.github', 'new', 'x.yml'))).status, 2, 'a file in a folder that does not exist yet');
  assert.equal((await call(join(sandbox.home, 'elsewhere.md'))).status, 0, 'outside the repo');
});

test('done-when: the command comes from the env or the git-folder file; a pass, a fail, and the try count (#614)', () => {
  const sandbox = makeSandbox();
  assert.equal(readDoneWhen({}, sandbox.repo), undefined);
  assert.equal(readDoneWhen({ YOKOTEN_DONE_WHEN: '  npm test  ' }, sandbox.repo), 'npm test');
  writeFileSync(join(sandbox.repo, '.git', 'yokoten-done-when'), '# comment\nnode --test\n');
  assert.equal(readDoneWhen({}, sandbox.repo), 'node --test');
  assert.equal(readDoneWhen({ YOKOTEN_DONE_WHEN: 'true' }, sandbox.repo), 'true', 'the env wins');
  assert.equal(doneWhenShell(), process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  // `true` and `echo` are sh. On Windows the command is a node script, below.
  if (process.platform !== 'win32') {
    assert.equal(runDoneWhen('true', sandbox.repo, sandbox.env).ok, true);
    const failed = runDoneWhen('echo fail-out >&2; exit 1', sandbox.repo, sandbox.env);
    assert.equal(failed.ok, false);
    assert.match(failed.output, /fail-out/);
  }
  const token = `${'gh'}p_${'a'.repeat(36)}`;
  assert.equal(shortenOutput(`token: ${token}`).includes(token), false);
  assert.equal(shortenOutput(`token: ${token}`).includes(SECRET), true);
  assert.equal(shortenOutput('a'.repeat(3000)).length <= 2000, true);
  assert.deepEqual(readStopFields({ cwd: '/w', stop_hook_active: true, agent_type: 'Worker', session_id: 's1' }), {
    cwd: '/w',
    active: true,
    worker: true,
    subagent: false,
    sessionId: 's1',
  });
  assert.equal(isWorkerType('worker'), true);
  assert.equal(isWorkerType('Worker'), true);
  assert.equal(isWorkerType('yokoten:worker'), true);
  assert.equal(isWorkerType('coworker'), false);
  assert.equal(isWorkerType('my-worker'), false);
  assert.equal(isWorkerType('worker:extra'), false);
  assert.equal(readStopFields({ hook_event_name: 'SubagentStop', agent_type: 'coworker' }).worker, false);
  assert.equal(readStopFields({ hook_event_name: 'SubagentStop', agent_type: 'coworker' }).subagent, true);
  const key = doneTryKey('task-614', sandbox.repo);
  assert.equal(key, 'task-614');
  assert.equal(doneTryKey('bad id!', sandbox.repo).length, 16);
  assert.equal(bumpDoneTries(sandbox.env, key), 1);
  assert.equal(bumpDoneTries(sandbox.env, key), 2);
  assert.ok(2 < DONE_TRY_LIMIT);
  clearDoneTries(sandbox.env, key);
  assert.equal(bumpDoneTries(sandbox.env, key), 1);
  assert.equal(readFileSync(join(sandbox.home, '.config', 'yokoten', 'done-tries', key), 'utf8').trim(), '1');
  // A count path that is a folder makes rmSync throw. The hook must still end.
  const blocked = 'task-dir';
  mkdirSync(join(sandbox.home, '.config', 'yokoten', 'done-tries', blocked), { recursive: true });
  assert.doesNotThrow(() => clearDoneTries(sandbox.env, blocked));
});

test('writeFailingChecks: keeps the other fields, and sets checks and the UTC time (#614)', () => {
  const sandbox = makeSandbox();
  const path = join(sandbox.repo, AGENT_STATUS_FILE);
  writeFileSync(path, `${JSON.stringify({ name: 'worker-1', role: 'engineer', doing: 'the task' })}\n`);
  writeFailingChecks(sandbox.repo, new Date('2026-10-22T10:00:00.123Z'));
  const status = JSON.parse(readFileSync(path, 'utf8')) as { name: string; role: string; doing: string; checks: string; updated: string };
  assert.equal(status.name, 'worker-1');
  assert.equal(status.role, 'engineer');
  assert.equal(status.doing, 'the task');
  assert.equal(status.checks, 'failing');
  assert.equal(status.updated, '2026-10-22T10:00:00Z');
  writeFileSync(path, 'not json');
  writeFailingChecks(sandbox.repo, new Date('2026-10-22T11:00:00.000Z'));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).checks, 'failing');
  writeFileSync(path, '[]\n');
  writeFailingChecks(sandbox.repo, new Date('2026-10-22T12:00:00.000Z'));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { checks: 'failing', updated: '2026-10-22T12:00:00Z' });
});

// The child ignores SIGHUP and SIGTERM. Only killing its process group stops it before the marker.
test('done-when: a timeout stops the command and the program it started (#614)', { skip: process.platform === 'win32' && 'the kill uses a POSIX process group' }, async () => {
  const sandbox = makeSandbox();
  const marker = join(sandbox.repo, 'child-marker');
  const childPidFile = join(sandbox.repo, 'child-pid');
  const parentPidFile = join(sandbox.repo, 'parent-pid');
  const childScript = join(sandbox.repo, 'child.mjs');
  const parentScript = join(sandbox.repo, 'parent.mjs');
  writeFileSync(childScript, `import { writeFileSync } from 'node:fs';
process.on('SIGHUP', () => {});
process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => writeFileSync(process.argv[3], 'alive'), 30000);
setInterval(() => {}, 1000);
`);
  writeFileSync(parentScript, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
writeFileSync(process.argv[2], String(process.pid));
const child = spawn(process.execPath, [process.argv[3], process.argv[4], process.argv[5]], { stdio: 'ignore' });
child.unref();
setInterval(() => {}, 1000);
`);
  const command = `${process.execPath} ${parentScript} ${parentPidFile} ${childScript} ${childPidFile} ${marker}`;
  let parentPid = 0;
  let childPid = 0;
  try {
    const result = runDoneWhen(command, sandbox.repo, sandbox.env, 8000);
    assert.equal(result.ok, false);
    assert.match(result.output, /ran too long/);
    assert.equal(existsSync(childPidFile), true, 'the child started');
    parentPid = Number(readFileSync(parentPidFile, 'utf8'));
    childPid = Number(readFileSync(childPidFile, 'utf8'));
    const dead = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    };
    const deadline = Date.now() + 2000;
    while ((!dead(childPid) || !dead(parentPid)) && Date.now() < deadline) await delay(50);
    assert.equal(dead(childPid), true, 'the child is still running');
    assert.equal(dead(parentPid), true, 'the parent is still running');
    assert.equal(existsSync(marker), false);
  } finally {
    for (const pid of [childPid, parentPid]) {
      if (!pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
});
