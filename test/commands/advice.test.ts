// Tests for src/commands/advice.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import {
  CLI,
  makeSandbox,
  makeTempDir,
  pick,
} from '../repo/helpers.ts';
import {
  ageText,
  boardPage,
  collectBoard,
  readBoardAgents,
  readBoardWorktrees,
  renderBoardText,
  runDoctor,
  startBoardServer,
} from '../../src/commands/advice.ts';
import type { Invocation, Output } from '../../src/commands/shared.ts';
import type { Gh } from '../../src/host/github.ts';

// Codex adds a SessionStart hook's plain stdout to the context; Gemini CLI reads JSON only (#211).
test('doctor --session --agent: plain text for Codex, hookSpecificOutput JSON for Gemini CLI (#211)', async () => {
  const sandbox = makeSandbox();
  // The entry, through the real binary; the rest runs in this process.
  const plain = sandbox.run(['doctor', '--session']);
  assert.match(plain.stdout, /^yokoten: stage 1 of 5/);
  // Codex and Gemini CLI also hear that they don't filter command output (#390).
  const unfiltered = 'yokoten: only Claude Code hides your details in command output; other agents show it as it is. To stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json.\n';
  assert.deepEqual(pick(await sandbox.call(['doctor', '--session', '--agent', 'codex'])), [plain.status, plain.stdout + unfiltered, plain.stderr]);
  const result = await sandbox.call(['doctor', '--session', '--agent', 'gemini']);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['additionalContext']);
  assert.equal(out.hookSpecificOutput.additionalContext, (plain.stdout + unfiltered).trimEnd());
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // Outside a repo there is nothing to say, and no JSON either.
  assert.equal((await sandbox.call(['doctor', '--session', '--agent', 'gemini'], { cwd: sandbox.home })).stdout, '');
  assert.equal((await sandbox.call(['doctor', '--session', '--agent', 'cursor'])).status, 1);
});

test('doctor --session: an agent that cannot filter output hears it once, with the opt-in (#390)', async () => {
  const sandbox = makeSandbox();
  const line = 'yokoten: only Claude Code hides your details in command output; other agents show it as it is. To stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json.';
  assert.ok((await sandbox.call(['doctor', '--session', '--agent', 'codex'])).stdout.includes(line));
  assert.ok(!(await sandbox.call(['doctor', '--session'])).stdout.includes(line), 'Claude Code filters it');
  sandbox.write('yokoten.json', JSON.stringify({ privacy: { output: 'stop' } }));
  assert.ok(!(await sandbox.call(['doctor', '--session', '--agent', 'codex'])).stdout.includes(line), 'opted in to the stop');
});

test('doctor --session: after a compaction, Claude Code hears only what changed (#405)', async () => {
  const sandbox = makeSandbox();
  const today = (await sandbox.call(['doctor', '--session'])).stdout;
  const hook = { CLAUDE_PROJECT_DIR: sandbox.repo };
  const start = async (event: Record<string, string>) => (await sandbox.call(['doctor', '--session'], { input: JSON.stringify({ hook_event_name: 'SessionStart', ...event }), extra: hook })).stdout;
  assert.equal(await start({ session_id: 's-1', source: 'startup' }), today, 'a first start prints as today');
  assert.equal(await start({ session_id: 's-1', source: 'compact' }), '', 'a compaction start with nothing new prints nothing');
  sandbox.write('AGENTS.md', '# rules\n');
  const changed = await start({ session_id: 's-1', source: 'compact' });
  assert.match(changed, /^yokoten: stage 1 of 5, safety net\. Next: no tool-call guard/);
  assert.match(changed, /^Tell the user in plain words/m, 'a changed step keeps its offer line');
  assert.doesNotMatch(changed, /private-marks/, 'a note the session heard is not repeated');
  // No session id, or no hook: as today.
  assert.equal(await start({ source: 'compact' }), (await sandbox.call(['doctor', '--session'])).stdout);
  assert.equal((await sandbox.call(['doctor', '--session'], { input: JSON.stringify({ session_id: 's-1', source: 'compact' }) })).stdout, (await sandbox.call(['doctor', '--session'])).stdout, 'stdin is read only in a Claude Code hook');
});

