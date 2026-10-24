// Tests for src/commands/merge/conflicts/map.ts (#909): the files a change touches, a split
// counted as a move, the pairs worth a merge-tree, and a cache a reader can trust.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  type GitRead,
  type ListedChange,
  type MapBuild,
  buildMap,
  conflictedPaths,
  hotPaths,
  leases,
  mainRef,
  mapPath,
  openChanges,
  pairsToTry,
  readMap,
  readMapState,
  writeMap,
} from '../../../../src/commands/merge/conflicts/map.ts';
import { MAP_FILE, MAP_MAX_AGE_MS, type Change } from '../../../../src/commands/merge/conflicts/types.ts';
import { runGit } from '../../../../src/run/check.ts';
import { CONFLICT_MAP_AGE_MS, CONFLICT_MAP_PATH, conflictNote } from '../../../../src/setup/doctor/checks.ts';
import { makeSandbox } from '../../../repo/helpers.ts';

/** The sandbox, by the type makeSandbox returns. */
type Sandbox = ReturnType<typeof makeSandbox>;

/** A file on main, and the first commit: an empty repo has no branch to compare. */
function withBase(sandbox: Sandbox): void {
  sandbox.write('a.txt', 'one\ntwo\nthree\n');
  sandbox.write('b.txt', 'x\n');
  sandbox.write('old.txt', 'l1\nl2\n');
  sandbox.git('add', '-A');
  sandbox.git('commit', '-q', '-m', 'base');
}

/** A branch from main: each path written, or deleted when its text is empty. Back on main after. */
function branchFiles(sandbox: Sandbox, branch: string, files: Record<string, string>): void {
  sandbox.git('switch', '-q', '-c', branch, 'main');
  for (const [path, text] of Object.entries(files)) {
    if (text === '') sandbox.git('rm', '-q', path);
    else sandbox.write(path, text);
  }
  sandbox.git('add', '-A');
  sandbox.git('commit', '-q', '-m', branch);
  sandbox.git('switch', '-q', 'main');
}

/** A map of this sandbox, failing the test in words when git could not build one. */
function build(sandbox: Sandbox, listed: ListedChange[] | null, git?: GitRead): MapBuild {
  const built = buildMap(sandbox.repo, sandbox.env, { listed, ...(git === undefined ? {} : { git }) });
  assert.ok(typeof built !== 'string', typeof built === 'string' ? built : '');
  return built;
}

/** The git this repo would run, with each call written down, so a test can count them. */
function countingGit(sandbox: Sandbox, calls: string[][]): GitRead {
  return (words) => {
    calls.push(words);
    try {
      const { stdout, status } = runGit(sandbox.repo, words, { env: sandbox.env, okCodes: [0, 1], maxBuffer: 64 << 20 });
      return { out: stdout.toString('utf8'), status };
    } catch {
      return null;
    }
  };
}

/** One change, by hand, for the pure functions: no git and no repo. */
function change(id: string, files: string[], moves: string[] = [], draft = false): Change {
  return { id, label: id, branch: id, head: '0'.repeat(8), draft, files, moves, mainConflicts: [] };
}

test('two branches that change one file collide', () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  branchFiles(sandbox, 'one', { 'a.txt': 'one\nTWO\nthree\n' });
  branchFiles(sandbox, 'two', { 'a.txt': 'one\n2\nthree\n' });

  const { map, notes } = build(sandbox, null);

  assert.deepEqual(map.collisions, [{ a: 'branch:one', b: 'branch:two', files: ['a.txt'] }]);
  assert.deepEqual(map.changes.map((held) => held.label), ['branch one', 'branch two']);
  // Each merges with main on its own: what collides here is the pair, not main.
  assert.deepEqual(map.changes.map((held) => held.mainConflicts), [[], []]);
  assert.deepEqual(notes, []);
  assert.equal(map.main.length, 8);
  assert.equal(map.version, 1);
});

