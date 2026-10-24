// Tests for src/agents/desk/gc.ts: mark and sweep (#708). Each root keeps a desk, a
// merged desk goes with its state, and a marker that can't decide removes nothing.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ACTIVE_WINDOW_MS, sweepFinishedDesks, sweepLines, stateIsActive } from '../../../src/agents/desk/gc.ts';
import { registerDesk } from '../../../src/run/hook.ts';
import { makeTempDir } from '../../repo/helpers.ts';
import { TEST_HOME } from '../../repo/home.ts';

/** git in a test folder, with a home of its own and no user config to depend on. */
const gitEnv = (): NodeJS.ProcessEnv => ({ HOME: TEST_HOME, PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });

function git(folder: string, args: string[]): string {
  return execFileSync('git', args, { cwd: folder, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A commit with a name and a mail that need no config. */
function commit(folder: string, message: string): void {
  git(folder, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', message]);
}

/** A bare origin with one commit on main, and the lead's clone of it. */
function makeRepo(base = realpathSync(makeTempDir('gc-'))): { base: string; origin: string; lead: string } {
  const origin = join(base, 'origin.git');
  git(base, ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(base, 'seed');
  git(base, ['clone', '-q', origin, seed]);
  commit(seed, 'start');
  git(seed, ['push', '-q', 'origin', 'main']);
  const lead = join(base, 'lead');
  git(base, ['clone', '-q', origin, lead]);
  return { base, origin, lead };
}

/** A desk clone on its own branch, cut from main. */
function makeDesk(base: string, origin: string, lead: string, name: string): string {
  const desk = join(base, 'desks', name);
  mkdirSync(dirname(desk), { recursive: true });
  git(base, ['clone', '-q', origin, desk]);
  git(desk, ['checkout', '-q', '-b', `708-${name}`]);
  registerDesk(lead, desk);
  return desk;
}

/** The desk's branch on the origin, then merged into main: nothing in it is unsaved. */
function finishDesk(desk: string, lead: string): void {
  writeFileSync(join(desk, 'work.txt'), 'work\n');
  git(desk, ['add', '.']);
  commit(desk, 'work');
  const branch = git(desk, ['symbolic-ref', '--short', 'HEAD']);
  git(desk, ['push', '-q', 'origin', branch]);
  git(lead, ['fetch', '-q', 'origin']);
  git(lead, ['merge', '-q', '--ff-only', `origin/${branch}`]);
  git(lead, ['push', '-q', 'origin', 'HEAD:main']);
}

/** A session log two days old, so it never roots a desk. */
function oldState(desk: string): string {
  const folder = `${desk}.state`;
  mkdirSync(join(folder, 'codex'), { recursive: true });
  const log = join(folder, 'codex', 'session.jsonl');
  writeFileSync(log, '{}\n');
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(log, old, old);
  return folder;
}

const sweep = (root: string, extra: Record<string, unknown> = {}) => sweepFinishedDesks(root, { env: gitEnv(), keep: root, openPullBranches: [], ...extra });

test('gc: a merged and pushed desk goes with its state, its list line and its status file', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'done');
  finishDesk(desk, lead);
  registerDesk(lead, desk);
  const state = oldState(desk);
  writeFileSync(join(desk, '.yokoten-agent.json'), '{}\n');

  const result = sweep(lead);

  assert.deepEqual(result.removed, [desk]);
  assert.ok(!existsSync(desk), 'the clone is gone');
  assert.ok(!existsSync(state), 'its state folder is gone');
  assert.equal(readFileSync(join(lead, '.git', 'yokoten-desks'), 'utf8'), '', 'its line is gone from the desk list');
  const lines = sweepLines(result, gitEnv());
  assert.match(lines[0], /^yokoten gc: 1 to remove, 1 kept, 0 to check by hand\./);
  assert.match(lines.join('\n'), /removed .*done: it is merged and on the remote/);
});

test('gc: every root keeps its desk', () => {
  // An open pull request on a merged branch.
  {
    const { base, origin, lead } = makeRepo();
    const desk = makeDesk(base, origin, lead, 'open');
    finishDesk(desk, lead);
    const branch = git(desk, ['symbolic-ref', '--short', 'HEAD']);
    oldState(desk);
    const result = sweep(lead, { openPullBranches: [branch] });
    assert.deepEqual(result.removed, []);
    assert.equal(result.entries.find((entry) => entry.path === desk)?.reason, 'an open pull request');
    assert.ok(existsSync(desk));
  }
  // A commit on no remote branch.
  {
    const { base, origin, lead } = makeRepo();
    const desk = makeDesk(base, origin, lead, 'unpushed');
    finishDesk(desk, lead);
    writeFileSync(join(desk, 'more.txt'), 'more\n');
    git(desk, ['add', '.']);
    commit(desk, 'not pushed');
    oldState(desk);
    const result = sweep(lead);
    assert.deepEqual(result.removed, []);
    assert.equal(result.entries.find((entry) => entry.path === desk)?.reason, 'it has commits on no remote branch');
  }
  // A change that is not saved.
  {
    const { base, origin, lead } = makeRepo();
    const desk = makeDesk(base, origin, lead, 'changed');
    finishDesk(desk, lead);
    writeFileSync(join(desk, 'note.txt'), 'a thought\n');
    oldState(desk);
    const result = sweep(lead);
    assert.deepEqual(result.removed, []);
    assert.equal(result.entries.find((entry) => entry.path === desk)?.reason, 'it has changes that are not saved');
  }
  // A log changed in the last 24 hours.
  {
    const { base, origin, lead } = makeRepo();
    const desk = makeDesk(base, origin, lead, 'awake');
    finishDesk(desk, lead);
    mkdirSync(join(`${desk}.state`, 'codex'), { recursive: true });
    writeFileSync(join(`${desk}.state`, 'codex', 'session.jsonl'), '{}\n');
    const result = sweep(lead);
    assert.deepEqual(result.removed, []);
    assert.equal(result.entries.find((entry) => entry.path === desk)?.reason, 'its log changed in the last 24 hours');
  }
  // An agent whose process is alive.
  {
    const { base, origin, lead } = makeRepo();
    const desk = makeDesk(base, origin, lead, 'alive');
    finishDesk(desk, lead);
    oldState(desk);
    writeFileSync(join(desk, '.git', 'yokoten-desk-pid'), `${process.pid}\n`);
    const result = sweep(lead);
    assert.deepEqual(result.removed, []);
    assert.equal(result.entries.find((entry) => entry.path === desk)?.reason, 'an agent is working there');
  }
  // The main checkout, always.
  {
    const { lead } = makeRepo();
    const result = sweep(lead);
    assert.deepEqual(result.removed, []);
    assert.equal(result.entries.find((entry) => entry.path === lead)?.decision, 'keep');
  }
});

test('gc: node_modules and the status file are clutter, not work', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'clutter');
  writeFileSync(join(desk, '.gitignore'), 'node_modules/\n.yokoten-agent.json\n');
  finishDesk(desk, lead);
  oldState(desk);
  writeFileSync(join(desk, '.yokoten-agent.json'), '{}\n');
  mkdirSync(join(desk, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(desk, 'node_modules', 'left-pad', 'index.js'), '');
  const result = sweep(lead);
  assert.deepEqual(result.removed, [desk]);
});

test('gc: an ignored file that is not empty keeps the desk', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'ignored');
  writeFileSync(join(desk, '.gitignore'), 'scratch.txt\n');
  finishDesk(desk, lead);
  writeFileSync(join(desk, 'scratch.txt'), 'a thought nobody saved\n');
  oldState(desk);

  const result = sweep(lead);

  assert.deepEqual(result.removed, [], 'an ignored file can hold work too');
  assert.equal(result.entries.find((entry) => entry.path === desk)?.reason, 'it has changes that are not saved');
});