test('doctor --session: a stdin pipe left open never holds the session start (#405)', async () => {
  const sandbox = makeSandbox();
  const today = (await sandbox.call(['doctor', '--session'])).stdout;
  // Like a hook runner that writes the event, or nothing, and never closes stdin.
  const start = (event?: Record<string, string>) =>
    new Promise<{ code: number | null; stdout: string }>((done, failed) => {
      const child = spawn('node', [CLI, 'doctor', '--session'], { cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PROJECT_DIR: sandbox.repo }, stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      const timer = setTimeout(() => {
        child.kill();
        failed(new Error('doctor --session waited on an open stdin'));
      }, 15_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        child.stdin.destroy();
        done({ code, stdout });
      });
      if (event) child.stdin.write(JSON.stringify(event));
    });
  assert.deepEqual(await start(), { code: 0, stdout: today }, 'no event: everything, as today');
  assert.deepEqual(await start({ session_id: 's-open', source: 'startup' }), { code: 0, stdout: today });
  assert.deepEqual(await start({ session_id: 's-open', source: 'compact' }), { code: 0, stdout: '' }, 'the event is read without an end of input');
});

test('doctor --session: a worker hears that lead-only files are guarded; the lead hears nothing (#402)', async () => {
  const sandbox = makeSandbox();
  const line = 'yokoten: this session is a worker: lead-only files are guarded.';
  const has = (result: { stdout: string }) => result.stdout.split('\n').includes(line);
  assert.ok(has(await sandbox.call(['doctor', '--session'], { extra: { YOKOTEN_ROLE: 'worker' } })), 'YOKOTEN_ROLE=worker');
  assert.ok(!has(await sandbox.call(['doctor', '--session'])), 'the lead');
  assert.ok(!has(await sandbox.call(['doctor'], { extra: { YOKOTEN_ROLE: 'worker' } })), 'only at session start');
  // A compaction drops what the session heard, never the worker's role (#405).
  const start = (source: string) => sandbox.call(['doctor', '--session'], { extra: { YOKOTEN_ROLE: 'worker', CLAUDE_PROJECT_DIR: sandbox.repo }, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'w-1', source }) });
  assert.ok(has(await start('startup')));
  assert.ok(has(await start('compact')), 'after a compaction too');
});

// #561: full doctor says one line while the slow reads run, on a terminal only. A session
// never reads the server, and --json keeps stdout to the report.
test('doctor: one progress line on a terminal; none off it, in a session, or with --json (#561)', () => {
  const sandbox = makeSandbox();
  const kept = (isTTY: boolean | undefined) => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _, done) { chunks.push(String(chunk)); done(); } });
    if (isTTY !== undefined) (stream as Writable & { isTTY: boolean }).isTTY = isTTY;
    return { stream: stream as Output, text: () => chunks.join('') };
  };
  const run = (isTTY: boolean | undefined, args: string[]): { code: number; stdout: string } => {
    const stdout = kept(isTTY);
    const stderr = kept(undefined);
    const invocation: Invocation = { command: 'doctor', args, env: { ...sandbox.env }, cwd: sandbox.repo, stdout: stdout.stream, stderr: stderr.stream, stdin: { fd: null, text: '', stream: Readable.from(['']) }, script: CLI };
    return { code: runDoctor(invocation), stdout: stdout.text() };
  };
  const line = 'reading GitHub settings...\n';
  const tty = run(true, []);
  assert.ok(tty.stdout.startsWith(line), 'the line comes first');
  const piped = run(undefined, []);
  assert.ok(!piped.stdout.includes('reading GitHub settings'), 'no line off a terminal');
  assert.ok(!run(true, ['--session']).stdout.includes('reading GitHub settings'), 'no line at session start');
  const json = run(true, ['--json']);
  assert.ok(!json.stdout.includes('reading GitHub settings'), 'stdout holds only the report');
  JSON.parse(json.stdout);
});

