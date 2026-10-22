// Tests for src/commands/advice/board.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { ageText, boardPage, collectBoard, readBoardAgents, readBoardWorktrees, renderBoardText, startBoardServer } from '../../../src/commands/advice/board.ts';
import type { Gh } from '../../../src/host/github.ts';

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
