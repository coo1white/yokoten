// Tests for src/commands/advice/board/view.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { registerDesk } from '../../../../src/run/hook.ts';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir, runChild } from '../../../repo/helpers.ts';
import type { BoardAgent } from '../../../../src/commands/advice/board/agents.ts';
import { claudeFolder } from '../../../../src/commands/advice/board/feed/logs.ts';
import { type AgentView, collectBoard, dotOf, issueNumbersOf, needsOf, nicknameId, nicknameOf, pullView, refOf, taskTitle, vendorOf } from '../../../../src/commands/advice/board/view.ts';
import type { BoardPull, Gh } from '../../../../src/host/github/index.ts';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const AGENT: BoardAgent = { name: 'a', vendor: '', model: '', effort: '', task: '', worktree: '', doing: '', updated: '', role: '', state: '', checks: '' };
const PULL: BoardPull = { number: 1, title: 't', branch: 'b', url: '', stage: 'open', checks: 'pass', tier: 'B', review: 'none', isApprovedOnHead: false, mergedAt: '' };

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
  // #685: the title is clean whatever the task: no leading refs, joins or links.
  assert.equal(taskTitle('PR #683 (https://github.com/o/r/pull/683), issues #668 and #664: Board fixes'), 'Board fixes');
  assert.equal(taskTitle(', issues #668 board'), 'board', 'what was left before');
  assert.equal(taskTitle('PR #1, PR #2 — tidy up (see https://example.com/x)'), 'tidy up');
  assert.equal(taskTitle('Fix 3 bugs in #12'), 'Fix 3 bugs in #12', 'a ref inside the text stays');
  assert.equal(taskTitle('3 bugs'), '3 bugs', 'a plain number is no ref');
});

test('board view: a known vendor has its own name and colour; any other is grey', () => {
  assert.deepEqual(vendorOf('claude-code'), { name: 'Claude', color: '#d97757' });
  assert.deepEqual(vendorOf(' Muse '), { name: 'Muse', color: '#0866ff' });
  assert.deepEqual(vendorOf('acme-agent'), { name: 'acme-agent', color: '#8b8b8b' });
  assert.deepEqual(vendorOf(''), { name: 'Unknown', color: '#8b8b8b' });
});