test('a split counts as a move: the old file is deleted, and git calls that no rename', () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  branchFiles(sandbox, 'split', { 'old.txt': '', 'new1.txt': 'n\n', 'new2.txt': 'm\n' });
  branchFiles(sandbox, 'rename', { 'old.txt': '' });
  sandbox.git('switch', '-q', 'rename');
  sandbox.write('moved.txt', 'l1\nl2\n');
  sandbox.git('add', '-A');
  sandbox.git('commit', '-q', '-m', 'rename');
  sandbox.git('switch', '-q', 'main');

  const { map } = build(sandbox, null);
  const split = map.changes.find((held) => held.branch === 'split');
  const rename = map.changes.find((held) => held.branch === 'rename');

  assert.deepEqual(split?.moves, ['old.txt']);
  assert.deepEqual(split?.files, ['new1.txt', 'new2.txt', 'old.txt']);
  // Both paths of a rename stay in the file list, so a pair that shares either one is tried.
  assert.deepEqual(rename?.files, ['moved.txt', 'old.txt']);
  assert.deepEqual(rename?.moves, ['old.txt']);
  // The split moved old.txt first in the map's order, and a path has one lease.
  assert.equal(map.leased['old.txt'], 'branch:rename');
  // A moved path is hot even when one change moves it.
  assert.ok(map.hot.includes('old.txt'));
});

test('a pair with no shared file is never merged', () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  branchFiles(sandbox, 'left', { 'a.txt': 'one\nLEFT\nthree\n' });
  branchFiles(sandbox, 'right', { 'b.txt': 'y\n' });
  branchFiles(sandbox, 'other', { 'a.txt': 'one\nOTHER\nthree\n' });

  const calls: string[][] = [];
  const { map } = build(sandbox, null, countingGit(sandbox, calls));

  const pairs = calls.filter((words) => words[0] === 'merge-tree');
  // One merge-tree with main for each of three branches, then the one pair that shares a.txt.
  assert.equal(pairs.length, 4, pairs.map((words) => words.slice(3).join(' ')).join('; '));
  assert.deepEqual(map.collisions.map((collision) => [collision.a, collision.b]), [['branch:left', 'branch:other']]);
});

test('the pairs to try are the pairs that share a file', () => {
  const pairs = pairsToTry([change('a', ['x.ts', 'y.ts']), change('b', ['z.ts']), change('c', ['y.ts'])]);
  assert.deepEqual(pairs.map(([left, right]) => [left.id, right.id]), [['a', 'c']]);
  assert.deepEqual(pairsToTry([change('a', ['x.ts']), change('b', ['y.ts'])]), []);
});

test('the paths of a merge-tree answer are the conflicted ones', () => {
  const tree = 'a'.repeat(40);
  const conflicted = 'src/app.ts';
  assert.deepEqual(conflictedPaths(`${tree}\n${conflicted}\n\nAuto-merging ${conflicted}\nCONFLICT (content): Merge conflict in ${conflicted}\n`), [conflicted]);
  // Two conflicted paths, then the messages: the blank line ends the list, not a space in a name.
  assert.deepEqual(conflictedPaths(`${tree}\nsrc/a.ts\nmy file.txt\n\nCONFLICT (content): Merge conflict in src/a.ts\n`), ['src/a.ts', 'my file.txt']);
  // A clean merge prints the tree alone.
  assert.deepEqual(conflictedPaths(`${tree}\n`), []);
  // Anything else is not a merge-tree answer.
  assert.deepEqual(conflictedPaths('git: not a git repository\n'), []);
});

