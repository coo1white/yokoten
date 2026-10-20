// Tests for src/agents/runtimes/grok.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addProjectHooks, addUserHooks, EDIT_TOOLS, projectHooksState, readStop, readToolCall, readTrust, userHooksState } from '../../../src/agents/runtimes/grok.ts';
import { makeSandbox } from '../../repo/helpers.ts';

// The events Grok CLI 1.0.52 sent its hooks in the real run of #407 (2026-10-20), as
// recorded. Only the placeholders differ: `<repo>` is the throwaway repo, and the
// transcript path is cut to `<transcript>`, since it holds the user's folder names.
const RECORDED = {
  push: {
    hookEventName: 'pre_tool_use',
    sessionId: '01a15a11-55e0-7ae1-9c00-6389bfe5c78f',
    cwd: '<repo>',
    workspaceRoot: '<repo>',
    timestamp: '2026-10-20T16:07:32.978116216+00:00',
    transcriptPath: '<transcript>',
    permissionMode: 'bypassPermissions',
    toolName: 'run_terminal_command',
    toolUseId: 'call-ea5b13bc-90a7-46df-87a3-bc96e8733dbc-0',
    toolInput: { command: 'git push --tags', description: 'Push git tags to the remote' },
    toolInputTruncated: false,
    hook_event_name: 'PreToolUse',
    session_id: '01a15a11-55e0-7ae1-9c00-6389bfe5c78f',
    transcript_path: '<transcript>',
    permission_mode: 'bypassPermissions',
    tool_name: 'run_terminal_command',
    tool_input: { command: 'git push --tags', description: 'Push git tags to the remote' },
    tool_use_id: 'call-ea5b13bc-90a7-46df-87a3-bc96e8733dbc-0',
  },
  ls: {
    hookEventName: 'pre_tool_use',
    sessionId: '01a15a11-a612-7d23-82ce-d95e376fa3bc',
    cwd: '<repo>',
    workspaceRoot: '<repo>',
    timestamp: '2026-10-20T16:07:52.409753666+00:00',
    transcriptPath: '<transcript>',
    permissionMode: 'bypassPermissions',
    toolName: 'run_terminal_command',
    toolUseId: 'call-ef0fb881-cdfc-4f8b-8cd2-1422b4c911c5-0',
    toolInput: { command: 'ls', description: 'List files in the workspace' },
    toolInputTruncated: false,
    hook_event_name: 'PreToolUse',
    session_id: '01a15a11-a612-7d23-82ce-d95e376fa3bc',
    transcript_path: '<transcript>',
    permission_mode: 'bypassPermissions',
    tool_name: 'run_terminal_command',
    tool_input: { command: 'ls', description: 'List files in the workspace' },
    tool_use_id: 'call-ef0fb881-cdfc-4f8b-8cd2-1422b4c911c5-0',
  },
  write: {
    hookEventName: 'pre_tool_use',
    sessionId: '01a15a09-f703-7d60-bf68-e18108cfe1d1',
    cwd: '<repo>',
    workspaceRoot: '<repo>',
    timestamp: '2026-10-20T15:59:28.741421597+00:00',
    transcriptPath: '<transcript>',
    permissionMode: 'bypassPermissions',
    toolName: 'write',
    toolUseId: 'call-55a86bda-469d-425e-8404-015810573ca8-1',
    toolInput: { file_path: '<repo>/note.txt', content: 'hi\n' },
    toolInputTruncated: false,
    hook_event_name: 'PreToolUse',
    session_id: '01a15a09-f703-7d60-bf68-e18108cfe1d1',
    transcript_path: '<transcript>',
    permission_mode: 'bypassPermissions',
    tool_name: 'write',
    tool_input: { file_path: '<repo>/note.txt', content: 'hi\n' },
    tool_use_id: 'call-55a86bda-469d-425e-8404-015810573ca8-1',
  },
  stop: {
    hookEventName: 'stop',
    sessionId: '01a15a11-55e0-7ae1-9c00-6389bfe5c78f',
    cwd: '<repo>',
    workspaceRoot: '<repo>',
    timestamp: '2026-10-20T16:07:38.993513920+00:00',
    transcriptPath: '<transcript>',
    promptId: '06c8eb4b-7e72-4c76-910c-41b76c69213a',
    permissionMode: 'bypassPermissions',
    reason: 'end_turn',
    stopHookActive: false,
    lastAssistantMessage: '`git push --tags` did not run. The yokoten hook blocked it before any tags were pushed.',
    backgroundTasks: [],
    sessionCrons: [],
    hook_event_name: 'Stop',
    session_id: '01a15a11-55e0-7ae1-9c00-6389bfe5c78f',
    transcript_path: '<transcript>',
    permission_mode: 'bypassPermissions',
  },
  shutdown: {
    hookEventName: 'stop',
    sessionId: '01a15a11-55e0-7ae1-9c00-6389bfe5c78f',
    cwd: '<repo>',
    workspaceRoot: '<repo>',
    timestamp: '2026-10-20T16:07:39.466848248+00:00',
    transcriptPath: '<transcript>',
    permissionMode: 'bypassPermissions',
    reason: 'shutdown',
    stopHookActive: false,
    hook_event_name: 'Stop',
    session_id: '01a15a11-55e0-7ae1-9c00-6389bfe5c78f',
    transcript_path: '<transcript>',
    permission_mode: 'bypassPermissions',
  },
};

