import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand, checkWorkerMarkEdit, gitLinkAbove, markNote, withWorkerMark, workerMarkAt, workerRole } from '../../../../src/rules/guards/index.ts';
import { makeGitFolder, makeTempDir, runChild } from '../../../../test/repo/helpers.ts';

test('worker mark: found from .git, fails closed on a link it cannot read (#555)', () => {
  const base = makeTempDir('yokoten-mark-');
  const store = join(base, 'store');
  mkdirSync(store);
  const tree = join(base, 'wt');
  mkdirSync(join(tree, 'src'), { recursive: true });
  const link = (text: string) => writeFileSync(join(tree, '.git'), text);
  // Negative control: an unmarked worktree is the lead's; a main checkout too.
  link(`gitdir: ${store}\n`);
  assert.equal(workerMarkAt(join(tree, 'src')), null);
  assert.deepEqual(withWorkerMark({}, [join(tree, 'src')]), {});
  const main = join(base, 'main');
  makeGitFolder(main);
  assert.equal(workerMarkAt(main), null);
  assert.equal(workerRole({}, [main, base]), null);
  // Positive control: the mark.
  writeFileSync(join(store, 'yokoten-worker'), 'x');
  assert.equal(workerMarkAt(join(tree, 'src')), 'mark');
  assert.equal(workerRole({}, [main, join(tree, 'src')]), 'mark');
  assert.deepEqual(withWorkerMark({}, [tree]), { YOKOTEN_ROLE: 'worker' });
  assert.equal(workerRole({ YOKOTEN_ROLE: 'worker' }, ['/nowhere']), 'env');
  rmSync(join(store, 'yokoten-worker'));
  // Fails closed: a gitdir that is gone, a .git with no gitdir line, one too big to be real.
  link(`gitdir: ${join(base, 'gone')}\n`);
  assert.equal(workerMarkAt(tree), 'broken');
  link('not a link\n');
  assert.equal(workerMarkAt(tree), 'broken');
  link(`gitdir: ${store}\n${'#'.repeat(5000)}\n`);
  assert.equal(workerMarkAt(tree), 'broken');
  link(`gitdir: ${store}\n`);
  assert.equal(workerMarkAt(tree), null);
  // Modes need a user that file modes stop: not root, not Windows.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(join(tree, '.git'), 0o000);
    assert.equal(workerMarkAt(tree), 'broken', 'a .git it cannot read');
    chmodSync(join(tree, '.git'), 0o644);
    chmodSync(store, 0o000);
    assert.equal(workerMarkAt(tree), 'broken', 'a git folder it cannot read');
    chmodSync(store, 0o755);
    assert.equal(workerMarkAt(tree), null);
  }
  // A FIFO named .git: not read, so nothing waits on a writer; and it fails closed.
  if (process.platform !== 'win32') {
    rmSync(join(tree, '.git'));
    runChild('mkfifo', [join(tree, '.git')]);
    const started = Date.now();
    assert.equal(workerMarkAt(tree), 'broken');
    assert.ok(Date.now() - started < 1000);
    rmSync(join(tree, '.git'));
    // A symlink to a git folder is a main checkout's .git.
    symlinkSync(join(main, '.git'), join(tree, '.git'));
    assert.equal(workerMarkAt(tree), null);
  }
});

// #555: an edit inside a git folder is a worker's way to change the mark, through a symlink too.
// #672: a desk is a plain clone, so its mark sits in its own `.git` folder.

test('worker mark: a plain clone with the mark in its .git is a worker; without it, the lead (#672)', () => {
  const clone = makeTempDir('yokoten-clone-');
  makeGitFolder(clone);
  mkdirSync(join(clone, 'src'));
  // Negative control: an unmarked clone is the lead's.
  assert.equal(workerMarkAt(join(clone, 'src')), null);
  // Positive control: the mark, found from a subfolder too.
  writeFileSync(join(clone, '.git', 'yokoten-worker'), 'x');
  assert.equal(workerMarkAt(join(clone, 'src')), 'mark');
  assert.deepEqual(withWorkerMark({}, [clone]), { YOKOTEN_ROLE: 'worker' });
  assert.match(markNote([clone]), /^this clone \(.*\) carries the worker mark/);
  // Fails closed: a .git folder the guard can't search. Modes need a user they stop.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(join(clone, '.git'), 0o000);
    try {
      assert.equal(workerMarkAt(clone), 'broken');
    } finally {
      chmodSync(join(clone, '.git'), 0o755);
    }
  }
  rmSync(join(clone, '.git', 'yokoten-worker'));
  assert.equal(workerMarkAt(clone), null);
});

// #672 (review): removing or replacing the folder that holds `.git` drops the mark, so a
// worker may not change the checkout's top folder or any folder above it.

