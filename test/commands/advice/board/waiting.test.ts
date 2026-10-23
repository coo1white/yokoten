// Tests for src/commands/advice/board/waiting.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../../repo/helpers.ts';
import type { BoardWaiting } from '../../../../src/commands/advice/board/controls.ts';
import { collectBoardWaiting, readBoardAttention, readBoardIssues, readBoardSnapshot } from '../../../../src/commands/advice/board/waiting.ts';
import { EMPTY_DESK } from '../../../../src/commands/advice/board/feed/read/desk.ts';
import { type AgentView, vendorOf } from '../../../../src/commands/advice/board/view.ts';
import type { Gh } from '../../../../src/host/github/index.ts';

const agent = (fields: Partial<AgentView>): AgentView => ({ key: '', name: 'a', nickname: '', isMain: false, vendor: vendorOf(''), model: '', effort: '', role: '', dot: 'idle', task: '', title: '', ref: null, doing: '', checks: '', age: '', updated: '', started: '', branch: '', ...fields });

// #603: the open issues as rows, or why gh cannot read them.
test('board waiting: the open issues', () => {
  const gh: Gh = () => JSON.stringify([{ number: 603, title: 'board agents', url: 'https://example.com/i/603', body: 'Depends on #601.', createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T11:00:00Z' }, { number: 'x' }, null]);
  assert.deepEqual(readBoardIssues(gh, 'octo/demo'), [{ number: 603, title: 'board agents', url: 'https://example.com/i/603', createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T11:00:00Z', dependsOn: [601] }]);
  assert.equal(readBoardIssues(() => { throw new Error('no net'); }, 'octo/demo'), 'gh could not list the open issues: run it again');
  assert.equal(readBoardIssues(() => 'oops', 'octo/demo'), 'gh gave no open issue list: run it again');
});

// #603: the attention comes from the status files; a missing, broken, or quiet file is skipped.
test('board waiting: the attention in the status files', () => {
  const folder = makeTempDir();
  const trees = [{ path: folder, branch: 'main' }];
  assert.deepEqual(readBoardAttention(trees), [], 'no file, no hold-up');
  writeFileSync(join(folder, '.yokoten-agent.json'), '{oops');
  assert.deepEqual(readBoardAttention(trees), [], 'a broken file is skipped');
  writeFileSync(join(folder, '.yokoten-agent.json'), JSON.stringify({ name: 'w', role: 'reviewer', updated: '2026-10-22T10:00:00Z', doing: 'fine' }));
  assert.deepEqual(readBoardAttention(trees), [], 'a quiet file is skipped');
  writeFileSync(join(folder, '.yokoten-agent.json'), JSON.stringify({ name: 'w', role: 'reviewer', updated: '2026-10-22T10:00:00Z', blocked: 'the guard stopped it\nsecond line', question: 'which one?', link: 'javascript:alert(1)' }));
  assert.deepEqual(readBoardAttention(trees), [
    { name: 'w', vendor: '', role: 'reviewer', worktree: '', updated: '2026-10-22T10:00:00Z', kind: 'guard', why: 'the guard stopped it', link: '' },
    { name: 'w', vendor: '', role: 'reviewer', worktree: '', updated: '2026-10-22T10:00:00Z', kind: 'question', why: 'which one?', link: '' },
  ], 'one line each, and no odd link');
});

// #603: the waiting list latches an agent row while the agent is here, and drops it
// when it leaves; Approve rows follow the pulls.
test('board waiting: the waiting list latches while the agent is here', () => {
  const board = { repo: 'r', repoName: 'r', repoUrl: '', desk: EMPTY_DESK, agents: [agent({ key: 'p', name: 'w', role: 'engineer', updated: '2026-10-22T10:00:00Z', branch: 'main' })], needs: [], pulls: [], merged: [], worktrees: [{ path: 'p', branch: 'main' }], updated: '' };
  const held = [{ name: 'w', vendor: '', role: 'engineer' as const, worktree: 'p', updated: '2026-10-22T10:00:00Z', kind: 'guard' as const, why: 'the guard stopped it', link: '' }];
  const seen: BoardWaiting[] = [];
  assert.deepEqual(collectBoardWaiting(board, held, [], seen).map((row) => row.kind), ['guard']);
  assert.deepEqual(collectBoardWaiting(board, [], [], seen).map((row) => row.kind), ['guard'], 'a quiet file clears nothing');
  assert.deepEqual(collectBoardWaiting({ ...board, agents: [] }, [], [], seen), [], 'leaving clears it');
});

// #603 re-inspection (LOW): a waiting row counted from the agent's last write, so a
// rewrite reset the wait. The wait counts from when the row first showed instead.
test('board waiting: the wait counts from when the row first showed', () => {
  const board = { repo: 'r', repoName: 'r', repoUrl: '', desk: EMPTY_DESK, agents: [agent({ key: 'p', name: 'w', role: 'engineer', updated: '2026-10-22T10:00:00Z', branch: 'main' })], needs: [], pulls: [], merged: [], worktrees: [{ path: 'p', branch: 'main' }], updated: '' };
  const seen: BoardWaiting[] = [];
  const at = Date.parse('2026-10-22T10:00:00Z');
  const held = (updated: string) => [{ name: 'w', vendor: '', role: 'engineer' as const, worktree: 'p', updated, kind: 'guard' as const, why: 'the guard stopped it', link: '' }];
  assert.deepEqual(collectBoardWaiting(board, held('2026-10-22T10:00:00Z'), [], seen, at).map((row) => row.wait), ['just now'], 'first seen');
  // The agent rewrites every minute; ten minutes later the wait is ten minutes.
  const later = collectBoardWaiting(board, held('2026-10-22T10:09:00Z'), [], seen, at + 10 * 60 * 1000);
  assert.deepEqual(later.map((row) => row.wait), ['10 min ago'], 'the rewrite resets nothing');
});

// /data keeps the latch time on the server and shows only the tail of a run's output.
test('board waiting: the snapshot hides the latch time and the home folder', () => {
  const home = makeTempDir();
  const board = { repo: 'r', repoName: 'r', repoUrl: '', desk: EMPTY_DESK, agents: [agent({ key: 'p', name: 'w', role: 'engineer' })], needs: [], pulls: [], merged: [], worktrees: [], updated: '' };
  const seen: BoardWaiting[] = [{ kind: 'guard', agent: 'w', role: 'engineer', wait: '', why: 'stopped', link: '', latchedAt: '2026-10-22T10:00:00Z' }];
  const lines = Array.from({ length: 31 }, (_, index) => `line ${index}`);
  const controls = {
    limits: { maxAgents: 3, byModel: { 'model-a': 1 } },
    runs: [{ name: 'w', issue: '1', vendor: 'grok', model: 'm', worktree: `${home}/repo/.worktrees/1`, pid: 1, status: 'running' as const, startedAt: '', stoppedAt: '', exitCode: null, output: lines }],
    seen,
    handles: new Map(),
    logPath: '',
    spawner: () => ({ pid: null, kill: () => undefined }),
  };
  const snapshot = readBoardSnapshot({ HOME: home }, controls, board, [], [{ number: 9, title: 'open', url: '', createdAt: '', updatedAt: '', dependsOn: [] }]);
  assert.equal('latchedAt' in snapshot.waiting[0], false, 'the latch time stays on the server');
  assert.equal(snapshot.runs[0].output.length, 30, 'only the tail of the output');
  assert.equal(snapshot.runs[0].output[0], 'line 1');
  assert.equal(snapshot.runs[0].worktree, '~/repo/.worktrees/1', 'the home folder stays hidden');
  assert.deepEqual(snapshot.issues, [{ number: 9, title: 'open', url: '', createdAt: '', updatedAt: '', dependsOn: [] }]);
  assert.deepEqual(snapshot.limits, { maxAgents: 3, byModel: { 'model-a': 1 } });
});
