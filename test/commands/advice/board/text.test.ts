// Tests for src/commands/advice/board/text.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBoardText } from '../../../../src/commands/advice/board/text.ts';
import { type AgentView, type BoardData, pullView, vendorOf } from '../../../../src/commands/advice/board/view.ts';

const agent = (fields: Partial<AgentView>): AgentView => ({ key: '', name: 'a', vendor: vendorOf(''), model: '', effort: '', role: '', dot: 'idle', task: '', title: '', ref: null, doing: '', checks: '', age: '', updated: '', branch: '', ...fields });

test('board text: needs, agents, pulls and worktrees in plain words; a part that cannot be read says why', () => {
  const board: BoardData = {
    repo: '/repo',
    repoUrl: '',
    agents: [
      agent({ key: '/repo/.worktrees/601', name: 'worker-1', vendor: vendorOf('claude-code'), role: 'engineer', task: 'issue 601', doing: 'writing tests', age: '2 min ago' }),
      agent({ name: 'Calm', vendor: vendorOf('grok'), dot: 'waiting', doing: 'asks to add a package' }),
      agent({ name: 'plain' }),
    ],
    needs: [{ kind: 'approve', title: 'Approve PR #1', why: 'team page. All checks pass. Tier A needs your approval.', agentKey: '', pull: 1 }],
    pulls: [pullView({ number: 1, title: 'team page', branch: 'board', url: '', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', mergedAt: '' })],
    merged: [{ number: 2, title: 'old work', url: '', mergedAt: '2026-10-22T09:00:00Z' }],
    worktrees: [
      { path: '/repo', branch: 'main' },
      { path: '/repo/.worktrees/601', branch: '' },
    ],
    updated: '',
  };
  assert.deepEqual(renderBoardText(board), [
    'yokoten board: /repo',
    '3 agents, 1 open pull request, 2 worktrees.',
    '',
    'Needs you:',
    '- Approve PR #1: team page. All checks pass. Tier A needs your approval.',
    '',
    'Agents:',
    '- worker-1 (Claude) [engineer]: issue 601, in /repo/.worktrees/601, writing tests, 2 min ago',
    '- Calm (Grok): asks to add a package, waiting',
    '- plain',
    '',
    'Pull requests:',
    '- #1 team page [board]: Needs your approval, tier A',
    '- #2 old work: merged',
    '',
    'Worktrees:',
    '- /repo (main)',
    '- /repo/.worktrees/601',
  ]);
  assert.deepEqual(renderBoardText({ repo: '/repo', repoUrl: '', agents: [], needs: [], pulls: 'gh failed', merged: [], worktrees: 'git failed', updated: '' }), [
    'yokoten board: /repo',
    '0 agents, 0 open pull requests, 0 worktrees.',
    '',
    'Needs you:',
    '- nothing.',
    '',
    'Agents:',
    '- none. An agent joins by writing .yokoten-agent.json in its worktree.',
    '',
    'Pull requests:',
    '- gh failed',
    '',
    'Worktrees:',
    '- git failed',
  ]);
});

// #603: agents write the status files, so --text never sends their control codes to the terminal.
test('board text: control and bidi characters in agent text show escaped', () => {
  const board: BoardData = { repo: '/repo', repoUrl: '', agents: [agent({ name: 'bad\u001b]0;owned\u0007', doing: 'x\u202ey' })], needs: [], pulls: [], merged: [], worktrees: [], updated: '' };
  const text = renderBoardText(board).join('\n');
  assert.ok(!/[\u001b\u0007\u202e]/.test(text), 'no raw control or bidi character');
  assert.match(text, /bad\\u001b/, 'the code shows as text');
});
