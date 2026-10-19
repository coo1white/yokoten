// Tests for src/agents/runtimes/muse.ts.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addProjectHooks, projectHooksState, readToolCall, readTrust } from '../../../src/agents/runtimes/muse.ts';
import { makeSandbox } from '../../repo/helpers.ts';

/** Write Muse's trust store in `home`, in the shape Muse Code 1.4.10 saved it (#341). */
function trustFolder(home: string, ...folders: string[]): string {
  const file = join(home, '.config', 'muse', 'trust.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema_version: 1, projects: Object.fromEntries(folders.map((folder) => [folder, { decision: 'trusted' }])) }, null, 2));
  return file;
}

/** A PreToolUse payload in the shape Muse Code 1.4.10 sent it in a real run (#5). */
const payload = (workspace: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    cwd: workspace,
    hook_event_name: 'PreToolUse',
    model: 'muse-spark-1.3',
    permission_mode: 'default',
    session_id: '0b6f4f0e-3c55-4d7e-9a43-6f2b1d3c9e10',
    transcript_path: null,
    tool_name: name,
    tool_input: input,
    tool_use_id: 'call_1',
    turn_id: 'turn_1',
  });

test('hook --agent muse: bash by command, the edit tools by path; a refusal is exit 2 with the reason on stderr (#5)', () => {
  const sandbox = makeSandbox();
  const call = (name: string, input: Record<string, unknown>, extra?: Record<string, string>) => sandbox.run(['hook', '--agent', 'muse'], { input: payload(sandbox.repo, name, input), extra });
  // The positive control: a tag push, in the shape Muse sends it, is refused.
  let result = call('bash', { command: 'git push --tags origin', description: 'Push tags', workdir: sandbox.repo });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags\. Only the owner decides when to release/);
  result = call('bash', { command: 'git status', description: 'Status', workdir: null });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  // Muse cuts YOKOTEN_ROLE from a hook's env, so a real Muse session is always the lead.
  // Set here by hand, it shows the edit tools' paths reach the lead-only guard.
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const name of ['write_file', 'edit_file', 'apply_patch']) {
    assert.equal(call(name, { path: 'AGENTS.md', content: 'x', find: 'a', replace: 'b' }, worker).status, 2, `${name}: a worker may not edit a lead-only file`);
  }
  assert.equal(call('write_file', { path: '.muse/hooks.json', content: '{}' }, worker).status, 2, "a worker may not turn off Muse's own hook");
  assert.equal(call('write_file', { path: 'src/a.ts', content: 'x' }, worker).status, 0);
  assert.equal(call('edit_file', { path: 'AGENTS.md', find: 'a', replace: 'b' }).status, 0, 'without YOKOTEN_ROLE the session is the lead');
  assert.equal(call('read_file', { path: 'AGENTS.md' }, worker).status, 0, 'reading is not editing');
});

test('muse readToolCall: the cwd is the call\'s workdir, else the session cwd; anything else is no action', () => {
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'bash', { command: 'ls', workdir: '/w/sub' }))), { command: 'ls', paths: [], cwd: '/w/sub', worker: false });
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'bash', { command: 'ls', workdir: null }))), { command: 'ls', paths: [], cwd: '/w', worker: false });
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'edit_file', { path: 'a.md', find: 'x', replace: 'y' }))), { command: undefined, paths: ['a.md'], cwd: '/w', worker: false });
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'read_skill', { path: 'a.md' }))), { command: undefined, paths: [], cwd: '/w', worker: false });
  for (const input of [null, 'x', [], { tool_input: 'x' }, { tool_name: 'bash', tool_input: [] }]) {
    assert.deepEqual(readToolCall(input), { command: undefined, paths: [], cwd: undefined, worker: false });
  }
});

