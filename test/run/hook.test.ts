// Tests for src/run/hook.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, constants, existsSync, lstatSync, lutimesSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  CLI,
  makeTempDir,
  makeSandbox,
  runChild,
  stopCheckoutWalk,
} from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { SECRET } from '../../src/rules/secrets.ts';
import {
  AGENT_STATUS_FILE,
  bumpDoneTries,
  clearDoneTries,
  clearRefusedMarker,
  DONE_TRY_LIMIT,
  doneTryKey,
  doneWhenShell,
  guardDeadline,
  isSameFile,
  isWorkerType,
  judge,
  noteRefused,
  readDoneWhen,
  readStatusResult,
  readStatusText,
  readStopFields,
  refusedMarkerPath,
  runDoneWhen,
  shortenOutput,
  STATUS_TEXT_LIMIT,
  startGuard,
  wasRefusedRecently,
  windowsTreeKillArgs,
  writeAgentChecks,
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
  assert.equal(judge({ command: 'git push --force origin main', commands: [], paths: [], worker: false }, options)?.id !== undefined, true, 'an empty commands list never hides a command');
});

// #674: a worker outside a desk can't write a team folder: nothing else fences it there.
test('hook: a worker edit inside <repo>.team/ is refused; the lead and other folders pass (#674)', () => {
  const sandbox = makeSandbox();
  const team = `${sandbox.repo}.team`;
  const options = { root: sandbox.repo, config: DEFAULTS, env: { YOKOTEN_ROLE: 'worker' }, cwd: sandbox.repo };
  for (const path of [join(team, 'outbox', 'g1.jsonl'), join(team, 'agents', 'g1.json'), join(team, 'lead', 'read.json'), `../${basename(sandbox.repo)}.team/outbox/lead.jsonl`]) {
    assert.equal(judge({ paths: [path], worker: false }, options)?.id, 'lead-only', path);
  }
  assert.equal(judge({ paths: [join(team, 'outbox', 'g1.jsonl')], worker: false }, { ...options, env: {} }), null, 'the lead passes');
  assert.equal(judge({ paths: ['src/.team.ts'], worker: false }, options), null);
  assert.equal(judge({ paths: ['notes.team'], worker: false }, options), null, 'a file named .team is not a team folder');
  // A folder that only ends in .team, with no checkout of that name next to it, is not a team folder.
  const work = makeTempDir('work-');
  for (const path of [join(work, 'acme.team', 'repo', 'src', 'a.ts'), join(work, 'acme.team', 'outbox', 'x.jsonl')]) {
    assert.equal(judge({ paths: [path], worker: false }, options), null, path);
  }
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
  assert.match(result.stderr, /^yokoten: the guard refused this call: reading this command took longer than 1 ms\.[\s\S]*Split the command into smaller ones\./);
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

test('done-when: the command comes from the env or the git-folder file; a pass, a fail, and the try count (#614)', async () => {
  const sandbox = makeSandbox();
  assert.equal(readDoneWhen({}, sandbox.repo), undefined);
  assert.equal(readDoneWhen({ YOKOTEN_DONE_WHEN: '  npm test  ' }, sandbox.repo), 'npm test');
  writeFileSync(join(sandbox.repo, '.git', 'yokoten-done-when'), '# comment\nnode --test\n');
  assert.equal(readDoneWhen({}, sandbox.repo), 'node --test');
  assert.equal(readDoneWhen({ YOKOTEN_DONE_WHEN: 'true' }, sandbox.repo), 'true', 'the env wins');
  assert.equal(doneWhenShell(), process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  // `true` and `echo` are sh. On Windows the command is a node script, below.
  if (process.platform !== 'win32') {
    assert.equal((await runDoneWhen('true', sandbox.repo, sandbox.env)).ok, true);
    const failed = await runDoneWhen('echo fail-out >&2; exit 1', sandbox.repo, sandbox.env);
    assert.equal(failed.ok, false);
    assert.match(failed.output, /fail-out/);
  }
  const token = `${'gh'}p_${'a'.repeat(36)}`;
  assert.equal(shortenOutput(`token: ${token}`).includes(token), false);
  assert.equal(shortenOutput(`token: ${token}`).includes(SECRET), true);
  assert.equal(shortenOutput('a'.repeat(3000)).length <= 2000, true);
  // The real value of a secret-looking variable is hidden too (#616).
  const value = `${'envSecret'}${'Value'}1234`;
  assert.equal(shortenOutput(`failed with ${value}`, { SERVICE_TOKEN: value }), 'failed with <secret>');
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
  assert.equal(isWorkerType('code-worker'), false);
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
  const triesDir = join(sandbox.home, '.config', 'yokoten', 'done-tries');
  const oldCount = join(triesDir, 'old-session');
  const recentCount = join(triesDir, 'recent-session');
  writeFileSync(oldCount, '4\n');
  writeFileSync(recentCount, '2\n');
  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(oldCount, oldTime, oldTime);
  const recentTime = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(recentCount, recentTime, recentTime);
  const oldDir = join(triesDir, 'old-dir');
  mkdirSync(oldDir);
  utimesSync(oldDir, oldTime, oldTime);
  const oldLink = join(triesDir, 'old-link');
  symlinkSync(recentCount, oldLink);
  lutimesSync(oldLink, oldTime, oldTime);
  assert.equal(bumpDoneTries(sandbox.env, 'fresh-session'), 1);
  assert.equal(existsSync(oldCount), false, 'a count file older than a day is removed');
  assert.equal(readFileSync(recentCount, 'utf8').trim(), '2', 'a recent count file stays');
  assert.equal(existsSync(oldDir), true, 'a directory is not a count file');
  assert.equal(lstatSync(oldLink).isSymbolicLink(), true, 'an old link is not removed');
  assert.equal(readFileSync(join(triesDir, 'fresh-session'), 'utf8').trim(), '1');
  // A count path that is a folder makes rmSync throw. The hook must still end.
  const blocked = 'task-dir';
  mkdirSync(join(sandbox.home, '.config', 'yokoten', 'done-tries', blocked), { recursive: true });
  assert.doesNotThrow(() => clearDoneTries(sandbox.env, blocked));
});

test('writeAgentChecks: keeps other fields, skips a link, and sets checks and the UTC time (#614)', () => {
  const sandbox = makeSandbox();
  const path = join(sandbox.repo, AGENT_STATUS_FILE);
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);
  const outside = join(sandbox.home, 'outside.json');
  const outsideText = `${JSON.stringify({ secret: 'keep', checks: 'old' })}\n`;
  writeFileSync(outside, outsideText);
  symlinkSync(outside, path);
  writeAgentChecks(sandbox.repo, 'failing', new Date('2026-10-22T10:00:00.000Z'), warn);
  assert.equal(readFileSync(outside, 'utf8'), outsideText, 'a link to JSON outside the worktree is not followed');
  assert.equal(readlinkSync(path), outside);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.deepEqual(lines, [`yokoten: ${AGENT_STATUS_FILE} is not a regular file, so it was left unchanged.\n`]);
  unlinkSync(path);
  lines.length = 0;
  const notes = join(sandbox.home, 'notes.txt');
  writeFileSync(notes, '# keep\n');
  symlinkSync(notes, path);
  writeAgentChecks(sandbox.repo, 'failing', new Date('2026-10-22T10:30:00.000Z'), warn);
  assert.equal(readFileSync(notes, 'utf8'), '# keep\n', 'a link to a non-JSON file is not followed');
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.equal(lines.length, 1);
  unlinkSync(path);
  lines.length = 0;
  writeAgentChecks(sandbox.repo, 'passing', new Date('2026-10-22T10:45:00.000Z'), warn);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { checks: 'passing', updated: '2026-10-22T10:45:00Z' });
  assert.deepEqual(lines, [], 'a missing file is created without a warning');
  writeFileSync(path, `${JSON.stringify({ name: 'worker-1', role: 'engineer', doing: 'the task' })}\n`);
  writeAgentChecks(sandbox.repo, 'failing', new Date('2026-10-22T10:00:00.123Z'), warn);
  const status = JSON.parse(readFileSync(path, 'utf8')) as { name: string; role: string; doing: string; checks: string; updated: string };
  assert.equal(status.name, 'worker-1');
  assert.equal(status.role, 'engineer');
  assert.equal(status.doing, 'the task');
  assert.equal(status.checks, 'failing');
  assert.equal(status.updated, '2026-10-22T10:00:00Z');
  assert.equal(lstatSync(path).isFile(), true, 'a normal file still gets checks');
  writeFileSync(path, 'not json');
  writeAgentChecks(sandbox.repo, 'failing', new Date('2026-10-22T11:00:00.000Z'), () => {});
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).checks, 'failing');
  writeFileSync(path, '[]\n');
  writeAgentChecks(sandbox.repo, 'passing', new Date('2026-10-22T12:00:00.000Z'), () => {});
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { checks: 'passing', updated: '2026-10-22T12:00:00Z' });
  assert.deepEqual(readdirSync(sandbox.repo).filter((name) => name.endsWith('.tmp')), []);
});

