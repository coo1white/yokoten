// Tests for src/agents/runtimes/gemini.ts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';

test('hook --agent gemini: run_shell_command by command, write_file and replace by file_path (#30)', () => {
  const sandbox = makeSandbox();
  const call = (tool_name: string, tool_input: object, extra?: Record<string, string>) =>
    sandbox.run(['hook', '--agent', 'gemini'], {
      input: JSON.stringify({
        session_id: 's1',
        transcript_path: join(sandbox.home, 't.json'),
        cwd: sandbox.repo,
        hook_event_name: 'BeforeTool',
        timestamp: '2026-10-18T00:00:00Z',
        tool_name,
        tool_input,
      }),
      extra,
    });
  let result = call('run_shell_command', { command: 'git push --tags', description: 'push tags' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /owner decides when to release/);
  assert.equal(result.stdout, '', 'Gemini CLI reads stdout as JSON: nothing else goes there');
  assert.equal(call('run_shell_command', { command: 'git status' }).status, 0);
  const worker = { YOKOTEN_ROLE: 'worker' };
  result = call('write_file', { file_path: join(sandbox.repo, 'AGENTS.md'), content: 'x' }, worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal(call('replace', { file_path: '.gemini/settings.json', instruction: 'i', old_string: 'a', new_string: 'b' }, worker).status, 2);
  assert.equal(call('write_file', { file_path: 'src/a.ts', content: 'x' }, worker).status, 0);
  assert.equal(call('read_file', { file_path: 'AGENTS.md' }, worker).status, 0, 'reading is not editing');
  assert.equal(call('write_file', { file_path: 'AGENTS.md', content: 'x' }).status, 0, 'the lead may');
  result = sandbox.run(['hook', '--agent', 'cursor'], { input: '{}' });
  assert.equal(result.status, 1, 'an unknown agent is an error to see, not a block');
  assert.match(result.stderr, /claude-code, codex, gemini/);
});