test('muse project hooks: init writes the guard and the stop check, keeps other hooks, and doctor notes them', () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.muse', 'hooks.json');
  const cli = '.yokoten/bin/yokoten.ts';
  assert.match(sandbox.run(['doctor']).stdout, /note +muse-hook: no tool-call guard or stop check in \.muse\/hooks\.json/, 'reported, not counted as missing');
  sandbox.write('.muse/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: './lint.sh' }] }] } }));
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the Muse Code tool-call hook in \.muse\/hooks\.json/);
  assert.match(result.stdout, /added the Muse Code stop check in \.muse\/hooks\.json/);
  assert.match(result.stdout, /Muse Code runs the hooks in \.muse\/hooks\.json only after you trust this folder/);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.hooks.PreToolUse.length, 2, "another hook's group stays");
  assert.equal(written.hooks.PreToolUse[1].matcher, 'bash|write_file|edit_file|apply_patch', 'named tools: "*" would also match read_skill');
  assert.match(written.hooks.PreToolUse[1].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.yokoten\/bin\/yokoten\.ts" hook --agent muse 2>&1/);
  assert.match(written.hooks.Stop[0].hooks[0].command, /hook --stop --agent muse$/);
  assert.deepEqual(projectHooksState(sandbox.repo, cli), { guard: 'same', stop: 'same' });
  // The hooks are in place, but this home has no trust store: never ok (#341).
  assert.match(sandbox.run(['doctor']).stdout, /note +muse-hook: can't check whether Muse Code trusts this folder/);
  trustFolder(sandbox.home, realpathSync(sandbox.repo));
  assert.match(sandbox.run(['doctor']).stdout, /ok +muse-hook/);
  assert.match(sandbox.run(['init']).stdout, /same the Muse Code tool-call hook/);
  written.hooks.Stop[0].hooks[0].command = 'node old/yokoten.ts hook --stop --agent muse';
  sandbox.write('.muse/hooks.json', JSON.stringify(written));
  assert.equal(projectHooksState(sandbox.repo, cli).stop, 'updated');
  assert.match(sandbox.run(['doctor']).stdout, /note +muse-hook: the hooks in \.muse\/hooks\.json are out of date/);
  assert.deepEqual(addProjectHooks(sandbox.repo, cli), { guard: 'same', stop: 'updated' });
  sandbox.write('.muse/hooks.json', '{ not json');
  assert.match(sandbox.run(['doctor']).stdout, /note +muse-hook: can't read \.muse\/hooks\.json/);
  assert.throws(() => addProjectHooks(sandbox.repo, cli), /can't read/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a file yokoten cannot read stays as it was');
});

test('muse trust (#341): doctor says when Muse skips the hooks; ok only when trust.json names the folder', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const root = realpathSync(sandbox.repo);
  const doctor = () => sandbox.run(['doctor']).stdout;
  assert.match(doctor(), /note +muse-hook: can't check whether Muse Code trusts this folder: no ~\/\.config\/muse\/trust\.json; if you use Muse Code: run `muse` in this folder and choose "Trust and continue"/);
  // The positive control: a store that trusts another folder.
  const file = trustFolder(sandbox.home, '/somewhere/else');
  assert.match(doctor(), /note +muse-hook: Muse Code skips \.muse\/hooks\.json until you trust this folder; run `muse` in this folder and choose "Trust and continue"/);
  // Checked with Muse 1.4.10: a trusted parent folder, or the key with a trailing slash, trusts nothing.
  trustFolder(sandbox.home, dirname(root), `${root}/`);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted');
  trustFolder(sandbox.home, root);
  assert.match(doctor(), /ok +muse-hook\n/);
  // Another decision, a file that won't parse, and a schema doctor does not know: never ok.
  writeFileSync(file, JSON.stringify({ schema_version: 1, projects: { [root]: { decision: 'untrusted' } } }));
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted');
  writeFileSync(file, '{ not json');
  assert.match(doctor(), /note +muse-hook: can't check whether Muse Code trusts this folder: can't read ~\/\.config\/muse\/trust\.json/);
  writeFileSync(file, JSON.stringify({ schema_version: 2, projects: { [root]: { decision: 'trusted' } } }));
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'unreadable');
  // XDG_CONFIG_HOME moves the store: the one under ~/.config no longer counts. The note names the variable, not the path.
  trustFolder(sandbox.home, root);
  assert.deepEqual(readTrust(root, { HOME: sandbox.home, XDG_CONFIG_HOME: join(sandbox.home, 'xdg') }), { state: 'no store', store: '$XDG_CONFIG_HOME/muse/trust.json' });
});