test('writeAgentChecks: an oversized status file stays byte for byte unchanged and warns (#642)', () => {
  const sandbox = makeSandbox();
  const path = join(sandbox.repo, AGENT_STATUS_FILE);
  const fields = `${JSON.stringify({ name: 'worker-1', role: 'engineer', doing: 'the task' })}\n`;
  const text = fields + ' '.repeat(STATUS_TEXT_LIMIT + 1 - Buffer.byteLength(fields));
  assert.equal(Buffer.byteLength(text), STATUS_TEXT_LIMIT + 1);
  writeFileSync(path, text);
  const lines: string[] = [];
  writeAgentChecks(sandbox.repo, 'failing', new Date('2026-10-22T11:00:00.000Z'), (line) => lines.push(line));
  assert.deepEqual(readFileSync(path), Buffer.from(text), 'the refused file is unchanged');
  assert.deepEqual(lines, [`yokoten: ${AGENT_STATUS_FILE} is too large, so it was left unchanged.\n`]);
});

test('writeAgentChecks: an unreadable status file stays unchanged and warns (#642)', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'no unreadable file for root or on Windows' }, () => {
  const sandbox = makeSandbox();
  const path = join(sandbox.repo, AGENT_STATUS_FILE);
  const text = `${JSON.stringify({ name: 'worker-1', role: 'engineer' })}\n`;
  writeFileSync(path, text);
  chmodSync(path, 0o000);
  const lines: string[] = [];
  try {
    writeAgentChecks(sandbox.repo, 'failing', new Date('2026-10-22T11:00:00.000Z'), (line) => lines.push(line));
  } finally {
    chmodSync(path, 0o600);
  }
  assert.equal(readFileSync(path, 'utf8'), text, 'the refused file is unchanged');
  assert.deepEqual(lines, [`yokoten: ${AGENT_STATUS_FILE} cannot be read, so it was left unchanged.\n`]);
});