test('gc: a branch stacked under another remote branch is not merged', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'stacked');
  writeFileSync(join(desk, 'a.txt'), 'a\n');
  git(desk, ['add', '.']);
  commit(desk, 'a');
  const branch = git(desk, ['symbolic-ref', '--short', 'HEAD']);
  git(desk, ['push', '-q', 'origin', branch]);
  // Another branch sits on this tip. The tip is on a remote branch, but not on main.
  git(lead, ['fetch', '-q', 'origin']);
  git(lead, ['checkout', '-q', '-b', '708-top', `origin/${branch}`]);
  writeFileSync(join(lead, 'b.txt'), 'b\n');
  git(lead, ['add', '.']);
  commit(lead, 'top');
  git(lead, ['push', '-q', 'origin', '708-top']);
  oldState(desk);

  const result = sweep(lead);

  assert.deepEqual(result.removed, []);
  assert.equal(result.entries.find((entry) => entry.path === desk)?.reason, 'its branch is not merged');
});

test('gc: a branch name matches a remote branch exactly', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'exact');
  writeFileSync(join(desk, 'a.txt'), 'a\n');
  git(desk, ['add', '.']);
  commit(desk, 'a');
  const branch = git(desk, ['symbolic-ref', '--short', 'HEAD']);
  // The same name, one folder deeper on the remote, is another branch.
  git(desk, ['push', '-q', 'origin', `HEAD:refs/heads/other/${branch}`]);
  oldState(desk);

  const result = sweep(lead);

  assert.deepEqual(result.removed, []);
  assert.equal(result.entries.find((entry) => entry.path === desk)?.reason, 'its branch is on no remote');
});