/** A recorded event with `<repo>` set to `repo`, and the tool call changed by `change`. */
function recorded(name: keyof typeof RECORDED, repo: string, change: (event: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const event = JSON.parse(JSON.stringify(RECORDED[name]).replaceAll('<repo>', repo));
  change(event);
  return event;
}

/** A recorded call with another tool and input, in both spellings, as Grok sends it. */
const withTool = (toolName: string, toolInput: Record<string, unknown>) => (event: Record<string, unknown>) => Object.assign(event, { toolName, toolInput, tool_name: toolName, tool_input: toolInput });

test('hook --agent grok: the recorded tag push is refused, with the whole reason on stdout and exit 2; the recorded ls runs (#407)', () => {
  const sandbox = makeSandbox();
  const call = (event: Record<string, unknown>, extra?: Record<string, string>) => sandbox.run(['hook', '--agent', 'grok'], { input: JSON.stringify(event), extra });
  // The positive control: the call Grok sent for `git push --tags`.
  let result = call(recorded('push', sandbox.repo));
  assert.equal(result.status, 2);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /^yokoten: git push --tags pushes tags\. Only the owner decides when to release[\s\S]*YOKOTEN_RELEASE_APPROVAL=1 grok/);
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags/);
  result = call(recorded('ls', sandbox.repo));
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  // YOKOTEN_ROLE reaches Grok's hooks (seen in the real run): a worker's edit of a lead-only file is refused.
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const [tool, file] of [
    ['write', 'AGENTS.md'],
    ['search_replace', 'AGENTS.md'],
    ['write', '.grok/hooks/yokoten.json'],
  ]) {
    assert.equal(call(recorded('write', sandbox.repo, withTool(tool, { file_path: join(sandbox.repo, file), content: 'x' })), worker).status, 2, `${tool} ${file}: a worker may not change it`);
  }
  assert.equal(call(recorded('write', sandbox.repo), worker).status, 0, 'the recorded write of note.txt is fine');
  assert.equal(call(recorded('write', sandbox.repo, withTool('write', { file_path: 'AGENTS.md', content: 'x' }))).status, 0, 'without YOKOTEN_ROLE the session is the lead');
  assert.equal(call(recorded('write', sandbox.repo, withTool('read_file', { file_path: 'AGENTS.md' })), worker).status, 0, 'reading is not editing');
  // A subagent whose type names a worker is a worker, whatever the session's role.
  assert.equal(call(recorded('write', sandbox.repo, (event) => Object.assign(withTool('write', { file_path: 'AGENTS.md', content: 'x' })(event) as object, { subagentType: 'yokoten:worker' }))).status, 2);
});

test('hook: under Grok, the Claude Code hook still guards, even next to an empty Grok hook file (#407)', () => {
  // A Grok hook can be skipped (an untrusted folder, an empty file a repo commits), so the
  // Claude Code hook that Grok also runs never steps aside for it.
  const sandbox = makeSandbox();
  sandbox.write('.grok/hooks/yokoten.json', '{}');
  const push = JSON.stringify(recorded('push', sandbox.repo));
  const grok = { GROK_HOOK_EVENT: 'pre_tool_use', GROK_SESSION_ID: '01a15a11-55e0-7ae1-9c00-6389bfe5c78f', GROK_WORKSPACE_ROOT: sandbox.repo };
  for (const args of [['hook'], ['hook', '--commands-only']]) {
    const result = sandbox.run(args, { input: push, extra: grok });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^yokoten: git push --tags pushes tags/);
  }
});

