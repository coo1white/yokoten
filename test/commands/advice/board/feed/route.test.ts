// Tests for src/commands/advice/board/feed/route.ts: /feed on the board server.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../../../repo/helpers.ts';
import { claudeFolder } from '../../../../../src/commands/advice/board/feed/read/logs.ts';
import { startBoardServer } from '../../../../../src/commands/advice/board/server.ts';
import type { Gh } from '../../../../../src/host/github/index.ts';

/** `*.localhost` is loopback in a browser. This machine's DNS does not resolve it, so tests dial 127.0.0.1 and send the Host header. */
function dialHost(hostname: string): string {
  return hostname === 'localhost' || hostname.endsWith('.localhost') ? '127.0.0.1' : hostname;
}

/** One request to the board. node:http reads no proxy setting. */
function get(target: string, headers: Record<string, string> = {}): Promise<{ status: number; kind: string; headers: Record<string, string | string[] | undefined>; text: string }> {
  const url = new URL(target);
  return new Promise((done, failed) => {
    const asked = request({ host: dialHost(url.hostname), port: url.port, path: `${url.pathname}${url.search}`, headers: { ...headers, host: headers.host ?? url.host } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => done({ status: res.statusCode ?? 0, kind: String(res.headers['content-type'] ?? ''), headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
    });
    asked.on('error', failed);
    asked.end();
  });
}

/** The cookie from the first visit. The link's token sets it and redirects. */
async function boardCookie(url: string): Promise<string> {
  const first = await get(url);
  assert.equal(first.status, 303, first.text);
  const raw = first.headers['set-cookie'];
  const line = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const match = /^yokoten-board=([0-9a-f]{32}); HttpOnly; Secure; SameSite=Strict; Path=\/$/.exec(line);
  assert.ok(match, 'the first visit sets an HttpOnly Secure SameSite=Strict cookie');
  return `yokoten-board=${match?.[1] ?? ''}`;
}

// Built from pieces, so this file passes the privacy and secrets checks (AGENTS.md).
const EMAIL = ['someone', 'personal-mail.com'].join('@');
const TOKEN = `${'gh'}p_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
const MARK = 'zebracorn';

// #694: the page asks /feed for one agent's session. Every line is masked before it leaves.
test('board feed route: a home path, an email, a token and a private mark never reach /feed', async () => {
  const sandbox = makeSandbox();
  const home = dirname(sandbox.repo);
  const env = { ...sandbox.env, HOME: home };
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), `${MARK}\n`);
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'claude-code', worktree: sandbox.repo, doing: 'reading' }));
  const log = join(home, '.claude', 'projects', claudeFolder(sandbox.repo), 'one.jsonl');
  mkdirSync(dirname(log), { recursive: true });
  const said = `Mail ${EMAIL} about ${MARK}, with ${TOKEN}, in ${sandbox.repo}/src/a.ts`;
  writeFileSync(log, [
    { type: 'assistant', timestamp: '2026-10-22T10:00:00.000Z', message: { content: [{ type: 'text', text: said }] } },
    { type: 'assistant', timestamp: '2026-10-22T10:00:01.000Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `cat ${sandbox.repo}/notes # ${EMAIL} ${TOKEN}` } }] } },
    { type: 'user', timestamp: '2026-10-22T10:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `${home}/.ssh ${MARK.toUpperCase()} <script>alert(1)</script>` }] } },
  ].map((record) => `${JSON.stringify(record)}\n`).join(''));
  const gh: Gh = () => '[]';
  const { server, url } = await startBoardServer(sandbox.repo, env, gh);
  try {
    const base = url.split('?')[0];
    const token = new URL(url).searchParams.get('token') ?? '';
    const cookie = await boardCookie(url);
    const feedUrl = (agent: string, after = '') => `${base}feed?agent=${encodeURIComponent(agent)}&after=${encodeURIComponent(after)}`;
    const answer = await get(feedUrl('~/repo'), { cookie });
    assert.equal(answer.text.includes(token), false, 'the feed does not echo the token');
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.kind, 'application/json; charset=utf-8', 'text in JSON, never HTML');
    for (const secret of [home, EMAIL, TOKEN, MARK, MARK.toUpperCase()]) assert.ok(!answer.text.includes(secret), `${secret === home ? 'the home folder' : 'a private value'} never leaves`);
    const body = JSON.parse(answer.text) as { source: string; next: string; items: { kind: string; text: string; full?: string }[] };
    assert.equal(body.source, 'claude');
    assert.deepEqual(body.items.map((item) => item.kind), ['say', 'tool', 'result']);
    assert.equal(body.items[0].text, 'Mail <email> about <mark>, with <secret>, in ~/repo/src/a.ts');
    assert.equal(body.items[1].full, 'cat ~/repo/notes # <email> <secret>');
    assert.equal(body.items[2].text, '~/.ssh <mark> <script>alert(1)</script>', 'the page puts it in as text');
    // The cursor brings only what came after it.
    const again = JSON.parse((await get(feedUrl('~/repo', body.next), { cookie })).text) as { items: unknown[]; reset: boolean };
    assert.deepEqual([again.items, again.reset], [[], false]);
    // The same cookie and Host as /data.
    assert.equal((await get(`${base}feed?token=wrong&agent=~/repo`)).status, 403);
    assert.equal((await get(feedUrl('~/repo'), { cookie, host: `evil.example:${new URL(url).port}` })).status, 403);
    assert.equal((await get(feedUrl('~/nobody'), { cookie })).status, 404);
  } finally {
    server.close();
  }
});

// #694: an agent whose log can't be found shows its `doing` steps, as before.
test('board feed route: no log falls back to the doing steps', async () => {
  const sandbox = makeSandbox();
  const env = { ...sandbox.env, HOME: dirname(sandbox.repo) };
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'codex', worktree: sandbox.repo, doing: 'reading the issue' }));
  const { server, url } = await startBoardServer(sandbox.repo, env, () => '[]');
  try {
    const base = url.split('?')[0];
    const cookie = await boardCookie(url);
    const answer = JSON.parse((await get(`${base}feed?agent=~/repo`, { cookie })).text) as { source: string; items: unknown[] };
    assert.deepEqual([answer.source, answer.items], ['doing', []]);
    const data = JSON.parse((await get(`${base}data`, { cookie })).text) as { feeds: Record<string, { text: string }[]> };
    assert.deepEqual(data.feeds['~/repo'].map((event) => event.text), ['reading the issue'], '/data still has the doing steps');
  } finally {
    server.close();
  }
});

// A positive control: when the masks can't be built, /feed sends nothing.
test('board feed route: a mask that fails sends no line', async () => {
  const sandbox = makeSandbox();
  const home = dirname(sandbox.repo);
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'claude-code' }));
  const log = join(home, '.claude', 'projects', claudeFolder(sandbox.repo), 'one.jsonl');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'raw words' }] } })}\n`);
  const feedMask = () => {
    throw new Error('no marks');
  };
  const { server, url } = await startBoardServer(sandbox.repo, { ...sandbox.env, HOME: home }, () => '[]', { feedMask });
  try {
    const cookie = await boardCookie(url);
    const answer = await get(`${url.split('?')[0]}feed?agent=~/repo`, { cookie });
    assert.equal(answer.status, 500);
    assert.ok(!answer.text.includes('raw words'));
  } finally {
    server.close();
  }
});