test('gc: an unreachable remote keeps everything', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'orphan');
  finishDesk(desk, lead);
  oldState(desk);
  rmSync(origin, { recursive: true, force: true });

  const result = sweep(lead);

  assert.deepEqual(result.removed, []);
  assert.ok(existsSync(desk), 'a desk whose remote cannot be read stays');
  const entry = result.entries.find((candidate) => candidate.path === desk);
  assert.equal(entry?.decision, 'list');
  assert.equal(entry?.reason, 'its remote could not be read');
});

test('gc: a branch on no remote is listed, never removed', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'local-only');
  finishDesk(desk, lead);
  // Rewrite the branch: same tree, a commit on no remote, and no local branch name remotely.
  // The commit is pushed, so the branch exists remotely; delete it there instead.
  const branch = git(desk, ['symbolic-ref', '--short', 'HEAD']);
  git(desk, ['push', '-q', 'origin', `:${branch}`]);
  oldState(desk);

  const result = sweep(lead);

  assert.deepEqual(result.removed, []);
  assert.equal(result.entries.find((candidate) => candidate.path === desk)?.reason, 'its branch is on no remote');
});

test('gc: a dry run removes nothing', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'dry');
  finishDesk(desk, lead);
  registerDesk(lead, desk);
  const state = oldState(desk);
  writeFileSync(join(desk, '.yokoten-agent.json'), '{}\n');

  const result = sweep(lead, { isDryRun: true });

  assert.deepEqual(result.removed, []);
  assert.equal(result.entries.find((entry) => entry.path === desk)?.decision, 'remove');
  assert.ok(existsSync(desk), 'the desk is there');
  assert.ok(existsSync(state), 'its state is there');
  assert.ok(existsSync(join(desk, '.yokoten-agent.json')), 'its status file is there');
  assert.match(readFileSync(join(lead, '.git', 'yokoten-desks'), 'utf8'), new RegExp(desk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(sweepLines(result, gitEnv())[0], /Nothing is removed: this is a dry run/);
});

