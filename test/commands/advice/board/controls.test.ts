// Tests for src/commands/advice/board/controls.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../../repo/helpers.ts';
import { EMPTY_DESK } from '../../../../src/commands/advice/board/feed/read/desk.ts';
import { addMachine, type MachineRunner } from '../../../../src/commands/advice/machine.ts';
import {
  boardBrief,
  boardGuardReady,
  boardStartParts,
  collectBoardWaiting,
  createBoardControls,
  readBoardLimitChange,
  readBoardStartAsk,
  setBoardLimits,
  startBoardAgent,
  stopBoardAgent,
  type BoardEvents,
  type BoardSpawner,
} from '../../../../src/commands/advice/board/controls.ts';
import type { Env } from '../../../../src/rules/config.ts';
import { workerMarkAt, workerRole } from '../../../../src/rules/guards.ts';
import * as codexHooks from '../../../../src/agents/runtimes/codex.ts';
import * as grokHooks from '../../../../src/agents/runtimes/grok.ts';

// #603: a fake agent process. Tests pass it, so they never start a real agent. Each
// start is recorded with its command, folder and env; each kill by its pid.
function fakeAgents(): { spawner: BoardSpawner; started: { command: string; args: string[]; cwd: string; env: Env; events: BoardEvents }[]; killed: (number | null)[] } {
  const started: { command: string; args: string[]; cwd: string; env: Env; events: BoardEvents }[] = [];
  const killed: (number | null)[] = [];
  const spawner: BoardSpawner = (command, args, options, events) => {
    const pid = 1000 + started.length;
    started.push({ command, args, cwd: options.cwd, env: options.env, events });
    return { pid, kill: () => { killed.push(pid); } };
  };
  return { spawner, started, killed };
}

// #603: the brief names the issue, the worktree and the model; each vendor starts with
// its own headless command, and an unknown vendor has none.
test('board controls: the brief and the start commands', () => {
  const brief = boardBrief('603', '/repo/.worktrees/603', 'model-a');
  assert.ok(brief.includes('Issue: #603'), 'the issue');
  assert.ok(brief.includes('/repo/.worktrees/603'), 'the worktree');
  assert.ok(brief.includes('model-a'), 'the model');
  assert.ok(brief.includes('YOKOTEN_ROLE') === false, 'no env text in the brief');
  assert.deepEqual(boardStartParts('claude-code', 'hi')?.slice(0, 2), ['claude', '-p']);
  assert.deepEqual(boardStartParts('codex', 'hi')?.slice(0, 2), ['codex', 'exec']);
  assert.deepEqual(boardStartParts('muse', 'hi')?.slice(0, 3), ['muse', 'exec', '--trust-workspace']);
  assert.deepEqual(boardStartParts('grok', 'hi')?.slice(0, 2), ['grok', '-p']);
  assert.deepEqual(boardStartParts('antigravity', 'hi')?.slice(0, 2), ['agy', '-p']);
  assert.deepEqual(boardStartParts('deepseek-harness', 'hi')?.slice(0, 2), ['dsh', 'headless']);
  assert.ok(boardStartParts('claude-code', 'hi')?.at(-1) === 'hi', 'the brief is last');
  assert.equal(boardStartParts('gemini', 'hi'), null, 'no headless form on record: start it by hand');
  assert.equal(boardStartParts('', 'hi'), null);
  assert.deepEqual(readBoardStartAsk({ issue: '603', vendor: 'codex', model: 'model-a' }), { issue: '603', vendor: 'codex', model: 'model-a' });
  assert.match(readBoardStartAsk({ issue: 'x', vendor: 'codex', model: 'm' }) as string, /number/, 'the issue is a number');
  assert.match(readBoardStartAsk({ issue: '603', vendor: 'gemini', model: 'm' }) as string, /by hand/, 'an unknown vendor is refused');
  assert.match(readBoardStartAsk({ issue: '603', vendor: 'codex', model: '' }) as string, /model/, 'the model is named');
});