test('refused marker: the same worker stays recent for 5 minutes (#614)', () => {
  const sandbox = makeSandbox();
  // A folder next to the repo must not be the machine's checkout (#712).
  stopCheckoutWalk(dirname(sandbox.repo));
  const key = 'mark-614';
  const path = refusedMarkerPath(sandbox.repo, key);
  assert.equal(path, join(sandbox.repo, '.git', 'yokoten-stop-refused', key));
  assert.equal(wasRefusedRecently(sandbox.repo, key), false);
  const now = new Date('2026-10-22T12:00:00.000Z');
  noteRefused(sandbox.repo, key, now);
  assert.equal(wasRefusedRecently(sandbox.repo, key, now.getTime()), true);
  assert.equal(wasRefusedRecently(sandbox.repo, key, now.getTime() + 5 * 60 * 1000), true, 'five minutes is still inside the window');
  assert.equal(wasRefusedRecently(sandbox.repo, key, now.getTime() + 5 * 60 * 1000 + 1), false, 'past five minutes is a new refusal');
  assert.equal(wasRefusedRecently(sandbox.repo, key, now.getTime() - 1000), false, 'a marker in the future is not recent');
  assert.ok(path);
  writeFileSync(path, 'not a time\n');
  assert.equal(wasRefusedRecently(sandbox.repo, key), false);
  clearRefusedMarker(sandbox.repo, key);
  assert.equal(existsSync(path), false);
  assert.equal(refusedMarkerPath(join(sandbox.home, 'outside'), key), null);
  assert.doesNotThrow(() => noteRefused(join(sandbox.home, 'outside'), key));
});