test('hook --agent grok: a command that prints the owner\'s details is rewritten with updatedInput, keeping the other fields (#390)', () => {
  const sandbox = makeSandbox();
  const result = sandbox.run(['hook', '--agent', 'grok'], { input: JSON.stringify(recorded('ls', sandbox.repo, withTool('run_terminal_command', { command: 'git log -1', description: 'Show the last commit' }))) });
  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(reply.hookEventName, 'PreToolUse');
  assert.equal(reply.permissionDecision, undefined, 'no decision: the rewrite approves nothing');
  assert.equal(reply.updatedInput.description, 'Show the last commit');
  assert.match(reply.updatedInput.command, /^set -o pipefail # yokoten-redact\n\(\ngit log -1\n\) 2>&1 \| \{ .* redact \|\| cat; \}$/);
  assert.match(reply.additionalContext, /goes through yokoten redact/);
});

test('grok readToolCall: the shell by command, an edit by file, and nothing for a read, a web call or an MCP tool', () => {
  assert.deepEqual(readToolCall(recorded('push', '/w')), { command: 'git push --tags', paths: [], cwd: '/w', worker: false });
  assert.deepEqual(readToolCall(recorded('write', '/w')), { command: undefined, paths: ['/w/note.txt'], cwd: '/w', worker: false });
  assert.deepEqual(readToolCall(recorded('ls', '/w', withTool('run_terminal_command', { command: 'ls', cwd: 'sub' }))), { command: 'ls', paths: [], cwd: '/w/sub', worker: false }, "a shell call's own cwd");
  assert.deepEqual(readToolCall(recorded('ls', '/w', withTool('run_terminal_command', { command: 'ls', cwd: '/elsewhere' }))).cwd, '/elsewhere');
  for (const [tool, input] of [
    ['list_dir', { path: 'AGENTS.md' }],
    ['web_search', { query: 'x' }],
    ['web_fetch', { url: 'https://example.com' }],
    ['read_file', { file_path: 'AGENTS.md' }],
    ['grep', { pattern: 'x', path: 'AGENTS.md' }],
    ['github__create_issue', { title: 'x', path: 'AGENTS.md' }],
  ] as const) {
    assert.deepEqual(readToolCall(recorded('write', '/w', withTool(tool, input))), { command: undefined, paths: [], cwd: '/w', worker: false }, tool);
  }
  // Only the camelCase fields, or only Claude Code's: either is read.
  assert.equal(readToolCall({ toolName: 'run_terminal_command', toolInput: { command: 'ls' } }).command, 'ls');
  assert.equal(readToolCall({ tool_name: 'run_terminal_command', tool_input: { command: 'ls' } }).command, 'ls');
  assert.equal(readToolCall({ toolName: 'write', toolInput: { file_path: 'a' }, subagentType: 'Worker' }).worker, true);
  assert.equal(readToolCall({ toolName: 'write', toolInput: { file_path: 'a' }, subagentType: 'explore' }).worker, false);
  for (const input of [null, 'x', [], { toolInput: 'x' }, { toolName: 'run_terminal_command', toolInput: [] }]) {
    assert.deepEqual(readToolCall(input), { command: undefined, paths: [], cwd: undefined, worker: false });
  }
});

test('grok readToolCall: every edit tool Grok names is read by its file, and the matcher names them all', () => {
  for (const tool of EDIT_TOOLS) {
    assert.deepEqual(readToolCall({ toolName: tool, toolInput: { file_path: '/w/AGENTS.md' }, cwd: '/w' }).paths, ['/w/AGENTS.md'], tool);
  }
  assert.deepEqual(readToolCall({ toolName: 'NotebookEdit', toolInput: { notebook_path: '/w/a.ipynb' }, cwd: '/w' }).paths, ['/w/a.ipynb']);
  assert.deepEqual(readToolCall({ toolName: 'EditNotebook', toolInput: { path: '/w/a.ipynb' }, cwd: '/w' }).paths, ['/w/a.ipynb']);
  const sandbox = makeSandbox();
  addProjectHooks(sandbox.repo, '.yokoten/bin/yokoten.ts');
  const matcher = JSON.parse(readFileSync(join(sandbox.repo, '.grok', 'hooks', 'yokoten.json'), 'utf8')).hooks.PreToolUse[0].matcher.split('|');
  for (const tool of [...EDIT_TOOLS, 'run_terminal_command', 'Bash']) assert.ok(matcher.includes(tool), tool);
  for (const tool of ['read_file', 'list_dir', 'web_search', 'grep']) assert.ok(!matcher.includes(tool), tool);
  // A worker's MultiEdit of a lead-only file is refused end to end.
  const result = sandbox.run(['hook', '--agent', 'grok'], { input: JSON.stringify({ toolName: 'MultiEdit', toolInput: { file_path: join(sandbox.repo, 'AGENTS.md'), edits: [] }, cwd: sandbox.repo }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 2);
});

test('grok readStop: a turn end is checked; the session-end fire only observes, so it is skipped', () => {
  assert.deepEqual(readStop(recorded('stop', '/w')), { cwd: '/w', active: false });
  assert.deepEqual(readStop(recorded('stop', '/w', (event) => Object.assign(event, { stopHookActive: true }))), { cwd: '/w', active: true });
  assert.equal(readStop(recorded('shutdown', '/w')), null);
  assert.equal(readStop(null), null);
  const sandbox = makeSandbox();
  const result = sandbox.run(['hook', '--stop', '--agent', 'grok', '--json'], { input: JSON.stringify(recorded('shutdown', sandbox.repo)) });
  assert.deepEqual([result.status, JSON.parse(result.stdout)], [0, { blocked: false, stop: false }]);
});

/** Write Grok's trust store in `home`, in the shape Grok CLI 1.0.52 saved it (#407). */
function trustFolder(home: string, folders: Record<string, boolean>): string {
  const file = join(home, '.grok', 'trusted_folders.toml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Object.entries(folders).map(([folder, trusted]) => `[folders.${JSON.stringify(folder)}]\ntrusted = ${trusted}\ndecided_at = 1792241026\n`).join('\n'));
  return file;
}

test('grok project hooks: init writes the guard and the stop check, keeps other hooks, says how to trust, and doctor notes them', () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.grok', 'hooks', 'yokoten.json');
  const cli = '.yokoten/bin/yokoten.ts';
  assert.match(sandbox.run(['doctor']).stdout, /note +grok-hook: no tool-call guard or stop check in \.grok\/hooks\/yokoten\.json/, 'reported, not counted as missing');
  sandbox.write('.grok/hooks/yokoten.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] }] } }));
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^added the Grok CLI tool-call hook in \.grok\/hooks\/yokoten\.json$/m);
  assert.match(result.stdout, /^added the Grok CLI stop check in \.grok\/hooks\/yokoten\.json$/m);
  assert.match(result.stdout, /^Grok CLI runs the hooks in \.grok\/hooks\/yokoten\.json only after you trust this folder: run `grok` in this folder and type `\/hooks-trust`$/m);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.hooks.PreToolUse.length, 2, "another hook's group stays");
  const guard = written.hooks.PreToolUse[1];
  assert.equal(guard.matcher, 'Bash|run_terminal_command|Edit|Write|MultiEdit|NotebookEdit|EditNotebook|search_replace|write|write_file', 'the shell and every edit tool Grok names');
  assert.equal(guard.hooks[0].timeout, 60, "Grok's 5-second default would let a slow guard's call through");
  assert.match(guard.hooks[0].command, /node --max-old-space-size=256 "\$GROK_WORKSPACE_ROOT\/\.yokoten\/bin\/yokoten\.ts" hook --agent grok 2>&1/);
  assert.match(written.hooks.Stop[0].hooks[0].command, /"\$GROK_WORKSPACE_ROOT\/\.yokoten\/bin\/yokoten\.ts" hook --stop --agent grok$/);
  assert.equal(written.hooks.Stop[0].hooks[0].timeout, 600, "Grok's own default for Stop");
  assert.deepEqual(projectHooksState(sandbox.repo, cli), { guard: 'same', stop: 'same' });
  // Grok looks unused here: no trust line.
  assert.match(sandbox.run(['doctor']).stdout, /ok +grok-hook: \.grok\/hooks\/yokoten\.json is in place; trust not checked, no ~\/\.grok\n/);
  assert.match(sandbox.run(['init']).stdout, /same the Grok CLI tool-call hook/);
  written.hooks.Stop[0].hooks[0].timeout = 5;
  sandbox.write('.grok/hooks/yokoten.json', JSON.stringify(written));
  assert.equal(projectHooksState(sandbox.repo, cli).stop, 'updated', 'a hook with the default timeout is out of date');
  assert.match(sandbox.run(['doctor']).stdout, /note +grok-hook: the hooks in \.grok\/hooks\/yokoten\.json are out of date/);
  assert.deepEqual(addProjectHooks(sandbox.repo, cli), { guard: 'same', stop: 'updated' });
  sandbox.write('.grok/hooks/yokoten.json', '{ not json');
  assert.match(sandbox.run(['doctor']).stdout, /note +grok-hook: can't read \.grok\/hooks\/yokoten\.json/);
  assert.throws(() => addProjectHooks(sandbox.repo, cli), /can't read/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a file yokoten cannot read stays as it was');
});

test('grok trust: doctor says when Grok skips the hooks; ok only when trusted_folders.toml trusts the folder itself', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const root = realpathSync(sandbox.repo);
  const doctor = () => sandbox.run(['doctor']).stdout;
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'no home');
  mkdirSync(join(sandbox.home, '.grok'));
  assert.match(doctor(), /note +grok-hook: can't check whether Grok CLI trusts this folder: no ~\/\.grok\/trusted_folders\.toml; if you use Grok CLI: run `grok` in this folder and type `\/hooks-trust`/);
  // The positive control: a store that trusts another folder, and one that says no to this one.
  trustFolder(sandbox.home, { '/somewhere/else': true, [root]: false });
  assert.match(doctor(), /note +grok-hook: Grok CLI skips \.grok\/hooks\/yokoten\.json until you trust this folder; run `grok` in this folder and type `\/hooks-trust`/);
  // A trusted parent folder does not cover a repo inside it, and a trailing slash is another key.
  trustFolder(sandbox.home, { [dirname(root)]: true, [`${root}/`]: true });
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted');
  trustFolder(sandbox.home, { [root]: true });
  assert.match(doctor(), /ok +grok-hook\n/);
  // GROK_FOLDER_TRUST=0 turns Grok's trust gate off: every folder runs its hooks.
  trustFolder(sandbox.home, { [root]: false });
  assert.match(doctor(), /note +grok-hook: Grok CLI skips/, 'the positive control');
  for (const value of ['0', 'false']) {
    assert.equal(readTrust(root, { HOME: sandbox.home, GROK_FOLDER_TRUST: value }).state, 'trusted');
    assert.match(sandbox.run(['doctor'], { extra: { GROK_FOLDER_TRUST: value } }).stdout, /ok +grok-hook\n/);
  }
  assert.equal(readTrust(root, { HOME: sandbox.home, GROK_FOLDER_TRUST: '1' }).state, 'untrusted');
  // So does `[folder_trust] enabled = false` in Grok's config.toml, read only.
  const config = join(sandbox.home, '.grok', 'config.toml');
  writeFileSync(config, '[ui]\nyolo = false\n\n[folder_trust]\nenabled = true\n');
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted', 'the positive control');
  writeFileSync(config, '[ui]\nyolo = false\n\n[folder_trust]\nenabled = false # off\n');
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'trusted');
  assert.match(doctor(), /ok +grok-hook\n/);
  writeFileSync(config, 'folder_trust.enabled = false\n');
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'trusted', 'a dotted key');
  writeFileSync(config, '[other]\nenabled = false\n');
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted', 'another table');
  assert.equal(readFileSync(config, 'utf8'), '[other]\nenabled = false\n', 'doctor only reads it');
  // GROK_HOME moves the store.
  const other = join(sandbox.home, 'grok-home');
  mkdirSync(other);
  assert.deepEqual(readTrust(root, { HOME: sandbox.home, GROK_HOME: other }), { state: 'no store', store: '$GROK_HOME/trusted_folders.toml' });
});

