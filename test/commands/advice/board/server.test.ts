// Tests for src/commands/advice/board/server.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { CLI, makeSandbox } from '../../../repo/helpers.ts';
import { boardHostName, boardPort, browserCommand, runBoard, startBoardServer } from '../../../../src/commands/advice/board/server.ts';
import { type BoardData, createBoardGitHub, nicknameId, nicknameOf } from '../../../../src/commands/advice/board/view.ts';
import type { Invocation, Output } from '../../../../src/commands/shared.ts';
import { type Gh, ghLaterIn } from '../../../../src/host/github/index.ts';
import type { Env } from '../../../../src/rules/config.ts';
import {
  createBoardControls,
  startBoardAgent,
  stopBoardAgent,
  type BoardEvents,
  type BoardSpawner,
} from '../../../../src/commands/advice/board/controls.ts';

// #601: `yokoten board --text` prints the team as plain text. An agent joins by writing
// .yokoten-agent.json at its worktree's root, and leaves by removing it.
test('board --text: the entry, an agent that joins and leaves, and the usage errors', async () => {
  const sandbox = makeSandbox();
  // The entry, through the real binary; the rest runs in this process.
  const started = sandbox.run(['board', '--text']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /^yokoten board: \S+\n0 agents, 0 open pull requests, 1 worktree\.\n\nNeeds you:\n- nothing\.\n\nAgents:\n- none\. Start an agent in this repo or its worktrees, or from the board page: it shows here by itself\.\n\nPull requests:\n- this repo has no GitHub remote, so the board shows no pull requests\n\nWorktrees:\n- \S+ \(main\)\n$/);
  const file = join(sandbox.repo, '.yokoten-agent.json');
  const who = nicknameOf(nicknameId(realpathSync(sandbox.repo), 'worker-1'), []);
  writeFileSync(file, JSON.stringify({ name: 'worker-1', vendor: 'claude-code', task: 'issue 601', worktree: sandbox.repo, doing: 'writing tests', updated: new Date().toISOString() }));
  const joined = await sandbox.call(['board', '--text']);
  assert.equal(joined.status, 0, joined.stderr);
  assert.match(joined.stdout, /\n1 agent, 0 open pull requests, 1 worktree\.\n/);
  assert.match(joined.stdout, new RegExp(`- ${who} \\(Claude\\): issue 601, in \\S+, writing tests, just now\n`));
  rmSync(file);
  const left = await sandbox.call(['board', '--text']);
  assert.match(left.stdout, /\n0 agents, 0 open pull requests, 1 worktree\.\n/);
  assert.match(left.stdout, /- none\. Start an agent in this repo or its worktrees, or from the board page: it shows here by itself\.\n/);
  // A fake HOME above the repo: every shown path hides it.
  writeFileSync(file, JSON.stringify({ name: 'worker-1', worktree: sandbox.repo }));
  const hidden = await sandbox.call(['board', '--text'], { extra: { HOME: dirname(sandbox.repo) } });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.match(hidden.stdout, /^yokoten board: ~\/repo\n/);
  assert.match(hidden.stdout, new RegExp(`- ${who}: in ~/repo\n`));
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

// #693: the address is the folder name on localhost, and the port stays with the repo path.
test('board address: the host name is safe, and the port stays with the repo', () => {
  const sandbox = makeSandbox();
  assert.equal(boardHostName(sandbox.repo), 'repo');
  assert.equal(boardHostName(join(sandbox.home, 'My Repo')), 'my-repo');
  assert.equal(boardHostName(join(sandbox.home, 'A_B.C')), 'a-b-c');
  assert.equal(boardHostName(join(sandbox.home, '---')), 'board');
  assert.equal(boardHostName(join(sandbox.home, '...')), 'board');
  assert.equal(boardHostName(join(sandbox.home, '\uFF21b')), 'ab', 'a fullwidth letter becomes the plain letter');
  assert.equal(boardHostName(join(sandbox.home, 'x'.repeat(80))), 'x'.repeat(63), 'a label stays within 63 letters');
  assert.equal(boardHostName(join(sandbox.home, `${'a'.repeat(62)}-b`)), 'a'.repeat(62), 'a cut label does not end on a hyphen');
  const port = boardPort(sandbox.repo);
  assert.equal(boardPort(sandbox.repo), port, 'the same path asks for the same port');
  assert.ok(port >= 28416 && port < 28416 + 4000, `the port stays in the high range: ${port}`);
  const link = join(sandbox.home, 'same-repo');
  symlinkSync(sandbox.repo, link);
  assert.equal(boardPort(link), port, 'two paths to one repo share a port');
  assert.equal(boardHostName(link), 'same-repo', 'the host name is the folder name as given');
  const missing = join(sandbox.home, 'not-there-yet');
  assert.equal(boardPort(missing), boardPort(missing), 'a missing folder still has a stable port');
  assert.ok(boardPort(missing) >= 28416 && boardPort(missing) < 28416 + 4000);
});

// #601: one status file per worktree, at its root, read in worktree order. A missing,
// broken or odd file never breaks the board; a missing name is the worktree's folder

/** `*.localhost` is loopback in a browser. This machine's DNS does not resolve it, so tests dial 127.0.0.1 and send the Host header. */
function boardDial(hostname: string): string {
  return hostname === 'localhost' || hostname.endsWith('.localhost') ? '127.0.0.1' : hostname;
}

// #601: one board read over a raw socket, so no proxy setting can send it elsewhere,
// with any Host header. Each server test starts its own server, which never outlives
// the test: it closes in a finally.
function boardGet(target: string, headers: Record<string, string> = {}): Promise<{ status: number; kind: string; headers: Record<string, string>; text: string }> {
  const url = new URL(target);
  return new Promise((done, failed) => {
    const socket = connect(Number(url.port), boardDial(url.hostname), () => {
      const rows = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${headers.host ?? url.host}`, 'Connection: close'];
      for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() !== 'host') rows.push(`${key}: ${value}`);
      socket.write(`${rows.join('\r\n')}\r\n\r\n`);
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

/** The cookie from the first visit. The link's token sets it and redirects; the body stays behind the cookie. */
async function boardCookie(url: string): Promise<string> {
  const first = await boardGet(url);
  assert.equal(first.status, 303, first.text);
  const match = /^yokoten-board=([0-9a-f]{32}); HttpOnly; Secure; SameSite=Strict; Path=\/$/.exec(first.headers['set-cookie'] ?? '');
  assert.ok(match, 'the first visit sets an HttpOnly Secure SameSite=Strict cookie');
  assert.equal((first.headers['set-cookie'] ?? '').toLowerCase().includes('domain='), false, 'the cookie stays on this host');
  assert.equal(first.headers.location?.includes('token'), false, 'the redirect drops the token');
  assert.equal(first.text.includes(match?.[1] ?? 'missing'), false, 'the redirect body has no token');
  return `yokoten-board=${match?.[1] ?? ''}`;
}

/** One read after the redirect, with the cookie and no token in the address. */
async function boardRead(url: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; kind: string; headers: Record<string, string>; text: string }> {
  const cookie = headers.cookie ?? await boardCookie(url);
  return boardGet(`${url.split('?')[0]}${path}`, { ...headers, cookie });
}

// #601: the server listens on 127.0.0.1 only. The right Host and cookie see the page
// at /, the same data as JSON at /data, and nothing else. Nothing is stored, and no
// referrer leaves the page.
test('board server: the right Host and cookie see the page and the data', async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse', worktree: join(sandbox.home, 'w') }));
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null);
    assert.equal(address.address, '127.0.0.1', 'this machine only');
    assert.match(url, /^http:\/\/repo\.localhost:\d+\/\?token=[0-9a-f]{32}$/, 'the link is the repo name on localhost, with the token once');
    const token = new URL(url).searchParams.get('token') ?? '';
    const cookie = await boardCookie(url);
    const page = await boardRead(url, '', { cookie });
    assert.equal(page.status, 200);
    assert.equal(page.text.includes(token), false, 'the page does not hold the token');
    assert.equal(page.kind, 'text/html; charset=utf-8');
    // Only the page's own script runs: its nonce is in the policy, and each load gets a new one.
    const nonce = /<script nonce="([^"]+)">/.exec(page.text)?.[1] ?? '';
    assert.ok(nonce.length >= 20, 'the script carries a nonce');
    assert.match(page.headers['content-security-policy'] ?? '', new RegExp(`^default-src 'none'; script-src 'nonce-${nonce.replace(/[+/=]/g, (c) => `\\${c}`)}';`));
    assert.match(page.headers['content-security-policy'] ?? '', /manifest-src 'self'/);
    assert.match(page.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    const manifest = JSON.parse((await boardRead(url, 'manifest.webmanifest', { cookie })).text) as { name: string; display: string };
    assert.equal(manifest.name, 'yokoten board');
    assert.equal(manifest.display, 'standalone');
    assert.equal((await boardGet(`${url.split('?')[0]}manifest.webmanifest`)).status, 403, 'the manifest needs the cookie');
    assert.notEqual(/<script nonce="([^"]+)">/.exec((await boardRead(url, '', { cookie })).text)?.[1], nonce, 'a new nonce on each load');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const data = await boardRead(url, 'data', { cookie });
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
    const later = JSON.parse((await boardRead(url, 'data', { cookie })).text) as { feeds: Record<string, { kind: string; text: string }[]> };
    assert.deepEqual(Object.values(later.feeds).map((feed) => feed.map((event) => [event.kind, event.text])), [[['step', 'writing tests']]]);
    assert.match(shown.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const answer of [page, data]) {
      assert.equal(answer.headers['cache-control'], 'no-store', 'nothing is stored');
      assert.equal(answer.headers['referrer-policy'], 'no-referrer', 'no referrer leaves the page');
    }
    // localhost and 127.0.0.1 name the same server, so those Host headers are welcome too.
    assert.equal((await boardRead(url, '', { cookie, host: `localhost:${address.port}` })).status, 200);
    assert.equal((await boardRead(url, '', { cookie, host: `127.0.0.1:${address.port}` })).status, 200);
    assert.equal((await boardRead(url, 'missing', { cookie })).status, 404);
    assert.doesNotThrow(() => server.emit('error', new Error('EADDRINUSE')), 'a server error is handled, never an uncaught throw');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #603: the page's controls read the waiting list, the open issues, the runs and
// the limits from /data, with the board.
test('board server: /data serves the waiting list, issues, runs and limits', async () => {
  const sandbox = makeSandbox();
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const data = JSON.parse((await boardRead(url, 'data')).text) as Record<string, unknown>;
    for (const key of ['waiting', 'issues', 'runs', 'limits']) assert.ok(key in data, `the page reads ${key} from /data`);
    assert.deepEqual(data.limits, { maxAgents: 3, byModel: {} });
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
    const cookie = await boardCookie(url);
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port}.evil.example`, '127.0.0.1', `127.0.0.1:${port + 1}`, `other.localhost:${port}`]) {
      assert.equal((await boardGet(url, { host })).status, 403, `wrong Host on /: ${host}`);
      assert.equal((await boardRead(url, 'data', { cookie, host })).status, 403, `wrong Host on /data: ${host}`);
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #693: / and /data refuse a missing cookie with a 403. The query token is not a second key.
test('board server: a missing cookie gets a 403', async () => {
  const sandbox = makeSandbox();
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const base = url.split('?')[0];
    assert.equal((await boardGet(base)).status, 403, '/ without a cookie');
    assert.equal((await boardGet(`${base}data`)).status, 403, '/data without a cookie');
    assert.equal((await boardGet(`${base}feed`)).status, 403, '/feed without a cookie');
    assert.equal((await boardGet(`${base}manifest.webmanifest`)).status, 403, 'the manifest without a cookie');
    assert.equal((await boardGet(`${base}?x=1`)).status, 403, 'another query, no cookie');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #693: a wrong cookie is refused, and a wrong token sets no cookie.
test('board server: a wrong cookie or token gets a 403', async () => {
  const sandbox = makeSandbox();
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const base = url.split('?')[0];
    const token = new URL(url).searchParams.get('token') ?? '';
    const flipped = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    const wrongLink = await boardGet(`${base}?token=wrong`);
    assert.equal(wrongLink.status, 403, 'a short token on /');
    assert.equal(wrongLink.headers['set-cookie'], undefined, 'a wrong token sets no cookie');
    assert.equal((await boardGet(`${base}data?token=wrong`)).status, 403, 'a short token on /data');
    assert.equal((await boardGet(`${base}?token=${flipped}`)).status, 403, 'a token of the right length, one digit off');
    assert.equal((await boardGet(base, { cookie: 'yokoten-board=wrong' })).status, 403, 'a short cookie');
    assert.equal((await boardGet(`${base}data`, { cookie: `yokoten-board=${flipped}` })).status, 403, 'a cookie of the right length, one digit off');
    assert.equal((await boardGet(`${base}feed`, { cookie: `yokoten-board=${flipped}` })).status, 403, 'a wrong cookie on /feed');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #693: the first visit leaves the token behind. Later pages and the log never show it.
test('board server: the first visit redirects, and the token stays out of the page and the log', async () => {
  const sandbox = makeSandbox();
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh);
  try {
    const token = new URL(url).searchParams.get('token') ?? '';
    const base = url.split('?')[0];
    const first = await boardGet(`${base}?token=${token}&x=1`);
    assert.equal(first.status, 303);
    assert.equal(first.headers.location, '/?x=1', 'other query words stay, the token does not');
    assert.equal(first.text.includes(token), false, 'the redirect body has no token');
    const cookie = `yokoten-board=${token}`;
    const page = await boardGet(`${base}?x=1`, { cookie });
    assert.equal(page.status, 200);
    assert.equal(page.text.includes(token), false, 'the page has no token');
    assert.equal(page.headers['set-cookie'], undefined, 'a later visit sets no cookie');
    const data = await boardGet(`${base}data`, { cookie });
    assert.equal(data.text.includes(token), false, '/data has no token');
    const manifestHop = await boardGet(`${base}manifest.webmanifest?token=${token}`);
    assert.equal(manifestHop.status, 303);
    assert.equal(manifestHop.headers.location, '/manifest.webmanifest', 'the manifest path is kept, the token is not');
    assert.equal(manifestHop.text.includes(token), false, 'the redirect body has no token');
    const sneak = await boardGet(`${base.replace(/\/$/, '')}/..%2F..%2Fetc?token=${token}`);
    assert.equal(sneak.status === 303 ? sneak.headers.location : '/', '/', 'a strange path returns to the page');
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
    const socket = connect(Number(url.port), boardDial(url.hostname), () => {
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

/** One change against the board with the cookie and the page's Origin, as the page sends it. */
async function boardPost(url: string, path: string, body: string): Promise<{ status: number; kind: string; text: string }> {
  const cookie = await boardCookie(url);
  return boardSend(`${url.split('?')[0]}${path}`, {
    method: 'POST',
    headers: { Origin: boardOrigin(url), 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  });
}

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
    const token = new URL(url).searchParams.get('token') ?? '';
    const data = JSON.parse((await boardRead(url, 'data')).text) as { runs: { name: string; status: string; output: string[]; worktree: string }[] };
    assert.equal(data.runs.length, 1);
    assert.equal(data.runs[0].output.join('\n'), 'doing the task', 'the latest output shows');
    const stopped = await boardPost(url, 'agents/stop', 'name=issue-12-claude-code');
    assert.equal(stopped.status, 200, stopped.text);
    assert.deepEqual(agents.killed, [1000], 'only its own process stops');
    assert.ok(existsSync(join(sandbox.repo, '.worktrees', '12')), 'stopping keeps the worktree');
    const log = readFileSync(join(sandbox.repo, '.yokoten-board.log'), 'utf8');
    assert.match(log, /start issue-12-claude-code pid 1000 issue #12 claude-code model-a/, 'the log holds the start');
    assert.match(log, /stop issue-12-claude-code pid 1000 issue #12/, 'the log holds the stop');
    assert.equal(log.includes(token), false, 'the log never holds the token');
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
  const pull = (number: number, branch: string, state: string, review: string, checks: unknown[], labels: unknown[], head = '') => ({
    number, title: `work ${number}`, headRefName: branch, headRefOid: head, url: `https://example.com/pull/${number}`, state, reviewDecision: review, isDraft: false, statusCheckRollup: checks, labels,
    latestReviews: head ? [{ state: 'APPROVED', commit: { oid: head } }] : [],
  });
  const pass = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const gh: Gh = (args) => {
    if (args[0] === 'issue') return '[]';
    return JSON.stringify([
      pull(7, 'main', 'OPEN', 'REVIEW_REQUIRED', pass, [{ name: 'tier A' }]),
      pull(8, 'main', 'OPEN', 'APPROVED', pass, [{ name: 'tier A' }], 'head-8'),
      pull(9, 'main', 'OPEN', 'REVIEW_REQUIRED', pass, [{ name: 'tier B' }]),
      pull(10, 'main', 'MERGED', 'APPROVED', pass, [{ name: 'tier A' }]),
      pull(11, 'other', 'OPEN', '', pass, [{ name: 'tier A' }]),
    ]);
  };
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh, { controls });
  try {
    const data = JSON.parse((await boardRead(url, 'data')).text) as { waiting: { kind: string; agent: string; role: string; wait: string; why: string; link: string }[] };
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
    const cookie = await boardCookie(url);
    const waiting = async () => (JSON.parse((await boardSend(`${base}data`, { headers: { cookie } })).text) as { waiting: { kind: string; agent: string }[] }).waiting;
    assert.equal((await waiting()).length, 3, 'an Approve, a guard stop, and a question');
    writeFileSync(file, JSON.stringify({ name: 'w', task: 'issue 601', worktree: tree, updated: '2026-10-22T10:30:00Z', role: 'engineer' }));
    assert.equal((await waiting()).length, 3, 'an agent that stops naming its hold-up still shows');
    assert.equal((await boardPost(url, 'agents/stop', 'name=w')).status, 404, 'no run of that name');
    assert.equal((await waiting()).length, 3, 'a refused stop changes nothing');
    assert.equal((await boardSend(`${base}waiting/clear`, { method: 'POST', headers: { Origin: boardOrigin(url), cookie }, body: '' })).status, 404, 'no clear endpoint');
    assert.equal((await boardSend(`${base}data`, { method: 'POST', headers: { Origin: boardOrigin(url), cookie }, body: '' })).status, 404, 'no change down the read path');
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
    const token = new URL(url).searchParams.get('token') ?? '';
    const cookie = await boardCookie(url);
    const body = 'issue=12&vendor=claude-code&model=model-a';
    assert.equal((await boardSend(`${base}agents/start?token=wrong`, { method: 'POST', headers: { Origin: origin, cookie }, body })).status, 403, 'a wrong token');
    assert.equal((await boardSend(`${base}agents/start?token=${token}`, { method: 'POST', headers: { Origin: origin }, body })).status, 403, 'a query token does not authorize a change');
    assert.equal((await boardSend(`${base}agents/start`, { method: 'POST', headers: { cookie }, body })).status, 403, 'a missing Origin');
    assert.equal((await boardSend(`${base}agents/start`, { method: 'POST', headers: { cookie, Origin: 'http://127.0.0.1:9' }, body })).status, 403, 'a wrong Origin');
    assert.equal((await boardSend(`${base}agents/start`, { method: 'POST', headers: { cookie, Origin: 'https://example.com' }, body })).status, 403, 'an outside Origin');
    assert.equal((await boardSend(`${base}agents/start`, { method: 'POST', headers: { cookie: 'yokoten-board=wrong', Origin: origin }, body })).status, 403, 'a wrong cookie');
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

// #603 findings: board --text showed none of the waiting data, so it shows the list
// whenever something waits.
test('board --text: the waiting list shows when something waits', async () => {
  const sandbox = makeSandbox();
  writeFileSync(
    join(sandbox.repo, '.yokoten-agent.json'),
    JSON.stringify({ name: 'w', vendor: 'muse', task: 'issue 601', worktree: sandbox.repo, doing: 'blocked', updated: '2026-10-22T10:00:00Z', role: 'engineer', blocked: 'the guard stopped a force push' }),
  );
  const result = await sandbox.call(['board', '--text']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\nWaiting for you:\n/);
  assert.match(result.stdout, /the guard stopped a force push/);
});

// #603 re-inspection (L1): `board --text` passed `runs: []`, so Started here never
// listed a run. It passes the board's own runs, like the page.
test('board --text: a started run shows under Started here', () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const run = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a' });
  assert.ok(typeof run !== 'string', `the start passes: ${run}`);
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _, done) { chunks.push(String(chunk)); done(); } });
  const invocation: Invocation = { command: 'board', args: ['--text'], env: { ...sandbox.env }, cwd: sandbox.repo, stdout: stream as Output, stderr: stream as Output, stdin: { fd: null, text: '', stream: Readable.from(['']) }, script: CLI };
  assert.equal(runBoard(invocation, { controls }), 0);
  const text = chunks.join('');
  assert.ok(text.includes('Started here:'), 'the runs section shows');
  assert.ok(text.includes(run.name), 'the started run shows, as on the page');
});

// #603 re-inspection (LOW): `board --text` printed a started run's worktree as an
// absolute home path. It hides the home folder, like /data does.
test('board --text: a started run hides the home folder', () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const run = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a' });
  assert.ok(typeof run !== 'string', `the start passes: ${run}`);
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _, done) { chunks.push(String(chunk)); done(); } });
  const invocation: Invocation = { command: 'board', args: ['--text'], env: { ...sandbox.env, HOME: dirname(sandbox.repo) }, cwd: sandbox.repo, stdout: stream as Output, stderr: stream as Output, stdin: { fd: null, text: '', stream: Readable.from(['']) }, script: CLI };
  assert.equal(runBoard(invocation, { controls }), 0);
  const text = chunks.join('');
  assert.ok(text.includes('Started here:'), 'the runs section shows');
  assert.ok(!text.includes(sandbox.repo), 'no absolute home path leaks');
  assert.ok(text.includes(`~${run.worktree.slice(dirname(sandbox.repo).length)}`), 'the worktree shows with ~ for home');
});

/** The /data fields #688 reads: the agents, the lists, and how fresh they are. */
interface GitHubShown {
  agents: { name: string }[];
  pulls: { number: number }[] | string;
  issues: { number: number }[] | string;
  github: { isReading: boolean; readAt: string; failed: string };
}

// #688: /data never waits for gh. A real child gh that sleeps 10 s: /data and the page
// still answer at once, with the agents and "reading GitHub…". Closing the board stops it.
test('board server: /data answers at once while gh sleeps', async () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git');
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse' }));
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), "#!/usr/bin/env node\nsetTimeout(() => console.log('[]'), 10000);\n");
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...sandbox.env, PATH: `${bin}:${process.env.PATH}` };
  const github = createBoardGitHub();
  const { server, url } = await startBoardServer(sandbox.repo, env, ghLaterIn(sandbox.repo, env, 20000), { github });
  try {
    assert.ok(github.reading, 'the first read starts with the board');
    const cookie = await boardCookie(url);
    const base = url.split('?')[0];
    const asked = performance.now();
    const answer = await boardGet(`${base}data`, { cookie });
    const took = performance.now() - asked;
    assert.equal(answer.status, 200);
    assert.ok(took < 200, `/data took ${took.toFixed(0)} ms while gh sleeps`);
    const shown = JSON.parse(answer.text) as GitHubShown;
    assert.deepEqual(shown.agents.map((agent) => agent.name), ['w'], 'the agents show at once');
    assert.equal(shown.pulls, 'reading GitHub…');
    assert.equal(shown.issues, 'reading GitHub…');
    assert.deepEqual(shown.github, { isReading: true, readAt: '', failed: '' });
    const page = performance.now();
    assert.equal((await boardGet(base, { cookie })).status, 200);
    assert.ok(performance.now() - page < 200, 'the page answers at once too');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #688: one read at a time. When it finishes, the next /data has the lists. A failed
// read keeps the last good lists, says why, and keeps the time they were read.
test('board server: the lists appear after the read, and a failed read keeps them', async () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git');
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse' }));
  const open = { number: 7, title: 'work', headRefName: 'b', url: 'https://example.com/pull/7', state: 'OPEN', reviewDecision: '', isDraft: false, statusCheckRollup: [], labels: [] };
  let release = () => {};
  let isFailing = false;
  let calls = 0;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const gh = async (args: string[]) => {
    calls += 1;
    await gate;
    if (isFailing) throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 502: Bad gateway' });
    if (args[0] === 'issue') return JSON.stringify([{ number: 12, title: 'an issue', url: 'https://example.com/i/12' }]);
    return JSON.stringify(args.includes('merged') ? [] : [open]);
  };
  const github = createBoardGitHub();
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, gh, { github });
  try {
    const cookie = await boardCookie(url);
    const dataUrl = `${url.split('?')[0]}data`;
    const read = async () => JSON.parse((await boardGet(dataUrl, { cookie })).text) as GitHubShown;
    const before = await read();
    assert.equal(before.pulls, 'reading GitHub…');
    assert.equal((await read()).github.isReading, true);
    assert.equal(calls, 4, 'one read in flight, however many /data asks: three pull queries and one issue query');
    release();
    await github.reading;
    const after = await read();
    assert.deepEqual(typeof after.pulls === 'string' ? after.pulls : after.pulls.map((pull) => pull.number), [7]);
    assert.deepEqual(typeof after.issues === 'string' ? after.issues : after.issues.map((issue) => issue.number), [12]);
    assert.equal(after.github.isReading, false);
    assert.equal(after.github.failed, '');
    assert.match(after.github.readAt, /^\d{4}-\d{2}-\d{2}T/);
    // The refresh time passes, and gh fails.
    isFailing = true;
    github.triedAt = 1;
    await read();
    await github.reading;
    const failed = await read();
    assert.deepEqual(typeof failed.pulls === 'string' ? failed.pulls : failed.pulls.map((pull) => pull.number), [7], 'the last good pull requests stay');
    assert.deepEqual(typeof failed.issues === 'string' ? failed.issues : failed.issues.map((issue) => issue.number), [12], 'the last good issues stay');
    assert.match(failed.github.failed, /HTTP 502/, 'it says why');
    assert.equal(failed.github.readAt, after.github.readAt, 'and when the lists were read');
    assert.deepEqual(failed.agents.map((agent) => agent.name), ['w'], 'the agents never empty');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// #685: `yokoten board` opens the page itself, so a beginner never copies the token.
// The link is one word to the opener, never through a shell.
test('board: the browser opener for each system', () => {
  const url = 'http://repo.localhost:9/?token=abc';
  assert.deepEqual(browserCommand(url, 'darwin', {}), ['open', url]);
  assert.deepEqual(browserCommand(url, 'linux', {}), ['xdg-open', url]);
  assert.deepEqual(browserCommand(url, 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }), ['explorer.exe', url], 'WSL opens the Windows browser');
  assert.deepEqual(browserCommand(url, 'win32', {}), ['rundll32', 'url.dll,FileProtocolHandler', url]);
  assert.equal(browserCommand(url, 'aix', {}), null);
});
