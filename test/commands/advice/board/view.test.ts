// Tests for src/commands/advice/board/view.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../../repo/helpers.ts';
import type { BoardAgent } from '../../../../src/commands/advice/board/agents.ts';
import { type AgentView, collectBoard, dotOf, needsOf, pullView, refOf, taskTitle, vendorOf } from '../../../../src/commands/advice/board/view.ts';
import type { BoardPull, Gh } from '../../../../src/host/github.ts';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const AGENT: BoardAgent = { name: 'a', vendor: '', model: '', effort: '', task: '', worktree: '', doing: '', updated: '', role: '', state: '', checks: '' };
const PULL: BoardPull = { number: 1, title: 't', branch: 'b', url: '', stage: 'open', checks: 'pass', tier: 'B', review: 'none', mergedAt: '' };

// #603: the dot says what the owner needs to know. The agent's own word wins, then its
// checks, then how recently it wrote.
test('board view: the dot is done, waiting, failing, working or idle', () => {
  const recent = '2026-10-22T11:45:00Z';
  assert.equal(dotOf({ ...AGENT, state: 'done', checks: 'failing', updated: recent }, NOW), 'done');
  assert.equal(dotOf({ ...AGENT, state: 'waiting', checks: 'failing' }, NOW), 'waiting');
  assert.equal(dotOf({ ...AGENT, checks: 'failing', updated: recent }, NOW), 'failing');
  assert.equal(dotOf({ ...AGENT, updated: recent }, NOW), 'working');
  assert.equal(dotOf({ ...AGENT, updated: '2026-10-22T11:00:00Z' }, NOW), 'idle', 'an hour quiet');
  assert.equal(dotOf({ ...AGENT, updated: 'soon' }, NOW), 'idle', 'an odd time');
  assert.equal(dotOf({ ...AGENT, state: 'working', updated: '' }, NOW), 'idle', 'no time');
});

test('board view: the task names its pull request or issue, shown as a chip', () => {
  assert.deepEqual(refOf('PR #615 Run rules locally'), { kind: 'pr', number: 615 });
  assert.deepEqual(refOf('review pull request 12'), { kind: 'pr', number: 12 });
  assert.deepEqual(refOf('Issue #614 Done needs the checker'), { kind: 'issue', number: 614 });
  assert.deepEqual(refOf('fix #7'), { kind: 'issue', number: 7 });
  assert.equal(refOf('just exploring'), null);
  assert.equal(taskTitle('PR #615 Run rules locally'), 'Run rules locally');
  assert.equal(taskTitle('issue 614: Done needs the checker'), 'Done needs the checker');
  assert.equal(taskTitle('#7 - polish'), 'polish');
  assert.equal(taskTitle('Plan the week'), 'Plan the week');
  assert.equal(taskTitle('#7'), '#7', 'nothing but the number keeps the number');
});

test('board view: a known vendor has its own name and colour; any other is grey', () => {
  assert.deepEqual(vendorOf('claude-code'), { name: 'Claude', color: '#d97757' });
  assert.deepEqual(vendorOf(' Muse '), { name: 'Muse', color: '#0866ff' });
  assert.deepEqual(vendorOf('acme-agent'), { name: 'acme-agent', color: '#8b8b8b' });
  assert.deepEqual(vendorOf(''), { name: 'Unknown', color: '#8b8b8b' });
});

// #603: four steps: Built, Checked, You (tier A only), Merged.
test('board view: each pull request stage as its steps and one word', () => {
  const shown = (pull: Partial<BoardPull>) => {
    const view = pullView({ ...PULL, ...pull });
    return [view.steps.join(','), view.label, view.tone];
  };
  assert.deepEqual(shown({ stage: 'draft' }), ['now,,skip,', 'Being built', 'now']);
  assert.deepEqual(shown({ checks: 'fail', tier: 'A' }), ['done,fail,,', 'Checks failed', 'fail']);
  assert.deepEqual(shown({ checks: 'running' }), ['done,now,skip,', 'Checks running', 'now']);
  assert.deepEqual(shown({ checks: 'none' }), ['done,now,skip,', 'No checks yet', 'now']);
  assert.deepEqual(shown({ tier: 'A', review: 'waiting' }), ['done,done,now,', 'Your Approve', 'now']);
  assert.deepEqual(shown({ tier: 'A', review: 'changes' }), ['done,done,fail,', 'Changes asked', 'fail']);
  assert.deepEqual(shown({ tier: 'A', review: 'approved' }), ['done,done,done,now', 'Ready to merge', 'ok']);
  assert.deepEqual(shown({ tier: 'B' }), ['done,done,skip,now', 'Ready to merge', 'ok']);
  assert.equal(pullView({ ...PULL, url: 'https://example.com/pull/1' }).url, 'https://example.com/pull/1');
  assert.equal(pullView({ ...PULL, url: 'javascript:alert(1)' }).url, '', 'only http(s) addresses reach the page');
  assert.equal(pullView({ ...PULL, url: ' JaVaScRiPt:alert(1)' }).url, '');
});

