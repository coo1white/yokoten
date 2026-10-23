// Tests for src/host/github/comment.ts: one comment per pull request (#615).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECK_COMMENT_MARKER, checkComment, upsertPullRequestComment } from '../../../src/host/github/comment.ts';
import { makeTempDir } from '../../repo/helpers.ts';

const TOKEN = 'ghs_comment_never_printed';

/** An event file for pull request 7 of octo/app. */
function eventFile(): string {
  const file = join(makeTempDir(), 'event.json');
  writeFileSync(file, JSON.stringify({ repository: { full_name: 'octo/app' }, pull_request: { number: 7 } }));
  return file;
}

/** A fake comments API. It keeps the comments in memory and records each call. */
async function fakeComments() {
  const comments: { id: number; body: string }[] = [];
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push(`${req.method} ${req.url} ${body ? body.body.slice(0, 40) : ''}`);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url?.startsWith('/repos/octo/app/issues/7/comments')) {
        res.statusCode = 200;
        res.end(JSON.stringify(comments));
      } else if (req.method === 'POST' && req.url === '/repos/octo/app/issues/7/comments') {
        comments.push({ id: 1, body: body.body });
        res.statusCode = 201;
        res.end(JSON.stringify(comments[0]));
      } else if (req.method === 'PATCH' && req.url === '/repos/octo/app/issues/comments/1') {
        comments[0] = { id: 1, body: body.body };
        res.statusCode = 200;
        res.end(JSON.stringify(comments[0]));
      } else if (req.method === 'DELETE' && req.url === '/repos/octo/app/issues/comments/1') {
        comments.length = 0;
        res.statusCode = 204;
        res.end();
      } else {
        res.statusCode = 500;
        res.end('{"message":"nope"}');
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { comments, calls, api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const problem = { id: 'pr-title', what: 'title: not in the commit form', why: 'a title names the commit', fix: 'use `type: summary`' };

test('one comment: a run makes it, a second edits it, a clean run deletes it (#615)', async () => {
  const fake = await fakeComments();
  const env = { GITHUB_EVENT_PATH: eventFile(), GITHUB_TOKEN: TOKEN, YOKOTEN_GITHUB_API: fake.api };
  try {
    const body = checkComment('yokoten check --pr', [problem], []);
    assert.ok(body.startsWith(`${CHECK_COMMENT_MARKER}\n`), 'the marker finds the comment again');
    assert.match(body, /### yokoten check --pr: 1 problem/);

    assert.deepEqual(await upsertPullRequestComment(env, body), { action: 'created' });
    assert.equal(fake.comments.length, 1);
    assert.equal(fake.calls.length, 2, 'read, then make');

    assert.deepEqual(await upsertPullRequestComment(env, body.replace('1 problem', '1 problem, edited')), { action: 'updated' });
    assert.equal(fake.comments.length, 1, 'the second run edits, never adds another');
    assert.deepEqual(fake.calls.map((call) => call.split(' ').slice(0, 2).join(' ')), [
      'GET /repos/octo/app/issues/7/comments?per_page=100',
      'POST /repos/octo/app/issues/7/comments',
      'GET /repos/octo/app/issues/7/comments?per_page=100',
      'PATCH /repos/octo/app/issues/comments/1',
    ]);

    assert.deepEqual(await upsertPullRequestComment(env, null), { action: 'deleted' });
    assert.equal(fake.comments.length, 0);
    assert.deepEqual(await upsertPullRequestComment(env, null), { action: 'none' }, 'a clean run with no old comment');
    for (const call of fake.calls) assert.ok(!call.includes(TOKEN), 'the token is never in a message');
  } finally {
    fake.close();
  }
});

test('one comment: a missing token or a failed call says why, and never throws (#615)', async () => {
  const missing = await upsertPullRequestComment({ GITHUB_EVENT_PATH: eventFile() }, 'x');
  assert.equal(missing.action, 'failed');
  assert.match(missing.problem ?? '', /GITHUB_TOKEN is not set/);
  const badApi = await upsertPullRequestComment({ GITHUB_EVENT_PATH: eventFile(), GITHUB_TOKEN: TOKEN, YOKOTEN_GITHUB_API: 'http://api.example.com' }, 'x');
  assert.equal(badApi.action, 'failed');
  assert.match(badApi.problem ?? '', /not https/);
  assert.ok(!(badApi.problem ?? '').includes('api.example.com'), 'the address is not named');
  // No answer at all.
  const noAnswer = await upsertPullRequestComment({ GITHUB_EVENT_PATH: eventFile(), GITHUB_TOKEN: TOKEN, YOKOTEN_GITHUB_API: 'http://127.0.0.1:1' }, 'x');
  assert.deepEqual([noAnswer.action, noAnswer.problem], ['failed', 'GitHub gave no answer when the comment was posted']);
  // A server error names only its status.
  const fake = await fakeComments();
  try {
    const failed = await upsertPullRequestComment({ GITHUB_EVENT_PATH: eventFile(), GITHUB_TOKEN: TOKEN, YOKOTEN_GITHUB_API: `${fake.api}/nope` }, 'x');
    assert.equal(failed.action, 'failed');
    assert.match(failed.problem ?? '', /GitHub answered 500/);
  } finally {
    fake.close();
  }
});