test('a path three changes touch is hot; a one-file-per-change folder is not', () => {
  const hot = change('pr:1', ['src/app.ts', 'changes/1-a.md']);
  const also = change('pr:2', ['src/app.ts', 'changes/2-b.md']);
  const third = change('pr:3', ['src/app.ts', 'changes/3-c.md']);
  assert.deepEqual(hotPaths([hot, also, third]), ['src/app.ts']);
  // Two changes touch one file: that is a pair to try, not a hot path.
  assert.deepEqual(hotPaths([hot, also]), []);
  // A path a change moves is hot even when no count says so.
  assert.deepEqual(hotPaths([change('pr:4', ['old.ts', 'new.ts'], ['old.ts'])]), ['old.ts']);
  // A draft leases nothing: the guard refuses an edit for a change a person holds back.
  assert.deepEqual(leases([change('pr:5', ['old.ts', 'new.ts'], ['old.ts'], true)]), {});
});

test('a stale map, or one from a version this yokoten does not know, reads as missing', () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  branchFiles(sandbox, 'one', { 'a.txt': 'one\nTWO\nthree\n' });
  const { map } = build(sandbox, null);
  assert.equal(writeMap(sandbox.repo, sandbox.env, map), null);
  const file = mapPath(sandbox.repo, sandbox.env);
  assert.ok(file !== null && existsSync(file), 'the map was not written where the guard reads it');
  const builtAt = Date.parse(map.builtAt);

  assert.equal(readMapState(sandbox.repo, sandbox.env, builtAt + 60_000).kind, 'ready');
  assert.equal(readMap(sandbox.repo, sandbox.env, builtAt + MAP_MAX_AGE_MS + 1), null);
  assert.equal(readMapState(sandbox.repo, sandbox.env, builtAt + MAP_MAX_AGE_MS + 1).kind, 'stale');

  writeFileSync(file, JSON.stringify({ ...map, version: 2 }));
  assert.equal(readMapState(sandbox.repo, sandbox.env).kind, 'missing');
  writeFileSync(file, '{');
  assert.equal(readMapState(sandbox.repo, sandbox.env).kind, 'missing');
  writeFileSync(file, JSON.stringify({ ...map, changes: [{ id: 1 }] }));
  assert.equal(readMapState(sandbox.repo, sandbox.env).kind, 'missing');
});

test('the doctor says one line when changes collide, and one when the map is old', () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  // Branches on one file collide with each other, and the map is fresh: one line, then.
  branchFiles(sandbox, 'one', { 'a.txt': 'one\nONE\nthree\n' });
  branchFiles(sandbox, 'two', { 'a.txt': 'one\nTWO\nthree\n' });
  const { map } = build(sandbox, null);
  assert.equal(writeMap(sandbox.repo, sandbox.env, map), null);
  assert.match(conflictNote(sandbox.repo, sandbox.env) ?? '', /^1 pair of open changes collide: run `yokoten conflicts`/);

  // The same map, two hours old: the note says so before it says anything else.
  const old = { ...map, builtAt: new Date(Date.now() - CONFLICT_MAP_AGE_MS * 2).toISOString() };
  assert.equal(writeMap(sandbox.repo, sandbox.env, old), null);
  assert.match(conflictNote(sandbox.repo, sandbox.env) ?? '', /^the conflict map is 2 hours old/);

  // A map with nothing to say says nothing.
  assert.equal(writeMap(sandbox.repo, sandbox.env, { ...map, collisions: [] }), null);
  assert.equal(conflictNote(sandbox.repo, sandbox.env), null);

  // A folder that is not a repo has no map, and the doctor never fails on that.
  const plain = makeSandbox();
  assert.equal(conflictNote(plain.home, sandbox.env), null);
});

test('the doctor reads the same file and the same age as the contract', () => {
  // setup sits below commands, so checks.ts names the file itself; this holds the two names together.
  assert.equal(CONFLICT_MAP_PATH, MAP_FILE);
  assert.equal(CONFLICT_MAP_AGE_MS, MAP_MAX_AGE_MS);
});

