// Tests for src/setup/advice/unsaved.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';
import {
  findTmpfs,
  type GitProcess,
  isGitProcess,
  isGitWorkingIn,
  type MachineReaders,
  parseStatus,
  parseWorktreeList,
  readUnsaved,
  SESSION_CHANGE_AGE,
  showAge,
  showPath,
  UNSAVED_CONTROL,
  unsavedNotes,
} from '../../../src/setup/advice/unsaved.ts';

const DAY = 24 * 60 * 60 * 1000;

/**
 * A clone with everything pushed: a bare origin next to it, one commit on main, and
 * origin/HEAD set. HOME and git's config are the sandbox's: no test reads the real home.
 */
function cleanClone() {
  const sandbox = makeSandbox();
  const base = dirname(sandbox.repo);
  const origin = join(base, 'origin.git');
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, env: sandbox.env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  writeFileSync(join(sandbox.repo, 'a.txt'), 'a\n');
  git(sandbox.repo, 'add', '-A');
  git(sandbox.repo, 'commit', '-qm', 'first');
  git(sandbox.repo, 'remote', 'add', 'origin', origin);
  git(sandbox.repo, 'push', '-q', '-u', 'origin', 'main');
  git(sandbox.repo, 'remote', 'set-head', 'origin', 'main');
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', file);
  };
  const facts = (more: MachineReaders = {}) => {
    const read = readUnsaved(sandbox.repo, { env: sandbox.env, readMounts: () => null, listProcesses: () => [], ...more });
    assert.ok(read, 'git read the repo');
    return read;
  };
  const notes = (options: { session?: boolean; platform?: string } = {}, more = {}) => unsavedNotes(facts(more), { home: sandbox.home, ...options });
  return { ...sandbox, base, origin, git, commit, facts, notes };
}

/** The ids of the notes, in order. */
const ids = (found: { id: string }[]) => found.map((f) => f.id);

test('unsaved: a clean clone gives no note, in full doctor or a session (#365)', () => {
  const clone = cleanClone();
  assert.deepEqual(clone.notes(), []);
  assert.deepEqual(clone.notes({ session: true }), []);
  const facts = clone.facts();
  assert.equal(facts.defaultRef, 'refs/remotes/origin/main', 'origin/HEAD, by the branch it names');
  assert.deepEqual(facts.remotes, ['origin']);
  assert.equal(facts.worktrees.length, 1);
  assert.deepEqual(facts.worktrees[0].changedFiles, []);
  assert.equal(facts.isGitRunning, null, 'no lock: the processes are not read');
});

test('unsaved: uncommitted changes, with the file count and the oldest change (#365)', () => {
  const clone = cleanClone();
  writeFileSync(join(clone.repo, 'a.txt'), 'changed\n');
  writeFileSync(join(clone.repo, 'new.txt'), 'new\n');
  const old = new Date(Date.now() - 3 * DAY);
  utimesSync(join(clone.repo, 'new.txt'), old, old);
  const [note, ...rest] = clone.notes();
  assert.deepEqual(rest, []);
  assert.equal(note.id, 'uncommitted-changes');
  assert.equal(note.what, '. has 2 uncommitted files, the oldest changed 3 days ago');
  assert.equal(note.fix, 'commit them: `git -C . add -A && git -C . commit`, then push');
  assert.deepEqual(clone.facts().worktrees[0].changedFiles?.sort(), ['a.txt', 'new.txt']);
  // A session hears only changes older than an hour: work going on now is not forgotten.
  assert.deepEqual(ids(clone.notes({ session: true })), ['uncommitted-changes']);
  const now = new Date();
  utimesSync(join(clone.repo, 'new.txt'), now, now);
  assert.deepEqual(clone.notes({ session: true }), []);
  assert.deepEqual(ids(clone.notes()), ['uncommitted-changes'], 'full doctor still lists it');
});

