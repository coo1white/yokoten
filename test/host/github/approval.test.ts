// Tests for src/host/github/approval.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir, said, serverGh } from '../../repo/helpers.ts';
import { type Gh } from '../../../src/host/github/planning.ts';
import { APPROVAL_GIT_TIMEOUT_MS, readApprovalState } from '../../../src/host/github/approval.ts';

// #612: the approval git fetch must not hang the bot. The git reads share the gh read
// budget through one constant, which gitRead passes to every approval git command.
test('approve: the approval git reads share the gh read budget (#612)', () => {
  assert.equal(APPROVAL_GIT_TIMEOUT_MS, 15000);
});
// #612: what the Approve check knows: the tier, the head, and what came after the
// latest Approve by a code owner of the changed files. Association never counts: the
// owner approves as COLLABORATOR on this repo, so only CODEOWNERS membership counts,
// and a review from anyone else never counts, even when newest. What gh or git can't
// answer is unsure, so the caller refuses it.
test('approval: the tier, the head, and what came after the code owner Approve (#612)', () => {
  const dir = makeTempDir('yokoten-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'CODEOWNERS'), '/a.txt @friend\n/c.txt @friend\n');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  git('checkout', '-qb', 'topic');
  writeFileSync(join(dir, 'a.txt'), 'b\n');
  git('commit', '-qam', 'change');
  const approved = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(dir, 'c.txt'), 'c\n');
  git('add', '.');
  git('commit', '-qm', 'more');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const review = (login: string, assoc: string, state: string, commit: string, at: string) => JSON.stringify({ login, assoc, state, commit, at });
  const approveAt = (login: string, assoc: string, commit: string, at: string) => review(login, assoc, 'APPROVED', commit, at);
  const ownerAt = (commit: string, at: string) => approveAt('owner', 'OWNER', commit, at);
  const friendAt = (commit: string, at: string) => approveAt('friend', 'COLLABORATOR', commit, at);
  const view = (body: string, labels: string[], ref: { sha: string }, baseSha: string) => ({ body, labels: labels.map((name) => ({ name })), head: { sha: ref.sha, ref: 'topic' }, base: { sha: baseSha, ref: 'main' } });
  const files = ['a.txt', 'c.txt'];
  const routes: Record<string, unknown> = {
    'repos/me/repo/pulls/12': view('tier: A\n', ['tier A'], { sha: head }, base),
    'repos/me/repo/pulls/12/files': files,
    'repos/me/repo/pulls/12/reviews': [ownerAt(head, '2026-10-22T11:00:00Z'), friendAt(approved, '2026-10-22T10:00:00Z')].join('\n'),
    'repos/me/repo/pulls/13': view('tier: B\n', ['tier B'], { sha: head }, base),
    'repos/me/repo/pulls/14': view('tier: A\n', ['tier A'], { sha: head }, base),
    'repos/me/repo/pulls/14/files': files,
    'repos/me/repo/pulls/14/reviews': friendAt(head, '2026-10-22T11:00:00Z'),
    'repos/me/repo/pulls/15': view('tier: A\n', ['tier A'], { sha: head }, base),
    'repos/me/repo/pulls/15/files': files,
    'repos/me/repo/pulls/15/reviews': ownerAt(head, '2026-10-22T11:00:00Z'),
    'repos/me/repo/pulls/16': view('no tier here\n', ['feat'], { sha: head }, base),
    'repos/me/repo/pulls/17': said(404),
    'repos/me/repo/pulls/19': view('tier: A\n', ['tier A'], { sha: head }, base),
    'repos/me/repo/pulls/19/files': files,
    'repos/me/repo/pulls/19/reviews': [friendAt(approved, '2026-10-22T10:00:00Z'), review('friend', 'COLLABORATOR', 'CHANGES_REQUESTED', head, '2026-10-22T11:00:00Z')].join('\n'),
    'repos/me/repo/pulls/20': view('tier: A\n', ['tier A'], { sha: head }, base),
    'repos/me/repo/pulls/20/files': files,
    'repos/me/repo/pulls/20/reviews': [friendAt(approved, '2026-10-22T10:00:00Z'), review('friend', 'COLLABORATOR', 'DISMISSED', head, '2026-10-22T11:00:00Z')].join('\n'),
    'repos/me/repo/pulls/21': view('tier: A\n', ['tier A'], { sha: head }, base),
    'repos/me/repo/pulls/21/files': files,
    'repos/me/repo/pulls/21/reviews': [friendAt(approved, '2026-10-22T10:00:00Z'), review('friend', 'COLLABORATOR', 'COMMENTED', head, '2026-10-22T11:00:00Z')].join('\n'),
  };
  const { gh, calls } = serverGh(routes);
  // A code change after the Approve: one commit with changes, and the sameDiff flag off.
  // The Approve counts although friend is only a collaborator, since CODEOWNERS names
  // them; the newer OWNER review never counts, since owner owns nothing changed.
  assert.deepEqual(readApprovalState(gh, dir, env, 12, 'me/repo'), { tier: 'A', head, approved, after: 1, sameDiff: false });
  // Not tier A: read no further. The Approve on the head needs no git either.
  assert.deepEqual(readApprovalState(gh, dir, env, 13, 'me/repo'), { tier: 'B', head, approved: null, after: 0, sameDiff: true });
  assert.deepEqual(readApprovalState(gh, dir, env, 14, 'me/repo'), { tier: 'A', head, approved: head, after: 0, sameDiff: true });
  assert.ok(
    !calls.some(([command, route]) => command === 'api' && (route === 'repos/me/repo/pulls/13/reviews' || route === 'repos/me/repo/pulls/13/files')),
    'no reviews or files read for tier B',
  );
  // No code owner Approve, no tier, and a gh failure are all unsure or empty, never a crash.
  assert.deepEqual(readApprovalState(gh, dir, env, 15, 'me/repo'), { tier: 'A', head, approved: null, after: 0, sameDiff: true });
  assert.deepEqual(readApprovalState(gh, dir, env, 16, 'me/repo'), { unsure: 'neither the body nor a label says the tier of pull request 16' });
  assert.deepEqual(readApprovalState(gh, dir, env, 17, 'me/repo'), { unsure: 'gh could not read pull request 17' });
  // A newer changes-requested or dismissed review from a code owner refuses, even with
  // an older Approve; a comment is neutral and leaves the Approve standing.
  assert.deepEqual(readApprovalState(gh, dir, env, 19, 'me/repo'), { tier: 'A', head, approved: null, after: 0, sameDiff: true });
  assert.deepEqual(readApprovalState(gh, dir, env, 20, 'me/repo'), { tier: 'A', head, approved: null, after: 0, sameDiff: true });
  assert.deepEqual(readApprovalState(gh, dir, env, 21, 'me/repo'), { tier: 'A', head, approved, after: 1, sameDiff: false });
  // A clean merge of main after the Approve: a branch with nothing new of its own merges
  // main in, so no commit with changes came after it, and the own diff is the same.
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-qm', 'main moves');
  const moved = git('rev-parse', 'HEAD').stdout.trim();
  git('checkout', '-q', '-b', 'clean', approved);
  git('merge', '-q', '-m', 'merge main', 'main');
  const merged = git('rev-parse', 'HEAD').stdout.trim();
  const mergedRoutes: Record<string, unknown> = {
    'repos/me/repo/pulls/18': view('tier: A\n', ['tier A'], { sha: merged }, moved),
    'repos/me/repo/pulls/18/files': ['a.txt', 'b.txt'],
    'repos/me/repo/pulls/18/reviews': friendAt(approved, '2026-10-22T10:00:00Z'),
  };
  assert.deepEqual(readApprovalState(serverGh(mergedRoutes).gh, dir, env, 18, 'me/repo'), { tier: 'A', head: merged, approved, after: 0, sameDiff: true });
});