// #601: `yokoten board --text` prints the team as plain text. An agent joins by writing
// .yokoten-agent.json at its worktree's root, and leaves by removing it.
test('board --text: the entry, an agent that joins and leaves, and the usage errors', async () => {
  const sandbox = makeSandbox();
  // The entry, through the real binary; the rest runs in this process.
  const started = sandbox.run(['board', '--text']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /^yokoten board: \S+\n0 agents, 0 pull requests, 1 worktree\.\n\nAgents:\n- none\. An agent joins by writing \.yokoten-agent\.json in its worktree\.\n\nPull requests:\n- this repo has no GitHub remote, so the board shows no pull requests\n\nWorktrees:\n- \S+ \(main\)\n$/);
  const file = join(sandbox.repo, '.yokoten-agent.json');
  writeFileSync(file, JSON.stringify({ name: 'worker-1', vendor: 'claude-code', task: 'issue 601', worktree: sandbox.repo, doing: 'writing tests', updated: new Date().toISOString() }));
  const joined = await sandbox.call(['board', '--text']);
  assert.equal(joined.status, 0, joined.stderr);
  assert.match(joined.stdout, /\n1 agent, 0 pull requests, 1 worktree\.\n/);
  assert.match(joined.stdout, /- worker-1 \(claude-code\): issue 601, in \S+, writing tests, just now\n/);
  rmSync(file);
  const left = await sandbox.call(['board', '--text']);
  assert.match(left.stdout, /\n0 agents, 0 pull requests, 1 worktree\.\n/);
  assert.match(left.stdout, /- none\. An agent joins by writing \.yokoten-agent\.json in its worktree\.\n/);
  // A fake HOME above the repo: every shown path hides it.
  writeFileSync(file, JSON.stringify({ name: 'worker-1', worktree: sandbox.repo }));
  const hidden = await sandbox.call(['board', '--text'], { extra: { HOME: dirname(sandbox.repo) } });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.match(hidden.stdout, /^yokoten board: ~\/repo\n/);
  assert.match(hidden.stdout, /- worker-1: in ~\/repo\n/);
  assert.match(hidden.stdout, /\nWorktrees:\n- ~\/repo \(main\)\n/);
  assert.ok(!hidden.stdout.includes(sandbox.repo), 'no full path under the home folder');
  rmSync(file);
  assert.equal((await sandbox.call(['board', '--bogus'])).status, 1, 'an unknown option is refused');
  const outside = await sandbox.call(['board', '--text'], { cwd: sandbox.home });
  assert.equal(outside.status, 1, 'outside a repo it says so');
  assert.match(outside.stderr, /is not inside a git repo/);
});

// #601: the pull requests come from `gh pr list`. A fake gh first on PATH answers; the real
// gh and GitHub are never reached.
test('board --text: pull requests with each stage, read-only', async () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/demo.git').status, 0);
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const pulls = [
    { number: 7, title: 'team page', headRefName: 'board', url: 'https://example.com/pull/7', state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], labels: [{ name: 'tier B' }] },
    { number: 6, title: 'old work', headRefName: 'old', url: '', state: 'MERGED', reviewDecision: 'APPROVED', isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }], labels: [] },
  ];
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(pulls))});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const result = await sandbox.call(['board', '--text'], { extra: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\n0 agents, 2 pull requests, 1 worktree\.\n/);
  assert.match(result.stdout, /\n- #7 team page \[board\]: checks pass, tier B, waiting for the owner\n- #6 old work \[old\]: checks fail, no tier, merged\n/);
});

// #601: one status file per worktree, at its root, read in worktree order. A missing,
// broken or odd file never breaks the board; a missing name is the worktree's folder name.
test('board agents: every worktree root as an agent; the odd ones are skipped or blank', () => {
  const first = makeTempDir('yokoten-board-');
  const second = makeTempDir('yokoten-board-');
  const missing = makeTempDir('yokoten-board-');
  const broken = makeTempDir('yokoten-board-');
  const listed = makeTempDir('yokoten-board-');
  const odd = makeTempDir('yokoten-board-');
  const blocked = makeTempDir('yokoten-board-');
  writeFileSync(join(first, '.yokoten-agent.json'), JSON.stringify({ name: 'b-worker', vendor: 'codex', task: 't', worktree: 'w', doing: 'd', updated: '2026-10-22T10:00:00Z' }));
  writeFileSync(join(second, '.yokoten-agent.json'), JSON.stringify({ task: 'only a task' }));
  writeFileSync(join(broken, '.yokoten-agent.json'), '{oops');
  writeFileSync(join(listed, '.yokoten-agent.json'), '[]');
  writeFileSync(join(odd, '.yokoten-agent.json'), JSON.stringify({ name: 7, vendor: null, updated: 123 }));
  mkdirSync(join(blocked, '.yokoten-agent.json'));
  assert.deepEqual(
    readBoardAgents([
      { path: first, branch: 'main' },
      { path: second, branch: 'feature' },
      { path: missing, branch: '' },
      { path: join(missing, 'gone'), branch: '' },
      { path: broken, branch: '' },
      { path: listed, branch: '' },
      { path: odd, branch: '' },
      { path: blocked, branch: '' },
    ]),
    [
      { name: 'b-worker', vendor: 'codex', task: 't', worktree: 'w', doing: 'd', updated: '2026-10-22T10:00:00Z' },
      { name: basename(second), vendor: '', task: 'only a task', worktree: '', doing: '', updated: '' },
      { name: basename(odd), vendor: '', task: '', worktree: '', doing: '', updated: '' },
    ],
  );
  assert.deepEqual(readBoardAgents([]), [], 'no worktrees, no agents');
});