test('unsaved: commits not pushed, per branch, and a branch with no upstream (#365)', () => {
  const clone = cleanClone();
  clone.commit(clone.repo, 'b.txt');
  let found = clone.notes();
  assert.deepEqual(ids(found), ['unpushed-commits']);
  assert.equal(found[0].what, 'branch main has 1 commit not pushed to origin/main; a commit not pushed is still only on this machine');
  assert.equal(found[0].fix, '`git push origin main`');
  clone.git(clone.repo, 'push', '-q');
  assert.deepEqual(clone.notes(), [], 'negative control: pushed');
  // A branch of its own, not pushed anywhere.
  clone.git(clone.repo, 'switch', '-q', '-c', 'topic');
  assert.deepEqual(clone.notes(), [], 'a branch with nothing of its own has nothing to lose');
  clone.commit(clone.repo, 'c.txt');
  clone.commit(clone.repo, 'd.txt');
  found = clone.notes();
  assert.equal(found[0].what, 'branch topic has 2 commits not on origin/main and no upstream, so they are still only on this machine');
  assert.equal(found[0].fix, '`git push -u origin topic`');
  assert.deepEqual(ids(clone.notes({ session: true })), ['unpushed-commits'], 'a session hears it');
});

test('unsaved: a branch made from origin/main is never told to push to main (#365)', () => {
  const clone = cleanClone();
  const tree = join(clone.base, 'tree');
  clone.git(clone.repo, 'worktree', 'add', '-q', '--track', '-b', 'fix', tree, 'origin/main');
  assert.deepEqual(clone.notes(), [], 'just made: nothing of its own');
  clone.commit(tree, 'e.txt');
  const [note] = clone.notes();
  assert.equal(note.what, 'branch fix has 1 commit not on origin/main, and no branch of its own on the remote, so they are still only on this machine');
  assert.equal(note.fix, '`git push -u origin fix`');
});

test('unsaved: a repo with no remote says once that every commit is only here (#365)', () => {
  const sandbox = makeSandbox();
  assert.deepEqual(unsavedNotes(readUnsaved(sandbox.repo, { env: sandbox.env, readMounts: () => null })!, { home: sandbox.home }), [], 'no commit yet: nothing to push');
  writeFileSync(join(sandbox.repo, 'a.txt'), 'a\n');
  sandbox.git('add', '-A');
  sandbox.git('commit', '-qm', 'first');
  const found = unsavedNotes(readUnsaved(sandbox.repo, { env: sandbox.env, readMounts: () => null })!, { home: sandbox.home });
  assert.deepEqual(ids(found), ['unpushed-commits']);
  assert.equal(found[0].what, 'this repo has no remote, so every commit is still only on this machine');
});

test('unsaved: commits on a detached HEAD that no branch holds; a detached worktree in main is done (#365)', () => {
  const clone = cleanClone();
  clone.commit(clone.repo, 'b.txt');
  clone.git(clone.repo, 'push', '-q');
  const tree = join(clone.base, 'detached');
  clone.git(clone.repo, 'worktree', 'add', '-q', '--detach', tree, 'main~1');
  assert.deepEqual(clone.notes(), [], 'just made from an older main: nothing to save, and not done either');
  clone.commit(tree, 'c.txt');
  const [note, ...rest] = clone.notes();
  assert.deepEqual(rest, []);
  assert.equal(note.id, 'unpushed-commits');
  assert.equal(note.what, 'worktree ../detached has commits on a detached HEAD that no branch holds, so they are still only on this machine');
  assert.equal(note.fix, 'give them a branch and push it: `git -C ../detached switch -c <name>`, then `git -C ../detached push -u origin <name>`');
  assert.deepEqual(ids(clone.notes({ session: true })), ['unpushed-commits'], 'a session hears it');
  clone.git(tree, 'checkout', '-q', '--detach', 'main');
  const done = clone.notes();
  assert.deepEqual(done.map((f) => f.what), ["worktree ../detached (detached HEAD) is in origin/main's history"]);
  assert.equal(done[0].fix, 'remove it: `git worktree remove ../detached`');
});