test('board view: needs you holds tier A pull requests ready for an Approve, then waiting agents', () => {
  const waiting = { key: '~/w', name: 'Calm', dot: 'waiting', doing: 'Asks to add a package', task: '' } as AgentView;
  const working = { key: '~/x', name: 'Busy', dot: 'working', doing: '', task: '' } as AgentView;
  const needs = needsOf([working, waiting], [
    { ...PULL, number: 5, tier: 'A', review: 'waiting' },
    { ...PULL, number: 6, tier: 'A', review: 'approved' },
    { ...PULL, number: 7, tier: 'A', review: 'changes' },
    { ...PULL, number: 8, tier: 'A', checks: 'fail' },
    { ...PULL, number: 9, tier: 'A', stage: 'draft' },
    { ...PULL, number: 10, tier: 'B' },
  ]);
  assert.deepEqual(needs.map((need) => [need.kind, need.title, need.agentKey, need.pull]), [
    ['approve', 'Approve PR #5', '', 5],
    ['answer', 'Calm is waiting for you', '~/w', 0],
  ]);
  assert.equal(needs[1].why, 'Asks to add a package');
});

// #601, #603: the data together. Without a GitHub remote, gh is never asked. Every shown
// path hides the home folder. Merged pull requests older than the window are not sent.
test('board data: agents, needs, pulls and worktrees; gh runs only with a GitHub remote', () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', role: 'lead', task: 'PR #1 t', updated: '2026-10-22T11:59:00Z' }));
  const unasked: Gh = () => {
    throw new Error('gh must not run without a GitHub remote');
  };
  const without = collectBoard(sandbox.repo, sandbox.env, unasked, NOW);
  assert.equal(without.repo, sandbox.repo);
  assert.deepEqual(without.agents.map((agent) => [agent.name, agent.role, agent.dot, agent.title, agent.ref, agent.age, agent.branch]), [['w', 'lead', 'working', 't', { kind: 'pr', number: 1 }, '1 min ago', 'main']]);
  assert.equal(without.pulls, 'this repo has no GitHub remote, so the board shows no pull requests');
  assert.deepEqual(without.worktrees, [{ path: realpathSync(sandbox.repo), branch: 'main' }]);
  assert.equal(without.updated, '2026-10-22T12:00:00.000Z');
  assert.equal(sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git').status, 0);
  const row = { headRefName: 'b', url: '', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], labels: [{ name: 'tier A' }] };
  const gh: Gh = () => JSON.stringify([
    { ...row, number: 1, title: 'open', state: 'OPEN' },
    { ...row, number: 2, title: 'new', state: 'MERGED', mergedAt: '2026-10-22T09:00:00Z' },
    { ...row, number: 3, title: 'old', state: 'MERGED', mergedAt: '2026-10-19T09:00:00Z' },
    { ...row, number: 4, title: 'shut', state: 'CLOSED' },
  ]);
  const board = collectBoard(sandbox.repo, sandbox.env, gh, NOW);
  assert.deepEqual(typeof board.pulls === 'string' ? board.pulls : board.pulls.map((pull) => [pull.number, pull.label]), [[1, 'Your Approve']]);
  assert.deepEqual(board.merged, [{ number: 2, title: 'new', url: '', mergedAt: '2026-10-22T09:00:00Z' }]);
  assert.deepEqual(board.needs.map((need) => need.title), ['Approve PR #1']);
  // A fake HOME above the repo: every shown path hides it.
  const hidden = collectBoard(sandbox.repo, { ...sandbox.env, HOME: dirname(sandbox.repo) }, gh, NOW);
  assert.equal(hidden.repo, '~/repo');
  assert.equal(hidden.agents[0].key, '~/repo');
  assert.deepEqual(hidden.worktrees, [{ path: '~/repo', branch: 'main' }]);
  // No repo: no agents, and the worktrees say why.
  const outside = collectBoard(sandbox.home, sandbox.env, unasked, NOW);
  assert.equal(outside.repo, '~');
  assert.deepEqual(outside.agents, []);
  assert.equal(outside.worktrees, 'git could not list the worktrees: run it again');
});