test('worker mark: a worker may not remove or replace the folder that holds the git folder (#672)', () => {
  const base = makeTempDir('yokoten-desk-');
  const desk = join(base, 'desk');
  makeGitFolder(desk);
  mkdirSync(join(desk, 'src'));
  writeFileSync(join(desk, '.git', 'yokoten-worker'), 'x');
  const worker = { YOKOTEN_ROLE: 'worker', HOME: join(base, 'home') };
  const check = (command: string, cwd = desk) => checkCommand(command, { cwd, env: worker });
  for (const command of [
    `rm -rf ${desk} && git clone -q ../lead ${desk}`,
    'rm -rf "$PWD"',
    'rm -rf $PWD',
    'rm -rf ${PWD}/',
    'rm -rf ~+',
    'rm -rf .',
    `rsync -a --delete ${join(base, 'empty')}/ ./`,
    'cd .. && rm -rf desk',
    `mv ${desk} ${join(base, 'old')}`,
    `rm -rf ${base}`,
  ]) assert.equal(check(command)?.id, 'worker-mark', command);
  assert.equal(check('rm -rf ..', join(desk, 'src'))?.id, 'worker-mark', 'from a subfolder');
  // Negative controls: work inside the checkout goes on.
  for (const command of ['rm -rf src', 'rm -rf ./src/', 'rsync -a --delete src/ out/', "find . -name '*.log' -delete", 'mv src lib', 'rm -rf "$PWD/src"']) {
    assert.equal(check(command), null, command);
  }
  // The lead may not delete the checkout either: a different rule answers (#828).
  assert.equal(checkCommand('rm -rf .', { cwd: desk, env: { HOME: worker.HOME } })?.id, 'delete-checkout');
});

test('checkWorkerMarkEdit: a git folder by name or by real path (#555)', () => {
  assert.equal(checkWorkerMarkEdit('/w/.git/worktrees/wt/yokoten-worker')?.id, 'worker-mark');
  assert.equal(checkWorkerMarkEdit('/w/wt/.git')?.id, 'worker-mark');
  assert.equal(checkWorkerMarkEdit('/w/wt/src/git.ts'), null);
  assert.equal(checkWorkerMarkEdit('/w/wt/.github/x.yml'), null);
  if (process.platform === 'win32') return;
  const base = makeTempDir('yokoten-edit-');
  const store = join(base, 'store'); // a worktree's git folder, not named .git
  const tree = join(base, 'wt');
  makeGitFolder(join(base, 'repo'));
  mkdirSync(store);
  mkdirSync(join(tree, 'src'), { recursive: true });
  writeFileSync(join(tree, '.git'), `gitdir: ${store}\n`);
  symlinkSync(join(base, 'repo', '.git'), join(tree, 'g'));
  symlinkSync(store, join(tree, 'h'));
  assert.equal(checkWorkerMarkEdit(join(tree, 'g', 'config'), tree)?.id, 'worker-mark', 'a symlink to a .git folder');
  assert.equal(checkWorkerMarkEdit(join(tree, 'h', 'yokoten-worker2'), tree)?.id, 'worker-mark', "a symlink to the worktree's git folder");
  assert.equal(checkWorkerMarkEdit(join(tree, 'src', 'a.ts'), tree), null);
  assert.equal(checkWorkerMarkEdit(join(tree, 'h', 'x'), join(base, 'repo')), null, 'another checkout: its git folder is not this one');
});

// #560: an alias runs another command under a new name, so the guard refuses it
// instead of parsing it. A read of one passes.