test('unsaved: stashes are counted (#365)', () => {
  const clone = cleanClone();
  writeFileSync(join(clone.repo, 'a.txt'), 'one\n');
  clone.git(clone.repo, 'stash', '-q');
  writeFileSync(join(clone.repo, 'a.txt'), 'two\n');
  clone.git(clone.repo, 'stash', '-q');
  const found = clone.notes();
  assert.deepEqual(ids(found), ['stashes']);
  assert.equal(found[0].what, 'there are 2 stashes, and a stash is only on this machine');
  assert.equal(clone.facts().stashes, 2);
  clone.git(clone.repo, 'stash', 'clear');
  assert.deepEqual(clone.notes(), [], 'negative control: no stash');
});

test('unsaved: a worktree whose branch is merged, or whose upstream is gone, is safe to remove (#365)', () => {
  const clone = cleanClone();
  const merged = join(clone.base, 'merged');
  const gone = join(clone.base, 'gone');
  const busy = join(clone.base, 'busy');
  const fresh = join(clone.base, 'fresh');
  clone.git(clone.repo, 'worktree', 'add', '-q', '-b', 'merged', merged, 'main');
  clone.commit(merged, 'm.txt');
  clone.git(clone.repo, 'merge', '-q', '--ff-only', 'merged');
  clone.git(clone.repo, 'push', '-q');
  clone.git(clone.repo, 'worktree', 'add', '-q', '-b', 'gone', gone, 'main');
  clone.commit(gone, 'g.txt');
  clone.git(gone, 'push', '-q', '-u', 'origin', 'gone');
  // The host squash-merged it and deleted the branch: no ancestry, only the gone upstream.
  clone.git(clone.repo, 'push', '-q', 'origin', '--delete', 'gone');
  clone.git(clone.repo, 'fetch', '-q', '--prune');
  clone.git(clone.repo, 'worktree', 'add', '-q', '-b', 'busy', busy, 'main');
  clone.commit(busy, 'b.txt');
  clone.git(clone.repo, 'branch', '-q', '-f', 'busy-copy', 'busy');
  writeFileSync(join(busy, 'b.txt'), 'still working\n');
  clone.git(clone.repo, 'worktree', 'add', '-q', '-b', 'fresh', fresh, 'origin/main~1');
  const found = clone.notes().filter((f) => f.id === 'finished-worktree');
  assert.deepEqual(found.map((f) => f.what).sort(), [
    'worktree ../gone (branch gone) has lost its upstream origin/gone, so it was most likely merged',
    'worktree ../merged (branch merged) is merged into origin/main',
  ]);
  assert.equal(found.find((f) => f.what.includes('../merged'))?.fix, 'remove it: `git worktree remove ../merged`; the branch stays');
  assert.ok(!found.some((f) => f.what.includes('busy')), 'never one with uncommitted changes');
  assert.ok(!found.some((f) => f.what.includes('fresh')), 'never one just made from an older main');
  assert.deepEqual(clone.notes({ session: true }).filter((f) => f.id === 'finished-worktree'), [], 'a session hears only what is at risk');
});

test('unsaved: a worktree whose folder is gone gets `git worktree prune` (#365)', () => {
  const clone = cleanClone();
  const tree = join(clone.base, 'lost');
  clone.git(clone.repo, 'worktree', 'add', '-q', '-b', 'lost', tree, 'main');
  assert.deepEqual(clone.notes(), [], 'negative control: the folder is there');
  rmSync(tree, { recursive: true, force: true });
  const found = clone.notes();
  assert.deepEqual(ids(found), ['missing-worktree']);
  assert.equal(found[0].what, 'git still lists 1 worktree whose folder is gone: ../lost');
  assert.equal(found[0].fix, '`git worktree prune`');
  assert.ok(clone.git(clone.repo, 'worktree', 'list').includes('lost'), 'doctor did not prune it');
});

