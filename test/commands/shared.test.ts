// Tests for src/commands/shared.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  at,
  makeSandbox,
} from '../repo/helpers.ts';
import { invoke } from '../repo/invoke.ts';
import { canColour, isColourTerminal, paint, styleLine, styleText, type Invocation } from '../../src/commands/shared.ts';
import type { Env } from '../../src/rules/config.ts';

test('outside a git repo: every command that needs one says so plainly, exits 1 and writes nothing (#205)', async () => {
  const sandbox = makeSandbox();
  // Inside the sandbox home, so the folder shows as ~.
  const away = join(sandbox.home, 'away');
  mkdirSync(away);
  const said = (command: string) => new RegExp(`^yokoten ${command}: ~/away is not inside a git repo\\. The checks read commits, so yokoten needs git history\\. Run it inside your project, or \`git init\` first\\.\\n  docs: \\S+#commands\\n$`);
  const runs: [string[], string, Record<string, string>?][] = [
    [['doctor'], 'doctor'],
    [['check'], 'check'],
    [['check', '--staged'], 'check'],
    [['check', '--history'], 'check'],
    [['check', '--pr'], 'check'],
    [['check', '--issue'], 'check'],
    [['adopt'], 'adopt'],
    [['update'], 'update'],
    [['update', '--write'], 'update'],
    [['init'], 'init'],
    [['init', '--github', '--yes'], 'init'],
    [['bot', '--', 'gh', 'issue', 'list'], 'bot', { YOKOTEN_BOT_APP_ID: '1' }],
  ];
  for (const [args, command, extra] of runs) {
    const result = await sandbox.call(args, { cwd: away, extra });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '', `${args.join(' ')}: nothing on stdout`);
    assert.match(result.stderr, said(command), args.join(' '));
    assert.deepEqual(readdirSync(away), [], `${args.join(' ')}: nothing written`);
  }
  // --json: the same finding, as data.
  for (const args of [['check', '--json'], ['doctor', '--json']]) {
    const result = await sandbox.call(args, { cwd: away });
    assert.equal(result.status, 1, args.join(' '));
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, false);
    const found = out.findings.find((f: { id: string }) => f.id === 'not-a-repo');
    assert.equal(found?.what, '~/away is not inside a git repo', args.join(' '));
  }
  // init in a folder that does not exist creates nothing: a typo never becomes a project.
  const result = await sandbox.call(['init', 'typo'], { cwd: away });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'yokoten init: typo does not exist; nothing was written. Create it and run `git init` there first.\n');
  assert.deepEqual(readdirSync(away), [], 'no folder made');
  // A session in a non-repo folder gets no noise, and starts.
  const session = await sandbox.call(['doctor', '--session'], { cwd: away });
  assert.deepEqual([session.status, session.stdout, session.stderr], [0, '', '']);
  // changelog reads changes/ only, and needs no git.
  assert.equal((await sandbox.call(['changelog'], { cwd: away })).status, 0);
});

test('git not installed: a command that needs a repo says git is missing, not "not a repo" (#205)', async () => {
  const sandbox = makeSandbox();
  // Only node on the PATH.
  const noGit = join(sandbox.home, 'no-git');
  mkdirSync(noGit);
  symlinkSync(process.execPath, join(noGit, 'node'));
  for (const command of ['check', 'doctor']) {
    const result = await sandbox.call([command], { extra: { PATH: noGit } });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, new RegExp(`^yokoten ${command}: git is not installed \\(or not on PATH\\); yokoten needs git\\. `), command);
  }
});

