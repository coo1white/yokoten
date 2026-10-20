// Tests for src/agents/runtimes/deepseek-harness.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addProjectHooks, initLines, PATCH, profilesWithBridge, projectHooksState, readToolCall, WINDOWS_GAP } from '../../../src/agents/runtimes/deepseek-harness.ts';
import { agentHooks } from '../../../src/setup/doctor.ts';
import { makeSandbox } from '../../repo/helpers.ts';

/** A PreToolUse payload in the shape the dsh 0.2.1-rc.2 hook bridge sent it in a real run (#334). */
const payload = (cwd: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    session_id: 'session-4d2c6add-7dbf-4ca4-8360-8ae87adbbb6f',
    transcript_path: '',
    hook_event_name: 'PreToolUse',
    tool_name: name,
    tool_input: input,
    tool_use_id: 'call_00_JLrWRt1veZZXcI6kbmvs8106',
    cwd,
  });

test('hook --agent deepseek-harness: lowercase bash by command, write and edit by a file_path relative to cwd; a refusal is exit 2 with the reason on stderr (#334)', () => {
  const sandbox = makeSandbox();
  const call = (name: string, input: Record<string, unknown>, extra?: Record<string, string>, cwd = sandbox.repo) =>
    sandbox.run(['hook', '--agent', 'deepseek-harness'], { input: payload(cwd, name, input), extra });
  // The positive control: a tag push, in the shape dsh sends it, is refused.
  let result = call('bash', { command: 'git push --tags origin', description: 'Push all tags to origin' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '', 'the bridge reads the reason from stderr');
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags\. Only the owner decides when to release/);
  assert.equal(call('pwsh', { command: 'git push --tags origin' }).status, 2, 'the Windows shell too');
  result = call('bash', { command: 'git status', description: 'Status' });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  // dsh sends no agent_type: YOKOTEN_ROLE, which reaches the hook, tells a worker.
  const worker = { YOKOTEN_ROLE: 'worker' };
  assert.equal(call('edit', { file_path: 'AGENTS.md', old_string: 'a', new_string: 'b' }, worker).status, 2, 'a worker may not edit a lead-only file');
  assert.equal(call('write', { file_path: 'AGENTS.md', content: 'x' }, worker).status, 2);
  assert.equal(call('write', { file_path: '.dsh/hooks.json', content: '{}' }, worker).status, 2, "a worker may not turn off dsh's own hook");
  // file_path is relative to cwd: from a subfolder, ../.dsh/hooks.json is the root one, and .dsh/hooks.json is not.
  const sub = join(sandbox.repo, 'src');
  mkdirSync(sub, { recursive: true });
  assert.equal(call('edit', { file_path: '../.dsh/hooks.json', old_string: 'a', new_string: 'b' }, worker, sub).status, 2, 'resolved against cwd');
  assert.equal(call('edit', { file_path: '.dsh/hooks.json', old_string: 'a', new_string: 'b' }, worker, sub).status, 0, 'src/.dsh/hooks.json is not lead-only');
  assert.equal(call('write', { file_path: 'src/a.ts', content: 'x' }, worker).status, 0);
  assert.equal(call('edit', { file_path: 'AGENTS.md', old_string: 'a', new_string: 'b' }).status, 0, 'without YOKOTEN_ROLE the session is the lead');
});

test('deepseek-harness readToolCall: the fields, not the name; anything else is no action', () => {
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'bash', { command: 'ls', description: 'x' }))), { command: 'ls', paths: [], cwd: '/w', worker: false });
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'edit', { file_path: 'a.md', old_string: 'x', new_string: 'y' }))), { command: undefined, paths: ['a.md'], cwd: '/w', worker: false });
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'read', { query: 'x' }))), { command: undefined, paths: [], cwd: '/w', worker: false });
});