// #693: filed names that are one vendor share one shown name. Codex shows as DeepSeek
// only when its model is a DeepSeek model. Claude on that model stays Claude.
test('board view: Claude, Grok, Muse and DeepSeek each have one name', () => {
  const claude = { name: 'Claude', color: '#d97757' };
  const grok = { name: 'Grok', color: '#9ca3af' };
  const muse = { name: 'Muse', color: '#0866ff' };
  const deepseek = { name: 'DeepSeek', color: '#4d6bfe' };
  for (const filed of ['claude-code', 'claude', 'anthropic', ' Claude-Code ']) assert.deepEqual(vendorOf(filed), claude, filed);
  for (const filed of ['grok', 'xai', 'XAI']) assert.deepEqual(vendorOf(filed), grok, filed);
  assert.deepEqual(vendorOf('muse'), muse);
  for (const filed of ['deepseek', 'deepseek-harness', 'codex-deepseek', 'codex on deepseek']) assert.deepEqual(vendorOf(filed), deepseek, filed);
  assert.deepEqual(vendorOf('codex', 'deepseek-chat'), deepseek, 'codex on a DeepSeek model');
  assert.deepEqual(vendorOf('codex', 'DeepSeek-V3'), deepseek);
  assert.deepEqual(vendorOf('codex'), { name: 'Codex', color: '#10a37f' }, 'codex on its own model stays Codex');
  assert.deepEqual(vendorOf('claude', 'deepseek-v3'), claude, 'Claude on a DeepSeek model stays Claude');
  assert.deepEqual(vendorOf('claude-code', 'deepseek-reasoner'), claude);
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
  assert.deepEqual(shown({ tier: 'A', review: 'waiting' }), ['done,done,now,', 'Needs your approval', 'now']);
  assert.deepEqual(shown({ tier: 'A', review: 'changes' }), ['done,done,fail,', 'Changes requested', 'fail']);
  assert.deepEqual(shown({ tier: 'A', review: 'approved', isApprovedOnHead: true }), ['done,done,done,now', 'Ready to merge', 'ok']);
  assert.deepEqual(shown({ tier: 'A', review: 'approved', isApprovedOnHead: false }), ['done,done,now,', 'Needs your approval', 'now'], 'an Approve on an older commit still needs you');
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
    { ...PULL, number: 6, tier: 'A', review: 'approved', isApprovedOnHead: true },
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

/** A waiting agent, with only the fields Needs you reads. */
const waitingAgent = (fields: Partial<AgentView>): AgentView => ({ key: '~/w', name: 'Calm', nickname: '', isMain: false, dot: 'waiting', doing: 'Asks a question', task: '', ref: null, title: '', vendor: vendorOf('grok'), model: '', effort: '', role: 'engineer', checks: '', age: '', updated: '', branch: '', ...fields });

// #693: one row per pull request or issue. An Approve row wins that pull request.
// Two agents with no number each keep a row, because nothing says they are the same item.
test('board view: Needs you is one row per pull request or issue', () => {
  const needs = needsOf(
    [
      waitingAgent({ key: '~/a', name: 'Ada', ref: { kind: 'pr', number: 5 }, task: 'PR #5' }),
      waitingAgent({ key: '~/b', name: 'Bea', ref: { kind: 'pr', number: 5 }, task: 'PR #5 again' }),
      waitingAgent({ key: '~/c', name: 'Cy', ref: { kind: 'issue', number: 9 }, task: 'issue #9' }),
      waitingAgent({ key: '~/d', name: 'Di', ref: { kind: 'issue', number: 9 }, task: 'issue #9 too' }),
      waitingAgent({ key: '~/e', name: 'Eve' }),
      waitingAgent({ key: '~/f', name: 'Fay' }),
    ],
    [{ ...PULL, number: 5, tier: 'A', review: 'waiting' }],
    [9],
  );
  assert.deepEqual(needs.map((need) => [need.kind, need.pull, need.agentKey, need.title]), [
    ['approve', 5, '', 'Approve PR #5'],
    ['answer', 0, '~/c', 'Cy is waiting for you'],
    ['answer', 0, '~/e', 'Eve is waiting for you'],
    ['answer', 0, '~/f', 'Fay is waiting for you'],
  ]);
});

// #693: a row leaves once the pull request is approved on its head commit, or the pull
// request or issue is merged or closed. A pull request the board has not read stays,
// and so does an issue when the open-issue list cannot prove it is closed.
test('board view: Needs you drops a row once it is approved on the head, or merged or closed', () => {
  const agents = [
    waitingAgent({ key: '~/head', name: 'Head', ref: { kind: 'pr', number: 1 } }),
    waitingAgent({ key: '~/old', name: 'Old', ref: { kind: 'pr', number: 2 } }),
    waitingAgent({ key: '~/merged', name: 'Merged', ref: { kind: 'pr', number: 3 } }),
    waitingAgent({ key: '~/closed', name: 'Closed', ref: { kind: 'pr', number: 4 } }),
    waitingAgent({ key: '~/shut', name: 'Shut', ref: { kind: 'issue', number: 8 } }),
    waitingAgent({ key: '~/open', name: 'Open', ref: { kind: 'issue', number: 9 } }),
    waitingAgent({ key: '~/missing', name: 'Missing', ref: { kind: 'pr', number: 99 } }),
  ];
  const pulls: BoardPull[] = [
    { ...PULL, number: 1, tier: 'A', review: 'approved', isApprovedOnHead: true },
    { ...PULL, number: 2, tier: 'A', review: 'approved', isApprovedOnHead: false },
    { ...PULL, number: 3, stage: 'merged' },
    { ...PULL, number: 4, stage: 'closed' },
  ];
  const needs = needsOf(agents, pulls, [9]);
  assert.deepEqual(needs.map((need) => [need.kind, need.title, need.agentKey]), [
    ['approve', 'Approve PR #2', ''],
    ['answer', 'Open is waiting for you', '~/open'],
    ['answer', 'Missing is waiting for you', '~/missing'],
  ]);
  const kept = needsOf(agents, pulls, null).filter((need) => need.kind === 'answer').map((need) => need.agentKey);
  assert.deepEqual(kept, ['~/shut', '~/open', '~/missing'], 'an unknown issue list cannot prove an issue is closed');
  const full = Array.from({ length: 30 }, (_, index) => ({ number: index + 1 }));
  assert.equal(issueNumbersOf(full), null, 'a list at the cap may be cut off');
  assert.equal(issueNumbersOf('gh could not list the open issues: run it again'), null);
  assert.deepEqual(issueNumbersOf([{ number: 9 }, { number: 10 }]), [9, 10]);
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
  assert.deepEqual(typeof board.pulls === 'string' ? board.pulls : board.pulls.map((pull) => [pull.number, pull.label]), [[1, 'Needs your approval']]);
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

/** A shell call in each runtime's own shape, for its hook (#685). */
const SHELL_CALLS: Record<string, (cwd: string) => unknown> = {
  'claude-code': (cwd) => ({ cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
  grok: (cwd) => ({ cwd, hookEventName: 'PreToolUse', toolName: 'run_terminal_command', toolInput: { command: 'npm test' } }),
  muse: (cwd) => ({ cwd, hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'npm test' } }),
  'deepseek-harness': (cwd) => ({ cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
};

// #685: the board fills itself. Each vendor's hook writes its worker's file in its own
// worktree, and a desk clone (no worktree) shows too. Each vendor has its own name and
// colour, so Grok, Muse and DeepSeek never show as one grey "other".
test('board data: agents from each vendor\'s hook, and a desk clone, with their own colours', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const base = realpathSync(makeTempDir('yokoten-trees-'));
  for (const agent of ['claude-code', 'muse', 'deepseek-harness']) {
    const tree = join(base, agent);
    sandbox.git('worktree', 'add', '-q', '-b', `w-${agent}`, tree);
    assert.equal((await sandbox.call(['hook', '--agent', agent], { cwd: tree, input: JSON.stringify(SHELL_CALLS[agent](tree)), extra: { YOKOTEN_ROLE: 'worker' } })).status, 0);
  }
  // A desk: a plain clone, which `yokoten desk` notes. Its Grok agent's hook writes there.
  const desk = join(base, 'desk');
  assert.equal(runChild('git', ['clone', '-q', sandbox.repo, desk]).status, 0);
  assert.equal(registerDesk(sandbox.repo, desk), '');
  assert.equal((await sandbox.call(['hook', '--agent', 'grok'], { cwd: desk, input: JSON.stringify(SHELL_CALLS.grok(desk)), extra: { YOKOTEN_ROLE: 'worker' } })).status, 0);
  const board = collectBoard(sandbox.repo, sandbox.env, () => '[]');
  const shown = board.agents.map((agent) => [agent.key, agent.vendor.name, agent.vendor.color, agent.role, agent.doing]);
  assert.deepEqual(shown, [
    [join(base, 'claude-code'), 'Claude', '#d97757', 'engineer', 'running npm test'],
    [join(base, 'deepseek-harness'), 'DeepSeek', '#4d6bfe', 'engineer', 'running npm test'],
    [join(base, 'muse'), 'Muse', '#0866ff', 'engineer', 'running npm test'],
    [desk, 'Grok', '#9ca3af', 'engineer', 'running npm test'],
  ]);
  assert.ok(typeof board.worktrees !== 'string' && board.worktrees.some((tree) => tree.path === desk && tree.branch === 'main'), 'the desk is listed with its branch');
  // A desk that is gone drops off.
  rmSync(desk, { recursive: true, force: true });
  assert.ok(!collectBoard(sandbox.repo, sandbox.env, () => '[]').agents.some((agent) => agent.key === desk));
});

// #693: one id keeps one friendly name. A name already taken in this run takes the next pioneer.
test('board view: the same id keeps its nickname, and one run never shares a name', () => {
  const id = '/trees/agent-a';
  const first = nicknameOf(id, []);
  assert.equal(nicknameOf(id, []), first, 'the same id, read again, keeps the name');
  assert.equal(nicknameId(id, 'status-name'), id, 'a path is the id');
  assert.equal(nicknameId('', 'status-name'), 'status-name', 'no path: the status name is the id');
  const taken: string[] = [];
  const names: string[] = [];
  for (let step = 0; step < 20; step += 1) {
    const name = nicknameOf(id, taken);
    assert.equal(taken.includes(name), false, name);
    taken.push(name);
    names.push(name);
  }
  assert.equal(new Set(names).size, 20, 'twenty pioneers, twenty names');
  assert.equal(nicknameOf(id, taken), `${first.split(' ')[0]} agent`, 'every pioneer taken');
  assert.equal(names[0], first);
});

// #698: a seat is held only while the agent is actually working. A bad seats file is ignored.
test('board view: a stale working agent holds no seat, and seats come from the git folder', () => {
  const sandbox = makeSandbox();
  const status = join(sandbox.repo, '.yokoten-agent.json');
  const clock = Date.now();
  const read = () => collectBoard(sandbox.repo, sandbox.env, () => '[]', clock);
  writeFileSync(status, JSON.stringify({ name: 'w', vendor: 'claude', state: 'working', updated: new Date(clock).toISOString() }));
  assert.equal(read().agents[0].isLive, true, 'a fresh working status is live');
  assert.equal(read().seats, null, 'no seats file');
  const old = new Date(clock - 60 * 60 * 1000);
  utimesSync(status, old, old);
  assert.equal(read().agents[0].isLive, false, 'a stale working status holds no seat');
  const tree = realpathSync(sandbox.repo);
  const log = join(sandbox.home, '.claude', 'projects', claudeFolder(tree), 's.jsonl');
  mkdirSync(join(log, '..'), { recursive: true });
  writeFileSync(log, '{}\n');
  utimesSync(log, new Date(clock), new Date(clock));
  assert.equal(read().agents[0].isLive, true, 'a fresh session log keeps it live');
  writeFileSync(status, JSON.stringify({ name: 'w', vendor: 'claude', state: 'done', updated: new Date(clock).toISOString() }));
  utimesSync(status, new Date(clock), new Date(clock));
  assert.equal(read().agents[0].isLive, false, 'a done agent holds no seat');
  const seats = join(sandbox.repo, '.git', 'yokoten-seats.json');
  writeFileSync(seats, 'not json');
  assert.equal(read().seats, null, 'a bad seats file is ignored');
  writeFileSync(seats, '{"grok":16,"claude":0,"deepseek":-1,"bad":1.5,"constructor":9,"__proto__":3}');
  assert.deepEqual(read().seats, { grok: 16, claude: 0 });
});

// #693: the board runs in a linked worktree. The top bar still names the main folder.
// A worker, a reviewer and a desk lead each keep their own name. The checkout lead is the main one.
test('board view: nicknames stay with the worktree, and the top bar names the main folder', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  const work = join(sandbox.home, 'repo-688-board-fast');
  assert.equal(sandbox.git('worktree', 'add', '-q', work, '-b', 'board-fast').status, 0);
  const desk = join(sandbox.home, 'desk');
  assert.equal(runChild('git', ['clone', '-q', sandbox.repo, desk]).status, 0);
  assert.equal(registerDesk(sandbox.repo, desk), '');
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'main-lead', role: 'lead' }));
  writeFileSync(join(work, '.yokoten-agent.json'), JSON.stringify({ name: 'worker-1', role: 'worker' }));
  writeFileSync(join(desk, '.yokoten-agent.json'), JSON.stringify({ name: 'area-lead', role: 'lead' }));
  const read = () => collectBoard(work, { ...sandbox.env, HOME: sandbox.home }, () => '[]', NOW);
  const board = read();
  assert.equal(board.repoName, 'repo');
  assert.match(board.repo, /repo-688-board-fast$/);
  assert.deepEqual(board.agents.map((agent) => [agent.name, agent.role, agent.isMain]), [
    ['main-lead', 'lead', true],
    ['worker-1', 'worker', false],
    ['area-lead', 'lead', false],
  ]);
  const names = board.agents.map((agent) => agent.nickname);
  assert.equal(new Set(names).size, names.length, 'two agents never share a name');
  assert.ok(names.every((name) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(name)), names.join(', '));
  const taken: string[] = [];
  // git reports a resolved path. The desk list keeps the path it was given.
  const paths = [realpathSync(sandbox.repo), realpathSync(work), desk];
  const expectNames = ['main-lead', 'worker-1', 'area-lead'].map((name, index) => {
    const nickname = nicknameOf(nicknameId(paths[index], name), taken);
    taken.push(nickname);
    return nickname;
  });
  assert.deepEqual(names, expectNames, 'the name comes from the worktree path');
  assert.deepEqual(read().agents.map((agent) => agent.nickname), names, 'a second read keeps every name');
});