test('--json: check, doctor, hook and explain print pure JSON with what, why and fix; never a private value (#42)', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks, YOKOTEN_ROLE: 'worker' };
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.write('notes/a.md', `me${at}gmail.com\nI live in MyCity\n${token}\nserver ${[10, 1, 2, 3].join('.')}\n`);
  sandbox.write('dist/app.js', 'x\n');
  for (let i = 0; i < 8; i++) sandbox.write(`many/${i}.md`, 'x\n');
  sandbox.git('add', '.');
  const shaped = (f: Record<string, unknown>) => {
    for (const k of ['id', 'what', 'why', 'fix']) assert.ok(typeof f[k] === 'string' && f[k], `${f.id}: ${k}`);
  };
  const clean = (out: string) => {
    for (const secret of ['mycity', 'gmail', token, [10, 1, 2, 3].join('.'), sandbox.home]) assert.ok(!out.toLowerCase().includes(secret.toLowerCase()), `${secret} printed`);
  };

  // check: the text form says what, why and fix on each line.
  // The entry, through the real binary; the rest runs in this process.
  let result: Pick<ReturnType<typeof sandbox.run>, 'status' | 'stdout' | 'stderr'> = sandbox.run(['check', '--staged'], { extra: { ...extra, GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' } });
  assert.equal(result.status, 1);
  const lines = result.stderr.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length >= 7, result.stderr);
  for (const line of lines) assert.match(line, /^- .+\. [A-Z].+\. .+\.$/, line);
  clean(result.stderr);
  result = await sandbox.call(['check', '--staged', '--json'], { extra: { ...extra, GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.check, 'staged');
  assert.equal(report.ok, false);
  assert.deepEqual(
    [...new Set(report.findings.map((f: { id: string }) => f.id))].sort(),
    ['build-output', 'email', 'ip', 'layout', 'lead-only', 'private-mark', 'secret', 'time-zone'],
  );
  report.findings.forEach(shaped);
  assert.deepEqual(report.findings.find((f: { id: string }) => f.id === 'email'), {
    id: 'email',
    what: 'an email address',
    why: 'an email address points at a person, and git keeps it after the file is gone',
    fix: 'use your GitHub noreply address, or a placeholder at example.com. If it is your project\'s own public address, such as support@ at its domain, add it to "privacy.allow" in yokoten.json',
    docs: 'https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#privacy',
    file: 'notes/a.md',
    line: 1,
    grade: 'sure',
  });
  clean(result.stdout);
  result = await sandbox.call(['check', '--json'], { extra });
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['check', 'ok', 'findings', 'notes']);

  // hook: the runtimes still read stderr and the exit code; --json adds the finding on stdout.
  const call = { cwd: sandbox.repo, tool_input: { command: 'git push --force' } };
  result = await sandbox.call(['hook', '--json'], { input: JSON.stringify(call) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^yokoten stopped this: git push --force forces the push \[force-push\]\nWhy: .+\nDo instead: .*Use --force-with-lease/);
  const blocked = JSON.parse(result.stdout);
  assert.equal(blocked.blocked, true);
  shaped(blocked.finding);
  assert.equal(blocked.finding.id, 'force-push');
  result = await sandbox.call(['hook', '--json'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command: 'git status' } }) });
  assert.deepEqual([result.status, JSON.parse(result.stdout)], [0, { blocked: false, toolCall: true }]);
  result = await sandbox.call(['hook'], { input: JSON.stringify(call) });
  // Without --json, stdout holds only the deny decision Copilot CLI reads (#30); Claude Code ignores it on exit 2.
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['permissionDecision', 'permissionDecisionReason']);

  // doctor: the road and the machine as data.
  result = await sandbox.call(['doctor', '--json'], { extra });
  assert.equal(result.status, 1);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.stage, 1);
  assert.equal(doc.next.id, 'tool-hook');
  assert.ok(doc.steps.some((st: { id: string; mark: string }) => st.id === 'rules' && st.mark === 'done'));
  assert.ok(doc.findings.some((f: { id: string }) => f.id === 'secret'), 'the tree check is in it');
  doc.findings.forEach(shaped);
  doc.notes.forEach(shaped);
  clean(result.stdout);
  result = await sandbox.call(['doctor', '--session', '--json'], { extra });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['tool-hook']);

  // explain: a known id, and an unknown one with the list.
  result = await sandbox.call(['explain', 'secret', '--json']);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['found', 'id', 'kind', 'what', 'why', 'check', 'docs']);
  result = await sandbox.call(['explain', 'nope', '--json']);
  assert.equal(result.status, 1);
  const unknown = JSON.parse(result.stdout);
  assert.equal(unknown.found, false);
  assert.ok(unknown.ids.includes('secret') && unknown.ids.includes('tool-hook'));
  result = await sandbox.call(['explain', 'secret']);
  assert.match(result.stdout, /^secret: .+\.\nWhy: .+\.\nCheck: .+\.\nDocs: https:\/\/github\.com\/yokoten-labs\/yokoten\/blob\/main\/docs\/guide\.md#privacy\n$/, 'the link to the rule (#94)');
  result = await sandbox.call(['explain', 'commit-check']);
  assert.match(result.stdout, /^commit-check: a step on the road: stage 1 of 5, safety net\.\nWhy: .+\.\nCheck: .+\.\nStandard: OSPS-BR-07\.01\.\n$/);
});