// #746: a `.git` folder git would not use is not a checkout, and the walk goes on past it: an
// empty `/tmp/.git` must not make every folder in /tmp a checkout.
test('git link: a .git folder needs a HEAD line, objects and refs (#746)', () => {
  const base = makeTempDir('yokoten-empty-git-');
  makeGitFolder(base);
  const parent = { kind: 'folder', top: base, gitDir: join(base, '.git') };
  const empty = join(base, 'empty');
  mkdirSync(join(empty, '.git'), { recursive: true });
  mkdirSync(join(empty, 'work'));
  assert.deepEqual(gitLinkAbove(join(empty, 'work')), parent, 'an empty .git is passed over');
  assert.equal(workerMarkAt(join(empty, 'work')), null, 'and it makes no worker');
  const headOnly = join(base, 'head-only');
  mkdirSync(join(headOnly, '.git'), { recursive: true });
  mkdirSync(join(headOnly, 'work'));
  writeFileSync(join(headOnly, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.deepEqual(gitLinkAbove(join(headOnly, 'work')), parent, 'HEAD without objects is not a checkout');
  const objectsOnly = join(base, 'objects-only');
  mkdirSync(join(objectsOnly, '.git', 'objects'), { recursive: true });
  mkdirSync(join(objectsOnly, 'work'));
  assert.deepEqual(gitLinkAbove(join(objectsOnly, 'work')), parent, 'objects without HEAD is not a checkout');
  writeFileSync(join(objectsOnly, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.deepEqual(gitLinkAbove(join(objectsOnly, 'work')), parent, 'HEAD and objects without refs is not a checkout');
  mkdirSync(join(objectsOnly, '.git', 'refs'));
  assert.deepEqual(gitLinkAbove(join(objectsOnly, 'work')), { kind: 'folder', top: objectsOnly, gitDir: join(objectsOnly, '.git') }, 'HEAD, objects and refs is a checkout');
  // A HEAD git cannot read is no HEAD: a symlink, or text that names no ref and no commit.
  const symlinkHead = join(base, 'symlink-head');
  mkdirSync(join(symlinkHead, '.git', 'objects'), { recursive: true });
  mkdirSync(join(symlinkHead, '.git', 'refs'), { recursive: true });
  mkdirSync(join(symlinkHead, 'work'));
  writeFileSync(join(symlinkHead, 'head-text'), 'ref: refs/heads/main\n');
  symlinkSync(join(symlinkHead, 'head-text'), join(symlinkHead, '.git', 'HEAD'));
  assert.deepEqual(gitLinkAbove(join(symlinkHead, 'work')), parent, 'a HEAD symlink is not a checkout');
  const strayHead = join(base, 'stray-head');
  mkdirSync(join(strayHead, '.git', 'objects'), { recursive: true });
  mkdirSync(join(strayHead, '.git', 'refs'), { recursive: true });
  mkdirSync(join(strayHead, 'work'));
  writeFileSync(join(strayHead, '.git', 'HEAD'), 'not a ref\n');
  assert.deepEqual(gitLinkAbove(join(strayHead, 'work')), parent, 'HEAD text that is no ref and no sha is not a checkout');
  writeFileSync(join(strayHead, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  assert.deepEqual(gitLinkAbove(join(strayHead, 'work')), { kind: 'folder', top: strayHead, gitDir: join(strayHead, '.git') }, 'a detached HEAD sha is a checkout');
});

// #746: a desk that keeps its worker mark and done-when but lost HEAD or objects must not
// become its parent's checkout. It fails closed, as a `.git` the guard cannot read does.
test('git link: a desk that lost HEAD or objects is broken, not its parent checkout (#746)', () => {
  const base = makeTempDir('yokoten-desk-partial-');
  const home = join(base, 'home');
  const env = { HOME: home };
  const worker = { HOME: home, YOKOTEN_ROLE: 'worker' };
  const removals: Record<string, (desk: string) => void> = {
    head: (desk) => rmSync(join(desk, '.git', 'HEAD')),
    objects: (desk) => rmSync(join(desk, '.git', 'objects'), { recursive: true }),
    both: (desk) => {
      rmSync(join(desk, '.git', 'HEAD'));
      rmSync(join(desk, '.git', 'objects'), { recursive: true });
    },
  };
  const makeDesk = (top: string, name: string) => {
    const desk = join(top, name);
    mkdirSync(desk);
    makeGitFolder(desk);
    writeFileSync(join(desk, '.git', 'yokoten-worker'), 'x');
    writeFileSync(join(desk, '.git', 'yokoten-done-when'), 'node --test-desk\n');
    mkdirSync(join(desk, 'src'));
    return desk;
  };
  const contexts: Record<string, (name: string) => string> = {
    sibling: (name) => {
      const top = join(base, 'sibling');
      mkdirSync(top, { recursive: true });
      return makeDesk(top, name);
    },
    nested: (name) => {
      const parent = join(base, 'nested');
      makeGitFolder(parent);
      writeFileSync(join(parent, '.git', 'yokoten-done-when'), 'node --test-parent\n');
      return makeDesk(parent, name);
    },
  };
  for (const [context, make] of Object.entries(contexts)) {
    for (const [removal, remove] of Object.entries(removals)) {
      const desk = make(`${context}-${removal}`);
      remove(desk);
      const src = join(desk, 'src');
      const label = `${context}/${removal}`;
      assert.deepEqual(gitLinkAbove(src), { kind: 'broken', top: desk }, `${label}: the desk stays the checkout`);
      assert.equal(workerMarkAt(src, env), 'broken', `${label}: fail closed`);
      assert.equal(workerRole(env, [src]), 'mark', `${label}: the mark still makes a worker`);
      assert.match(markNote([src], env), /can't be read/, `${label}: the note names the broken link`);
      assert.equal(checkCommand('cd ../..', { cwd: src, env: worker })?.id, 'worker-mark', `${label}: cd ../.. is refused`);
      assert.equal(checkCommand('cd ..', { cwd: src, env: worker }), null, `${label}: the desk itself is the box`);
    }
  }
});
