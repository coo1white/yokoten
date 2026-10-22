// Tests for src/commands/advice.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
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
  boardBrief,
  boardPage,
  boardStartParts,
  collectBoard,
  collectBoardWaiting,
  createBoardControls,
  readBoardAgents,
  readBoardAttention,
  readBoardIssues,
  readBoardLimitChange,
  readBoardStartAsk,
  readBoardWorktrees,
  renderBoardText,
  runDoctor,
  setBoardLimits,
  startBoardServer,
  stopBoardAgent,
  type BoardEvents,
  type BoardSpawner,
  type BoardWaiting,
} from '../../src/commands/advice.ts';
import type { Invocation, Output } from '../../src/commands/shared.ts';
import type { Gh } from '../../src/host/github.ts';
import type { Env } from '../../src/rules/config.ts';

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
// broken or odd file never breaks the board; a missing name is the worktree's folder
// name, and a role that is not engineer, reviewer or verifier is blank.
test('board agents: every worktree root as an agent; the odd ones are skipped or blank', () => {
  const first = makeTempDir('yokoten-board-');
  const second = makeTempDir('yokoten-board-');
  const missing = makeTempDir('yokoten-board-');
  const broken = makeTempDir('yokoten-board-');
  const listed = makeTempDir('yokoten-board-');
  const odd = makeTempDir('yokoten-board-');
  const blocked = makeTempDir('yokoten-board-');
  writeFileSync(join(first, '.yokoten-agent.json'), JSON.stringify({ name: 'b-worker', vendor: 'codex', task: 't', worktree: 'w', doing: 'd', updated: '2026-10-22T10:00:00Z', role: 'engineer' }));
  writeFileSync(join(second, '.yokoten-agent.json'), JSON.stringify({ task: 'only a task', role: 'reviewer' }));
  writeFileSync(join(broken, '.yokoten-agent.json'), '{oops');
  writeFileSync(join(listed, '.yokoten-agent.json'), '[]');
  writeFileSync(join(odd, '.yokoten-agent.json'), JSON.stringify({ name: 7, vendor: null, updated: 123, role: 'boss' }));
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
      { name: 'b-worker', vendor: 'codex', task: 't', worktree: 'w', doing: 'd', updated: '2026-10-22T10:00:00Z', role: 'engineer' },
      { name: basename(second), vendor: '', task: 'only a task', worktree: '', doing: '', updated: '', role: 'reviewer' },
      { name: basename(odd), vendor: '', task: '', worktree: '', doing: '', updated: '', role: '' },
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
  // git reports the resolved path (/private/var/... on macOS), not the temp path.
  const root = realpathSync(sandbox.repo);
  assert.deepEqual(readBoardWorktrees(sandbox.repo, sandbox.env), [{ path: root, branch: 'main' }]);
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  const second = join(sandbox.home, 'second');
  assert.equal(sandbox.git('worktree', 'add', second, '-b', 'feature').status, 0);
  assert.deepEqual(readBoardWorktrees(sandbox.repo, sandbox.env), [
    { path: root, branch: 'main' },
    { path: realpathSync(second), branch: 'feature' },
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
          { name: 'worker-1', vendor: 'claude-code', task: 'issue 601', worktree: '/repo/.worktrees/601', doing: 'writing tests', updated: '2026-10-22T11:58:00Z', role: 'engineer' },
          { name: 'plain', vendor: '', task: '', worktree: '', doing: '', updated: '', role: '' },
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
      '- worker-1 (claude-code) [engineer]: issue 601, in /repo/.worktrees/601, writing tests, 2 min ago',
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
  assert.deepEqual(without.agents, [{ name: 'w', vendor: '', task: '', worktree: sandbox.repo, doing: '', updated: '', role: '' }]);
  assert.equal(without.pulls, 'this repo has no GitHub remote, so the board shows no pull requests');
  assert.deepEqual(without.worktrees, [{ path: realpathSync(sandbox.repo), branch: 'main' }]);
  assert.equal(sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git').status, 0);
  const gh: Gh = () => JSON.stringify([{ number: 1, title: 't', headRefName: 'b', url: '', state: 'OPEN', reviewDecision: 'APPROVED', isDraft: false, statusCheckRollup: [], labels: [] }]);
  assert.deepEqual(collectBoard(sandbox.repo, sandbox.env, gh).pulls, [{ number: 1, title: 't', branch: 'b', url: '', stage: 'open', checks: 'none', tier: '', review: 'approved' }]);
  // A fake HOME above the repo: every shown path hides it.
  const hidden = collectBoard(sandbox.repo, { ...sandbox.env, HOME: dirname(sandbox.repo) }, gh);
  assert.equal(hidden.repo, '~/repo');
  assert.deepEqual(hidden.agents, [{ name: 'w', vendor: '', task: '', worktree: '~/repo', doing: '', updated: '', role: '' }]);
  assert.deepEqual(hidden.worktrees, [{ path: '~/repo', branch: 'main' }]);
  // No repo: no agents, and the worktrees say why.
  const outside = collectBoard(sandbox.home, sandbox.env, unasked);
  assert.equal(outside.repo, '~');
  assert.deepEqual(outside.agents, []);
  assert.equal(outside.worktrees, 'git could not list the worktrees: run it again');
});

test('board page: three columns; the agents grouped, one picked, the pulls with checks in plain words', () => {
  const page = boardPage();
  assert.match(page, /<title>yokoten board<\/title>/);
  assert.match(page, /<h1>yokoten board<\/h1>/);
  assert.ok(page.includes('<div class="columns">'), 'three columns');
  assert.ok(page.includes('<div id="groups"></div>'), 'the agents on the left');
  assert.ok(page.includes('<div id="detail"></div>'), 'the picked agent in the middle');
  assert.ok(page.includes('<div id="pulls"></div>'), 'the pull requests on the right');
  assert.ok(page.includes('<h2>Conversation</h2>'), 'room for the conversation');
  assert.ok(!page.includes('<table'), 'no tables');
  assert.ok(!page.includes('JSON.stringify'), 'no raw JSON on screen');
  assert.ok(page.includes('checks pass'), 'checks in plain words');
  assert.ok(page.includes('setInterval(load, 15000)'), 'refreshes every 15 seconds');
  assert.ok(page.includes("fetch('data?t=' + encodeURIComponent(pageToken()))"), 'reads the same data as JSON, with the link token');
  assert.ok(page.includes('new URLSearchParams(location.search)'), 'the token comes from the link');
  assert.ok(page.includes('.yokoten-agent.json'), 'the empty state names the file');
  // Each scheme shows once, in the link guard; nothing else points outside, so the page works offline.
  assert.equal(page.split('http://').length - 1, 1, 'one http:// (the link guard)');
  assert.equal(page.split('https://').length - 1, 1, 'one https:// (the link guard)');
});

// The page script, for the tests that run it with fakes: one fetch, one timer, one note.
function boardScript(): string {
  const pageText = boardPage();
  const scriptStart = pageText.indexOf('<script>');
  const scriptEnd = pageText.lastIndexOf('</script>');
  return scriptStart < 0 || scriptEnd < 0 ? '' : pageText.slice(scriptStart + '<script>'.length, scriptEnd);
}

// #601: only http(s) pull addresses become links; anything else stays plain text, so an
// odd address never becomes a script link.
test('board page: only http(s) pull addresses become links', () => {
  const script = boardScript();
  assert.ok(script.includes('if (isHttpUrl(pull.url))'), 'the pull number links only through the guard');
  // The page script on its own, with fakes for what it touches at load: one fetch, one timer, one note.
  const run = new Function('document', 'location', 'fetch', 'setInterval', `${script}; return { isHttpUrl, pageToken };`) as unknown as (
    fakeDocument: unknown,
    fakeLocation: unknown,
    fakeFetch: () => Promise<never>,
    fakeTimer: () => number,
  ) => { isHttpUrl: (url: unknown) => boolean; pageToken: () => string };
  const { isHttpUrl, pageToken } = run({ getElementById: () => ({}) }, { search: '?t=abc' }, () => Promise.reject(new Error('no net')), () => 0);
  assert.equal(pageToken(), 'abc', 'the page sends the link token on to /data');
  assert.equal(isHttpUrl('https://example.com/pull/7'), true);
  assert.equal(isHttpUrl('http://example.com/pull/7'), true);
  assert.equal(isHttpUrl('HTTPS://example.com/pull/7'), true, 'the scheme ignores case');
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('JaVaScRiPt:alert(1)'), false, 'mixed case');
  assert.equal(isHttpUrl('  javascript:alert(1)  '), false, 'padded');
  assert.equal(isHttpUrl('data:text/html,hi'), false);
  assert.equal(isHttpUrl(''), false);
  assert.equal(isHttpUrl(undefined), false);
});

// #601: the left column groups the agents by the issue their task names, so one issue
// shows its engineer, reviewer and verifier together. The rest is other work.
test('board page: agents group by issue; the rest is other work', () => {
  const script = boardScript();
  assert.ok(script.includes("'Issue ' + group.key"), 'each group names its issue');
  const run = new Function('document', 'location', 'fetch', 'setInterval', `${script}; return { issueOf, groupAgents };`) as unknown as (
    fakeDocument: unknown,
    fakeLocation: unknown,
    fakeFetch: () => Promise<never>,
    fakeTimer: () => number,
  ) => {
    issueOf: (task: unknown) => string;
    groupAgents: (agents: { name: string; task: string }[]) => { key: string; agents: { name: string; task: string }[] }[];
  };
  const { issueOf, groupAgents } = run({ getElementById: () => ({}) }, { search: '' }, () => Promise.reject(new Error('no net')), () => 0);
  assert.equal(issueOf('issue 601'), '601');
  assert.equal(issueOf('review issue #42'), '42');
  assert.equal(issueOf('ISSUE 7: polish'), '7');
  assert.equal(issueOf('just exploring'), '');
  assert.equal(issueOf(''), '');
  assert.equal(issueOf(undefined), '');
  assert.deepEqual(
    groupAgents([
      { name: 'a-worker', task: 'issue 601' },
      { name: 'a-review', task: 'review issue 601' },
      { name: 'b-worker', task: 'issue 602' },
      { name: 'lost', task: '' },
    ]).map((group) => [group.key, group.agents.map((agent) => agent.name)]),
    [
      ['601', ['a-worker', 'a-review']],
      ['602', ['b-worker']],
      ['', ['lost']],
    ],
  );
});

// #601: one board read over a raw socket, so no proxy setting can send it elsewhere,
// with any Host header. Each server test starts its own server, which never outlives
// the test: it closes in a finally.
function boardGet(target: string, headers: Record<string, string> = {}): Promise<{ status: number; kind: string; headers: Record<string, string>; text: string }> {
  const url = new URL(target);
  return new Promise((done, failed) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${headers.host ?? url.host}\r\nConnection: close\r\n\r\n`);
    });
    const parts: Buffer[] = [];
    socket.on('data', (chunk) => parts.push(chunk));
    socket.on('end', () => {
      const answer = Buffer.concat(parts);
      const split = answer.indexOf('\r\n\r\n');
      const [statusLine, ...rows] = answer.subarray(0, split).toString('utf8').split('\r\n');
      const found: Record<string, string> = {};
      for (const row of rows) {
        const at = row.indexOf(':');
        if (at > 0) found[row.slice(0, at).trim().toLowerCase()] = row.slice(at + 1).trim();
      }
      done({ status: Number(statusLine.split(' ')[1]), kind: found['content-type'] ?? '', headers: found, text: answer.subarray(split + 4).toString('utf8') });
    });
    socket.on('error', failed);
  });
}

// #601: the server listens on 127.0.0.1 only. The right Host and token see the page
// at /, the same data as JSON at /data, and nothing else. Nothing is stored, and no
// referrer leaves the page.
test('board server: the right Host and token see the page and the data', async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse', worktree: join(sandbox.home, 'w') }));
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null);
    assert.equal(address.address, '127.0.0.1', 'this machine only');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/, 'the link holds a random token');
    const base = url.split('?')[0];
    const token = new URL(url).searchParams.get('t') ?? '';
    const dataUrl = `${base}data?t=${token}`;
    const page = await boardGet(url);
    assert.equal(page.status, 200);
    assert.equal(page.kind, 'text/html; charset=utf-8');
    assert.equal(page.text, boardPage());
    const data = await boardGet(dataUrl);
    assert.equal(data.status, 200);
    assert.equal(data.kind, 'application/json; charset=utf-8');
    const shown = JSON.parse(data.text) as { repo: string; agents: unknown[]; pulls: unknown; worktrees: unknown[]; updated: string };
    assert.equal(shown.repo, sandbox.repo);
    assert.deepEqual(shown.agents, [{ name: 'w', vendor: 'muse', task: '', worktree: '~/w', doing: '', updated: '', role: '', age: '' }]);
    assert.equal(shown.pulls, 'this repo has no GitHub remote, so the board shows no pull requests');
    assert.deepEqual(shown.worktrees, [{ path: realpathSync(sandbox.repo), branch: 'main' }]);
    assert.match(shown.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const answer of [page, data]) {
      assert.equal(answer.headers['cache-control'], 'no-store', 'nothing is stored');
      assert.equal(answer.headers['referrer-policy'], 'no-referrer', 'no referrer leaves the page');
    }
    // localhost names the same server, so its Host is welcome too.
    assert.equal((await boardGet(url, { host: `localhost:${address.port}` })).status, 200);
    assert.equal((await boardGet(`${base}missing?t=${token}`)).status, 404);
    assert.doesNotThrow(() => server.emit('error', new Error('EADDRINUSE')), 'a server error is handled, never an uncaught throw');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #601: the board answers only its own Host, so a page open in the same browser
// cannot read /data through a rebound name. Anything else gets a 403.
test('board server: a wrong Host gets a 403', async () => {
  const sandbox = makeSandbox();
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const port = (server.address() as { port: number }).port;
    const token = new URL(url).searchParams.get('t') ?? '';
    const base = url.split('?')[0];
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port}.evil.example`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
      assert.equal((await boardGet(url, { host })).status, 403, `wrong Host on /: ${host}`);
      assert.equal((await boardGet(`${base}data?t=${token}`, { host })).status, 403, `wrong Host on /data: ${host}`);
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #601: / and /data refuse a missing token with a 403.
test('board server: a missing token gets a 403', async () => {
  const sandbox = makeSandbox();
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const base = url.split('?')[0];
    assert.equal((await boardGet(`${base}`)).status, 403, '/ without a token');
    assert.equal((await boardGet(`${base}data`)).status, 403, '/data without a token');
    assert.equal((await boardGet(`${base}?x=1`)).status, 403, 'another query, no token');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #601: / and /data refuse a wrong token with a 403, whatever its length.
test('board server: a wrong token gets a 403', async () => {
  const sandbox = makeSandbox();
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const base = url.split('?')[0];
    const token = new URL(url).searchParams.get('t') ?? '';
    const flipped = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    assert.equal((await boardGet(`${base}?t=wrong`)).status, 403, 'a short token on /');
    assert.equal((await boardGet(`${base}data?t=wrong`)).status, 403, 'a short token on /data');
    assert.equal((await boardGet(`${base}?t=${flipped}`)).status, 403, 'a token of the right length, one digit off, on /');
    assert.equal((await boardGet(`${base}data?t=${flipped}`)).status, 403, 'a token of the right length, one digit off, on /data');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #603: one board request over a raw socket, with any method, headers and body, so no
// proxy setting can send it elsewhere. Each server test closes its server in a finally.
function boardSend(target: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; kind: string; text: string }> {
  const url = new URL(target);
  const method = options.method ?? 'GET';
  const body = options.body ?? '';
  return new Promise((done, failed) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      const rows = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${options.headers?.host ?? url.host}`, 'Connection: close'];
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (key.toLowerCase() !== 'host') rows.push(`${key}: ${value}`);
      }
      if (method === 'POST') rows.push(`Content-Length: ${Buffer.byteLength(body)}`);
      socket.write(`${rows.join('\r\n')}\r\n\r\n${body}`);
    });
    const parts: Buffer[] = [];
    socket.on('data', (chunk) => parts.push(chunk));
    socket.on('end', () => {
      const answer = Buffer.concat(parts);
      const split = answer.indexOf('\r\n\r\n');
      const [statusLine, ...rows] = answer.subarray(0, split).toString('utf8').split('\r\n');
      const found: Record<string, string> = {};
      for (const row of rows) {
        const at = row.indexOf(':');
        if (at > 0) found[row.slice(0, at).trim().toLowerCase()] = row.slice(at + 1).trim();
      }
      done({ status: Number(statusLine.split(' ')[1]), kind: found['content-type'] ?? '', text: answer.subarray(split + 4).toString('utf8') });
    });
    socket.on('error', failed);
  });
}

// #603: a fake agent process. Tests pass it, so they never start a real agent. Each
// start is recorded with its command, folder and env; each kill by its pid.
function fakeAgents(): { spawner: BoardSpawner; started: { command: string; args: string[]; cwd: string; env: Env; events: BoardEvents }[]; killed: (number | null)[] } {
  const started: { command: string; args: string[]; cwd: string; env: Env; events: BoardEvents }[] = [];
  const killed: (number | null)[] = [];
  const spawner: BoardSpawner = (command, args, options, events) => {
    const pid = 1000 + started.length;
    started.push({ command, args, cwd: options.cwd, env: options.env, events });
    return { pid, kill: () => { killed.push(pid); } };
  };
  return { spawner, started, killed };
}

/** The page's Origin for a board link: the server only. */
function boardOrigin(url: string): string {
  const link = new URL(url);
  return `${link.protocol}//${link.host}`;
}

/** One change against the board with the token and the page's Origin, as the page sends it. */
function boardPost(url: string, path: string, body: string): Promise<{ status: number; kind: string; text: string }> {
  const token = new URL(url).searchParams.get('t') ?? '';
  return boardSend(`${url.split('?')[0]}${path}?t=${token}`, {
    method: 'POST',
    headers: { Origin: boardOrigin(url), 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

// #603: the brief names the issue, the worktree and the model; each vendor starts with
// its own headless command, and an unknown vendor has none.
test('board controls: the brief and the start commands', () => {
  const brief = boardBrief('603', '/repo/.worktrees/603', 'model-a');
  assert.ok(brief.includes('Issue: #603'), 'the issue');
  assert.ok(brief.includes('/repo/.worktrees/603'), 'the worktree');
  assert.ok(brief.includes('model-a'), 'the model');
  assert.ok(brief.includes('YOKOTEN_ROLE') === false, 'no env text in the brief');
  assert.deepEqual(boardStartParts('claude-code', 'hi')?.slice(0, 2), ['claude', '-p']);
  assert.deepEqual(boardStartParts('codex', 'hi')?.slice(0, 2), ['codex', 'exec']);
  assert.deepEqual(boardStartParts('muse', 'hi')?.slice(0, 3), ['muse', 'exec', '--trust-workspace']);
  assert.deepEqual(boardStartParts('grok', 'hi')?.slice(0, 2), ['grok', '-p']);
  assert.deepEqual(boardStartParts('antigravity', 'hi')?.slice(0, 2), ['agy', '-p']);
  assert.deepEqual(boardStartParts('deepseek-harness', 'hi')?.slice(0, 2), ['dsh', 'headless']);
  assert.ok(boardStartParts('claude-code', 'hi')?.at(-1) === 'hi', 'the brief is last');
  assert.equal(boardStartParts('gemini', 'hi'), null, 'no headless form on record: start it by hand');
  assert.equal(boardStartParts('', 'hi'), null);
  assert.deepEqual(readBoardStartAsk({ issue: '603', vendor: 'codex', model: 'model-a' }), { issue: '603', vendor: 'codex', model: 'model-a' });
  assert.match(readBoardStartAsk({ issue: 'x', vendor: 'codex', model: 'm' }) as string, /number/, 'the issue is a number');
  assert.match(readBoardStartAsk({ issue: '603', vendor: 'gemini', model: 'm' }) as string, /by hand/, 'an unknown vendor is refused');
  assert.match(readBoardStartAsk({ issue: '603', vendor: 'codex', model: '' }) as string, /model/, 'the model is named');
});

// #603: the limits change one side and keep the other; anything odd is refused plainly.
test('board controls: the limits change', () => {
  const controls = createBoardControls(join(makeTempDir(), 'board.log'));
  assert.deepEqual(controls.limits, { maxAgents: 3, byModel: {} });
  assert.deepEqual(setBoardLimits(controls, { maxAgents: '2' }), { maxAgents: 2, byModel: {} });
  assert.deepEqual(setBoardLimits(controls, { models: 'model-a:1, model-b:2' }), { maxAgents: 2, byModel: { 'model-a': 1, 'model-b': 2 } });
  assert.match(setBoardLimits(controls, { maxAgents: '0' }) as string, /1 to 32/);
  assert.match(setBoardLimits(controls, { maxAgents: 'many' }) as string, /1 to 32/);
  assert.match(setBoardLimits(controls, { models: 'model-a:x' }) as string, /name:count/);
  assert.match(setBoardLimits(controls, { models: 'model-a' }) as string, /name:count/);
  assert.match(setBoardLimits(controls, {}) as string, /maxAgents, models/);
  assert.deepEqual(readBoardLimitChange({ maxAgents: '33' }) as string, 'set maxAgents to a whole number from 1 to 32');
});

// #603: the open issues as rows, or why gh cannot read them.
test('board controls: the open issues', () => {
  const gh: Gh = () => JSON.stringify([{ number: 603, title: 'board agents', url: 'https://example.com/i/603' }, { number: 'x' }, null]);
  assert.deepEqual(readBoardIssues(gh, 'octo/demo'), [{ number: 603, title: 'board agents', url: 'https://example.com/i/603' }]);
  assert.equal(readBoardIssues(() => { throw new Error('no net'); }, 'octo/demo'), 'gh could not list the open issues: run it again');
  assert.equal(readBoardIssues(() => 'oops', 'octo/demo'), 'gh gave no open issue list: run it again');
});

// #603: from the page, the owner starts a worker on an issue, sees its output, and
// stops it. Stopping keeps the worktree, and the log holds the start and the stop.
test('board server: start an agent, see its output, stop it', async () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh, { controls });
  try {
    const started = await boardPost(url, 'agents/start', 'issue=12&vendor=claude-code&model=model-a');
    assert.equal(started.status, 200, started.text);
    assert.deepEqual(JSON.parse(started.text), { name: 'issue-12-claude-code', worktree: join(sandbox.repo, '.worktrees', '12'), pid: 1000 });
    assert.equal(agents.started.length, 1);
    assert.equal(agents.started[0].command, 'claude');
    assert.deepEqual(agents.started[0].args.slice(0, 1), ['-p']);
    assert.ok(agents.started[0].args.at(-1)?.includes('Issue: #12'), 'the brief is the last word');
    assert.equal(agents.started[0].cwd, join(sandbox.repo, '.worktrees', '12'), 'its own worktree');
    assert.ok(existsSync(join(sandbox.repo, '.worktrees', '12')), 'the worktree is made');
    assert.equal(agents.started[0].env.YOKOTEN_ROLE, 'worker', 'a worker, like the dispatch skill');
    assert.equal(agents.started[0].env.YOKOTEN_MODEL, 'model-a');
    agents.started[0].events.line('doing the task');
    const token = new URL(url).searchParams.get('t') ?? '';
    const data = JSON.parse((await boardSend(`${url.split('?')[0]}data?t=${token}`)).text) as { runs: { name: string; status: string; output: string[]; worktree: string }[] };
    assert.equal(data.runs.length, 1);
    assert.equal(data.runs[0].output.join('\n'), 'doing the task', 'the latest output shows');
    const stopped = await boardPost(url, 'agents/stop', 'name=issue-12-claude-code');
    assert.equal(stopped.status, 200, stopped.text);
    assert.deepEqual(agents.killed, [1000], 'only its own process stops');
    assert.ok(existsSync(join(sandbox.repo, '.worktrees', '12')), 'stopping keeps the worktree');
    const log = readFileSync(join(sandbox.repo, '.yokoten-board.log'), 'utf8');
    assert.match(log, /start issue-12-claude-code pid 1000 issue #12 claude-code model-a/, 'the log holds the start');
    assert.match(log, /stop issue-12-claude-code pid 1000 issue #12/, 'the log holds the stop');
    assert.equal((await boardPost(url, 'agents/stop', 'name=issue-12-claude-code')).status, 409, 'stopping twice is refused');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #603: over the limit, the board refuses with a plain reason; a higher limit starts it.
test('board server: over the limit the start is refused', async () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh, { controls });
  try {
    assert.equal((await boardPost(url, 'agents/limits', 'maxAgents=1')).status, 200);
    assert.equal((await boardPost(url, 'agents/start', 'issue=12&vendor=claude-code&model=model-a')).status, 200);
    const over = await boardPost(url, 'agents/start', 'issue=13&vendor=codex&model=model-a');
    assert.equal(over.status, 409, 'one too many');
    assert.match(over.text, /already runs 1 agent of 1/, 'a plain reason');
    assert.equal(over.kind, 'text/plain; charset=utf-8');
    assert.equal((await boardPost(url, 'agents/limits', 'maxAgents=3')).status, 200);
    assert.equal((await boardPost(url, 'agents/start', 'issue=13&vendor=codex&model=model-a')).status, 200);
    assert.match((await boardPost(url, 'agents/limits', 'models=model-a%3A2')).text, /model-a/, 'a per-model cap saves');
    const capped = await boardPost(url, 'agents/start', 'issue=14&vendor=grok&model=model-a');
    assert.equal(capped.status, 409);
    assert.match(capped.text, /model-a/, 'names the model');
    assert.equal((await boardPost(url, 'agents/start', 'issue=14&vendor=grok&model=model-b')).status, 200, 'another model still starts');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #603: the waiting list shows a tier A pull with green checks and no Approve, and a
// guard stop; an approved, tier B, red or closed pull never shows.
test('board server: the waiting list shows what needs the owner', async () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git');
  const tree = realpathSync(sandbox.repo);
  writeFileSync(
    join(sandbox.repo, '.yokoten-agent.json'),
    JSON.stringify({ name: 'w', vendor: 'muse', task: 'issue 601', worktree: tree, doing: 'blocked', updated: '2026-10-22T10:00:00Z', role: 'engineer', blocked: 'the guard stopped a force push: say which branch', question: 'one scope or the repo?', link: 'https://example.com/pull/7' }),
  );
  const pull = (number: number, branch: string, state: string, review: string, checks: unknown[], labels: unknown[]) => ({
    number, title: `work ${number}`, headRefName: branch, url: `https://example.com/pull/${number}`, state, reviewDecision: review, isDraft: false, statusCheckRollup: checks, labels,
  });
  const pass = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const gh: Gh = (args) => {
    if (args[0] === 'issue') return '[]';
    return JSON.stringify([
      pull(7, 'main', 'OPEN', 'REVIEW_REQUIRED', pass, [{ name: 'tier A' }]),
      pull(8, 'main', 'OPEN', 'APPROVED', pass, [{ name: 'tier A' }]),
      pull(9, 'main', 'OPEN', 'REVIEW_REQUIRED', pass, [{ name: 'tier B' }]),
      pull(10, 'main', 'MERGED', 'APPROVED', pass, [{ name: 'tier A' }]),
      pull(11, 'other', 'OPEN', '', pass, [{ name: 'tier A' }]),
    ]);
  };
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh, { controls });
  try {
    const token = new URL(url).searchParams.get('t') ?? '';
    const data = JSON.parse((await boardSend(`${url.split('?')[0]}data?t=${token}`)).text) as { waiting: { kind: string; agent: string; role: string; wait: string; why: string; link: string }[] };
    const kinds = data.waiting.map((row) => [row.kind, row.agent]);
    assert.ok(kinds.some(([kind, agent]) => kind === 'approve' && agent === 'w'), `tier A with green checks and no Approve shows, with its agent: ${JSON.stringify(kinds)}`);
    assert.ok(kinds.some(([kind, agent]) => kind === 'guard' && agent === 'w'), 'the guard stop shows');
    assert.ok(kinds.some(([kind, agent]) => kind === 'question' && agent === 'w'), 'the question shows');
    assert.ok(kinds.some(([kind, agent]) => kind === 'approve' && agent === ''), 'a pull with no agent still shows');
    assert.ok(!data.waiting.some((row) => row.why.includes('#8')), 'an approved pull never waits');
    assert.ok(!data.waiting.some((row) => row.why.includes('#9')), 'tier B never waits here');
    assert.ok(!data.waiting.some((row) => row.why.includes('#10')), 'a merged pull never waits');
    const row = data.waiting.find((one) => one.kind === 'approve' && one.agent === 'w');
    assert.equal(row?.role, 'engineer', 'the row shows the role');
    assert.ok(row?.wait, 'the row shows how long it waited');
    assert.ok(row?.why, 'the row says why in one line');
    assert.equal(row?.link, 'https://example.com/pull/7', 'the row links where the owner acts');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #603: no agent action clears a waiting item. The list has no clear endpoint; an agent
// that stops naming its hold-up still shows, and a refused change leaves it as it is.
test('board server: no agent action clears a waiting item', async () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git');
  const tree = realpathSync(sandbox.repo);
  const file = join(sandbox.repo, '.yokoten-agent.json');
  writeFileSync(file, JSON.stringify({ name: 'w', task: 'issue 601', worktree: tree, updated: '2026-10-22T10:00:00Z', role: 'engineer', blocked: 'the guard stopped a force push', question: 'one scope or the repo?' }));
  const pass = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const gh: Gh = (args) => {
    if (args[0] === 'issue') return '[]';
    return JSON.stringify([{ number: 7, title: 'work 7', headRefName: 'main', url: 'https://example.com/pull/7', state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, statusCheckRollup: pass, labels: [{ name: 'tier A' }] }]);
  };
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh, { controls });
  try {
    const base = url.split('?')[0];
    const token = new URL(url).searchParams.get('t') ?? '';
    const waiting = async () => (JSON.parse((await boardSend(`${base}data?t=${token}`)).text) as { waiting: { kind: string; agent: string }[] }).waiting;
    assert.equal((await waiting()).length, 3, 'an Approve, a guard stop, and a question');
    writeFileSync(file, JSON.stringify({ name: 'w', task: 'issue 601', worktree: tree, updated: '2026-10-22T10:30:00Z', role: 'engineer' }));
    assert.equal((await waiting()).length, 3, 'an agent that stops naming its hold-up still shows');
    assert.equal((await boardPost(url, 'agents/stop', 'name=w')).status, 404, 'no run of that name');
    assert.equal((await waiting()).length, 3, 'a refused stop changes nothing');
    assert.equal((await boardSend(`${base}waiting/clear?t=${token}`, { method: 'POST', headers: { Origin: boardOrigin(url) }, body: '' })).status, 404, 'no clear endpoint');
    assert.equal((await boardSend(`${base}data?t=${token}`, { method: 'POST', headers: { Origin: boardOrigin(url) }, body: '' })).status, 404, 'no change down the read path');
    assert.equal((await waiting()).length, 3, 'the list is read only');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #603: every safety refusal: a wrong token, a missing or wrong Origin, and a process
// the board did not start. Each says why in plain words.
test('board server: a change without the token or the Origin is refused', async () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh, { controls });
  try {
    const base = url.split('?')[0];
    const origin = boardOrigin(url);
    const body = 'issue=12&vendor=claude-code&model=model-a';
    assert.equal((await boardSend(`${base}agents/start?t=wrong`, { method: 'POST', headers: { Origin: origin }, body })).status, 403, 'a wrong token');
    assert.equal((await boardSend(`${base}agents/start?t=${new URL(url).searchParams.get('t')}`, { method: 'POST', body })).status, 403, 'a missing Origin');
    assert.equal((await boardSend(`${base}agents/start?t=${new URL(url).searchParams.get('t')}`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:9' }, body })).status, 403, 'a wrong Origin');
    assert.equal((await boardSend(`${base}agents/start?t=${new URL(url).searchParams.get('t')}`, { method: 'POST', headers: { Origin: 'https://example.com' }, body })).status, 403, 'an outside Origin');
    assert.equal(agents.started.length, 0, 'nothing started');
    assert.equal((await boardPost(url, 'agents/start', 'issue=x&vendor=claude-code&model=model-a')).status, 400, 'a bad issue is refused');
    assert.match((await boardPost(url, 'agents/start', 'issue=x&vendor=claude-code&model=model-a')).text, /number/);
    assert.equal((await boardPost(url, 'agents/start', 'issue=12&vendor=gemini&model=model-a')).status, 400, 'an unknown vendor is refused');
    assert.match((await boardPost(url, 'agents/start', 'issue=12&vendor=gemini&model=model-a')).text, /by hand/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #603: stop only stops a process the board started: any other name is refused, and a
// neighbour the board started keeps running.
test('board server: stop only stops what the board started', async () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh, { controls });
  try {
    assert.equal((await boardPost(url, 'agents/start', 'issue=12&vendor=claude-code&model=model-a')).status, 200);
    assert.equal((await boardPost(url, 'agents/start', 'issue=13&vendor=codex&model=model-b')).status, 200);
    const foreign = await boardPost(url, 'agents/stop', 'name=issue-99-claude-code');
    assert.equal(foreign.status, 404, 'a process the board did not start');
    assert.match(foreign.text, /no agent called issue-99-claude-code was started by this board/);
    assert.equal((await boardPost(url, 'agents/stop', 'name=')).status, 404, 'no name at all');
    const stopped = await boardPost(url, 'agents/stop', 'name=issue-12-claude-code');
    assert.equal(stopped.status, 200, stopped.text);
    assert.deepEqual(agents.killed, [1000], 'the neighbour keeps running');
    assert.equal(stopBoardAgent(controls, 'nope'), 'no agent called nope was started by this board', 'direct, too');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #603: the attention comes from the status files; a missing, broken, or quiet file is skipped.
test('board controls: the attention in the status files', () => {
  const folder = makeTempDir();
  const trees = [{ path: folder, branch: 'main' }];
  assert.deepEqual(readBoardAttention(trees), [], 'no file, no hold-up');
  writeFileSync(join(folder, '.yokoten-agent.json'), '{oops');
  assert.deepEqual(readBoardAttention(trees), [], 'a broken file is skipped');
  writeFileSync(join(folder, '.yokoten-agent.json'), JSON.stringify({ name: 'w', role: 'reviewer', updated: '2026-10-22T10:00:00Z', doing: 'fine' }));
  assert.deepEqual(readBoardAttention(trees), [], 'a quiet file is skipped');
  writeFileSync(join(folder, '.yokoten-agent.json'), JSON.stringify({ name: 'w', role: 'reviewer', updated: '2026-10-22T10:00:00Z', blocked: 'the guard stopped it\nsecond line', question: 'which one?', link: 'javascript:alert(1)' }));
  assert.deepEqual(readBoardAttention(trees), [
    { name: 'w', vendor: '', role: 'reviewer', worktree: '', updated: '2026-10-22T10:00:00Z', kind: 'guard', why: 'the guard stopped it', link: '' },
    { name: 'w', vendor: '', role: 'reviewer', worktree: '', updated: '2026-10-22T10:00:00Z', kind: 'question', why: 'which one?', link: '' },
  ], 'one line each, and no odd link');
});

// #603: the waiting list latches an agent row while the agent is here, and drops it
// when it leaves; Approve rows follow the pulls.
test('board controls: the waiting list latches while the agent is here', () => {
  const board = { repo: 'r', agents: [{ name: 'w', vendor: '', task: '', worktree: 'p', doing: '', updated: '2026-10-22T10:00:00Z', role: 'engineer' as const }], pulls: [], worktrees: [{ path: 'p', branch: 'main' }] };
  const held = [{ name: 'w', vendor: '', role: 'engineer' as const, worktree: 'p', updated: '2026-10-22T10:00:00Z', kind: 'guard' as const, why: 'the guard stopped it', link: '' }];
  const seen: BoardWaiting[] = [];
  assert.deepEqual(collectBoardWaiting(board, held, [], seen).map((row) => row.kind), ['guard']);
  assert.deepEqual(collectBoardWaiting(board, [], [], seen).map((row) => row.kind), ['guard'], 'a quiet file clears nothing');
  assert.deepEqual(collectBoardWaiting({ ...board, agents: [] }, [], [], seen), [], 'leaving clears it');
});

// #603: the page shows the waiting list, the start and limits forms, the runs and their
// output, and no Approve or Merge button anywhere.
test('board page: the waiting list, the controls, and no Approve or Merge button', () => {
  const page = boardPage();
  assert.ok(page.includes('<div id="waiting"></div>'), 'the waiting list at the top');
  assert.ok(page.includes('<div id="started"></div>'), 'the runs the board started');
  assert.ok(page.includes('<div id="output"></div>'), 'the latest output');
  assert.ok(page.includes('id="start"'), 'the start form');
  assert.ok(page.includes('id="limits"'), 'the limits form');
  assert.ok(page.includes('Nothing waits for you.'), 'the empty state says so');
  assert.ok(page.includes('application/x-www-form-urlencoded'), 'forms, never raw JSON');
  assert.ok(!/>Approve</.test(page), 'no Approve button');
  assert.ok(!/>Merge</.test(page), 'no Merge button');
  assert.ok(!/fetch\('[^']*(approve|merge)/i.test(page), 'no call that approves or merges');
  assert.ok(page.includes("<div id=\"groups\"></div>"), 'the left sidebar stays');
  assert.ok(page.includes("<div id=\"detail\"></div>"), 'the middle stays');
  assert.ok(page.includes('agents/start') && page.includes('agents/stop') && page.includes('agents/limits'), 'the page only changes through the board');
});
