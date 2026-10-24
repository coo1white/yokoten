// Tests for src/commands/merge/conflicts/moves.ts and the commit-time move window (#910).

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveCollision, structural } from '../../../../src/commands/merge/conflicts/moves.ts';
import type { Change, ConflictMap } from '../../../../src/commands/merge/conflicts/types.ts';
import { makeSandbox } from '../../../repo/helpers.ts';

/** One open change, with only the fields a test cares about. */
function change(id: string, more: Partial<Change> = {}): Change {
  return {
    id,
    label: `PR #${id.replace('pr:', '')}`,
    branch: id.replace('pr:', 'feat/'),
    head: '01234567',
    draft: false,
    files: [],
    moves: [],
    mainConflicts: [],
    ...more,
  };
}

function conflictMap(...changes: Change[]): ConflictMap {
  return { version: 1, builtAt: new Date().toISOString(), main: '01234567', changes, collisions: [], leased: {}, hot: [] };
}

/** The map a commit check reads, at the clone's git folder. */
function writeMap(sandbox: ReturnType<typeof makeSandbox>, changes: Change[], { builtAt = new Date().toISOString(), version = 1 } = {}): void {
  sandbox.write('.git/yokoten/conflicts.json', JSON.stringify({ ...conflictMap(...changes), builtAt, version }));
}

test('structural: the changes that move files, in the map order, without drafts (#910)', () => {
  const first = change('pr:1', { branch: 'feat/one', moves: ['src/a.ts'], files: ['src/a.ts', 'src/b.ts'] });
  const edit = change('pr:2', { branch: 'feat/two', files: ['README.md'] });
  const draft = change('pr:3', { branch: 'feat/three', draft: true, moves: ['src/d.ts'] });
  const second = change('pr:4', { branch: 'feat/four', moves: ['src/e.ts'] });
  assert.deepEqual(structural(conflictMap(edit, first, draft, second)).map((one) => one.id), ['pr:1', 'pr:4']);
  assert.deepEqual(structural(conflictMap(edit, draft)), []);
});

test('moveCollision: the first other change that moves a staged path, or null (#910)', () => {
  const first = change('pr:1', { branch: 'feat/one', moves: ['src/a.ts'] });
  const second = change('pr:2', { branch: 'feat/two', moves: ['src/a.ts', 'src/b.ts'] });
  // Oldest first: the change that got there first is the one a person waits for.
  assert.equal(moveCollision(conflictMap(first, second), ['src/a.ts'], 'feat/three')?.id, 'pr:1');
  // The branch's own change never collides with itself.
  assert.equal(moveCollision(conflictMap(first, second), ['src/a.ts'], 'feat/one')?.id, 'pr:2');
  // Only a move counts, not an edit elsewhere, and a different path is free.
  assert.equal(moveCollision(conflictMap(change('pr:5', { branch: 'feat/five', files: ['src/a.ts'] })), ['src/a.ts'], 'feat/three'), null);
  assert.equal(moveCollision(conflictMap(first), ['src/z.ts'], 'feat/three'), null);
  // A draft still holds the path it moves.
  assert.equal(moveCollision(conflictMap(change('pr:6', { branch: 'feat/six', draft: true, moves: ['src/a.ts'] })), ['src/a.ts'], 'feat/three')?.id, 'pr:6');
  assert.equal(moveCollision(conflictMap(), [], 'feat/three'), null);
});

test('check --staged: a rename waits for the open change that moves the same path (#910)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  sandbox.git('checkout', '-qb', 'feat/second');
  sandbox.git('mv', 'src/a.ts', 'src/b.ts');
  const other = change('pr:12', { branch: 'feat/move', moves: ['src/a.ts'], files: ['src/a.ts', 'src/c.ts'] });
  // No map, a stale map, and this branch's own change all allow: a commit is only blocked
  // by an open change on another branch, in a map rebuilt within the hour.
  assert.equal((await sandbox.call(['check', '--staged'])).status, 0, 'a missing map allows');
  writeMap(sandbox, [other], { builtAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
  assert.equal((await sandbox.call(['check', '--staged'])).status, 0, 'a stale map allows');
  writeMap(sandbox, [{ ...other, branch: 'feat/second' }]);
  assert.equal((await sandbox.call(['check', '--staged'])).status, 0, 'this branch is not another change');
  writeMap(sandbox, [other], { version: 2 });
  assert.equal((await sandbox.call(['check', '--staged'])).status, 0, 'a version it does not know allows');
  // The refusal, with the other change's name. Run once as a child: this is the entry point
  // the commit hook starts.
  writeMap(sandbox, [other]);
  const result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /PR #12 moves src\/a\.ts too/);
  const json = await sandbox.call(['check', '--staged', '--json']);
  assert.equal(JSON.parse(json.stdout).findings[0].id, 'structural-change');
});

test('check --staged: a merge that brings a move allows it (#910)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  sandbox.git('checkout', '-qb', 'feat/move');
  sandbox.git('mv', 'src/a.ts', 'src/c.ts');
  sandbox.git('commit', '-qm', 'move a.ts');
  sandbox.git('checkout', '-q', 'main');
  sandbox.git('merge', '--no-ff', '--no-commit', 'feat/move');
  // The map may still list the change being merged: its own commit was checked already.
  writeMap(sandbox, [change('pr:30', { branch: 'feat/move', moves: ['src/a.ts'] })]);
  const result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
});

test('check --staged: a split (delete plus adds) waits too (#910)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  sandbox.git('rm', '-q', 'src/a.ts');
  sandbox.write('src/b.ts', 'export const b = 1;\n');
  sandbox.write('src/c.ts', 'export const c = 1;\n');
  sandbox.git('add', '.');
  writeMap(sandbox, [change('pr:20', { branch: 'feat/split', moves: ['src/a.ts'] })]);
  const result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /PR #20 moves src\/a\.ts too/);
});