// #612: an Approve counts when its author is on the owning team, and a review from
// outside the owners never counts, even when newest. A team gh can't expand is unsure,
// so the caller refuses it: fail closed.
test('approval: a team member Approve counts; an unexpandable team is unsure (#612)', () => {
  const dir = makeTempDir('yokoten-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'CODEOWNERS'), '/a.txt @me/crew\n');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  git('checkout', '-qb', 'topic');
  writeFileSync(join(dir, 'a.txt'), 'b\n');
  git('commit', '-qam', 'change');
  const approved = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(dir, 'a.txt'), 'c\n');
  git('commit', '-qam', 'more');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const view = { body: 'tier: A\n', labels: [{ name: 'tier A' }], head: { sha: head, ref: 'topic' }, base: { sha: base, ref: 'main' } };
  const review = (login: string, assoc: string, state: string, commit: string, at: string) => JSON.stringify({ login, assoc, state, commit, at });
  const mateApprove = (commit: string, at: string) => review('mate1', 'MEMBER', 'APPROVED', commit, at);
  const fakeGh = (reviews: string, members: string[] | null): Gh => (args) => {
    const path = args[1] ?? '';
    if (path === 'repos/me/repo/pulls/30') return JSON.stringify(view);
    if (path === 'repos/me/repo/pulls/30/files') return JSON.stringify(['a.txt']);
    if (path === 'repos/me/repo/pulls/30/reviews') return reviews;
    if (path === 'orgs/me/teams/crew/members') {
      if (members === null) throw new Error('gh: the team lookup failed');
      return members.map((login) => JSON.stringify(login)).join('\n');
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  // A team member's Approve counts, although the association is only MEMBER.
  assert.deepEqual(readApprovalState(fakeGh(mateApprove(head, '2026-10-22T11:00:00Z'), ['mate1']), dir, env, 30, 'me/repo'), {
    tier: 'A',
    head,
    approved: head,
    after: 0,
    sameDiff: true,
  });
  // A newer Approve from outside the owners never counts, even when newest.
  const outsiderNewest = [mateApprove(approved, '2026-10-22T10:00:00Z'), review('stranger', 'COLLABORATOR', 'APPROVED', head, '2026-10-22T11:00:00Z')].join('\n');
  assert.deepEqual(readApprovalState(fakeGh(outsiderNewest, ['mate1']), dir, env, 30, 'me/repo'), { tier: 'A', head, approved, after: 1, sameDiff: false });
  // A team gh can't expand is unsure, never a pass.
  assert.deepEqual(readApprovalState(fakeGh(mateApprove(head, '2026-10-22T11:00:00Z'), null), dir, env, 30, 'me/repo'), {
    unsure: 'gh could not list the members of @me/crew for pull request 30',
  });
});

// #612: files CODEOWNERS names no owner for fall back to every user it names.
// GitHub enforces nothing file-specific there, so any repo owner is stronger.
test('approval: unowned files fall back to every CODEOWNERS user (#612)', () => {
  const dir = makeTempDir('yokoten-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'CODEOWNERS'), '/a.txt @friend\n');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  git('checkout', '-qb', 'topic');
  writeFileSync(join(dir, 'docs-note.txt'), 'words\n');
  git('add', '.');
  git('commit', '-qam', 'docs');
  const approved = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(dir, 'more-note.txt'), 'more\n');
  git('add', '.');
  git('commit', '-qm', 'more docs');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const view = { body: 'tier: A\n', labels: [{ name: 'tier A' }], head: { sha: head, ref: 'topic' }, base: { sha: base, ref: 'main' } };
  const review = (login: string, commit: string, at: string) => JSON.stringify({ login, assoc: 'COLLABORATOR', state: 'APPROVED', commit, at });
  const fakeGh = (reviews: string): Gh => (args) => {
    const path = args[1] ?? '';
    if (path === 'repos/me/repo/pulls/31') return JSON.stringify(view);
    if (path === 'repos/me/repo/pulls/31/files') return JSON.stringify(['docs-note.txt', 'more-note.txt']);
    if (path === 'repos/me/repo/pulls/31/reviews') return reviews;
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  // The repo owner's Approve counts on the head, although no rule owns the files.
  assert.deepEqual(readApprovalState(fakeGh(review('friend', head, '2026-10-22T11:00:00Z')), dir, env, 31, 'me/repo'), {
    tier: 'A',
    head,
    approved: head,
    after: 0,
    sameDiff: true,
  });
  // The same Approve on an older commit refuses: one commit with changes came after.
  assert.deepEqual(readApprovalState(fakeGh(review('friend', approved, '2026-10-22T10:00:00Z')), dir, env, 31, 'me/repo'), {
    tier: 'A',
    head,
    approved,
    after: 1,
    sameDiff: false,
  });
});
// #612: two deciding reviews by owners sharing the newest second with different
// states decide nothing: fail closed with the plain message, never first-in-list.
test('approval: a shared newest second with different states is no Approve (#612)', () => {
  const dir = makeTempDir('yokoten-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'CODEOWNERS'), '/a.txt @friend\n');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  git('checkout', '-qb', 'topic');
  writeFileSync(join(dir, 'a.txt'), 'b\n');
  git('commit', '-qam', 'change');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const view = { body: 'tier: A\n', labels: [{ name: 'tier A' }], head: { sha: head, ref: 'topic' }, base: { sha: base, ref: 'main' } };
  const review = (login: string, state: string, commit: string, at: string) => JSON.stringify({ login, assoc: 'COLLABORATOR', state, commit, at });
  const fakeGh = (reviews: string): Gh => (args) => {
    const path = args[1] ?? '';
    if (path === 'repos/me/repo/pulls/32') return JSON.stringify(view);
    if (path === 'repos/me/repo/pulls/32/files') return JSON.stringify(['a.txt']);
    if (path === 'repos/me/repo/pulls/32/reviews') return reviews;
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const at = '2026-10-22T11:00:00Z';
  // The Approve is listed first, but the same-second changes-requested ties it.
  const tied = [review('friend', 'APPROVED', head, at), review('friend', 'CHANGES_REQUESTED', head, at)].join('\n');
  assert.deepEqual(readApprovalState(fakeGh(tied), dir, env, 32, 'me/repo'), { tier: 'A', head, approved: null, after: 0, sameDiff: true });
  // The same second with the same state still stands.
  const agreed = [review('friend', 'APPROVED', head, at), review('friend', 'APPROVED', head, at)].join('\n');
  assert.deepEqual(readApprovalState(fakeGh(agreed), dir, env, 32, 'me/repo'), { tier: 'A', head, approved: head, after: 0, sameDiff: true });
});

/** The git env the Approve tests use: no home config, and an example.com author. */
function makeApprovalEnv(home: string) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
}

/** One git command's output. A non-zero exit fails the test. */
function runGitOk(cwd: string, env: ReturnType<typeof makeApprovalEnv>, args: string[]): string {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Whether this checkout has `sha` as a commit. */
function hasCommit(cwd: string, env: ReturnType<typeof makeApprovalEnv>, sha: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, env, encoding: 'utf8' }).status === 0;
}

/** A tier A pull request whose head `friend` approved, aimed at `base`. */
function makeFriendView(head: string, base: string) {
  return {
    body: 'tier: A\n',
    labels: [{ name: 'tier A' }],
    head: { sha: head, ref: 'topic' },
    base: { sha: base, ref: 'main' },
  };
}

/** The review line: `friend` approved `commit`. */
function makeFriendReview(commit: string): string {
  return JSON.stringify({ login: 'friend', assoc: 'COLLABORATOR', state: 'APPROVED', commit, at: '2026-10-22T11:00:00Z' });
}

/** A contents API file body. Newlines sit in `content`, as GitHub writes them. */
function makeOwnersFile(text: string) {
  return { type: 'file', encoding: 'base64', content: `\n${Buffer.from(text).toString('base64')}\n` };
}

const ownersText = '/a.txt @friend\n';

// #670: a lead's clone often lacks the pull request's base commit. The check
// fetches that commit and reads CODEOWNERS from it. The contents API is not used
// once the commit is here.
test('approval: a missing base commit is fetched before CODEOWNERS is read (#670)', () => {
  const root = makeTempDir('yokoten-');
  const env = makeApprovalEnv(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const dir = join(root, 'clone');
  runGitOk(root, env, ['init', '-q', '--bare', '-b', 'main', origin]);
  runGitOk(origin, env, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  runGitOk(origin, env, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  runGitOk(root, env, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  runGitOk(seed, env, ['add', '.']);
  runGitOk(seed, env, ['commit', '-qm', 'old']);
  runGitOk(seed, env, ['remote', 'add', 'origin', origin]);
  runGitOk(seed, env, ['push', '-q', 'origin', 'main']);
  runGitOk(root, env, ['clone', '-q', origin, dir]);
  writeFileSync(join(seed, 'CODEOWNERS'), ownersText);
  runGitOk(seed, env, ['add', '.']);
  runGitOk(seed, env, ['commit', '-qm', 'owners']);
  runGitOk(seed, env, ['push', '-q', 'origin', 'main']);
  const base = runGitOk(seed, env, ['rev-parse', 'HEAD']).trim();
  const head = 'a'.repeat(40);
  assert.equal(hasCommit(dir, env, base), false, 'the clone does not have the base commit yet');
  const contents = `repos/me/repo/contents/.github/CODEOWNERS?ref=${base}`;
  const routes: Record<string, unknown> = {
    'repos/me/repo/pulls/40': makeFriendView(head, base),
    'repos/me/repo/pulls/40/files': ['a.txt'],
    'repos/me/repo/pulls/40/reviews': makeFriendReview(head),
    // A body that names nobody useful: using it would not count friend's Approve.
    [contents]: makeOwnersFile('/a.txt @stranger\n'),
  };
  const { gh, calls } = serverGh(routes);
  assert.deepEqual(readApprovalState(gh, dir, env, 40, 'me/repo'), { tier: 'A', head, approved: head, after: 0, sameDiff: true });
  assert.equal(hasCommit(dir, env, base), true, 'the check fetched the base commit');
  assert.ok(!calls.some((args) => args.some((arg) => arg.includes('/contents/'))), 'a fetched commit is not read through the contents API');
});

// #670: with no remote, the fetch cannot get the base commit. A contents body for
// `.github/CODEOWNERS` is enough. A file over 64 KiB is a failed read, not a
// reason to use the next place. `@friend` approved the head.
test('approval: the contents API supplies CODEOWNERS when the base stays missing (#670)', () => {
  const dir = makeTempDir('yokoten-');
  const env = makeApprovalEnv(dir);
  runGitOk(dir, env, ['init', '-q', '-b', 'main']);
  // A worktree file must not count: the base commit is the one that is read.
  writeFileSync(join(dir, 'CODEOWNERS'), '/a.txt @stranger\n');
  const base = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const huge = 'x'.repeat(64 * 1024 + 1);
  const laterBase = 'e'.repeat(40);
  const routes: Record<string, unknown> = {
    'repos/me/repo/pulls/41': makeFriendView(head, base),
    'repos/me/repo/pulls/41/files': ['a.txt'],
    'repos/me/repo/pulls/41/reviews': makeFriendReview(head),
    [`repos/me/repo/contents/.github/CODEOWNERS?ref=${base}`]: makeOwnersFile(ownersText),
    'repos/me/repo/pulls/42': makeFriendView(head, laterBase),
    'repos/me/repo/pulls/42/files': ['a.txt'],
    'repos/me/repo/pulls/42/reviews': makeFriendReview(head),
    [`repos/me/repo/contents/.github/CODEOWNERS?ref=${laterBase}`]: makeOwnersFile(huge),
    [`repos/me/repo/contents/CODEOWNERS?ref=${laterBase}`]: makeOwnersFile(ownersText),
  };
  const { gh, calls } = serverGh(routes);
  assert.deepEqual(readApprovalState(gh, dir, env, 41, 'me/repo'), { tier: 'A', head, approved: head, after: 0, sameDiff: true });
  assert.equal(hasCommit(dir, env, base), false, 'the contents API does not fetch the commit');
  assert.ok(
    calls.some((args) => args[0] === 'api' && args[1] === `repos/me/repo/contents/.github/CODEOWNERS?ref=${base}`),
    'the contents path is one argument',
  );
  assert.ok(!calls.some((args) => args[1] === `repos/me/repo/contents/CODEOWNERS?ref=${base}`), 'the first file wins');
  // The first place is over 64 KiB. The cap is ours, so the read fails closed.
  calls.length = 0;
  assert.deepEqual(readApprovalState(gh, dir, env, 42, 'me/repo'), { unsure: 'the CODEOWNERS file for pull request 42 could not be read' });
  assert.ok(!calls.some((args) => args[1] === `repos/me/repo/contents/CODEOWNERS?ref=${laterBase}`), 'a file over the cap is not a 404');
});

// #670: GitHub keeps the first CODEOWNERS place that exists. A real 404 means
// that place is absent, so the next place is read. Any other failure stops the
// search. A later file must not count as the owner's Approve.
test('approval: only a real 404 moves to the next CODEOWNERS place (#670)', () => {
  const dir = makeTempDir('yokoten-');
  const env = makeApprovalEnv(dir);
  runGitOk(dir, env, ['init', '-q', '-b', 'main']);
  // A worktree file must not count: the base commit is the one that is read.
  writeFileSync(join(dir, 'CODEOWNERS'), '/a.txt @stranger\n');
  const head = 'a'.repeat(40);
  const broken = 'f'.repeat(40);
  const absent = '1'.repeat(40);
  const middle = '2'.repeat(40);
  const contentsAt = (base: string, place: string) => `repos/me/repo/contents/${place}?ref=${base}`;
  const makePull = (number: number, base: string) => ({
    [`repos/me/repo/pulls/${number}`]: makeFriendView(head, base),
    [`repos/me/repo/pulls/${number}/files`]: ['a.txt'],
    [`repos/me/repo/pulls/${number}/reviews`]: makeFriendReview(head),
  });
  const routes: Record<string, unknown> = {
    ...makePull(48, broken),
    [contentsAt(broken, '.github/CODEOWNERS')]: said(500),
    // A later file that would approve, if the 500 were treated as "no file".
    [contentsAt(broken, 'CODEOWNERS')]: makeOwnersFile(ownersText),
    ...makePull(49, absent),
    [contentsAt(absent, '.github/CODEOWNERS')]: said(404),
    [contentsAt(absent, 'CODEOWNERS')]: makeOwnersFile(ownersText),
    ...makePull(50, middle),
    [contentsAt(middle, '.github/CODEOWNERS')]: said(404),
    [contentsAt(middle, 'CODEOWNERS')]: said(500),
    [contentsAt(middle, 'docs/CODEOWNERS')]: makeOwnersFile(ownersText),
  };
  const { gh, calls } = serverGh(routes);
  const refused = readApprovalState(gh, dir, env, 48, 'me/repo');
  assert.deepEqual(refused, { unsure: 'the CODEOWNERS file for pull request 48 could not be read' });
  assert.equal(JSON.stringify(refused).includes('approve'), false);
  assert.ok(!calls.some((args) => args[1] === contentsAt(broken, 'CODEOWNERS')), 'an HTTP 500 is not a 404');
  calls.length = 0;
  assert.deepEqual(readApprovalState(gh, dir, env, 49, 'me/repo'), { tier: 'A', head, approved: head, after: 0, sameDiff: true });
  assert.ok(calls.some((args) => args[1] === contentsAt(absent, 'CODEOWNERS')), 'a 404 moves to the next place');
  assert.ok(!calls.some((args) => args[1] === contentsAt(absent, 'docs/CODEOWNERS')), 'the first file that exists wins');
  calls.length = 0;
  assert.deepEqual(readApprovalState(gh, dir, env, 50, 'me/repo'), { unsure: 'the CODEOWNERS file for pull request 50 could not be read' });
  assert.ok(calls.some((args) => args[1] === contentsAt(middle, 'CODEOWNERS')), 'the 404 place is passed');
  assert.ok(!calls.some((args) => args[1] === contentsAt(middle, 'docs/CODEOWNERS')), 'a later 500 stops the search');
});

// #670: when the base commit stays missing and no contents body answers, the
// reason names the short sha and says to fetch. It does not ask for an Approve.
// A name that is not a commit id keeps today's failure. A commit that is already
// here, but whose CODEOWNERS git cannot read, does too, and the contents API is
// not called.
test('approval: a base commit that stays missing names the short sha (#670)', () => {
  const dir = makeTempDir('yokoten-');
  const env = makeApprovalEnv(dir);
  runGitOk(dir, env, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  runGitOk(dir, env, ['add', '.']);
  runGitOk(dir, env, ['commit', '-qm', 'base']);
  const base = 'd'.repeat(40);
  const head = 'a'.repeat(40);
  const missing = `the base commit ${base.slice(0, 7)} isn't in this clone; run \`git fetch origin\``;
  const makePulls = (number: number, sha: string) => ({
    [`repos/me/repo/pulls/${number}`]: makeFriendView(head, sha),
    [`repos/me/repo/pulls/${number}/files`]: ['a.txt'],
    [`repos/me/repo/pulls/${number}/reviews`]: makeFriendReview(head),
  });
  const { gh, calls } = serverGh({ ...makePulls(43, base), ...makePulls(44, 'no-such-branch') });
  const absent = readApprovalState(gh, dir, env, 43, 'me/repo');
  assert.deepEqual(absent, { unsure: missing });
  assert.equal(missing.includes('approve'), false);
  calls.length = 0;
  assert.deepEqual(readApprovalState(gh, dir, env, 44, 'me/repo'), { unsure: 'the CODEOWNERS file for pull request 44 could not be read' });
  assert.ok(!calls.some((args) => args.some((arg) => arg.includes('/contents/'))), 'a branch name is not read through the contents API');
  // The commit is local, but its CODEOWNERS blob is gone, so git cannot read the file.
  writeFileSync(join(dir, 'CODEOWNERS'), ownersText);
  runGitOk(dir, env, ['add', '.']);
  runGitOk(dir, env, ['commit', '-qm', 'owners']);
  const present = runGitOk(dir, env, ['rev-parse', 'HEAD']).trim();
  const blob = runGitOk(dir, env, ['rev-parse', 'HEAD:CODEOWNERS']).trim();
  rmSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const { gh: brokenGh, calls: brokenCalls } = serverGh({
    ...makePulls(46, present),
    // A usable file, so a wrong call would count friend's Approve.
    [`repos/me/repo/contents/.github/CODEOWNERS?ref=${present}`]: makeOwnersFile(ownersText),
  });
  assert.equal(hasCommit(dir, env, present), true);
  assert.deepEqual(readApprovalState(brokenGh, dir, env, 46, 'me/repo'), { unsure: 'the CODEOWNERS file for pull request 46 could not be read' });
  assert.ok(!brokenCalls.some((args) => args.some((arg) => arg.includes('/contents/'))), 'a local commit is not read through the contents API');
  // A good read with no CODEOWNERS file keeps the old reason.
  const bare = makeTempDir('yokoten-');
  const bareEnv = makeApprovalEnv(bare);
  runGitOk(bare, bareEnv, ['init', '-q', '-b', 'main']);
  writeFileSync(join(bare, 'a.txt'), 'a\n');
  runGitOk(bare, bareEnv, ['add', '.']);
  runGitOk(bare, bareEnv, ['commit', '-qm', 'no owners']);
  const none = runGitOk(bare, bareEnv, ['rev-parse', 'HEAD']).trim();
  const { gh: noneGh, calls: noneCalls } = serverGh(makePulls(47, none));
  assert.deepEqual(readApprovalState(noneGh, bare, bareEnv, 47, 'me/repo'), {
    unsure: 'no CODEOWNERS file covers pull request 47, so no code owner can approve it',
  });
  assert.ok(!noneCalls.some((args) => args.some((arg) => arg.includes('/contents/'))));
});