test('the command prints the summary and keeps the map for the guard', async () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  branchFiles(sandbox, 'one', { 'a.txt': 'one\nONE\nthree\n' });
  branchFiles(sandbox, 'two', { 'a.txt': 'one\nTWO\nthree\n' });

  const shown = await sandbox.call(['conflicts']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /branch one and branch two both change a\.txt\. Merge branch one first, then branch two\./);

  const asJson = await sandbox.call(['conflicts', '--json']);
  assert.equal(asJson.status, 0, asJson.stderr);
  const map = JSON.parse(asJson.stdout) as { version: number; changes: unknown[]; collisions: unknown[] };
  assert.equal(map.version, 1);
  assert.equal(map.changes.length, 2);
  assert.equal(map.collisions.length, 1);
  const file = mapPath(sandbox.repo, sandbox.env);
  assert.ok(file !== null && existsSync(file), 'the guard has no map to read');
});

test('a pull request with no branch in this clone is left out, and one note says so', () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  branchFiles(sandbox, 'here', { 'a.txt': 'one\nHERE\nthree\n' });
  const { map, notes } = build(sandbox, [
    { id: 'pr:12', label: 'PR #12', branch: 'here', draft: true },
    { id: 'pr:99', label: 'PR #99', branch: 'not-in-this-clone', draft: false },
  ]);
  assert.deepEqual(map.changes.map((held) => [held.id, held.label, held.draft]), [['pr:12', 'PR #12', true]]);
  assert.deepEqual(notes, ['1 open change is not in this clone, so the map leaves it out']);
  // A draft leases nothing, so nothing it moves would be refused.
  assert.deepEqual(map.leased, {});
});

test('a GitHub host names the open pull requests, and the clone says what they change', async () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  branchFiles(sandbox, 'one', { 'a.txt': 'one\nONE\nthree\n' });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/example/demo.git');
  const gh = (args: string[]): string => {
    assert.deepEqual(args.slice(0, 2), ['pr', 'list']);
    return JSON.stringify([
      { number: 12, headRefName: 'one', baseRefName: 'main', isCrossRepository: false },
      { number: 13, headRefName: 'gone', baseRefName: 'main', isCrossRepository: false },
    ]);
  };
  const opened = await openChanges(sandbox.repo, sandbox.env, { gh });
  assert.deepEqual(opened.listed?.map((held) => [held.id, held.label, held.branch, held.draft]), [
    ['pr:12', 'PR #12', 'one', false],
    ['pr:13', 'PR #13', 'gone', false],
  ]);
  const { map, notes } = build(sandbox, opened.listed);
  assert.deepEqual(map.changes.map((held) => held.label), ['PR #12']);
  assert.deepEqual(notes, ['1 open change is not in this clone, so the map leaves it out']);
});

test('a Gitea host names the open pull requests, and a draft stays a draft', async () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  branchFiles(sandbox, 'one', { 'a.txt': 'one\nONE\nthree\n' });
  sandbox.git('remote', 'add', 'origin', 'https://gitea.example.com/me/repo.git');
  sandbox.write('yokoten.json', JSON.stringify({ host: 'gitea' }));
  const seen: string[] = [];
  const gitea = async (path: string) => {
    seen.push(path);
    return { status: 200, body: [{ number: 12, head: { ref: 'one' }, draft: true }, { number: 'x', head: {} }] };
  };
  const opened = await openChanges(sandbox.repo, sandbox.env, { gitea });
  assert.deepEqual(seen, ['/repos/me/repo/pulls?state=open&limit=50']);
  assert.deepEqual(opened.listed, [{ id: 'pr:12', label: 'PR #12', branch: 'one', draft: true }]);
  const { map } = build(sandbox, opened.listed);
  assert.equal(map.changes[0]?.draft, true);
});

test('main is the branch this clone compares against, and a repo with none builds no map', () => {
  const sandbox = makeSandbox();
  withBase(sandbox);
  const main = mainRef(sandbox.repo, sandbox.env);
  assert.equal(main?.name, 'main');
  assert.equal(main?.commit, sandbox.git('rev-parse', 'refs/heads/main').stdout.trim());

  const empty = makeSandbox();
  assert.equal(typeof buildMap(empty.repo, empty.env, { listed: null }), 'string');
});
