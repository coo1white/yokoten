// Tests for src/host/github/pull-request.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { GitReadError } from '../../../src/run/check.ts';
import { annotation, annotations, CHECK_COMMENT_MARKER, checkComment, OPEN_PULL_LIMIT, pullRequestNumber, readBranchFiles, readBranchPullRequest, readCodeOwners, readOpenPulls, stepSummary, upsertPullRequestComment } from '../../../src/host/github/pull-request.ts';

// #91: workflow commands, escaped as GitHub's runner decodes them
// (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands).
test('annotations: escape the message and the properties; a history place goes in the message (#91)', () => {
  const f = { id: 'layout', what: '100% full,\nline two\r', why: 'a: b', fix: 'see a, b', file: 'docs/a,b:c.md', line: 7 };
  assert.equal(annotation(f, 'error'), '::error file=docs/a%2Cb%3Ac.md,line=7,title=yokoten layout::100%25 full,%0Aline two%0D. A: b. See a, b.');
  assert.equal(annotation({ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }, 'warning'), '::warning title=yokoten large-diff::big. W. F.');
  assert.equal(annotation({ id: 'secret', what: 'a secret', why: 'w', fix: 'f', grade: 'likely', ignored: 'a test fixture' }, 'warning'), '::warning title=yokoten secret::a secret [likely; ignored: a test fixture]. W. F.');
  assert.equal(annotation({ ...f, what: 'x', file: 'commit abc (message)', line: 1 }, 'error', false), '::error title=yokoten layout::commit abc (message):1: x. A: b. See a, b.');
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.equal(annotation(linked, 'error'), '::error file=a.md,line=1,title=yokoten email::an email. W. F.%0A  docs: https://example.com/guide#privacy', 'the link goes in the message (#94)');
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const lines = annotations(many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.equal(lines.length, 50, 'GitHub shows at most 50 per job');
  assert.ok(lines.every((l) => l.startsWith('::error ')), 'problems come before notes');
});

test('step summary: a heading with the result, a table, notes apart, at most 50 rows (#91)', () => {
  assert.equal(stepSummary('yokoten check', [], []), '### yokoten check: ok\n\n');
  // GitHub renders the summary as HTML: a `<` in a cell would hide the text after it.
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'an email', why: 'w', fix: 'f', file: '<draft>.md', line: 1 }], []), /\| &lt;draft>\.md:1 \|/);
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'a\\|b', why: 'w', fix: 'f' }], []), /\| a\\\\\\\|b \|/);
  const one = stepSummary('yokoten check --pr', [{ id: 'pr-title', what: 'title: a | b', why: 'why', fix: 'fix it' }], [{ id: 'long-sentence', what: 'long', why: 'w', fix: 'f', file: 'a.md', line: 2 }]);
  assert.equal(one, [
    '### yokoten check --pr: 1 problem',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '|  | pr-title | title: a \\| b | Why | Fix it |',
    '',
    '#### Notes (1): these never fail the check',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '| a.md:2 | long-sentence | long | W | F |',
    '',
    '',
  ].join('\n'));
  // The id links to its section (#94).
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.match(stepSummary('yokoten check', [linked], []), /\n\| a\.md:1 \| \[email\]\(https:\/\/example\.com\/guide#privacy\) \| an email \| W \| F \|\n/);
  assert.match(stepSummary('yokoten check', [{ id: 'secret', what: 'a secret', why: 'w', fix: 'f', file: 'a.env', line: 2, grade: 'likely', ignored: 'a test fixture' }], []), /\n\| a\.env:2 \| secret \| a secret \[likely; ignored: a test fixture\] \| W \| F \|\n/);
  const many = Array.from({ length: 53 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const text = stepSummary('yokoten check', many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.match(text, /^### yokoten check: 53 problems\n/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('| a.md:')).length, 50);
  assert.match(text, /\nAnd 3 more\. The job log lists them all\.\n/);
  assert.match(text, /#### Notes \(1\): these never fail the check\n\nThe job log lists them\.\n/);
});
// #406: the bot reads the branch's files as check --pr reads a pull request's: a rename is its new path.
test('branch files: changed, renamed and deleted paths since the base, from one local diff (#406)', () => {
  const dir = makeTempDir('yokoten-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'old.ts'), 'export const long = "a long enough line for git to see a rename";\n');
  writeFileSync(join(dir, 'gone.md'), 'Gone.\n');
  writeFileSync(join(dir, 'same.md'), 'Same.\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('mv', 'src/old.ts', 'src/new name.ts');
  git('rm', '-q', 'gone.md');
  writeFileSync(join(dir, 'kit.md'), 'New.\n');
  git('add', '.');
  git('commit', '-qm', 'head');
  const read = readBranchFiles(dir, 'origin/main', 'HEAD', process.env);
  assert.deepEqual({ files: read?.files.sort(), deleted: read?.deleted }, { files: ['gone.md', 'kit.md', 'src/new name.ts'], deleted: ['gone.md'] });
  assert.equal(readBranchFiles(dir, 'origin/none', 'HEAD', process.env), null, 'a base git does not have');
});

// No answer from git is never "no CODEOWNERS", which would let a pull request lower its tier (#403).
test('readCodeOwners: the first place the base commit has; a base git can\'t read throws, never null (#403)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'none');
  const none = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('docs/CODEOWNERS', '/docs/ @b\n');
  sandbox.write('CODEOWNERS', '/kit/ @a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'owners');
  const owners = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // The work tree has another file, which a pull request run must not read.
  sandbox.write('CODEOWNERS', '');
  assert.equal(readCodeOwners(sandbox.repo, none, process.env), null);
  assert.deepEqual(readCodeOwners(sandbox.repo, owners, process.env), { text: '/kit/ @a\n', from: 'the base branch' });
  assert.throws(() => readCodeOwners(sandbox.repo, 'f'.repeat(40), process.env), GitReadError);
});

test('annotations: an ignore a pull request adds is a notice, after the problems and before the other notes (#616)', () => {
  const problem = { id: 'secret', what: 'a secret', why: 'w', fix: 'f', file: 'a.ts', line: 1 };
  const added = { id: 'ignore-added', what: 'this pull request lets a secret hit through on this line', why: 'w', fix: 'f', file: 'a.ts', line: 2, ignored: 'a fixture' };
  const note = { id: 'large-diff', what: 'big', why: 'w', fix: 'f' };
  const lines = annotations([problem], [note, added]);
  assert.match(lines[0], /^::error /);
  assert.equal(lines[1], '::notice file=a.ts,line=2,title=yokoten ignore-added::this pull request lets a secret hit through on this line [ignored: a fixture]. W. F.');
  assert.match(lines[2], /^::warning /);
});

// #615: a local run names the pull request by number or URL, and `check --pr` with no
// number reads the one open on the current branch.
test('pull request number: a number or a pull request URL, never anything else (#615)', () => {
  assert.equal(pullRequestNumber('12'), '12');
  assert.equal(pullRequestNumber(' 12 '), '12');
  assert.equal(pullRequestNumber('https://github.com/octo/app/pull/12'), '12');
  assert.equal(pullRequestNumber('https://github.com/octo/app/pull/12/'), '12');
  for (const bad of ['0', 'main', 'https://github.com/octo/app/issues/12', 'ftp://github.com/octo/app/pull/12', 'not a url']) {
    assert.equal(pullRequestNumber(bad), null, bad);
  }
});

test('branch pull request: the open pull request of the current branch through gh (#615)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const answer = (fields: Record<string, unknown>) =>
    JSON.stringify({ title: 'feat: a', body: 'tier: B\n', labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, author: { login: 'octo' }, baseRefOid: base, headRefOid: head, ...fields });
  const read = readBranchPullRequest(sandbox.repo, () => answer({}), process.env);
  assert.equal(read && !('problem' in read) && read.title, 'feat: a');
  assert.deepEqual(read && !('problem' in read) && read.files, ['src/a.ts']);
  // A branch with no open pull request is null: the check says so and passes.
  const none = readBranchPullRequest(sandbox.repo, () => { throw Object.assign(new Error('gh failed'), { stderr: 'no pull requests found for branch "feat/a"' }); }, process.env);
  assert.equal(none, null);
  // A commit this clone does not have is one finding, with the fetch to run.
  const missing = readBranchPullRequest(sandbox.repo, () => answer({ headRefOid: 'f'.repeat(40) }), process.env);
  assert.match(missing && 'problem' in missing ? missing.problem.fix : '', /git fetch origin/);
});

// #432: the open pull requests `pr sync` walks, through one gh list. A fork is kept and
// marked, since its branch is not on origin. Odd rows are skipped, and a failure is a reason.
test('readOpenPulls: open rows, a fork marked, odd rows skipped, a failure is a reason (#432)', () => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return JSON.stringify([
      { number: 3, headRefName: 'work', baseRefName: 'main', isCrossRepository: false },
      { number: 4, headRefName: 'from-fork', baseRefName: 'main', isCrossRepository: true },
      { number: 0, headRefName: 'bad', baseRefName: 'main' },
      { number: 5, headRefName: '', baseRefName: 'main' },
      { headRefName: 'no-number', baseRefName: 'main' },
    ]);
  };
  assert.deepEqual(readOpenPulls(gh, 'octo/demo'), {
    pulls: [
      { number: 3, branch: 'work', base: 'main', isFork: false },
      { number: 4, branch: 'from-fork', base: 'main', isFork: true },
    ],
    isCut: false,
  });
  assert.deepEqual(calls, [['pr', 'list', '--repo', 'octo/demo', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,baseRefName,isCrossRepository']]);
  assert.equal(readOpenPulls(() => '{"not":"a list"}', 'o/r'), 'gh gave no pull request list: run it again');
  const missing = () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  };
  assert.match(String(readOpenPulls(missing, 'o/r')), /^gh is not installed/);
  const refused = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 401: Bad credentials' });
  };
  assert.match(String(readOpenPulls(refused, 'o/r')), /^gh can't list the open pull requests/);
});

test('readOpenPulls: a full list is marked as cut at the limit (#809)', () => {
  const rows = Array.from({ length: OPEN_PULL_LIMIT }, (_, at) => ({ number: at + 1, headRefName: `work-${at + 1}`, baseRefName: 'main' }));
  const full = readOpenPulls(() => JSON.stringify(rows), 'o/r');
  assert.equal(typeof full === 'string' ? full : full.isCut, true, 'the caller can say some pull requests were not read');
  const short = readOpenPulls(() => JSON.stringify(rows.slice(0, OPEN_PULL_LIMIT - 1)), 'o/r');
  assert.equal(typeof short === 'string' ? short : short.isCut, false);
});

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