test('gc: a dry run leaves a stale remote-tracking ref alone', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'tracking');
  finishDesk(desk, lead);
  // A fetch --prune would delete this ref: no branch of that name is on the remote.
  git(desk, ['update-ref', 'refs/remotes/origin/gone', 'HEAD']);
  oldState(desk);

  const result = sweep(lead, { isDryRun: true });

  assert.equal(result.entries.find((entry) => entry.path === desk)?.decision, 'remove');
  assert.ok(git(desk, ['rev-parse', '--verify', 'refs/remotes/origin/gone']), 'the stale ref survived the dry run');
});

test('gc: a merged worktree goes, with its state', () => {
  const { base, lead } = makeRepo();
  const worktree = join(base, 'desks', 'tree');
  mkdirSync(dirname(worktree), { recursive: true });
  git(lead, ['worktree', 'add', '-q', '-b', '708-tree', worktree]);
  writeFileSync(join(worktree, 'work.txt'), 'work\n');
  git(worktree, ['add', '.']);
  commit(worktree, 'work');
  git(worktree, ['push', '-q', 'origin', '708-tree']);
  git(lead, ['merge', '-q', '--ff-only', 'origin/708-tree']);
  git(lead, ['push', '-q', 'origin', 'HEAD:main']);
  const state = oldState(worktree);

  const result = sweep(lead);

  assert.deepEqual(result.removed, [worktree]);
  assert.ok(!existsSync(worktree));
  assert.ok(!existsSync(state));
  assert.ok(!git(lead, ['worktree', 'list']).includes(worktree));
});

test('gc: a state folder whose files are old is not active', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'sleepy');
  assert.equal(stateIsActive(desk, Date.now(), ACTIVE_WINDOW_MS), false, 'no state yet is not active');
  oldState(desk);
  assert.equal(stateIsActive(desk, Date.now(), ACTIVE_WINDOW_MS), false);
});

test('gc: a state folder past the entry limit counts as active', () => {
  const { base, origin, lead } = makeRepo();
  const desk = makeDesk(base, origin, lead, 'huge');
  const folder = join(`${desk}.state`, 'codex');
  mkdirSync(folder, { recursive: true });
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  for (let index = 0; index < 5001; index++) {
    const file = join(folder, `entry-${index}`);
    writeFileSync(file, '');
    utimesSync(file, old, old);
  }

  assert.equal(stateIsActive(desk, Date.now(), ACTIVE_WINDOW_MS), true, 'a folder too big to read may hide a fresh log');
});

test('gc: a worktree with a running process is kept', async () => {
  const { base, lead } = makeRepo();
  const worktree = join(base, 'desks', 'busy');
  mkdirSync(dirname(worktree), { recursive: true });
  git(lead, ['worktree', 'add', '-q', '-b', '708-busy', worktree]);
  writeFileSync(join(worktree, 'work.txt'), 'work\n');
  git(worktree, ['add', '.']);
  commit(worktree, 'work');
  git(worktree, ['push', '-q', 'origin', '708-busy']);
  git(lead, ['merge', '-q', '--ff-only', 'origin/708-busy']);
  git(lead, ['push', '-q', 'origin', 'HEAD:main']);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: worktree, stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });

    const result = sweep(lead);

    assert.deepEqual(result.removed, [], 'a process works in it');
    assert.equal(result.entries.find((entry) => entry.path === worktree)?.reason, 'a process is running there');
  } finally {
    child.kill();
  }
});

test('gc: a sweep line shows the home folder as ~', () => {
  // A repo under the test home folder, so a sweep line has a home path to hide.
  const base = join(TEST_HOME, 'gc-home');
  mkdirSync(base, { recursive: true });
  const { origin, lead } = makeRepo(realpathSync(base));
  const desk = makeDesk(base, origin, lead, 'home');
  finishDesk(desk, lead);
  registerDesk(lead, desk);
  oldState(desk);

  const lines = sweepLines(sweep(lead));

  assert.match(lines.join('\n'), /~\/[^/]+\/desks\/home/, 'the desk path starts at ~');
  assert.ok(!lines.join('\n').includes(TEST_HOME), 'the home path is not printed');
});
