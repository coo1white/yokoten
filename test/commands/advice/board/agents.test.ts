// Tests for src/commands/advice/board/agents.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../../repo/helpers.ts';
import { ageText, BOARD_OUTPUT_CACHE_LIMIT, BOARD_OUTPUT_CACHE_MS, BOARD_OUTPUT_LIMIT, type BoardOutputEntry, parseBoardAgent, readBoardAgents, readBoardOutputs, readBoardWorktrees, readDefaultBranch, readMergeBase, trimBoardOutputs } from '../../../../src/commands/advice/board/agents.ts';

const BLANK = { vendor: '', model: '', effort: '', task: '', worktree: '', doing: '', updated: '', started: '', log: '', role: '', state: '', checks: '', contextUsed: null, contextLimit: null, background: [] };

// #601, #603: one status file per worktree, at its root, read in worktree order. A
// missing, broken or odd file never breaks the board. A missing name is the worktree's
// folder name. A state or checks word outside its list is blank. The role is kept.
test('board agents: every worktree root as an agent; the odd ones are skipped or blank', () => {
  const first = makeTempDir('yokoten-board-');
  const second = makeTempDir('yokoten-board-');
  const missing = makeTempDir('yokoten-board-');
  const broken = makeTempDir('yokoten-board-');
  const listed = makeTempDir('yokoten-board-');
  const odd = makeTempDir('yokoten-board-');
  const blocked = makeTempDir('yokoten-board-');
  const full = { name: 'b-worker', vendor: 'codex', model: 'gpt-x', effort: 'high', task: 't', worktree: 'w', doing: 'd', updated: '2026-10-22T10:00:00Z', started: '', log: '', role: 'engineer', state: 'waiting', checks: 'failing', contextUsed: 12, contextLimit: 100, background: [{ text: 'npm test', since: '2026-10-22T09:00:00Z' }] };
  const { contextUsed, contextLimit, ...filed } = full;
  writeFileSync(join(first, '.yokoten-agent.json'), JSON.stringify({ ...filed, context_used: contextUsed, context_limit: contextLimit }));
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
    { agent: { ...BLANK, name: basename(odd), role: 'boss' }, tree: trees[6] },
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

// #644: the panel's context and background come from optional status fields. A missing
// or odd value is unknown, never a guess. A string in the background is still a task.
test('board agents: context and background are read when filed, and left empty when odd', () => {
  const filed = parseBoardAgent(JSON.stringify({ context_used: 50, context_limit: 200, background: [{ name: 'npm test', since: '2026-10-22T10:00:00Z' }, 'git status'] }), '/w');
  assert.deepEqual(filed && [filed.contextUsed, filed.contextLimit, filed.background], [50, 200, [{ text: 'npm test', since: '2026-10-22T10:00:00Z' }, { text: 'git status', since: '' }]]);
  const odd = parseBoardAgent(JSON.stringify({ context_used: '50', context_limit: -1, background: 'npm test' }), '/w');
  assert.deepEqual(odd && [odd.contextUsed, odd.contextLimit, odd.background], [null, null, []]);
});

// #644: the panel reads changed files with one git call, and keeps at most 20.
test('board outputs: changed files are capped at 20 and a bad base is no files', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  for (let index = 0; index < BOARD_OUTPUT_LIMIT + 5; index += 1) writeFileSync(join(sandbox.repo, `out-${index}.txt`), 'x');
  assert.equal(sandbox.git('add', '-A').status, 0);
  const files = readBoardOutputs(sandbox.repo, 'HEAD', sandbox.env);
  assert.equal(files.length, BOARD_OUTPUT_LIMIT);
  assert.ok(files.every((file) => /^out-\d+\.txt$/.test(file)), files.join(','));
  assert.deepEqual(readBoardOutputs(sandbox.repo, 'no-such-base', sandbox.env), []);
});

// #784: a new file the desk has not staged yet is still a file it changed.
test('board outputs: a staged file and an untracked file both show', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  writeFileSync(join(sandbox.repo, 'staged.txt'), 'x');
  assert.equal(sandbox.git('add', 'staged.txt').status, 0);
  writeFileSync(join(sandbox.repo, 'untracked.txt'), 'x');
  assert.deepEqual(readBoardOutputs(sandbox.repo, 'HEAD', sandbox.env), ['staged.txt', 'untracked.txt']);
});

// #784: the page reads every 15 seconds, so the answer must stand a little longer than that.
test('board outputs: an answer stands past the page refresh, then git is asked again', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  assert.ok(BOARD_OUTPUT_CACHE_MS > 15000, `the window is ${BOARD_OUTPUT_CACHE_MS} ms`);
  writeFileSync(join(sandbox.repo, 'first.txt'), 'x');
  assert.deepEqual(readBoardOutputs(sandbox.repo, 'HEAD', sandbox.env, 1000), ['first.txt']);
  writeFileSync(join(sandbox.repo, 'second.txt'), 'x');
  assert.deepEqual(readBoardOutputs(sandbox.repo, 'HEAD', sandbox.env, 1000 + BOARD_OUTPUT_CACHE_MS - 1), ['first.txt']);
  assert.deepEqual(readBoardOutputs(sandbox.repo, 'HEAD', sandbox.env, 1000 + BOARD_OUTPUT_CACHE_MS), ['first.txt', 'second.txt']);
});

// #784: a board left open all day keeps a fixed number of answers, and the oldest go first.
test('board outputs: the cache keeps 64 answers and drops the oldest', () => {
  const entries = new Map<string, BoardOutputEntry>();
  for (let index = 0; index < BOARD_OUTPUT_CACHE_LIMIT + 6; index += 1) entries.set(`key-${index}`, { at: index, files: [] });
  trimBoardOutputs(entries);
  assert.equal(entries.size, BOARD_OUTPUT_CACHE_LIMIT);
  assert.equal(entries.has('key-5'), false, 'the oldest keys go');
  assert.equal(entries.has('key-6'), true, 'the rest stay');
});

// #784: a desk on the main branch, or on none, counts from where it left the default
// branch, so the commits it made on its own branch are not lost.
test('board outputs: the merge base shows a commit that a HEAD base hides', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  assert.equal(readDefaultBranch(sandbox.repo, sandbox.env), 'main');
  assert.equal(sandbox.git('checkout', '-q', '-b', 'feature').status, 0);
  writeFileSync(join(sandbox.repo, 'work.txt'), 'x');
  assert.equal(sandbox.git('add', 'work.txt').status, 0);
  assert.equal(sandbox.git('commit', '-q', '-m', 'work').status, 0);
  assert.deepEqual(readBoardOutputs(sandbox.repo, 'HEAD', sandbox.env), []);
  const where = readMergeBase(sandbox.repo, 'main', sandbox.env);
  assert.notEqual(where, '');
  assert.deepEqual(readBoardOutputs(sandbox.repo, where, sandbox.env), ['work.txt']);
});