test('done-when: Windows tree kill uses taskkill /F /T while the shell can still be alive (#614)', () => {
  assert.deepEqual(windowsTreeKillArgs(4242), ['/F', '/T', '/PID', '4242']);
});

// The timer must see a live shell. spawnSync's timeout would have killed it first (#614).
test('done-when: a timeout kills the tree while the shell is still running (#614)', { skip: process.platform === 'win32' && 'the stand-in kill uses a POSIX process group' }, async () => {
  const sandbox = makeSandbox();
  let alive = false;
  const result = await runDoneWhen(`${process.execPath} -e "setInterval(() => {}, 1000)"`, sandbox.repo, sandbox.env, 400, (pid) => {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /ran too long/);
  assert.equal(alive, true, 'the shell was still running when the tree was killed');
});

// setsid leaves the process group and keeps the pipes. The check must not wait for it.
test('done-when: a timeout ends when a program left the process group (#614)', { skip: (process.platform === 'win32' || runChild('sh', ['-c', 'command -v setsid']).status !== 0) && 'setsid is missing' }, async () => {
  const sandbox = makeSandbox();
  const pidFile = join(sandbox.repo, 'grandchild.pid');
  const command = `setsid sh -c 'echo $$ > "${pidFile}"; sleep 30' & sleep 30`;
  const started = Date.now();
  try {
    const result = await runDoneWhen(command, sandbox.repo, sandbox.env, 500);
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.match(result.output, /ran too long/);
    assert.ok(elapsed < 3000, `ended after ${elapsed} ms`);
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The grandchild is already gone.
          }
        }
      }
    }
  }
});

// (...) & stays in the shell's group. A normal exit must stop it before the late write (#641).
test('done-when: a passing check stops a background writer (#641)', { skip: process.platform === 'win32' && 'the kill uses a POSIX process group', timeout: 5000 }, async () => {
  const sandbox = makeSandbox();
  const started = join(sandbox.repo, 'writer-started');
  const late = join(sandbox.repo, 'writer-late');
  const command = `(touch ${JSON.stringify(started)}; sleep 0.4; touch ${JSON.stringify(late)}) & while [ ! -f ${JSON.stringify(started)} ]; do :; done; exit 0`;
  const result = await runDoneWhen(command, sandbox.repo, sandbox.env, 5000);
  assert.equal(result.ok, true, result.output);
  assert.equal(/ran too long/.test(result.output), false);
  assert.equal(existsSync(started), true, 'the writer started');
  await delay(800);
  assert.equal(existsSync(late), false, 'the writer wrote after the check ended');
});

// The shell exits 0. setsid keeps the pipes. The check must pass before the timeout.
test('done-when: an exited shell passes even when a program keeps the pipes open (#614)', { skip: (process.platform === 'win32' || runChild('sh', ['-c', 'command -v setsid']).status !== 0) && 'setsid is missing', timeout: 5000 }, async () => {
  const sandbox = makeSandbox();
  const started = Date.now();
  const result = await runDoneWhen('echo kept-614; setsid sleep 5 & exit 0', sandbox.repo, sandbox.env, 2000);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /kept-614/);
  assert.equal(/ran too long/.test(result.output), false);
  assert.ok(elapsed < 1500, `ended after ${elapsed} ms`);
});