// #603: the limits change one side and keep the other; anything odd is refused plainly.
test('board controls: the limits change', () => {
  const controls = createBoardControls(join(makeTempDir(), 'board.log'));
  assert.deepEqual(controls.limits, { maxAgents: 3, byModel: {} });
  assert.deepEqual(setBoardLimits(controls, { maxAgents: '2' }), { maxAgents: 2, byModel: {} });
  assert.deepEqual(setBoardLimits(controls, { models: 'model-a:1, model-b:2' }), { maxAgents: 2, byModel: { 'model-a': 1, 'model-b': 2 } });
  assert.match(setBoardLimits(controls, { maxAgents: '0' }) as string, /1 to 32/);
  assert.match(setBoardLimits(controls, { maxAgents: 'many' }) as string, /1 to 32/);
  assert.match(setBoardLimits(controls, { models: 'model-a:x' }) as string, /name:count/);
  assert.match(setBoardLimits(controls, { models: 'model-a' }) as string, /name:count/);
  assert.match(setBoardLimits(controls, {}) as string, /maxAgents, models/);
  assert.deepEqual(readBoardLimitChange({ maxAgents: '33' }) as string, 'set maxAgents to a whole number from 1 to 32');
});

// #603 findings: the board marks the worktree it makes or reuses, so a runtime that
// drops YOKOTEN_ROLE (Muse) still runs as a worker.
test('board controls: a started agent works in a marked worktree', () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const run = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a' });
  assert.ok(typeof run !== 'string', `the start passes: ${run}`);
  assert.equal(workerMarkAt(run.worktree, sandbox.env), 'mark', 'the board-made worktree carries the worker mark');
  assert.equal(workerRole({}, [run.worktree]), 'mark', 'a worker even with no YOKOTEN_ROLE in the env');
});

// #603 findings: on a fresh untrusted worktree the guard hooks are skipped without a
// word, so the board refuses the start with the trust step.
test('board controls: a start is refused when the hooks will not run', () => {
  const sandbox = makeSandbox();
  // Codex in use on this machine, its hooks in place, the folder trusted nowhere.
  mkdirSync(join(sandbox.home, '.codex'), { recursive: true });
  codexHooks.addProjectHook(sandbox.repo, 'bin/yokoten.mjs');
  codexHooks.addProjectStopHook(sandbox.repo, 'bin/yokoten.mjs');
  writeFileSync(join(sandbox.home, '.codex', 'config.toml'), `[projects."${sandbox.repo}"]\ntrust_level = "trusted"\n`);
  assert.match(boardGuardReady('codex', sandbox.repo, sandbox.env) ?? '', /\/hooks/, 'untrusted hooks name the trust step');
  // Codex in use, but no hooks in the worktree: init adds them.
  const bare = makeTempDir('yokoten-board-bare-');
  assert.match(boardGuardReady('codex', bare, sandbox.env) ?? '', /yokoten init/, 'missing hooks name init');
  // Codex not in use here at all: no store to check against, so nothing is refused.
  assert.equal(boardGuardReady('codex', bare, { ...sandbox.env, HOME: join(makeTempDir('yokoten-board-'), 'no-home') }), null);
  // Grok in use, but no hooks in the worktree: init adds them. An untrusted folder
  // passes: the board starts grok with --trust, which trusts it there.
  mkdirSync(join(sandbox.home, '.grok'), { recursive: true });
  assert.match(boardGuardReady('grok', bare, sandbox.env) ?? '', /yokoten init/);
  grokHooks.addProjectHooks(sandbox.repo, 'bin/yokoten.mjs');
  assert.equal(boardGuardReady('grok', sandbox.repo, sandbox.env), null);
  // Muse in use, but no hooks in the worktree: init adds them.
  mkdirSync(join(sandbox.home, '.config', 'muse'), { recursive: true });
  assert.match(boardGuardReady('muse', bare, sandbox.env) ?? '', /yokoten init/);
});