// #707: colour for a person's terminal, never for an agent, a pipe or a file. `NO_COLOR`
// turns it off.
test('output colour: a terminal only, and NO_COLOR or a dumb terminal turns it off (#707)', () => {
  assert.equal(isColourTerminal({}, { isTTY: true }), true);
  assert.equal(isColourTerminal({}, { isTTY: false }), false);
  assert.equal(isColourTerminal({}, {}), false, 'a pipe is not a terminal');
  assert.equal(isColourTerminal({ NO_COLOR: '' }, { isTTY: true }), false, 'an empty NO_COLOR still turns it off');
  assert.equal(isColourTerminal({ NO_COLOR: '1' }, { isTTY: true }), false);
  assert.equal(isColourTerminal({ TERM: 'dumb' }, { isTTY: true }), false);
  const invocation = (command: string, env: Env = {}): Invocation => ({
    command,
    args: [],
    env,
    cwd: '',
    stdout: { isTTY: true } as Invocation['stdout'],
    stderr: { isTTY: true } as Invocation['stderr'],
    stdin: { fd: null, text: null, stream: {} as Invocation['stdin']['stream'] },
    script: '',
  });
  assert.equal(canColour(invocation('doctor'), invocation('doctor').stdout), true);
  assert.equal(canColour(invocation('hook'), invocation('hook').stdout), false, 'an agent reads the hook answer');
  assert.equal(canColour(invocation('doctor', { NO_COLOR: '1' }), invocation('doctor').stdout), false);
});

test('output colour: a mark in green, red or yellow, a heading in bold, a command in cyan (#707)', () => {
  assert.equal(paint('ok', '32', false), 'ok', 'off is plain text');
  assert.equal(styleLine('  ok      tool-call-guard: ready', false), '  ok      tool-call-guard: ready');
  assert.equal(styleLine('  ok      tool-call-guard: ready', true), '  \u001b[32mok\u001b[0m      tool-call-guard: ready');
  assert.match(styleLine('  MISSING tree: 2 problems', true), /^\s+\u001b\[31mMISSING\u001b\[0m /);
  assert.match(styleLine('    note    a warning', true), /^\s+\u001b\[33mnote\u001b\[0m /);
  assert.equal(styleLine('project:', true), '\u001b[1mproject:\u001b[0m');
  assert.equal(styleLine('yokoten stopped this: a tag push [release]', true), '\u001b[1;31myokoten stopped this: a tag push [release]\u001b[0m');
  assert.equal(styleLine('  1. safety net', true), '\u001b[1m  1. safety net\u001b[0m');
  assert.equal(styleLine('Run `yokoten init` first', true), 'Run \u001b[36m`yokoten init`\u001b[0m first');
  // A command inside a coloured line closes the colour, so the outer style is opened again
  // after it; otherwise the rest of a red refusal or a bold heading goes plain (#707).
  assert.equal(
    styleLine('yokoten stopped this: run `yokoten init` now [release]', true),
    '\u001b[1;31myokoten stopped this: run \u001b[36m`yokoten init`\u001b[0m\u001b[1;31m now [release]\u001b[0m',
  );
  assert.equal(
    styleLine('the road: run `yokoten doctor` next', true),
    '\u001b[1mthe road: run \u001b[36m`yokoten doctor`\u001b[0m\u001b[1m next\u001b[0m',
  );
  assert.equal(styleLine('project: `yokoten init`', true), '\u001b[1mproject: \u001b[36m`yokoten init`\u001b[0m\u001b[0m', 'a command at the end needs no re-open');
  assert.equal(styleText('project:\n  ok      done', false), 'project:\n  ok      done');
  assert.ok(!styleText('project:\n  ok      done', false).includes('\u001b'));
});

// #707: doctor on a terminal, through the command, gets colour; a pipe or NO_COLOR does not.
test('output colour: doctor colours a terminal report and never a pipe or NO_COLOR (#707)', async () => {
  const sandbox = makeSandbox();
  const colour = await invoke(['doctor'], { env: { ...sandbox.env, NO_COLOR: undefined }, cwd: sandbox.repo, isTTY: true });
  assert.match(colour.stdout, /\u001b\[1m/, 'a heading is bold');
  assert.match(colour.stdout, /\u001b\[(?:32|31|33)m(?:ok|MISSING|note)\u001b\[0m/, 'a mark has its colour');
  const plain = await invoke(['doctor'], { env: { ...sandbox.env, NO_COLOR: '1' }, cwd: sandbox.repo, isTTY: true });
  const piped = await invoke(['doctor'], { env: { ...sandbox.env, NO_COLOR: undefined }, cwd: sandbox.repo });
  for (const [name, result] of [['NO_COLOR', plain], ['a pipe', piped]] as const) {
    assert.ok(!result.stdout.includes('\u001b'), `${name}: no ANSI code`);
    assert.ok(result.stdout.includes('yokoten '), `${name}: the report still reads`);
  }
});
