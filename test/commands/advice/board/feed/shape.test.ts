// Tests for src/commands/advice/board/feed/shape.ts: the one shape every vendor maps onto.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commonTool, TOOL_NAMES } from '../../../../../src/commands/advice/board/feed/shape.ts';

test('board stream shape: one set of tool names, and the first match wins', () => {
  assert.deepEqual([...TOOL_NAMES], ['Bash', 'Read', 'Edit', 'Write', 'Search', 'Web', 'Agent', 'Other']);
  assert.equal(commonTool('exec_command'), 'Bash');
  assert.equal(commonTool('run_terminal_command'), 'Bash');
  assert.equal(commonTool('Bash'), 'Bash');
  assert.equal(commonTool('web_search'), 'Web');
  assert.equal(commonTool('search_replace'), 'Edit', 'edit wins over a name that also says search');
  assert.equal(commonTool('apply_patch'), 'Edit');
  assert.equal(commonTool('grep'), 'Search');
  assert.equal(commonTool('write_file'), 'Write');
  assert.equal(commonTool('read_file'), 'Read');
  assert.equal(commonTool('spawn_subagent'), 'Agent');
  assert.equal(commonTool('todo'), 'Other');
});
