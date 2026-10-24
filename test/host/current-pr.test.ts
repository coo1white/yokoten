// Tests for src/host/current-pr.ts: the pull request as it is now, from the API (#645).

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCurrentPullRequest, readsCurrentPullRequest } from '../../src/host/current-pr.ts';
import { makeTempDir } from '../repo/helpers.ts';

const TOKEN = 'ghs_current_pr_never_printed';

/** An event file for pull request 7 of octo/app, with `fields` merged in. */
function eventFile(fields: Record<string, unknown> = {}): string {
  const file = join(makeTempDir(), 'event.json');
  writeFileSync(file, JSON.stringify({ repository: { full_name: 'octo/app' }, pull_request: { number: 7, labels: [] }, ...fields }));
  return file;
}

/** A fake API that answers each request with the next status in `statuses` (the last one repeats). */
async function fakeApi(statuses: number[], pull: Record<string, unknown>) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const status = statuses[Math.min(requests.length, statuses.length - 1)];
    requests.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${TOKEN}` ? 'token' : 'no token'}`);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(status === 200 ? pull : { message: 'nope' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { requests, api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const what = (read: unknown) => (read && typeof read === 'object' && 'problem' in read ? (read.problem as { id: string; what: string }) : null);

test('current pull request: only YOKOTEN_PR_LIVE=1 turns it on; a token alone does not (#645)', () => {
  assert.equal(readsCurrentPullRequest({ GITHUB_TOKEN: TOKEN }), false);
  assert.equal(readsCurrentPullRequest({ YOKOTEN_PR_LIVE: '1' }), true);
  assert.equal(readsCurrentPullRequest({ YOKOTEN_PR_LIVE: '' }), false);
  assert.equal(readsCurrentPullRequest({ YOKOTEN_PR_LIVE: '0' }), false, 'only 1 turns it on, like the other YOKOTEN_ switches');
});

test('current pull request: the fields as GitHub has them now, read once with the token (#645)', async () => {
  const fake = await fakeApi([200], { title: 'feat: now', body: null, labels: [{ name: 'feat' }, null, { name: 'tier B' }], milestone: { title: 'M0' }, draft: true, user: { login: 'dependabot[bot]' } });
  try {
    const read = await readCurrentPullRequest({ GITHUB_EVENT_PATH: eventFile(), GITHUB_TOKEN: TOKEN, YOKOTEN_GITHUB_API: `${fake.api}/` });
    assert.deepEqual(read, { title: 'feat: now', body: '', labels: ['feat', 'tier B'], milestone: 'M0', author: 'dependabot[bot]' });
    assert.deepEqual(fake.requests, ['GET /repos/octo/app/pulls/7 token']);
  } finally {
    fake.close();
  }
});

test('current pull request: a read that fails is one finding; a server error is tried once more (#645)', async () => {
  for (const [statuses, tries, answer] of [
    [[403], 1, 'GitHub answered 403'],
    [[404], 1, 'GitHub answered 404'],
    [[502], 2, 'GitHub answered 502'],
    [[503, 200], 2, null],
  ] as const) {
    const fake = await fakeApi([...statuses], { title: 'feat: a', labels: [] });
    try {
      const read = await readCurrentPullRequest({ GITHUB_EVENT_PATH: eventFile(), GITHUB_TOKEN: TOKEN, YOKOTEN_GITHUB_API: fake.api });
      assert.equal(fake.requests.length, tries, `${statuses}`);
      if (answer === null) assert.equal(what(read), null, 'the second try answered');
      else assert.deepEqual(what(read) && [what(read)?.id, what(read)?.what], ['pr-current', `pull request 7 can't be read as it is now: ${answer}`]);
      assert.ok(!JSON.stringify(read).includes(TOKEN));
      assert.ok(!JSON.stringify(read).includes('127.0.0.1'));
    } finally {
      fake.close();
    }
  }
  // No answer at all.
  const read = await readCurrentPullRequest({ GITHUB_EVENT_PATH: eventFile(), GITHUB_TOKEN: TOKEN, YOKOTEN_GITHUB_API: 'http://127.0.0.1:1' });
  assert.equal(what(read)?.what, "pull request 7 can't be read as it is now: GitHub gave no answer");
});

test('current pull request: the token goes only over https, or to this machine (#645)', async () => {
  const event = eventFile();
  for (const api of ['http://api.example.com', 'http://192.0.2.10:8080', 'ftp://api.example.com', 'not a url']) {
    const read = await readCurrentPullRequest({ GITHUB_EVENT_PATH: event, GITHUB_TOKEN: TOKEN, GITHUB_API_URL: api });
    assert.equal(what(read)?.what, 'the GitHub API address is not https, so the token is not sent', api);
    // The address and its host part are named nowhere in the result.
    const host = api.split('//').at(-1) ?? api;
    assert.ok(!JSON.stringify(read).includes(api) && !JSON.stringify(read).includes(host), 'the address is not named');
  }
  // YOKOTEN_GITHUB_API wins over GITHUB_API_URL, and localhost is allowed for tests.
  const fake = await fakeApi([200], { title: 'feat: a', labels: [] });
  try {
    const local = fake.api.replace('127.0.0.1', 'localhost');
    const read = await readCurrentPullRequest({ GITHUB_EVENT_PATH: event, GITHUB_TOKEN: TOKEN, GITHUB_API_URL: 'http://api.example.com', YOKOTEN_GITHUB_API: local });
    assert.equal(what(read), null);
  } finally {
    fake.close();
  }
});

test('current pull request: no token, no event, or an event with no number or repo fails before any read (#645)', async () => {
  const cases: [Record<string, string>, string][] = [
    [{ GITHUB_EVENT_PATH: eventFile() }, "GITHUB_TOKEN is not set, so the pull request as it is now can't be read"],
    [{ GITHUB_TOKEN: TOKEN }, 'there is no CI event file (GITHUB_EVENT_PATH), so the pull request is not named'],
    [{ GITHUB_TOKEN: TOKEN, GITHUB_EVENT_PATH: eventFile({ pull_request: { number: '7' } }) }, 'the CI event names no pull request number'],
    [{ GITHUB_TOKEN: TOKEN, GITHUB_EVENT_PATH: eventFile({ repository: { full_name: 'octo/app; rm' } }) }, 'the CI event names no repository'],
  ];
  for (const [env, expected] of cases) {
    const read = await readCurrentPullRequest({ ...env, YOKOTEN_GITHUB_API: 'http://127.0.0.1:1' });
    assert.deepEqual([what(read)?.id, what(read)?.what], ['pr-current', expected]);
  }
  // GITHUB_REPOSITORY names the repo when the event does not.
  const fake = await fakeApi([200], { title: 'feat: a', labels: [] });
  try {
    const read = await readCurrentPullRequest({ GITHUB_EVENT_PATH: eventFile({ repository: null }), GITHUB_REPOSITORY: 'octo/other', GITHUB_TOKEN: TOKEN, YOKOTEN_GITHUB_API: fake.api });
    assert.equal(what(read), null);
    assert.deepEqual(fake.requests, ['GET /repos/octo/other/pulls/7 token']);
  } finally {
    fake.close();
  }
});