test('done-when: a timeout still ends when the tree kill throws (#614)', { skip: process.platform === 'win32' && 'the stand-in kill uses a POSIX process group', timeout: 5000 }, async () => {
  const sandbox = makeSandbox();
  let pid = 0;
  try {
    const result = await runDoneWhen(`${process.execPath} -e "setInterval(() => {}, 1000)"`, sandbox.repo, sandbox.env, 300, (childPid) => {
      pid = childPid;
      throw new Error('kill failed');
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /ran too long/);
  } finally {
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process is already gone.
        }
      }
    }
  }
});

test('readStatusText: an unchanged file is read, and a swap at open time is not (#614)', { timeout: 5000 }, () => {
  const sandbox = makeSandbox();
  const path = join(sandbox.repo, 'status.json');
  const swapped = join(sandbox.repo, 'other.json');
  writeFileSync(path, '{"name":"kept"}\n');
  writeFileSync(swapped, '{"name":"other"}\n');
  assert.deepEqual(readStatusResult(path), { text: '{"name":"kept"}\n' }, 'an unchanged file returns its text');
  assert.equal(readStatusText(path), '{"name":"kept"}\n', 'an unchanged file returns its text');
  let openFlags = 0;
  const swappedResult = readStatusResult(path, (_, flags) => {
    openFlags = flags;
    return openSync(swapped, flags);
  });
  assert.deepEqual(swappedResult, { refused: 'changed while it was read' }, 'a swap at open time is refused');
  assert.equal(readStatusText(path, (_, flags) => openSync(swapped, flags)), null);
  const nonblock = constants.O_NONBLOCK ?? 0;
  assert.equal(openFlags & nonblock, nonblock, 'the open does not wait on a pipe');
  writeFileSync(path, 'x'.repeat(STATUS_TEXT_LIMIT));
  const atCap = readStatusResult(path);
  assert.ok('text' in atCap);
  assert.equal(atCap.text.length, STATUS_TEXT_LIMIT, 'a file at the size cap is read');
  writeFileSync(path, 'y'.repeat(STATUS_TEXT_LIMIT + 1));
  assert.deepEqual(readStatusResult(path), { refused: 'too large' }, 'a file over the size cap is refused');
  assert.equal(readStatusText(path), null, 'a file over the size cap is not read');
  if (existsSync('/dev/zero')) {
    const openedAt = Date.now();
    assert.deepEqual(readStatusResult(path, () => openSync('/dev/zero', constants.O_RDONLY)), { refused: 'changed while it was read' }, 'a device opened in place of the file is refused');
    assert.equal(readStatusText(path, () => openSync('/dev/zero', constants.O_RDONLY)), null, 'a device opened in place of the file is not read');
    assert.ok(Date.now() - openedAt < 1000, 'a device is refused before it is read');
  }
});

test('isSameFile: dev and ino both have to match (#614)', () => {
  assert.equal(isSameFile({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), true);
  assert.equal(isSameFile({ dev: 1, ino: 2 }, { dev: 3, ino: 2 }), false, 'a different dev is another file');
  assert.equal(isSameFile({ dev: 1, ino: 2 }, { dev: 1, ino: 4 }), false, 'a different ino is another file');
  const sandbox = makeSandbox();
  const path = join(sandbox.repo, 'status.txt');
  const other = join(sandbox.repo, 'other.txt');
  writeFileSync(path, 'one\n');
  writeFileSync(other, 'two\n');
  const listed = lstatSync(path);
  assert.equal(isSameFile(listed, lstatSync(path)), true);
  assert.equal(isSameFile(listed, lstatSync(other)), false);
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
    const result = await runDoneWhen(command, sandbox.repo, sandbox.env, 8000);
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