// #603 findings: YOKOTEN_MODEL alone never reached the CLIs. Every vendor with a
// model flag on record gets it; deepseek-harness keeps the model as a label only.
test('board controls: every vendor starts with a real model flag', () => {
  assert.deepEqual(boardStartParts('claude-code', 'hi', 'model-a'), ['claude', '-p', '--model', 'model-a', 'hi']);
  assert.deepEqual(boardStartParts('codex', 'hi', 'model-a'), ['codex', 'exec', '--model', 'model-a', 'hi']);
  assert.deepEqual(boardStartParts('muse', 'hi', 'model-a'), ['muse', 'exec', '--trust-workspace', '--model', 'model-a', 'hi']);
  assert.deepEqual(boardStartParts('grok', 'hi', 'model-a'), ['grok', '-p', 'hi', '--trust', '--always-approve', '--model', 'model-a']);
  assert.deepEqual(boardStartParts('antigravity', 'hi', 'model-a'), ['agy', '-p', '--model', 'model-a', 'hi']);
  assert.deepEqual(boardStartParts('deepseek-harness', 'hi', 'model-a'), ['dsh', 'headless', '--patch', '.dsh/yokoten.patch.yml', 'hi'], 'no model flag on record: the brief and YOKOTEN_MODEL keep the name');
  assert.ok(!(boardStartParts('grok', 'hi', 'model-a') ?? []).includes('--sandbox'), 'no sandbox profile that does not exist');
});

// #603 findings: an exited process kept status running, leaking its slot and rows.
test('board controls: an exited run frees its slot and answers already-stopped', () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  controls.limits.maxAgents = 1;
  const first = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a' });
  assert.ok(typeof first !== 'string', `the start passes: ${first}`);
  agents.started[0].events.line('guard stopped the push');
  agents.started[0].events.exit(1);
  assert.equal(first.status, 'stopped', 'the exit marks the run stopped');
  assert.equal(first.exitCode, 1);
  assert.ok(first.stoppedAt, 'the exit stamps when it stopped');
  assert.equal(stopBoardAgent(controls, first.name), `${first.name} already stopped`);
  const second = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '13', vendor: 'claude-code', model: 'model-a' });
  assert.ok(typeof second !== 'string', `the slot is free: ${second}`);
  assert.deepEqual(collectBoardWaiting({ repo: 'r', repoName: 'r', repoUrl: '', desk: EMPTY_DESK, agents: [], needs: [], pulls: [], merged: [], worktrees: [], updated: '' }, [], controls.runs, []), [], 'a stopped run clears its rows');
});

// Board hygiene: the start log line holds the whole brief, so it must stay one line.
test('board controls: the log keeps every start on one line', () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const run = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a' });
  assert.ok(typeof run !== 'string', `the start passes: ${run}`);
  const log = readFileSync(join(sandbox.repo, '.yokoten-board.log'), 'utf8');
  assert.equal(log.split('\n').filter((line) => line !== '').length, 1, 'the multi-line brief adds no lines');
  assert.ok(log.includes('Issue: #12'), 'the brief stays readable on the one line');
});

// #682: the board starts a task on an added machine, and its log names the machine only.
test('board controls: start and stop a task on an added machine', () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'https://example.com/acme/repo.git');
  const folder = makeTempDir('second-machine-');
  addMachine(sandbox.env, 'wsl', { folder });
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const scripts: string[] = [];
  const runner: MachineRunner = (_, script) => {
    scripts.push(script);
    return script.includes('kill') ? { code: 0, stdout: 'stopped\n', stderr: '' } : { code: 0, stdout: 'started 71\n', stderr: '' };
  };
  controls.machineRunner = runner;
  const run = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a', machine: 'wsl' });
  assert.ok(typeof run !== 'string', `the start passes: ${run}`);
  assert.equal(run.machine, 'wsl');
  assert.equal(run.pid, 71);
  assert.match(run.name, /wsl/);
  assert.equal(run.worktree, join(folder, 'issue-12'));
  assert.equal(agents.started.length, 0, 'it starts nothing on this machine');
  assert.equal(scripts.length, 1);
  const log = readFileSync(join(sandbox.repo, '.yokoten-board.log'), 'utf8');
  assert.ok(!log.includes(folder), 'the log never holds the target');
  assert.match(log, /on machine wsl/);
  const stopped = stopBoardAgent(controls, run.name);
  assert.ok(typeof stopped !== 'string', `the stop passes: ${stopped}`);
  assert.equal(scripts.length, 2);
  assert.match(scripts[1], /kill/);
  assert.match(startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '13', vendor: 'claude-code', model: 'model-a', machine: 'mac' }) as string, /no machine called mac/);
});

