// Tests for src/host/github/planning.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import { borrowedHost, type Gh, parseBorrowedSource, parseCommitDate, parseCommits, readIssueMilestone, readLocalLogins, readLogin, repoOf } from '../../../src/host/github/planning.ts';
import { syncBoard } from '../../../scripts/board-sync.ts';

test('repo: read from https and ssh remotes', () => {
  assert.equal(repoOf('https://github.com/me/repo.git\n'), 'me/repo');
  assert.equal(repoOf('git@github.com:me/repo.git'), 'me/repo');
  assert.equal(repoOf('https://github.com/me/repo'), 'me/repo');
  assert.equal(repoOf('https://example.com/me/repo.git'), null);
});

// The board sync (#165, #908), against a fake GraphQL API. Two pages of items; the
// mutations are recorded and applied to the fake board, never sent anywhere, so a second
// run sees what the first one wrote.
test('board sync: fills empty fields, corrects a wrong status, keeps filled ones, a dry run writes nothing, and a second run changes nothing', async () => {
  const issue = (number: number, state: string, created: string, closed: string | null, extra: Record<string, unknown> = {}) => ({
    id: `i${number}`, __typename: 'Issue', number, state, createdAt: `${created}T08:00:00Z`, closedAt: closed && `${closed}T09:00:00Z`,
    milestone: null, repository: { nameWithOwner: 'octo/demo' }, ...extra,
  });
  const date = (value: string) => ({ date: value });
  const pages = [[
    { id: 'empty', start: null, target: null, status: null, content: issue(1, 'OPEN', '2026-10-01', null, { milestone: { dueOn: '2026-10-26T07:00:00Z' } }) },
    { id: 'filled', start: date('2026-09-01'), target: date('2026-09-30'), status: { name: 'In progress' }, content: issue(2, 'CLOSED', '2026-10-01', '2026-10-05') },
    { id: 'done-open', start: date('2026-10-01'), target: date('2026-10-02'), status: { name: 'Done', updatedAt: '2026-10-03T00:00:00Z' }, content: issue(3, 'OPEN', '2026-10-01', null) },
    { id: 'done-closed', start: date('2026-09-20'), target: date('2026-09-25'), status: { name: 'Done', updatedAt: '2026-09-25T10:00:00Z' }, content: issue(7, 'CLOSED', '2026-10-01', '2026-10-05') },
  ], [
    { id: 'pr', start: date('2026-10-01'), target: null, status: { name: 'Todo' }, content: { ...issue(4, 'OPEN', '2026-10-01', null), __typename: 'PullRequest' } },
    { id: 'reopened', start: date('2026-10-01'), target: date('2026-10-02'), status: { name: 'Done' }, content: issue(5, 'OPEN', '2026-10-01', null) },
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
  const openContent = (kind: string) => pages.flat().map((node) => node.content as any).filter((content) => content && content.__typename === kind && content.state === 'OPEN');
  const adds: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(raw);
      assert.equal(req.headers.authorization, 'Bearer t');
      let data: unknown;
      if (query.includes('addProjectV2ItemById')) {
        adds.push(variables.content);
        data = { addProjectV2ItemById: { item: { id: `new-${variables.content}` } } };
      } else if (query.startsWith('mutation')) {
        writes.push({ item: variables.item, field: variables.field, value: variables.value });
        applyWrite(writes.at(-1)!);
        data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } };
      } else if (query.includes('fields(first')) {
        data = { organization: { projectV2: { id: 'P1', fields: { nodes: [
          { id: 'F-title', name: 'Title' }, { id: 'F-start', name: 'Start' }, { id: 'F-target', name: 'Target' },
          { id: 'F-status', name: 'Status', options: ['Todo', 'In progress', 'In review', 'Done'].map((name) => ({ id: `O-${name}`, name })) },
        ] } } } };
      } else if (query.includes('issues(first')) {
        data = { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: openContent('Issue') } } };
      } else if (query.includes('pullRequests(first')) {
        data = { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: openContent('PullRequest') } } };
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
    const options = { owner: 'octo', number: 1, repo: 'octo/demo', token: 't', api, isDryRun: true, log: (line: string) => lines.push(line) };
    const planned = await syncBoard(options);
    assert.deepEqual(writes, [], 'a dry run writes nothing');
    assert.deepEqual(adds, [], 'nothing is added when every open item is on the board');
    assert.equal(JSON.stringify(pages), before, 'a dry run leaves the board as it was');
    assert.deepEqual(planned.map((c) => c.kind === 'added' ? `${c.item} added` : `${c.item} ${c.field}=${c.value}`), [
      'empty Start=2026-10-01', 'empty Target=2026-10-26', 'empty Status=Todo',
      'filled Status=Done',
      'done-open Status=Todo',
      'pr Status=In review',
      'reopened Status=Todo',
      'early-close Target=2026-10-12',
    ]);
    assert.match(lines.at(-1)!, /^8 items, 8 change\(s\) \(dry run: nothing written\)$/);
    assert.match(lines[0], /^would set octo\/demo#1 Start: 2026-10-01$/);

    const doneClosed = () => JSON.stringify(pages.flat().find((node) => node.id === 'done-closed'));
    const doneClosedBefore = doneClosed();
    const written = await syncBoard({ ...options, isDryRun: false });
    assert.deepEqual(written, planned);
    assert.deepEqual(writes.slice(0, 3), [
      { item: 'empty', field: 'F-start', value: { date: '2026-10-01' } },
      { item: 'empty', field: 'F-target', value: { date: '2026-10-26' } },
      { item: 'empty', field: 'F-status', value: { singleSelectOptionId: 'O-Todo' } },
    ]);
    assert.equal(writes.length, 8);

    // A closed Done item keeps Done and its dates; an open one follows the work.
    assert.equal(doneClosed(), doneClosedBefore, 'the first run keeps a closed Done item as it was');
    assert.equal((pages.flat().find((node) => node.id === 'done-open') as any).status.name, 'Todo', 'an open issue with no branch or pull request is Todo');

    // The second run, on the board the first one wrote: no mutation, nothing changed.
    lines.length = 0;
    const second = await syncBoard({ ...options, isDryRun: false });
    assert.deepEqual(second, [], 'a second run plans nothing');
    assert.equal(writes.length, 8, 'a second run sends no field mutation');
    assert.deepEqual(adds, [], 'a second run adds nothing');
    assert.deepEqual(lines, ['8 items, 0 change(s)']);
    assert.equal(doneClosed(), doneClosedBefore, 'the second run keeps a closed Done item as it was');
  } finally {
    server.close();
    for (const [name, value] of [['NO_PROXY', saved.upper], ['no_proxy', saved.lower]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// #908: the board was missing new work. One open issue and one open pull request are
// added, each once, and the status of an issue with a branch is corrected to In progress.
test('board sync: adds the open issues and pull requests missing from the board, once', async () => {
  const content = (kind: 'Issue' | 'PullRequest', number: number, extra: Record<string, unknown> = {}) => ({
    id: `i${number}`, __typename: kind, number, state: 'OPEN', createdAt: '2026-10-01T08:00:00Z', closedAt: null,
    milestone: null, repository: { nameWithOwner: 'octo/demo' }, ...extra,
  });
  const done = (status: string) => ({ start: { date: '2026-10-01' }, target: { date: '2026-10-20' }, status: { name: status } });
  const board: any[] = [
    { id: 'b1', ...done('Todo'), content: content('Issue', 1) },
    { id: 'b5', ...done('Todo'), content: content('Issue', 5, { linkedBranches: { nodes: [{ ref: { name: '5-work' } }] } }) },
    { id: 'b3', ...done('In review'), content: content('PullRequest', 3, { headRefName: '3-work' }) },
  ];
  const openIssues = [board[0].content, content('Issue', 2), board[1].content];
  const openPulls = [board[2].content, content('PullRequest', 4, { headRefName: '4-work' })];
  const everyContent = [...openIssues, ...openPulls];
  const adds: string[] = [];
  const writes: Array<{ item: string; field: string; value: any }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(raw);
      let data: unknown;
      if (query.includes('addProjectV2ItemById')) {
        adds.push(variables.content);
        board.push({ id: `new-${variables.content}`, start: null, target: null, status: null, content: everyContent.find((node) => node.id === variables.content) });
        data = { addProjectV2ItemById: { item: { id: `new-${variables.content}` } } };
      } else if (query.startsWith('mutation')) {
        writes.push({ item: variables.item, field: variables.field, value: variables.value });
        const item: any = board.find((node) => node.id === variables.item);
        if (variables.field === 'F-start') item.start = { date: variables.value.date };
        else if (variables.field === 'F-target') item.target = { date: variables.value.date };
        else if (variables.field === 'F-status') item.status = { name: variables.value.singleSelectOptionId.replace(/^O-/, '') };
        data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } };
      } else if (query.includes('fields(first')) {
        data = { organization: { projectV2: { id: 'P1', fields: { nodes: [
          { id: 'F-start', name: 'Start' }, { id: 'F-target', name: 'Target' },
          { id: 'F-status', name: 'Status', options: ['Todo', 'In progress', 'In review', 'Done'].map((name) => ({ id: `O-${name}`, name })) },
        ] } } } };
      } else if (query.includes('issues(first')) {
        data = { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: openIssues } } };
      } else if (query.includes('pullRequests(first')) {
        data = { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: openPulls } } };
      } else {
        data = { organization: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: board } } } };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  try {
    const lines: string[] = [];
    const options = { owner: 'octo', number: 1, repo: 'octo/demo', token: 't', api, isDryRun: false, log: (line: string) => lines.push(line) };
    const changes = await syncBoard(options);
    assert.deepEqual(adds, ['i2', 'i4'], 'the missing issue and pull request are added, each once');
    assert.deepEqual(changes.filter((c) => c.kind === 'added').map((c) => c.label), ['octo/demo#2', 'octo/demo#4']);
    const statusOf = (item: string) => writes.find((w) => w.item === item && w.field === 'F-status')?.value.singleSelectOptionId;
    assert.equal(statusOf('new-i2'), 'O-Todo', 'a new issue with no branch or pull request is Todo');
    assert.equal(statusOf('new-i4'), 'O-In review', 'a new pull request is In review');
    assert.equal(statusOf('b5'), 'O-In progress', 'an open issue with a branch is corrected to In progress');
    assert.match(lines.at(-1)!, /^5 items, 7 change\(s\)$/);

    lines.length = 0;
    const second = await syncBoard(options);
    assert.deepEqual(second, [], 'a second run plans nothing');
    assert.deepEqual(adds, ['i2', 'i4'], 'a second run adds nothing again');
    assert.deepEqual(lines, ['5 items, 0 change(s)']);
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

const SOURCE = 'https://github.com/example/upstream/blob/main/src/thing.ts';
const SHA = '0123456789abcdef0123456789abcdef01234567';

test('borrowed source: a GitHub blob URL names the repo and the path', () => {
  assert.deepEqual(parseBorrowedSource(SOURCE), { repo: 'example/upstream', path: 'src/thing.ts' });
  assert.deepEqual(parseBorrowedSource('https://www.github.com/example/upstream/blob/v1/a%20b/c.ts'), { repo: 'example/upstream', path: 'a b/c.ts' });
  for (const bad of [
    'https://example.com/example/upstream/blob/main/src/thing.ts',
    'https://github.com/example/upstream/tree/main/src',
    'https://github.com/example/upstream/blob/main',
    'not a url',
  ]) assert.equal(parseBorrowedSource(bad), null, bad);
});

test('commits: gh’s answer becomes plain commits, and a malformed answer is no answer', () => {
  const text = JSON.stringify([
    { sha: SHA, commit: { message: 'fix: a thing\n\nbody', author: { date: '2026-10-01T08:00:00Z' } } },
    { sha: 42 },
  ]);
  assert.deepEqual(parseCommits(text), [{ sha: SHA, message: 'fix: a thing\n\nbody', date: '2026-10-01T08:00:00Z' }]);
  assert.equal(parseCommits('{'), null);
  assert.equal(parseCommits('{"sha":"x"}'), null);
});

test('borrowed host: reads the default branch for the borrowed path, and gives null when gh fails', () => {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    return JSON.stringify([{ sha: SHA, commit: { message: 'taken' } }]);
  };
  assert.deepEqual(borrowedHost(gh).commits(SOURCE), [{ sha: SHA, message: 'taken' }]);
  assert.deepEqual(calls, [['api', 'repos/example/upstream/commits?path=src%2Fthing.ts&per_page=100']]);

  assert.equal(borrowedHost(() => { throw new Error('no network'); }).commits(SOURCE), null);
  assert.equal(borrowedHost(() => '[]').commits('https://example.com/a/b/blob/main/c.ts'), null);
});

test('borrowed host: reads one commit’s date, and gives null when it cannot', () => {
  assert.equal(parseCommitDate(JSON.stringify({ commit: { author: { date: '2026-10-01T08:00:00Z' } } })), '2026-10-01T08:00:00Z');
  for (const bad of ['{', '{}', '[]', JSON.stringify({ commit: { author: {} } })]) assert.equal(parseCommitDate(bad), null, bad);
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    return JSON.stringify({ commit: { author: { date: '2026-10-01T08:00:00Z' } } });
  };
  assert.equal(borrowedHost(gh).commitDate?.(SOURCE, SHA), '2026-10-01T08:00:00Z');
  assert.deepEqual(calls, [['api', `repos/example/upstream/commits/${SHA}`]]);
  assert.equal(borrowedHost(() => { throw new Error('no network'); }).commitDate?.(SOURCE, SHA), null);
  assert.equal(borrowedHost(() => '{}').commitDate?.('https://example.com/a/b/blob/main/c.ts', SHA), null);
});
