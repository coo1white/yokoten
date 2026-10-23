// Tests for src/commands/advice/board/feed/items.ts: one line of a runtime's log as items.
// tail.test.ts reads whole logs of each runtime into the same list.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeItems, codexItems, cut, describeCall, grokItems, museItems } from '../../../../../src/commands/advice/board/feed/items.ts';

const TREE = '/work/repo';

test('board stream: a call reads in a few words, and the whole call opens on click', () => {
  assert.equal(describeCall('Bash', { command: 'npm test\nmore', description: '' }, TREE), 'npm test');
  assert.equal(describeCall('Edit', { file_path: `${TREE}/src/b.ts` }, TREE), 'changed src/b.ts');
  assert.equal(describeCall('Grep', { pattern: 'feed' }, TREE), 'searched for feed');
  assert.equal(describeCall('subagent_wait', {}, TREE), 'subagent wait');
  const [call] = claudeItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: 'a', old_string: 'x' } }] } }, TREE);
  assert.match(call.full ?? '', /^Edit \{\n {2}"file_path": "a",/);
  assert.match(cut('x'.repeat(10), 4), /^xxxx\n… \(6 more characters\)$/);
  // A guard's refusal stands out from the other output.
  const [stop] = claudeItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'yokoten: `rm -rf` is blocked in this project.' }] } }, TREE);
  assert.equal(stop.kind, 'stop');
  assert.deepEqual(museItems('not a record', TREE), []);
  assert.deepEqual(grokItems({ type: 'user', content: 'the task' }, TREE), [], 'the prompts stay out');
  const [failed] = claudeItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'no such file' }] } }, TREE);
  assert.equal(failed.isFailed, true, 'a failed result marks the step');
  assert.equal(stop.isFailed, undefined, 'a guard stop stays its own block');
});

// #698: Codex is a guess. A response item becomes the same kinds. An event message is not shown twice.
test('board stream: a Codex rollout maps onto the same kinds', () => {
  const at = '2026-10-22T10:00:00.000Z';
  const call = (body: unknown) => ({ timestamp: at, type: 'response_item', payload: body });
  const items = [
    { timestamp: at, type: 'session_meta', payload: { cwd: TREE } },
    { timestamp: at, type: 'event_msg', payload: { type: 'agent_message', message: 'do not show this twice' } },
    call({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the task' }] }),
    call({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading the issue first.' }] }),
    call({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Look at the issue.' }] }),
    call({ type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'npm test' }) }),
    call({ type: 'function_call_output', call_id: 'c1', output: 'ok' }),
    call({ type: 'function_call', name: 'exec_command', call_id: 'c2', arguments: JSON.stringify({ command: ['git', 'status'] }) }),
    call({ type: 'function_call', name: 'apply_patch', call_id: 'c3', arguments: JSON.stringify({ patch: '*** Update File: src/a.ts\n@@\n-a\n+b' }) }),
    call({ type: 'function_call_output', call_id: 'c3', output: { stdout: 'failed', exit_code: 1 } }),
  ].flatMap((record) => codexItems(record, TREE));
  assert.equal(items.some((item) => item.text.includes('do not show')), false, 'an event message is left out');
  assert.equal(items.some((item) => item.text === 'the task'), false, 'the prompt stays out');
  assert.deepEqual(items.slice(0, 2).map((item) => item.kind), ['say', 'think']);
  const bash = items.find((item) => item.call === 'c1' && item.kind === 'tool');
  assert.equal(bash?.tool, 'Bash');
  assert.equal(bash?.text, 'npm test');
  assert.equal(bash?.isCommand, true);
  const listed = items.find((item) => item.call === 'c2');
  assert.equal(listed?.tool, 'Bash');
  assert.equal(listed?.text, 'git status');
  const edit = items.find((item) => item.call === 'c3' && item.kind === 'tool');
  assert.equal(edit?.tool, 'Edit');
  assert.equal(edit?.text, 'changed src/a.ts');
  assert.match(edit?.full ?? '', /^apply_patch \{\n/);
  const failed = items.find((item) => item.kind === 'result' && item.call === 'c3');
  assert.equal(failed?.isFailed, true);
  assert.equal(failed?.text, 'failed');
});