test('board age: just now, minutes, hours and days; a missing or odd time is blank', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(ageText('2026-10-22T11:59:30Z', now), 'just now');
  assert.equal(ageText('2026-10-22T12:00:01Z', now), 'just now', 'a time ahead never goes below just now');
  assert.equal(ageText('2026-10-22T11:59:00Z', now), '1 min ago');
  assert.equal(ageText('2026-10-22T11:01:00Z', now), '59 min ago');
  assert.equal(ageText('2026-10-22T11:00:00Z', now), '1 h ago');
  assert.equal(ageText('2026-10-21T12:00:01Z', now), '23 h ago');
  assert.equal(ageText('2026-10-21T12:00:00Z', now), '1 day ago');
  assert.equal(ageText('2026-10-20T12:00:00Z', now), '2 days ago');
  assert.equal(ageText('', now), '');
  assert.equal(ageText('yesterday', now), '');
});

test('board worktrees: the repo lists its own; outside a repo git cannot list them', () => {
  const sandbox = makeSandbox();
  assert.deepEqual(readBoardWorktrees(sandbox.repo, sandbox.env), [{ path: sandbox.repo, branch: 'main' }]);
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  const second = join(sandbox.home, 'second');
  assert.equal(sandbox.git('worktree', 'add', second, '-b', 'feature').status, 0);
  assert.deepEqual(readBoardWorktrees(sandbox.repo, sandbox.env), [
    { path: sandbox.repo, branch: 'main' },
    { path: second, branch: 'feature' },
  ]);
  assert.equal(readBoardWorktrees(sandbox.home, sandbox.env), 'git could not list the worktrees: run it again');
});

test('board text: every stage in plain words; a part that cannot be read says why', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.deepEqual(
    renderBoardText(
      {
        repo: '/repo',
        agents: [
          { name: 'worker-1', vendor: 'claude-code', task: 'issue 601', worktree: '/repo/.worktrees/601', doing: 'writing tests', updated: '2026-10-22T11:58:00Z' },
          { name: 'plain', vendor: '', task: '', worktree: '', doing: '', updated: '' },
        ],
        pulls: [
          { number: 1, title: 'team page', branch: 'board', url: '', stage: 'open', checks: 'pass', tier: 'B', review: 'waiting' },
          { number: 2, title: 'old work', branch: 'old', url: '', stage: 'merged', checks: 'fail', tier: '', review: 'approved' },
          { number: 3, title: 'draft', branch: 'd', url: '', stage: 'draft', checks: 'none', tier: 'C', review: 'none' },
        ],
        worktrees: [
          { path: '/repo', branch: 'main' },
          { path: '/repo/.worktrees/601', branch: '' },
        ],
      },
      now,
    ),
    [
      'yokoten board: /repo',
      '2 agents, 3 pull requests, 2 worktrees.',
      '',
      'Agents:',
      '- worker-1 (claude-code): issue 601, in /repo/.worktrees/601, writing tests, 2 min ago',
      '- plain',
      '',
      'Pull requests:',
      '- #1 team page [board]: checks pass, tier B, waiting for the owner',
      '- #2 old work [old]: checks fail, no tier, merged',
      '- #3 draft [d]: no checks, tier C, draft',
      '',
      'Worktrees:',
      '- /repo (main)',
      '- /repo/.worktrees/601',
    ],
  );
  assert.deepEqual(renderBoardText({ repo: '/repo', agents: [], pulls: 'gh failed', worktrees: 'git failed' }, now), [
    'yokoten board: /repo',
    '0 agents, 0 pull requests, 0 worktrees.',
    '',
    'Agents:',
    '- none. An agent joins by writing .yokoten-agent.json in its worktree.',
    '',
    'Pull requests:',
    '- gh failed',
    '',
    'Worktrees:',
    '- git failed',
  ]);
});

