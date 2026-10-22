// Tests for src/commands/advice/board/feed/items.ts: one line of a runtime's log as items.
// tail.test.ts reads whole logs of each runtime into the same list.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeItems, cut, describeCall, grokItems, museItems } from '../../../../../src/commands/advice/board/feed/items.ts';

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
});
