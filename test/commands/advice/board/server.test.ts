// Tests for src/commands/advice/board/server.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../../repo/helpers.ts';
import { startBoardServer } from '../../../../src/commands/advice/board/server.ts';
import type { BoardData } from '../../../../src/commands/advice/board/view.ts';
import type { Gh } from '../../../../src/host/github.ts';

// #601: `yokoten board --text` prints the team as plain text. An agent joins by writing
// .yokoten-agent.json at its worktree's root, and leaves by removing it.
test('board --text: the entry, an agent that joins and leaves, and the usage errors', async () => {
  const sandbox = makeSandbox();
  // The entry, through the real binary; the rest runs in this process.
  const started = sandbox.run(['board', '--text']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /^yokoten board: \S+\n0 agents, 0 open pull requests, 1 worktree\.\n\nNeeds you:\n- nothing\.\n\nAgents:\n- none\. An agent joins by writing \.yokoten-agent\.json in its worktree\.\n\nPull requests:\n- this repo has no GitHub remote, so the board shows no pull requests\n\nWorktrees:\n- \S+ \(main\)\n$/);
  const file = join(sandbox.repo, '.yokoten-agent.json');
  writeFileSync(file, JSON.stringify({ name: 'worker-1', vendor: 'claude-code', task: 'issue 601', worktree: sandbox.repo, doing: 'writing tests', updated: new Date().toISOString() }));
  const joined = await sandbox.call(['board', '--text']);
  assert.equal(joined.status, 0, joined.stderr);
  assert.match(joined.stdout, /\n1 agent, 0 open pull requests, 1 worktree\.\n/);
  assert.match(joined.stdout, /- worker-1 \(Claude\): issue 601, in \S+, writing tests, just now\n/);
  rmSync(file);
  const left = await sandbox.call(['board', '--text']);
  assert.match(left.stdout, /\n0 agents, 0 open pull requests, 1 worktree\.\n/);
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
    { number: 6, title: 'old work', headRefName: 'old', url: '', state: 'MERGED', mergedAt: new Date().toISOString(), reviewDecision: 'APPROVED', isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }], labels: [] },
  ];
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(pulls))});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const result = await sandbox.call(['board', '--text'], { extra: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\n0 agents, 1 open pull request, 1 worktree\.\n/);
  assert.match(result.stdout, /\n- #7 team page \[board\]: Ready to merge, tier B\n- #6 old work: merged\n/);
});

// #601: one status file per worktree, at its root, read in worktree order. A missing,
// broken or odd file never breaks the board; a missing name is the worktree's folder

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
    // Only the page's own script runs: its nonce is in the policy, and each load gets a new one.
    const nonce = /<script nonce="([^"]+)">/.exec(page.text)?.[1] ?? '';
    assert.ok(nonce.length >= 20, 'the script carries a nonce');
    assert.match(page.headers['content-security-policy'] ?? '', new RegExp(`^default-src 'none'; script-src 'nonce-${nonce.replace(/[+/=]/g, (c) => `\\${c}`)}';`));
    assert.match(page.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    assert.notEqual(/<script nonce="([^"]+)">/.exec((await boardGet(url)).text)?.[1], nonce, 'a new nonce on each load');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const data = await boardGet(dataUrl);
    assert.equal(data.status, 200);
    assert.equal(data.kind, 'application/json; charset=utf-8');
    const shown = JSON.parse(data.text) as BoardData & { feeds: Record<string, { kind: string; text: string }[]> };
    assert.equal(shown.repo, sandbox.repo);
    assert.deepEqual(shown.agents.map((agent) => [agent.name, agent.vendor.name, agent.dot, agent.branch]), [['w', 'Muse', 'idle', 'main']]);
    assert.deepEqual(shown.needs, []);
    assert.deepEqual(shown.merged, []);
    assert.equal(shown.pulls, 'this repo has no GitHub remote, so the board shows no pull requests');
    assert.deepEqual(shown.worktrees, [{ path: realpathSync(sandbox.repo), branch: 'main' }]);
    assert.deepEqual(shown.feeds, {}, 'nothing done yet, so no steps');
    // An agent that says what it does gets a step in its feed on the next read.
    writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse', doing: 'writing tests' }));
    const later = JSON.parse((await boardGet(dataUrl)).text) as { feeds: Record<string, { kind: string; text: string }[]> };
    assert.deepEqual(Object.values(later.feeds).map((feed) => feed.map((event) => [event.kind, event.text])), [[['step', 'writing tests']]]);
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
