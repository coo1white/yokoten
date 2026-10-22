// Tests for src/agents/runtimes/gemini.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addProjectSandbox, SANDBOX_HAND_ADD, sandboxProblem } from '../../../src/agents/runtimes/gemini.ts';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { addProjectStopHook, projectHooksState } from '../../../src/agents/runtimes/gemini.ts';

test('hook --agent gemini: run_shell_command by command, write_file and replace by file_path (#30)', async () => {
  const sandbox = makeSandbox();
  const call = (tool_name: string, tool_input: object, extra?: Record<string, string>) =>
    sandbox.call(['hook', '--agent', 'gemini'], {
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
  let result = await call('run_shell_command', { command: 'git push --tags', description: 'push tags' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /owner decides when to release/);
  assert.equal(result.stdout, '', 'Gemini CLI reads stdout as JSON: nothing else goes there');
  assert.equal((await call('run_shell_command', { command: 'git status' })).status, 0);
  const worker = { YOKOTEN_ROLE: 'worker' };
  result = await call('write_file', { file_path: join(sandbox.repo, 'AGENTS.md'), content: 'x' }, worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal((await call('replace', { file_path: '.gemini/settings.json', instruction: 'i', old_string: 'a', new_string: 'b' }, worker)).status, 2);
  assert.equal((await call('write_file', { file_path: 'src/a.ts', content: 'x' }, worker)).status, 0);
  assert.equal((await call('read_file', { file_path: 'AGENTS.md' }, worker)).status, 0, 'reading is not editing');
  assert.equal((await call('write_file', { file_path: 'AGENTS.md', content: 'x' })).status, 0, 'the lead may');
  result = await sandbox.call(['hook', '--agent', 'cursor'], { input: '{}' });
  assert.equal(result.status, 1, 'an unknown agent is an error to see, not a block');
  assert.match(result.stderr, /claude-code, codex, gemini/);
});

// ---- The project's sandbox (#589) ----

/** A project folder with `.gemini/settings.json` holding `settings`, as text or an object. */
function settingsProject(settings: string | object): string {
  const root = makeTempDir('yokoten-gemini-');
  mkdirSync(join(root, '.gemini'), { recursive: true });
  writeFileSync(join(root, '.gemini', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  return root;
}

test('sandbox write: the YOLO block is added, or handed to the user when the file has comments', () => {
  const root = makeTempDir('yokoten-gemini-');
  assert.equal(addProjectSandbox(root), 'added');
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf8')).security, { disableYoloMode: true });
  assert.equal(addProjectSandbox(root), 'same');
  // The key joins a security block already there; `false` stays, as the user's own.
  const partial = settingsProject({ security: { other: 1 } });
  assert.equal(addProjectSandbox(partial), 'added');
  assert.deepEqual(JSON.parse(readFileSync(join(partial, '.gemini', 'settings.json'), 'utf8')).security, { other: 1, disableYoloMode: true });
  assert.equal(addProjectSandbox(settingsProject({ security: { disableYoloMode: false } })), 'kept');
  // Comments are never rewritten: init prints the block, and the file stays as it was.
  const commented = settingsProject('{\n// mine\n"hooks": {}\n}\n');
  assert.equal(addProjectSandbox(commented), 'hand');
  assert.equal(readFileSync(join(commented, '.gemini', 'settings.json'), 'utf8'), '{\n// mine\n"hooks": {}\n}\n');
  assert.deepEqual(JSON.parse(SANDBOX_HAND_ADD), { security: { disableYoloMode: true } });
  assert.deepEqual(addProjectSandbox(settingsProject('not json {')), { kind: 'json' });
  assert.deepEqual(addProjectSandbox(settingsProject({ security: 'high' })), { kind: 'shape', hint: '`security` should be an object' });
  assert.deepEqual(addProjectSandbox(settingsProject({ hooks: 'x' })), { kind: 'shape', hint: '`hooks` should be an object' });
});

test('sandbox problem: a missing or allowed key, each with its one fix', () => {
  assert.deepEqual(sandboxProblem(makeTempDir('yokoten-gemini-')), { what: 'nothing blocks Gemini YOLO mode in .gemini/settings.json', fix: '`yokoten init` blocks it' });
  assert.equal(sandboxProblem(settingsProject({ security: { disableYoloMode: true } })), null);
  const problem = (settings: string | object) => sandboxProblem(settingsProject(settings));
  assert.deepEqual(problem({ security: { disableYoloMode: false } }), {
    what: 'Gemini YOLO mode is allowed in .gemini/settings.json',
    fix: 'set security.disableYoloMode to true in .gemini/settings.json',
  });
  assert.deepEqual(problem('{\n// mine\n"hooks": {}\n}\n'), {
    what: '.gemini/settings.json has comments and no YOLO block',
    fix: `add ${SANDBOX_HAND_ADD} to .gemini/settings.json by hand`,
  });
  assert.deepEqual(problem('not json {'), { what: "can't read .gemini/settings.json", fix: 'make it valid JSON, then run `yokoten init`' });
  assert.deepEqual(problem({ security: 'high' })?.what, '.gemini/settings.json has an unexpected shape');
  assert.deepEqual(problem({ hooks: 'x' })?.what, '.gemini/settings.json has an unexpected shape');
});

test('gemini stop hook waits 600000 milliseconds, and an old timeout of 600 is updated (#614)', () => {
  const sandbox = makeSandbox();
  const cli = '.yokoten/bin/yokoten.mjs';
  assert.equal(addProjectStopHook(sandbox.repo, cli), 'added');
  const file = join(sandbox.repo, '.gemini', 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8')) as { hooks: { AfterAgent: { hooks: { timeout: number }[] }[] } };
  assert.equal(settings.hooks.AfterAgent[0].hooks[0].timeout, 600_000);
  settings.hooks.AfterAgent[0].hooks[0].timeout = 600;
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  assert.equal(projectHooksState(sandbox.repo, cli).stop, 'updated');
  assert.equal(addProjectStopHook(sandbox.repo, cli), 'updated');
  const again = JSON.parse(readFileSync(file, 'utf8')) as { hooks: { AfterAgent: { hooks: { timeout: number }[] }[] } };
  assert.equal(again.hooks.AfterAgent[0].hooks[0].timeout, 600_000);
});