test('unsaved: an index.lock is stale only when no git process works in the repo (#365)', () => {
  const clone = cleanClone();
  const tree = join(clone.base, 'locked');
  clone.git(clone.repo, 'worktree', 'add', '-q', '-b', 'locked', tree, 'main');
  const lock = join(clone.repo, '.git', 'worktrees', 'locked', 'index.lock');
  const check = (processes: GitProcess[] | null) => clone.notes({}, { listProcesses: () => processes });
  assert.deepEqual(check([]), [], 'negative control: no lock');
  writeFileSync(lock, '');
  const [stale] = check([]);
  assert.equal(stale.what, '.git/worktrees/locked/index.lock is left from a crash: no git process is running');
  assert.equal(stale.fix, 'delete it: `rm .git/worktrees/locked/index.lock`');
  assert.equal(clone.notes({ platform: 'win32' }, { listProcesses: () => [] })[0].fix, 'delete it: `del .git/worktrees/locked/index.lock`');
  assert.deepEqual(check([{ cwd: tree }]), [], 'a git process works in the worktree: the lock is in use');
  assert.deepEqual(check([{ cwd: join(clone.home, 'elsewhere') }])[0].what, stale.what, 'a git process elsewhere does not hold this lock');
  for (const processes of [[{ cwd: null }], null]) {
    const [unsure] = check(processes);
    assert.equal(unsure.what, ".git/worktrees/locked/index.lock is there, and doctor can't tell whether a git process is using it");
    assert.doesNotMatch(unsure.fix, /\b(rm|del|delete)\b/, "can't tell: never say to delete it");
  }
  // The clone's own lock too.
  rmSync(lock);
  writeFileSync(join(clone.repo, '.git', 'index.lock'), '');
  assert.equal(check([])[0].what, '.git/index.lock is left from a crash: no git process is running');
  assert.ok(statSync(join(clone.repo, '.git', 'index.lock')).isFile(), 'doctor did not delete it');
});

test('unsaved: a repo on a tmpfs is gone after a restart (#365)', () => {
  const clone = cleanClone();
  const tmpfs = `tmpfs ${clone.base} tmpfs rw 0 0\n`;
  const disk = `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${clone.base} ext4 rw 0 0\n`;
  const found = clone.notes({}, { readMounts: () => tmpfs });
  assert.deepEqual(ids(found), ['repo-on-tmpfs']);
  assert.match(found[0].what, /^this repo is on a tmpfs \(.+\), so everything here is gone after a restart$/);
  assert.equal(found[0].fix, 'push every branch now: `git push --all origin`; then clone it again on a disk');
  assert.deepEqual(clone.notes({}, { readMounts: () => disk }), [], 'negative control: a disk');
  assert.deepEqual(clone.notes({}, { readMounts: () => null }), [], 'no /proc/mounts (macOS): nothing');
  // A mount in the home shows from ~; with no remote, the fix says to add one.
  const inHome = unsavedNotes({ ...UNSAVED_CONTROL, remotes: [], tmpfs: '/h/t' }, { home: '/h' }).find((f) => f.id === 'repo-on-tmpfs');
  assert.equal(inHome?.what, 'this repo is on a tmpfs (~/t), so everything here is gone after a restart');
  assert.equal(inHome?.fix, 'add a remote and push every branch now; then clone it again on a disk');
});

test('unsaved: doctor only reads; no file in the git folder changes (#365)', () => {
  const clone = cleanClone();
  const tree = join(clone.base, 'tree');
  clone.git(clone.repo, 'worktree', 'add', '-q', '-b', 'tree', tree, 'main');
  writeFileSync(join(clone.repo, 'a.txt'), 'changed\n');
  writeFileSync(join(tree, 'a.txt'), 'changed\n');
  const gitDir = join(clone.repo, '.git');
  const snapshot = () =>
    readdirSync(gitDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return `${path} ${statSync(path).mtimeMs} ${statSync(path).size}`;
      })
      .sort();
  const before = snapshot();
  // Let a refresh show: a write a millisecond later gets another time.
  const until = Date.now() + 20;
  while (Date.now() < until);
  clone.notes();
  assert.deepEqual(snapshot(), before);
});

