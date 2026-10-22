// Tests for src/commands/advice/board/agents.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../../repo/helpers.ts';
import { ageText, readBoardAgents, readBoardWorktrees } from '../../../../src/commands/advice/board/agents.ts';

const BLANK = { vendor: '', model: '', effort: '', task: '', worktree: '', doing: '', updated: '', role: '', state: '', checks: '' };

// #601, #603: one status file per worktree, at its root, read in worktree order. A
// missing, broken or odd file never breaks the board; a missing name is the worktree's
// folder name, and a word outside each field's list is blank.
test('board agents: every worktree root as an agent; the odd ones are skipped or blank', () => {
  const first = makeTempDir('yokoten-board-');
  const second = makeTempDir('yokoten-board-');
  const missing = makeTempDir('yokoten-board-');
  const broken = makeTempDir('yokoten-board-');
  const listed = makeTempDir('yokoten-board-');
  const odd = makeTempDir('yokoten-board-');
  const blocked = makeTempDir('yokoten-board-');
  const full = { name: 'b-worker', vendor: 'codex', model: 'gpt-x', effort: 'high', task: 't', worktree: 'w', doing: 'd', updated: '2026-10-22T10:00:00Z', role: 'engineer', state: 'waiting', checks: 'failing' };
  writeFileSync(join(first, '.yokoten-agent.json'), JSON.stringify(full));
  writeFileSync(join(second, '.yokoten-agent.json'), JSON.stringify({ task: 'only a task', role: 'lead' }));
  writeFileSync(join(broken, '.yokoten-agent.json'), '{oops');
  writeFileSync(join(listed, '.yokoten-agent.json'), '[]');
  writeFileSync(join(odd, '.yokoten-agent.json'), JSON.stringify({ name: 7, vendor: null, updated: 123, role: 'boss', state: 'sleeping', checks: true }));
  mkdirSync(join(blocked, '.yokoten-agent.json'));
  const trees = [
    { path: first, branch: 'main' },
    { path: second, branch: 'feature' },
    { path: missing, branch: '' },
    { path: join(missing, 'gone'), branch: '' },
    { path: broken, branch: '' },
    { path: listed, branch: '' },
    { path: odd, branch: '' },
    { path: blocked, branch: '' },
  ];
  assert.deepEqual(readBoardAgents(trees), [
    { agent: full, tree: trees[0] },
    { agent: { ...BLANK, name: basename(second), task: 'only a task', role: 'lead' }, tree: trees[1] },
    { agent: { ...BLANK, name: basename(odd) }, tree: trees[6] },
  ]);
  assert.deepEqual(readBoardAgents([]), [], 'no worktrees, no agents');
});

test('board age: just now, minutes, hours and days; a missing or odd time is blank', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(ageText('2026-10-22T11:59:30Z', now), 'just now');
  assert.equal(ageText('2026-10-22T12:00:01Z', now), 'just now', 'a time ahead never goes below just now');
  assert.equal(ageText('2026-10-22T11:59:00Z', now), '1 min ago');
  assert.equal(ageText('2026-10-22T11:01:00Z', now), '59 min ago');
  assert.equal(ageText('2026-10-22T11:00:00Z', now), '1 h ago');
  assert.equal(ageText('2026-10-21T12:00:01Z', now), '23 h ago');
  assert.equal(ageText('2026-10-21T12:00:00Z', now), '1 day ago');
  assert.equal(ageText('2026-10-20T12:00:00Z', now), '2 days ago');
  assert.equal(ageText('', now), '');
  assert.equal(ageText('yesterday', now), '');
});

test('board worktrees: the repo lists its own; outside a repo git cannot list them', () => {
  const sandbox = makeSandbox();
  // git reports the resolved path (/private/var/... on macOS), not the temp path.
  const root = realpathSync(sandbox.repo);
  assert.deepEqual(readBoardWorktrees(sandbox.repo, sandbox.env), [{ path: root, branch: 'main' }]);
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  const second = join(sandbox.home, 'second');
  assert.equal(sandbox.git('worktree', 'add', second, '-b', 'feature').status, 0);
  assert.deepEqual(readBoardWorktrees(sandbox.repo, sandbox.env), [
    { path: root, branch: 'main' },
    { path: realpathSync(second), branch: 'feature' },
  ]);
  assert.equal(readBoardWorktrees(sandbox.home, sandbox.env), 'git could not list the worktrees: run it again');
});
