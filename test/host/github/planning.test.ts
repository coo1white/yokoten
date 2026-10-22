// Tests for src/host/github/planning.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import { type Gh, readIssueMilestone, readLocalLogins, readLogin, repoOf } from '../../../src/host/github/planning.ts';
import { syncBoard } from '../../../scripts/board-sync.ts';

test('repo: read from https and ssh remotes', () => {
  assert.equal(repoOf('https://github.com/me/repo.git\n'), 'me/repo');
  assert.equal(repoOf('git@github.com:me/repo.git'), 'me/repo');
  assert.equal(repoOf('https://github.com/me/repo'), 'me/repo');
  assert.equal(repoOf('https://example.com/me/repo.git'), null);
});

// The board sync (#165), against a fake GraphQL API. Two pages of items; the mutations
// are recorded and applied to the fake board, never sent anywhere, so a second run sees
// what the first one wrote.
test('board sync: fills empty fields, keeps filled ones and Done, a dry run writes nothing, and a second run changes nothing', async () => {
  const issue = (number: number, state: string, created: string, closed: string | null, extra: Record<string, unknown> = {}) => ({
    __typename: 'Issue', number, state, createdAt: `${created}T08:00:00Z`, closedAt: closed && `${closed}T09:00:00Z`,
    milestone: null, repository: { nameWithOwner: 'octo/demo' }, timelineItems: { nodes: [] }, ...extra,
  });
  const date = (value: string) => ({ date: value });
  const pages = [[
    { id: 'empty', start: null, target: null, status: null, content: issue(1, 'OPEN', '2026-10-01', null, { milestone: { dueOn: '2026-10-26T07:00:00Z' } }) },
    { id: 'filled', start: date('2026-09-01'), target: date('2026-09-30'), status: { name: 'In progress' }, content: issue(2, 'CLOSED', '2026-10-01', '2026-10-05') },
    { id: 'done-open', start: date('2026-10-01'), target: date('2026-10-02'), status: { name: 'Done', updatedAt: '2026-10-03T00:00:00Z' }, content: issue(3, 'OPEN', '2026-10-01', null) },
    { id: 'done-closed', start: date('2026-09-20'), target: date('2026-09-25'), status: { name: 'Done', updatedAt: '2026-09-25T10:00:00Z' }, content: issue(7, 'CLOSED', '2026-10-01', '2026-10-05') },
  ], [
    { id: 'pr', start: date('2026-10-01'), target: null, status: { name: 'Todo' }, content: { ...issue(4, 'OPEN', '2026-10-01', null), __typename: 'PullRequest' } },
    { id: 'reopened', start: date('2026-10-01'), target: date('2026-10-02'), status: { name: 'Done', updatedAt: '2026-10-03T00:00:00Z' }, content: issue(5, 'OPEN', '2026-10-01', null, { timelineItems: { nodes: [{ createdAt: '2026-10-04T00:00:00Z' }] } }) },
    { id: 'early-close', start: date('2026-10-12'), target: null, status: { name: 'Done' }, content: { ...issue(6, 'MERGED', '2026-10-10', '2026-10-11'), __typename: 'PullRequest' } },
    { id: 'draft', start: null, target: null, status: null, content: { __typename: 'DraftIssue' } },
  ]];
  const writes: Array<{ item: string; field: string; value: any }> = [];
  // The fake board applies each write, as GitHub would.
  const applyWrite = (write: { item: string; field: string; value: any }) => {
    const item: any = pages.flat().find((node) => node.id === write.item);
    if (write.field === 'F-start') item.start = date(write.value.date);
    else if (write.field === 'F-target') item.target = date(write.value.date);
    else if (write.field === 'F-status') item.status = { name: write.value.singleSelectOptionId.replace(/^O-/, ''), updatedAt: new Date().toISOString() };
    else throw new Error(`unknown field ${write.field}`);
  };
  const before = JSON.stringify(pages);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(raw);
      assert.equal(req.headers.authorization, 'Bearer t');
      let data: unknown;
      if (query.startsWith('mutation')) {
        writes.push({ item: variables.item, field: variables.field, value: variables.value });
        applyWrite(writes.at(-1)!);
        data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } };
      } else if (query.includes('fields(first')) {
        data = { organization: { projectV2: { id: 'P1', fields: { nodes: [
          { id: 'F-title', name: 'Title' }, { id: 'F-start', name: 'Start' }, { id: 'F-target', name: 'Target' },
          { id: 'F-status', name: 'Status', options: ['Todo', 'In progress', 'In review', 'Done'].map((name) => ({ id: `O-${name}`, name })) },
        ] } } } };
      } else {
        const index = variables.after === null ? 0 : 1;
        data = { organization: { projectV2: { items: { pageInfo: { hasNextPage: index === 0, endCursor: 'c1' }, nodes: pages[index] } } } };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  // As in the token test: the fake API is local, so fetch must not use the shell's proxy.
  const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  try {
    const lines: string[] = [];
    const options = { owner: 'octo', number: 1, token: 't', api, isDryRun: true, log: (line: string) => lines.push(line) };
    const planned = await syncBoard(options);
    assert.deepEqual(writes, [], 'a dry run writes nothing');
    assert.equal(JSON.stringify(pages), before, 'a dry run leaves the board as it was');
    assert.deepEqual(planned.map((c) => `${c.item} ${c.field}=${c.value}`), [
      'empty Start=2026-10-01', 'empty Target=2026-10-26', 'empty Status=Todo',
      'filled Status=Done',
      'pr Status=In review',
      'reopened Status=Todo',
      'early-close Target=2026-10-12',
    ]);
    assert.match(lines.at(-1)!, /^8 items, 7 change\(s\) \(dry run: nothing written\)$/);
    assert.match(lines[0], /^would set octo\/demo#1 Start: 2026-10-01$/);

    const written = await syncBoard({ ...options, isDryRun: false });
    assert.deepEqual(written, planned);
    assert.deepEqual(writes.slice(0, 3), [
      { item: 'empty', field: 'F-start', value: { date: '2026-10-01' } },
      { item: 'empty', field: 'F-target', value: { date: '2026-10-26' } },
      { item: 'empty', field: 'F-status', value: { singleSelectOptionId: 'O-Todo' } },
    ]);
    assert.equal(writes.length, 7);

    // A Done item keeps Done and its dates.
    const doneItems = () => pages.flat().filter((node) => node.id.startsWith('done-')).map((node) => JSON.stringify(node));
    const doneBefore = JSON.parse(before).flat().filter((node: { id: string }) => node.id.startsWith('done-')).map((node: unknown) => JSON.stringify(node));
    assert.deepEqual(doneItems(), doneBefore, 'the first run keeps Done items as they were');

    // The second run, on the board the first one wrote: no mutation, nothing changed.
    lines.length = 0;
    const second = await syncBoard({ ...options, isDryRun: false });
    assert.deepEqual(second, [], 'a second run plans nothing');
    assert.equal(writes.length, 7, 'a second run sends no mutation');
    assert.deepEqual(lines, ['8 items, 0 change(s)']);
    assert.deepEqual(doneItems(), doneBefore, 'the second run keeps Done items as they were');
  } finally {
    server.close();
    for (const [name, value] of [['NO_PROXY', saved.upper], ['no_proxy', saved.lower]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('readLogin: the signed-in login, or null when gh fails or answers something else (#390)', () => {
  const asked: string[][] = [];
  assert.equal(readLogin((args) => (asked.push(args), 'someone-1\n')), 'someone-1');
  assert.deepEqual(asked, [['api', 'user', '--jq', '.login']]);
  assert.equal(readLogin(() => { throw new Error('not signed in'); }), null);
  assert.equal(readLogin(() => '{"message":"Bad credentials"}'), null);
  assert.equal(readLogin(() => ''), null);
});

// #392: the gh login, read from gh's own file on this machine, with no network call.
test('readLocalLogins: the user under each host in hosts.yml; none when the file is missing', () => {
  const home = makeTempDir('yokoten-gh-');
  assert.deepEqual(readLocalLogins({ HOME: home }), []);
  mkdirSync(join(home, '.config', 'gh'), { recursive: true });
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    users:\n        octo-jane:\n    user: octo-jane\n    git_protocol: https\nghe.example.com:\n    user: "jroe"\n');
  assert.deepEqual(readLocalLogins({ HOME: home }), ['octo-jane', 'jroe']);
  const other = makeTempDir('yokoten-gh-');
  writeFileSync(join(other, 'hosts.yml'), 'github.com:\n    user: someone-else\n');
  assert.deepEqual(readLocalLogins({ HOME: home, GH_CONFIG_DIR: other }), ['someone-else'], 'GH_CONFIG_DIR first, as gh reads it');
});
// #512: an issue's milestone, from one `gh issue view`; a fake gh stands in for GitHub.
test('readIssueMilestone: the title, null for none, undefined when gh cannot read it (#512)', () => {
  const calls: string[][] = [];
  const answer = (said: string): Gh => (args) => {
    calls.push(args);
    return said;
  };
  assert.equal(readIssueMilestone(answer(JSON.stringify({ milestone: { number: 1, title: 'v0.1.0' } })), 5, null), 'v0.1.0');
  assert.deepEqual(calls, [['issue', 'view', '5', '--json', 'milestone']]);
  assert.equal(readIssueMilestone(answer(JSON.stringify({ milestone: null })), 5, 'o/r'), null);
  assert.deepEqual(calls.at(-1), ['issue', 'view', '5', '--json', 'milestone', '--repo', 'o/r']);
  for (const said of ['', 'not json', '{}', '[]', JSON.stringify({ milestone: { title: '' } })]) {
    assert.equal(readIssueMilestone(answer(said), 5, null), undefined, said);
  }
  const failing: Gh = () => {
    throw new Error('gh: network');
  };
  assert.equal(readIssueMilestone(failing, 5, null), undefined);
});