test('unsaved: the parts, read from git output (#365)', () => {
  const status = ['1 .M N... 100644 100644 100644 abc abc a file.txt', '2 R. N... 100644 100644 100644 abc abc R100 new name.txt', 'old name.txt', 'u UU N... 100644 100644 100644 100644 a b c conflict.txt', '? untracked dir/', '! ignored.log', ''].join('\0');
  assert.deepEqual(parseStatus(status), ['a file.txt', 'new name.txt', 'conflict.txt', 'untracked dir/']);
  const list = ['worktree /r', 'HEAD 1111', 'branch refs/heads/main', '', 'worktree /w', 'HEAD 2222', 'detached', 'locked', '', 'worktree /x', 'HEAD 3333', 'branch refs/heads/x', 'prunable gitdir file points to non-existent location', '', ''].join('\0');
  assert.deepEqual(parseWorktreeList(list), [
    { path: '/r', branch: 'main', head: '1111', isMain: true, isMissing: false, isLocked: false },
    { path: '/w', branch: null, head: '2222', isMain: false, isMissing: false, isLocked: true },
    { path: '/x', branch: 'x', head: '3333', isMain: false, isMissing: true, isLocked: false },
  ]);
  assert.equal(findTmpfs('/tmp/my repo/a', 'tmpfs /tmp/my\\040repo tmpfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n'), '/tmp/my repo', 'a space is \\040');
  assert.equal(findTmpfs('/tmp/a', 'tmpfs /tmp tmpfs rw 0 0\n/dev/sdb /tmp/a ext4 rw 0 0\n'), null, 'the deepest mount wins');
  assert.equal(findTmpfs('/tmpx/a', 'tmpfs /tmp tmpfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n'), null, 'a prefix of the name is not a parent');
  assert.ok(['git', 'git-remote-https', 'git.exe', 'GIT.EXE'].every(isGitProcess));
  assert.ok(!['gitea', 'node', 'gitk', 'legit'].some(isGitProcess));
  assert.equal(isGitWorkingIn(['/r'], [{ cwd: '/r/src' }]), true);
  assert.equal(isGitWorkingIn(['/r'], [{ cwd: '/rx' }]), false);
  assert.equal(isGitWorkingIn(['/r'], [{ cwd: null }]), null);
  assert.equal(isGitWorkingIn(['/r'], null), null);
  assert.equal(showPath('/h/p/x', '/h/p/x', '/h'), '.');
  assert.equal(showPath('/h/p/x/.git/index.lock', '/h/p/x', '/h'), '.git/index.lock');
  assert.equal(showPath('/h/q/y', '/h/p/x', '/h'), '~/q/y', 'outside the root: from ~, never the full home path');
  assert.equal(showPath('/srv/y', '/srv/x', '/h'), '../y');
  assert.equal(showPath('/tmp/w', '/srv/a/b/c', '/h'), '/tmp/w', 'far away: as it is, not ../../../../tmp/w');
  assert.deepEqual([showAge(30_000), showAge(SESSION_CHANGE_AGE), showAge(3 * 60 * 60_000), showAge(3 * DAY)], ['1 minute', '60 minutes', '3 hours', '3 days']);
});

test('unsaved: every note is plain, with sentences of at most 25 words, and no full home path (#365)', () => {
  const clone = cleanClone();
  const tree = join(clone.base, 'tree');
  clone.git(clone.repo, 'worktree', 'add', '-q', '--track', '-b', 'tree', tree, 'origin/main');
  clone.commit(tree, 't.txt');
  mkdirSync(join(clone.repo, 'dir'));
  writeFileSync(join(clone.repo, 'dir', 'x.txt'), 'x\n');
  clone.commit(clone.repo, 'b.txt');
  writeFileSync(join(clone.repo, 'a.txt'), 'stash me\n');
  clone.git(clone.repo, 'stash', '-q');
  writeFileSync(join(clone.repo, '.git', 'index.lock'), '');
  const found = clone.notes({}, { readMounts: () => `tmpfs ${clone.base} tmpfs rw 0 0\n` });
  assert.ok(found.length >= 6, ids(found).join(', '));
  for (const f of found) {
    const text = `${f.what}. ${f.why}. ${f.fix}.`;
    assert.ok(!text.includes(clone.home), text);
    for (const sentence of text.split(/[.;] /)) assert.ok(sentence.split(/\s+/).length <= 25, sentence);
  }
});
