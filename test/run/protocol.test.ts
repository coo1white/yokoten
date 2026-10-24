// Tests for src/run/protocol.ts: the guard protocol (#898). One fixed call any agent tool
// can send, one fixed answer, and the conformance test a toolkit runs against its own
// integration. The OpenCode adapter sends this protocol end to end.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { adapterFor } from '../../src/agents/runtimes/runtime.ts';
import { pluginSource } from '../../src/agents/runtimes/small/opencode.ts';
import { stopsFile } from '../../src/rules/guards.ts';
import {
  checkGuardIntegration,
  CONFORMANCE_CASES,
  type GuardInput,
  type GuardOutput,
  GUARD_PROTOCOL_ID,
  parseGuardInput,
  readGuardInput,
  toGuardInput,
} from '../../src/run/protocol.ts';
import { makeSandbox } from '../repo/helpers.ts';

const call = (over: Partial<GuardInput> = {}): GuardInput => ({
  protocol: GUARD_PROTOCOL_ID,
  action: { command: 'git status' },
  role: 'lead',
  project: '/repo',
  ...over,
});

/** The guard protocol through the command line, as an integration sends it. */
const runProtocol = async (input: GuardInput): Promise<GuardOutput> => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['hook', '--protocol'], { input: JSON.stringify(input), cwd: sandbox.repo });
  assert.ok(result.status === 0 || result.status === 2, result.stderr);
  return JSON.parse(result.stdout) as GuardOutput;
};

test('protocol: the fixed call is read, and every wrong shape says what is wrong', () => {
  assert.deepEqual(readGuardInput(call()), call());
  assert.deepEqual(readGuardInput(call({ action: { paths: ['src/a.ts'] } })), call({ action: { paths: ['src/a.ts'] } }));
  const problems = [
    readGuardInput({ ...call(), protocol: 'yokoten-guard/2' }),
    readGuardInput({ ...call(), action: {} }),
    readGuardInput({ ...call(), role: 'owner' }),
    readGuardInput({ ...call(), project: 'repo' }),
    readGuardInput({ ...call(), action: { commands: [] } }),
    readGuardInput({ ...call(), action: { paths: [3] } }),
    readGuardInput('not an object'),
  ];
  for (const problem of problems) assert.equal(typeof problem, 'string', JSON.stringify(problem));
  assert.equal(parseGuardInput('{'), 'the input must be JSON');
});

test('conformance: yokoten\'s own command line passes every case any tool runs', async () => {
  const failures: string[] = [];
  for (const item of CONFORMANCE_CASES) {
    const answer = await runProtocol(item.input);
    if (answer.protocol !== GUARD_PROTOCOL_ID) failures.push(`${item.name}: wrong protocol`);
    if (answer.decision !== item.decision) failures.push(`${item.name}: ${answer.decision}, not ${item.decision}`);
    if (item.id !== undefined && answer.reason?.id !== item.id) failures.push(`${item.name}: ${String(answer.reason?.id)}, not ${item.id}`);
    assert.equal(answer.reason === undefined, item.decision === 'allow', `${item.name}: a reason is there exactly when the guard does not allow`);
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(await checkGuardIntegration(runProtocol), []);
});

test('conformance: the check catches an integration that drifts, and a wrong version is refused', async () => {
  const lie = async (): Promise<GuardOutput> => ({ protocol: GUARD_PROTOCOL_ID, decision: 'allow' });
  const failures = await checkGuardIntegration(lie);
  for (const item of CONFORMANCE_CASES.filter((entry) => entry.decision !== 'allow')) {
    assert.ok(failures.some((line) => line.startsWith(item.name)), `${item.name}: the drift went unseen`);
  }
  const wrongVersion = await runProtocol({ ...call(), protocol: 'yokoten-guard/2' as typeof GUARD_PROTOCOL_ID });
  assert.equal(wrongVersion.decision, 'refuse');
  assert.equal(wrongVersion.reason?.id, 'unreadable-protocol');
});

test('protocol: a refusal names the tool in the stop log, and carries the four parts', async () => {
  const sandbox = makeSandbox();
  const input = { ...call(), action: { tool: 'shell', command: 'git push --force origin main' }, project: sandbox.repo };
  const result = await sandbox.call(['hook', '--protocol'], { input: JSON.stringify(input), cwd: sandbox.repo });
  assert.equal(result.status, 2);
  const answer = JSON.parse(result.stdout) as GuardOutput;
  assert.equal(answer.decision, 'refuse');
  assert.equal(answer.reason?.id, 'force-push');
  assert.match(answer.reason?.message ?? '', /^yokoten stopped this: .+\nWhy: .+\nDo instead: .+\nMore: /);
  const file = stopsFile(sandbox.env);
  assert.ok(file);
  const line = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1) ?? '{}') as { vendor: string; rule: string; answer: string };
  assert.equal(line.vendor, 'protocol:shell');
  assert.equal(line.rule, 'force-push');
  assert.equal(line.answer, 'refused');
});

test('conformance: the OpenCode adapter is a thin translation into the protocol', async () => {
  const adapter = adapterFor('opencode');
  assert.ok(adapter);
  const sandbox = makeSandbox();
  const through = async (input: unknown, role: 'lead' | 'worker' = 'lead'): Promise<GuardOutput> => {
    const action = adapter.readToolCall(input);
    const answer = await sandbox.call(['hook', '--protocol'], { input: JSON.stringify(toGuardInput(action, role, sandbox.repo)), cwd: sandbox.repo });
    return JSON.parse(answer.stdout) as GuardOutput;
  };
  const push = await through(adapter.call('git push --force origin main'));
  assert.equal(push.decision, 'refuse');
  assert.equal(push.reason?.id, 'force-push');
  assert.equal((await through(adapter.call('git status'))).decision, 'allow');
  const edit = await through({ tool: 'edit', args: { filePath: '.git/config' }, directory: sandbox.repo }, 'worker');
  assert.equal(edit.decision, 'refuse');
  assert.equal(edit.reason?.id, 'worker-mark');
});

test('conformance: the OpenCode plugin sends the protocol, and reads its answer', () => {
  const source = pluginSource('true');
  assert.ok(source.includes(GUARD_PROTOCOL_ID), 'the plugin does not name the protocol version');
  assert.ok(source.includes("answer.decision === 'refuse'"), 'the plugin does not read the decision');
  assert.ok(source.includes('answer.reason'), 'the plugin does not read the reason');
});