// #682: the engineer limit counts runs on every machine, not just this one.
test('board controls: the engineer limit counts a machine run too', () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'https://example.com/acme/repo.git');
  addMachine(sandbox.env, 'wsl', { folder: makeTempDir('second-machine-'), maxAgents: 2 });
  addMachine(sandbox.env, 'mac', { folder: makeTempDir('second-machine-'), maxAgents: 2 });
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  controls.limits.maxAgents = 1;
  controls.machineRunner = () => ({ code: 0, stdout: 'started 72\n', stderr: '' });
  const first = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a', machine: 'wsl' });
  assert.ok(typeof first !== 'string', `the first start passes: ${first}`);
  const refused = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '13', vendor: 'claude-code', model: 'model-a', machine: 'mac' });
  assert.match(typeof refused === 'string' ? refused : 'started', /already runs 1 agent of 1/, 'the run on wsl counts on the mac too');
});

// #603 re-inspection (L2): the start marked the worktree before the guard check,
// so a refused start left a marked worktree behind. The checks run first now.
test('board controls: a refused start leaves the worktree unmarked', () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.home, '.codex'), { recursive: true });
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const refused = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'codex', model: 'model-a' });
  assert.match(typeof refused === 'string' ? refused : 'started', /yokoten init/, 'the guard refuses the start');
  assert.equal(workerMarkAt(join(sandbox.repo, '.worktrees', '12'), sandbox.env), null, 'no worker mark left behind');
  assert.equal(agents.started.length, 0, 'no process started');
});

// #603 re-inspection (MEDIUM): the worktree was made before the limits check, so a
// refused start left a dir and a branch behind. Limits need no dir, so they run first.
test('board controls: a refused start leaves no worktree behind', () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  controls.limits.maxAgents = 1;
  const first = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a' });
  assert.ok(typeof first !== 'string', `the start passes: ${first}`);
  const refused = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '13', vendor: 'claude-code', model: 'model-a' });
  assert.match(typeof refused === 'string' ? refused : 'started', /already runs/, 'over the limit');
  assert.equal(existsSync(join(sandbox.repo, '.worktrees', '13')), false, 'no dir left behind');
  assert.equal(agents.started.length, 1, 'no process started');
});

// #603 re-inspection (L3): the exit handler never dropped the process handle.
// Stopping already answers already-stopped from the status, so dropping it
// changes no answer.
test('board controls: an exited run drops its process handle', () => {
  const sandbox = makeSandbox();
  const agents = fakeAgents();
  const controls = createBoardControls(join(sandbox.repo, '.yokoten-board.log'), agents.spawner);
  const run = startBoardAgent(sandbox.repo, sandbox.env, controls, { issue: '12', vendor: 'claude-code', model: 'model-a' });
  assert.ok(typeof run !== 'string', `the start passes: ${run}`);
  assert.ok(controls.handles.has(run.name), 'the handle is held while running');
  agents.started[0].events.exit(1);
  assert.ok(!controls.handles.has(run.name), 'the exit drops the handle');
  assert.equal(stopBoardAgent(controls, run.name), `${run.name} already stopped`, 'stopping still answers already-stopped');
});
