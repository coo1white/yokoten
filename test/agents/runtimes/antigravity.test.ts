// Tests for src/agents/runtimes/antigravity.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addProjectHook, projectHookState, readToolCall } from '../../../src/agents/runtimes/antigravity.ts';
import { makeSandbox } from '../../repo/helpers.ts';

/** A PreToolUse payload as agy 1.4.2 sent it in a real run (#30): camelCase, the call under `toolCall`. */
const payload = (workspace: string, name: string, args: Record<string, unknown>) =>
  JSON.stringify({
    toolCall: { name, args },
    stepIdx: 2,
    conversationId: '356a1164-dcc9-4ae7-bf64-87c7f6ddf1e5',
    workspacePaths: [workspace],
    transcriptPath: join(workspace, 'transcript.jsonl'),
    artifactDirectoryPath: workspace,
    modelName: 'gemini-3.8-flash-high',
  });

test('hook --agent antigravity: run_command by CommandLine, the edit tools by TargetFile; a refusal is a deny decision on stdout (#30)', () => {
  const sandbox = makeSandbox();
  const call = (name: string, args: Record<string, unknown>, extra?: Record<string, string>) => sandbox.run(['hook', '--agent', 'antigravity'], { input: payload(sandbox.repo, name, args), extra });
  // The positive control: a tag push, in the shape agy sends it, is refused.
  let result = call('run_command', { CommandLine: 'git push --tags origin', Cwd: sandbox.repo, WaitMsBeforeAsync: 5000, toolAction: 'Pushing git tags', toolSummary: 'Git push tags' });
  assert.equal(result.status, 0, 'agy reads the decision, not the exit code');
  const denial = JSON.parse(result.stdout);
  assert.equal(denial.decision, 'deny');
  assert.match(denial.reason, /^yokoten: git push --tags pushes tags\. Only the owner decides when to release/);
  assert.match(result.stderr, /owner decides when to release/);
  result = call('run_command', { CommandLine: 'git status', Cwd: sandbox.repo });
  assert.deepEqual([result.status, result.stdout], [0, ''], 'an allowed call leaves stdout empty: agy goes on');
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const name of ['write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
    assert.equal(JSON.parse(call(name, { TargetFile: join(sandbox.repo, 'AGENTS.md') }, worker).stdout).decision, 'deny', `${name}: a worker may not edit a lead-only file`);
  }
  assert.equal(JSON.parse(call('write_to_file', { TargetFile: join(sandbox.repo, '.agents', 'hooks.json') }, worker).stdout).decision, 'deny', "a worker may not turn off agy's own hook");
  assert.equal(call('write_to_file', { TargetFile: join(sandbox.repo, 'src', 'a.ts') }, worker).stdout, '');
  assert.equal(call('view_file', { AbsolutePath: join(sandbox.repo, 'AGENTS.md') }, worker).stdout, '', 'reading is not editing');
  // --json keeps its own contract: the result on stdout, exit 2 on a block.
  result = sandbox.run(['hook', '--agent', 'antigravity', '--json'], { input: payload(sandbox.repo, 'run_command', { CommandLine: 'git push --tags' }) });
  assert.deepEqual([result.status, JSON.parse(result.stdout).blocked], [2, true]);
});

test('antigravity readToolCall: the cwd is the call\'s Cwd, else the first workspace; anything else is no action', () => {
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'run_command', { CommandLine: 'ls', Cwd: '/w/sub' }))), { command: 'ls', paths: [], cwd: '/w/sub', worker: false });
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'replace_file_content', { TargetFile: 'a.md' }))), { command: undefined, paths: ['a.md'], cwd: '/w', worker: false });
  for (const input of [null, 'x', [], { toolCall: 'x' }, { toolCall: { name: 'run_command', args: [] } }]) {
    assert.deepEqual(readToolCall(input), { command: undefined, paths: [], cwd: undefined, worker: false });
  }
});

test('antigravity project hook: init writes the yokoten entry, keeps the others, and turns an old or disabled one back on', () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.agents', 'hooks.json');
  const cli = '.yokoten/bin/yokoten.ts';
  assert.equal(projectHookState(sandbox.repo, cli), 'added');
  sandbox.write('.agents/hooks.json', JSON.stringify({ lint: { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } }));
  assert.equal(addProjectHook(sandbox.repo, cli), 'added');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(written), ['lint', 'yokoten'], "another hook's entry stays");
  assert.equal(written.yokoten.PreToolUse[0].matcher, 'run_command|write_to_file|replace_file_content|multi_replace_file_content');
  assert.match(written.yokoten.PreToolUse[0].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.yokoten\/bin\/yokoten\.ts" hook --agent antigravity/);
  assert.equal(addProjectHook(sandbox.repo, cli), 'same');
  sandbox.write('.agents/hooks.json', JSON.stringify({ yokoten: { ...written.yokoten, enabled: false } }));
  assert.equal(projectHookState(sandbox.repo, cli), 'updated', 'a disabled guard is not the guard');
  assert.equal(addProjectHook(sandbox.repo, cli), 'updated');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).yokoten.enabled, undefined);
  sandbox.write('.agents/hooks.json', '{ not json');
  assert.deepEqual(projectHookState(sandbox.repo, cli), { kind: 'json' });
  assert.throws(() => addProjectHook(sandbox.repo, cli), /can't read/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a file yokoten cannot read stays as it was');
  sandbox.write('.agents/hooks.json', '{ "yokoten": [] }');
  assert.deepEqual(projectHookState(sandbox.repo, cli), { kind: 'shape', hint: '`yokoten` should be an object' });
});