test('deepseek-harness project files: init writes the guard and the launch patch, keeps other hooks, and doctor says only a real deny proves it', () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.dsh', 'hooks.json');
  const cli = '.yokoten/bin/yokoten.mjs';
  const dshHome = join(sandbox.home, 'dsh-home');
  const doctor = () => sandbox.run(['doctor'], { extra: { DSH_HOME: dshHome } }).stdout;
  assert.match(doctor(), /note +deepseek-harness-hook: no tool-call guard in \.dsh\/hooks\.json/, 'reported, not counted as missing');
  sandbox.write('.dsh/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: './lint.sh' }] }] } }));
  const result = sandbox.run(['init'], { extra: { DSH_HOME: dshHome } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the DeepSeek Harness tool-call hook in \.dsh\/hooks\.json/);
  assert.match(result.stdout, /added the DeepSeek Harness launch patch in \.dsh\/yokoten\.patch\.yml/);
  assert.match(result.stdout, /dsh plugin --profile <profile> add @deepseek-ai\/dsh-hooks-claude-code@0\.2\.1-rc\.2 && dsh plugin --profile <profile> add @deepseek-ai\/dsh-hook-protocol@0\.2\.1-rc\.2/);
  assert.match(result.stdout, /dsh <profile> --patch \.dsh\/yokoten\.patch\.yml/);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(written.hooks), ['PreToolUse'], 'no Stop hook: the bridge sends it back with no loop guard');
  assert.equal(written.hooks.PreToolUse.length, 2, "another hook's group stays");
  assert.equal(written.hooks.PreToolUse[1].matcher, 'bash|pwsh|edit|write', 'dsh matches the lowercase names exactly');
  assert.match(written.hooks.PreToolUse[1].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.yokoten\/bin\/yokoten\.mjs" hook --agent deepseek-harness 2>&1/);
  const patch = readFileSync(join(sandbox.repo, '.dsh', 'yokoten.patch.yml'), 'utf8');
  assert.equal(patch, PATCH);
  assert.match(patch, /^- insert:\n {4}- id: hooks-claude-code\n {6}name: '@deepseek-ai\/dsh-hooks-claude-code'\n {6}config:\n {8}configPath: \.dsh\/hooks\.json\n$/m);
  assert.deepEqual(projectHooksState(sandbox.repo, cli), { guard: 'same', patch: 'same' });
  assert.match(sandbox.run(['init']).stdout, /same the DeepSeek Harness tool-call hook/);
  // The bridge in the profile: can't check without a dsh home, never "done".
  assert.match(doctor(), /note +deepseek-harness-hook: can't check the bridge: no dsh home/);
  const modules = join(dshHome, 'profiles', 'tui', 'node_modules', '@deepseek-ai');
  mkdirSync(join(modules, 'dsh-hooks-claude-code'), { recursive: true });
  writeFileSync(join(modules, 'dsh-hooks-claude-code', 'package.json'), '{}');
  assert.match(doctor(), /note +deepseek-harness-hook: no dsh profile has the bridge and its peer/, 'without the peer, dsh runs no hooks');
  mkdirSync(join(modules, 'dsh-hook-protocol'));
  writeFileSync(join(modules, 'dsh-hook-protocol', 'package.json'), '{}');
  assert.deepEqual(profilesWithBridge({ DSH_HOME: dshHome }), { found: ['tui'], all: ['tui'] });
  assert.match(doctor(), /ok +deepseek-harness-hook: the bridge is in profile tui; .*Only a real deny proves it/);
  // Out of date, then a file init can't edit.
  writeFileSync(join(sandbox.repo, '.dsh', 'yokoten.patch.yml'), '[]\n');
  assert.match(doctor(), /note +deepseek-harness-hook: \.dsh\/yokoten\.patch\.yml is out of date/);
  assert.deepEqual(addProjectHooks(sandbox.repo, cli), { guard: 'same', patch: 'updated' });
  sandbox.write('.dsh/hooks.json', '{ not json');
  assert.match(doctor(), /note +deepseek-harness-hook: can't read \.dsh\/hooks\.json/);
  assert.throws(() => addProjectHooks(sandbox.repo, cli), /can't read/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a file yokoten cannot read stays as it was');
});

test('deepseek-harness on Windows: dsh runs hooks in PowerShell, so doctor notes it is not checked, never ok, and init says the same (#332)', () => {
  const sandbox = makeSandbox();
  const dshHome = join(sandbox.home, 'dsh-home');
  const modules = join(dshHome, 'profiles', 'tui', 'node_modules', '@deepseek-ai');
  for (const pkg of ['dsh-hooks-claude-code', 'dsh-hook-protocol']) {
    mkdirSync(join(modules, pkg), { recursive: true });
    writeFileSync(join(modules, pkg, 'package.json'), '{}');
  }
  addProjectHooks(sandbox.repo, '.yokoten/bin/yokoten.mjs');
  const dshCheck = (platform: string) => agentHooks(sandbox.repo, { DSH_HOME: dshHome }, platform).find((p) => p.name === 'deepseek-harness-hook');
  const windows = dshCheck('win32');
  assert.equal(windows?.ok, false, 'files and bridge in place, but PowerShell cannot run the guard');
  assert.equal(windows?.finding.what, "DeepSeek Harness runs hooks in PowerShell on Windows, and yokoten's guard is a POSIX shell command, so dsh's calls are not checked on Windows yet (issue #332)");
  assert.equal(windows?.detail, undefined);
  const linux = dshCheck('linux');
  assert.equal(linux?.ok, true, 'unchanged off Windows');
  assert.match(linux?.detail ?? '', /the bridge is in profile tui; .*Only a real deny proves it/);
  const added = { guard: 'same', patch: 'same' } as const;
  const onWindows = initLines(added, 'win32');
  assert.equal(onWindows.at(-1), WINDOWS_GAP);
  assert.ok(!onWindows.some((line) => /dsh plugin|--patch/.test(line)), 'no steps that imply a guard');
  assert.match(initLines(added, 'linux').join('\n'), /dsh plugin --profile <profile> add .*\n.*dsh <profile> --patch \.dsh\/yokoten\.patch\.yml/);
});
