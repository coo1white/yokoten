import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addWorkerPath, checkCommand, listedWorker, loadWorkerPaths, markNote, removeWorkerPath, withWorkerMark, workerMarkAt, workerRole } from '../../../../src/rules/guards/index.ts';
import { makeTempDir } from '../../../../test/repo/helpers.ts';

test('worker list: a listed path stays a worker with .git moved away (#566)', () => {
  const base = makeTempDir('yokoten-list-');
  const home = join(base, 'home');
  mkdirSync(home);
  const env = { HOME: home };
  const store = join(base, 'store');
  mkdirSync(store);
  const tree = join(base, 'wt');
  mkdirSync(join(tree, 'src'), { recursive: true });
  writeFileSync(join(tree, '.git'), `gitdir: ${store}\n`);
  // Negative control: no mark and no list entry is the lead's.
  assert.equal(workerMarkAt(join(tree, 'src'), env), null);
  assert.equal(workerRole(env, [join(tree, 'src')]), null);
  assert.equal(listedWorker(join(tree, 'src'), env), null);
  // Mark the worktree: the git-folder mark and the list entry.
  writeFileSync(join(store, 'yokoten-worker'), 'x');
  addWorkerPath(env, tree);
  addWorkerPath(env, tree);
  const top = realpathSync(tree);
  assert.deepEqual(loadWorkerPaths(env), [top], 'marking twice keeps one entry');
  assert.equal(workerMarkAt(join(tree, 'src'), env), 'mark');
  assert.equal(workerRole(env, [join(tree, 'src')]), 'mark');
  assert.deepEqual(withWorkerMark(env, [tree]), { ...env, YOKOTEN_ROLE: 'worker' });
  // Positive control: with `.git` moved away, the list still makes it a worker.
  renameSync(join(tree, '.git'), join(base, 'dot-git-moved'));
  assert.equal(workerMarkAt(join(tree, 'src'), env), 'mark');
  assert.equal(workerRole(env, [join(tree, 'src')]), 'mark');
  assert.match(markNote([join(tree, 'src')], env), /worker list/);
  // A folder outside the listed worktree is not a worker.
  assert.equal(workerMarkAt(base, env), null);
  assert.equal(workerRole(env, [base]), null);
  // Unmark clears it: the lead again.
  removeWorkerPath(env, tree);
  assert.deepEqual(loadWorkerPaths(env), []);
  assert.equal(workerMarkAt(join(tree, 'src'), env), null);
  assert.equal(workerRole(env, [join(tree, 'src')]), null);
  // A removed worktree's entry never matches, and the next mark drops it.
  addWorkerPath(env, tree);
  rmSync(tree, { recursive: true, force: true });
  assert.equal(listedWorker(tree, env), null, 'an entry whose folder is gone never matches');
  assert.equal(workerMarkAt(tree, env), null);
  const other = join(base, 'other');
  mkdirSync(other);
  addWorkerPath(env, other);
  assert.deepEqual(loadWorkerPaths(env), [realpathSync(other)], 'the next mark drops the gone entry');
});

// #566: `yokoten worker unmark` is the lead's: the command guard refuses it for a
// worker-role session, whatever folder the command names, and lets the lead through.

test('worker list: the guard refuses `yokoten worker unmark` for a worker, not the lead (#566)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const command of [
    'yokoten worker unmark /tmp/wt',
    'cd /tmp && yokoten worker unmark /tmp/wt',
    'node bin/yokoten.ts worker unmark /tmp/wt',
    'npx yokoten worker unmark /tmp/wt',
    'yokoten worker unmark',
  ]) {
    const found = checkCommand(command, { env: worker, cwd: process.cwd() });
    assert.equal(found?.id, 'worker-mark', `should refuse: ${command}`);
    assert.match(found?.what ?? '', /only the lead unmarks a worktree/, command);
  }
  assert.equal(checkCommand('yokoten worker unmark /tmp/wt', { env: {}, cwd: process.cwd() }), null, 'the lead');
  // #672: a worker that marks the lead's checkout makes the lead a worker: refused too.
  for (const command of ['yokoten worker mark /tmp/lead', 'node bin/yokoten.ts worker mark .', 'cd /tmp && npx yokoten worker mark lead']) {
    const found = checkCommand(command, { env: worker, cwd: process.cwd() });
    assert.equal(found?.id, 'worker-mark', `should refuse: ${command}`);
    assert.match(found?.what ?? '', /only the lead marks a worktree or a clone/, command);
  }
  assert.equal(checkCommand('yokoten worker mark /tmp/wt', { env: {}, cwd: process.cwd() }), null, 'the lead marks');
  assert.equal(checkCommand('yokoten worker env', { env: worker, cwd: process.cwd() }), null, 'env only lists names');
  assert.equal(checkCommand('yokoten bot -- echo hi', { env: worker, cwd: process.cwd() })?.id, 'worker-push', 'bot keeps its own refusal');
});

// #591: yokoten's config folder holds the worker list and the bot's keys. A worker that
// clears the list loses its role, as with the mark (#555), so a worker's plain ways to
// change that folder are refused, by real path too; a read passes, and the lead may.