test('grok user hook: install writes the command guard in ~/.grok/hooks only when ~/.grok is there, and doctor compares it', () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.home, '.grok', 'hooks', 'yokoten.json');
  let result = sandbox.run(['install']);
  assert.match(result.stdout, /^skipped Grok CLI: ~\/\.grok not found \(run `yokoten install` again after installing Grok CLI\)$/m);
  assert.ok(!existsSync(dirname(dirname(file))), 'no ~/.grok made');
  mkdirSync(join(sandbox.home, '.grok'));
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, /ok +grok-user-hook/);
  result = sandbox.run(['install']);
  assert.match(result.stdout, /^added the Grok CLI command guard in ~\/\.grok\/hooks\/yokoten\.json$/m);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(written.hooks.PreToolUse[0].hooks[0].timeout, 60);
  assert.match(written.hooks.PreToolUse[0].hooks[0].command, /hook --agent grok --commands-only/);
  assert.equal(written.hooks.SessionStart, undefined, 'Grok shows a session-start hook only to the user');
  assert.match(sandbox.run(['doctor']).stdout, /ok +grok-user-hook/);
  assert.match(sandbox.run(['install']).stdout, /^same the Grok CLI command guard/m);
  const env = { HOME: sandbox.home };
  assert.deepEqual(userHooksState(env, '/elsewhere/bin/yokoten.ts', 'gone'), { guard: 'updated' }, 'another runtime path is out of date');
  assert.deepEqual(addUserHooks(env, '/elsewhere/bin/yokoten.ts', 'gone'), { guard: 'updated' });
  assert.match(sandbox.run(['doctor']).stdout, /note +grok-user-hook: the command guard in ~\/\.grok\/hooks\/yokoten\.json is out of date/);
});