// #601: the data together. Without a GitHub remote, gh is never asked. Every shown path
// hides the home folder.
test('board data: agents, pulls and worktrees; gh runs only with a GitHub remote', () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', worktree: sandbox.repo }));
  const unasked: Gh = () => {
    throw new Error('gh must not run without a GitHub remote');
  };
  const without = collectBoard(sandbox.repo, sandbox.env, unasked);
  assert.equal(without.repo, sandbox.repo);
  assert.deepEqual(without.agents, [{ name: 'w', vendor: '', task: '', worktree: sandbox.repo, doing: '', updated: '' }]);
  assert.equal(without.pulls, 'this repo has no GitHub remote, so the board shows no pull requests');
  assert.deepEqual(without.worktrees, [{ path: sandbox.repo, branch: 'main' }]);
  assert.equal(sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git').status, 0);
  const gh: Gh = () => JSON.stringify([{ number: 1, title: 't', headRefName: 'b', url: '', state: 'OPEN', reviewDecision: 'APPROVED', isDraft: false, statusCheckRollup: [], labels: [] }]);
  assert.deepEqual(collectBoard(sandbox.repo, sandbox.env, gh).pulls, [{ number: 1, title: 't', branch: 'b', url: '', stage: 'open', checks: 'none', tier: '', review: 'approved' }]);
  // A fake HOME above the repo: every shown path hides it.
  const hidden = collectBoard(sandbox.repo, { ...sandbox.env, HOME: dirname(sandbox.repo) }, gh);
  assert.equal(hidden.repo, '~/repo');
  assert.deepEqual(hidden.agents, [{ name: 'w', vendor: '', task: '', worktree: '~/repo', doing: '', updated: '' }]);
  assert.deepEqual(hidden.worktrees, [{ path: '~/repo', branch: 'main' }]);
  // No repo: no agents, and the worktrees say why.
  const outside = collectBoard(sandbox.home, sandbox.env, unasked);
  assert.equal(outside.repo, '~');
  assert.deepEqual(outside.agents, []);
  assert.equal(outside.worktrees, 'git could not list the worktrees: run it again');
});

test('board page: plain HTML with the three tables; it reads /data every 15 seconds', () => {
  const page = boardPage();
  assert.match(page, /<title>yokoten board<\/title>/);
  assert.match(page, /<h1>yokoten board<\/h1>/);
  for (const id of ['agents', 'pulls', 'worktrees']) assert.ok(page.includes(`<table id="${id}"></table>`), `a ${id} table`);
  assert.ok(page.includes('setInterval(load, 15000)'), 'refreshes every 15 seconds');
  assert.ok(page.includes("fetch('data')"), 'reads the same data as JSON');
  assert.ok(page.includes('.yokoten-agent.json'), 'the empty state names the file');
  assert.ok(!page.includes('http://') && !page.includes('https://'), 'no outside address: it works offline');
});

// #601: the server listens on 127.0.0.1 only. It never outlives the test: it closes in a finally.
test('board server: the page at /, the same data as JSON at /data, nothing else', async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse', worktree: join(sandbox.home, 'w') }));
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null);
    assert.equal(address.address, '127.0.0.1', 'this machine only');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const get = (path: string) =>
      new Promise<{ status: number; kind: string; text: string }>((done, failed) => {
        httpGet(`${url}${path.slice(1)}`, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => done({ status: res.statusCode ?? 0, kind: String(res.headers['content-type'] ?? ''), text }));
        }).on('error', failed);
      });
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.equal(page.kind, 'text/html; charset=utf-8');
    assert.equal(page.text, boardPage());
    const data = await get('/data');
    assert.equal(data.status, 200);
    assert.equal(data.kind, 'application/json; charset=utf-8');
    const shown = JSON.parse(data.text) as { repo: string; agents: unknown[]; pulls: unknown; worktrees: unknown[]; updated: string };
    assert.equal(shown.repo, sandbox.repo);
    assert.deepEqual(shown.agents, [{ name: 'w', vendor: 'muse', task: '', worktree: '~/w', doing: '', updated: '', age: '' }]);
    assert.equal(shown.pulls, 'this repo has no GitHub remote, so the board shows no pull requests');
    assert.deepEqual(shown.worktrees, [{ path: sandbox.repo, branch: 'main' }]);
    assert.match(shown.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal((await get('/missing')).status, 404);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
