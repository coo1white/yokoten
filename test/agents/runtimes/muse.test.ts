// Tests for src/agents/runtimes/muse.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addProjectHooks, addUserHooks, hasUserDir, isGuardOff, projectHooksState, readToolCall, readTrust, userHooksState, userSettingsFile } from '../../../src/agents/runtimes/muse.ts';
import { makeSandbox } from '../../repo/helpers.ts';

/** Write Muse's trust store in `home`, in the shape Muse Code 1.4.11 writes it (#341). */
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

test('hook --agent muse: bash by command, the edit tools by path; a refusal is exit 2 with the reason on stderr (#5)', async () => {
  const sandbox = makeSandbox();
  const call = (name: string, input: Record<string, unknown>, extra?: Record<string, string>) => sandbox.call(['hook', '--agent', 'muse'], { input: payload(sandbox.repo, name, input), extra });
  // The positive control: a tag push, in the shape Muse sends it, is refused.
  let result = await call('bash', { command: 'git push --tags origin', description: 'Push tags', workdir: sandbox.repo });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags\. Only the owner decides when to release/);
  result = await call('bash', { command: 'git status', description: 'Status', workdir: null });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  // Muse cuts YOKOTEN_ROLE from a hook's env, so a real Muse session is always the lead.
  // Set here by hand, it shows the edit tools' paths reach the lead-only guard.
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const name of ['write_file', 'edit_file', 'apply_patch']) {
    assert.equal((await call(name, { path: 'AGENTS.md', content: 'x', find: 'a', replace: 'b' }, worker)).status, 2, `${name}: a worker may not edit a lead-only file`);
  }
  assert.equal((await call('write_file', { path: '.muse/hooks.json', content: '{}' }, worker)).status, 2, "a worker may not turn off Muse's own hook");
  assert.equal((await call('write_file', { path: 'src/a.ts', content: 'x' }, worker)).status, 0);
  assert.equal((await call('edit_file', { path: 'AGENTS.md', find: 'a', replace: 'b' })).status, 0, 'without YOKOTEN_ROLE the session is the lead');
  assert.equal((await call('read_file', { path: 'AGENTS.md' }, worker)).status, 0, 'reading is not editing');
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

test('muse project hooks: init writes the guard and the stop check, keeps other hooks, and doctor notes them', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.muse', 'hooks.json');
  const cli = '.yokoten/bin/yokoten.mjs';
  assert.match((await sandbox.call(['doctor'])).stdout, /note +muse-hook: no tool-call guard or stop check in \.muse\/hooks\.json/, 'reported, not counted as missing');
  sandbox.write('.muse/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: './lint.sh' }] }] } }));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the Muse Code tool-call hook in \.muse\/hooks\.json/);
  assert.match(result.stdout, /added the Muse Code stop check in \.muse\/hooks\.json/);
  assert.match(result.stdout, /added the Muse Code session doctor in \.muse\/hooks\.json/);
  assert.match(result.stdout, /Muse Code runs the hooks in \.muse\/hooks\.json only after you trust this folder/);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.hooks.PreToolUse.length, 2, "another hook's group stays");
  assert.equal(written.hooks.PreToolUse[1].matcher, 'bash|write_file|edit_file|apply_patch', 'named tools: "*" would also match read_skill');
  assert.match(written.hooks.PreToolUse[1].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.yokoten\/bin\/yokoten\.mjs" hook --agent muse 2>&1/);
  assert.match(written.hooks.Stop[0].hooks[0].command, /hook --stop --agent muse$/);
  assert.equal(written.hooks.Stop[0].hooks[0].timeout, 600, 'long enough for the done-when command');
  assert.deepEqual(projectHooksState(sandbox.repo, cli), { guard: 'same', stop: 'same' });
  assert.equal(written.hooks.SessionStart.length, 1);
  assert.match(written.hooks.SessionStart[0].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.yokoten\/bin\/yokoten\.mjs" doctor --session --agent muse$/);
  assert.equal(written.hooks.SessionStart[0].matcher, undefined);
  // The hooks are in place, and Muse looks unused here: no trust line (#341).
  assert.match((await sandbox.call(['doctor'])).stdout, /ok +muse-hook: \.muse\/hooks\.json is in place; trust not checked, no ~\/\.config\/muse\n/);
  trustFolder(sandbox.home, realpathSync(sandbox.repo));
  assert.match((await sandbox.call(['doctor'])).stdout, /ok +muse-hook/);
  assert.match((await sandbox.call(['init'])).stdout, /same the Muse Code tool-call hook/);
  written.hooks.Stop[0].hooks[0].command = 'node old/yokoten.ts hook --stop --agent muse';
  sandbox.write('.muse/hooks.json', JSON.stringify(written));
  assert.equal(projectHooksState(sandbox.repo, cli).stop, 'updated');
  assert.match((await sandbox.call(['doctor'])).stdout, /note +muse-hook: the hooks in \.muse\/hooks\.json are out of date/);
  assert.deepEqual(addProjectHooks(sandbox.repo, cli), { guard: 'same', stop: 'updated', doctor: 'same' });
  sandbox.write('.muse/hooks.json', '{ not json');
  assert.match((await sandbox.call(['doctor'])).stdout, /note +muse-hook: can't read \.muse\/hooks\.json/);
  assert.throws(() => addProjectHooks(sandbox.repo, cli), /can't read/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a file yokoten cannot read stays as it was');
});

test('muse trust (#341): doctor says when Muse skips the hooks; ok only when trust.json names the folder', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const root = realpathSync(sandbox.repo);
  const doctor = async () => (await sandbox.call(['doctor'])).stdout;
  // No Muse home: no trust line, and no claim that Muse trusts the folder.
  assert.doesNotMatch(await doctor(), /muse-hook: can't check|Muse Code skips/);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'no home');
  assert.match(await doctor(), /done +tool-hook\n/);
  // A home without a store: the guard is off, and it is a step on the road (#554), not a note.
  mkdirSync(join(sandbox.home, '.config', 'muse'), { recursive: true });
  const off = /(next|to do) +tool-hook: the guard is off in Muse Code until you trust this folder; run `muse` in this folder and choose "Trust and continue", or pass `--trust-workspace` to `muse exec`/;
  assert.match(await doctor(), off);
  assert.doesNotMatch(await doctor(), /muse-hook: (can't check|Muse Code skips)/);
  assert.equal(isGuardOff(root, { HOME: sandbox.home }), true);
  // The positive control: a store that trusts another folder.
  const file = trustFolder(sandbox.home, '/somewhere/else');
  assert.match(await doctor(), off);
  // Checked with Muse 1.4.10: a trusted parent folder, or the key with a trailing slash, trusts nothing.
  trustFolder(sandbox.home, dirname(root), `${root}/`);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted');
  trustFolder(sandbox.home, root);
  assert.match(await doctor(), /ok +muse-hook\n/);
  assert.match(await doctor(), /done +tool-hook\n/);
  assert.equal(isGuardOff(root, { HOME: sandbox.home }), false);
  // Another decision, a file that won't parse, and a schema doctor does not know: never ok.
  writeFileSync(file, JSON.stringify({ schema_version: 1, projects: { [root]: { decision: 'untrusted' } } }));
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted');
  assert.match(await doctor(), off);
  writeFileSync(file, '{ not json');
  // A store doctor can't read is a note, and the note names the headless way to trust (#557).
  assert.match(
    await doctor(),
    /note +muse-hook: can't check whether Muse Code trusts this folder: can't read ~\/\.config\/muse\/trust\.json; if you use Muse Code: run `muse` in this folder and choose "Trust and continue", or pass `--trust-workspace` to `muse exec`/,
  );
  assert.equal(isGuardOff(root, { HOME: sandbox.home }), false, "a store doctor can't read is a note, not a step");
  assert.equal(isGuardOff(join(sandbox.home, 'none'), { HOME: sandbox.home }), false, 'no .muse/hooks.json, no step');
  writeFileSync(file, JSON.stringify({ schema_version: 2, projects: { [root]: { decision: 'trusted' } } }));
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'unreadable');
  // XDG_CONFIG_HOME moves the store: the one under ~/.config no longer counts. The note names the variable, not the path.
  trustFolder(sandbox.home, root);
  assert.deepEqual(readTrust(root, { HOME: sandbox.home, XDG_CONFIG_HOME: join(sandbox.home, 'xdg') }), { state: 'no home', store: '$XDG_CONFIG_HOME/muse/trust.json' });
  mkdirSync(join(sandbox.home, 'xdg', 'muse'), { recursive: true });
  assert.deepEqual(readTrust(root, { HOME: sandbox.home, XDG_CONFIG_HOME: join(sandbox.home, 'xdg') }), { state: 'no store', store: '$XDG_CONFIG_HOME/muse/trust.json' });
});

test('muse session doctor (#556): a new project gets it; an existing file keeps the user\'s hooks and gets it once', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.muse', 'hooks.json');
  const mine = { matcher: 'bash', hooks: [{ type: 'command', command: './lint.sh' }] };
  const own = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: './hello.sh' }] }], PreToolUse: [mine] } };
  sandbox.write('.muse/hooks.json', JSON.stringify(own));
  assert.equal((await sandbox.call(['init'])).status, 0);
  assert.equal((await sandbox.call(['init'])).status, 0);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.hooks.SessionStart.length, 2, 'the user\'s own SessionStart hook stays, ours is added once');
  assert.deepEqual(written.hooks.SessionStart[0], own.hooks.SessionStart[0]);
  assert.match(written.hooks.SessionStart[1].hooks[0].command, /doctor --session --agent muse$/);
  assert.deepEqual(written.hooks.PreToolUse[0], mine);
  assert.equal(written.hooks.PreToolUse.length, 2);
  // The hook itself runs the session doctor: plain text on stdout, exit 0, as Muse reads it.
  const run = await sandbox.call(['doctor', '--session', '--agent', 'muse']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /yokoten/);
});

test('muse user hooks (#557): install writes the doctor and the guard in its settings only when its config folder is there, and doctor compares them', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.home, '.config', 'muse', 'settings.json');
  assert.equal(hasUserDir({ HOME: sandbox.home }), false);
  assert.equal(userSettingsFile({ HOME: sandbox.home }), '~/.config/muse/settings.json');
  assert.equal(userSettingsFile({ HOME: sandbox.home, XDG_CONFIG_HOME: join(sandbox.home, 'xdg') }), '$XDG_CONFIG_HOME/muse/settings.json');
  let result = await sandbox.call(['install']);
  assert.match(result.stdout, /^skipped Muse Code: ~\/\.config\/muse not found \(run `yokoten install` again after installing Muse Code\)$/m);
  assert.ok(!existsSync(join(sandbox.home, '.config', 'muse')), 'no config folder made');
  mkdirSync(join(sandbox.home, '.config', 'muse'));
  assert.equal(hasUserDir({ HOME: sandbox.home }), true);
  // The doctor names both hooks as missing, and install adds them, twice safe. The runtime
  // is installed by now, so doctor says `npx yokoten install`, which works from anywhere.
  assert.match((await sandbox.call(['doctor'])).stdout, /note +muse-user-hook: no session-start doctor and no command guard in ~\/\.config\/muse\/settings\.json; `npx yokoten install` adds them/);
  result = await sandbox.call(['install']);
  assert.match(result.stdout, /^added the Muse Code SessionStart doctor in ~\/\.config\/muse\/settings\.json$/m);
  assert.match(result.stdout, /^added the Muse Code command guard in ~\/\.config\/muse\/settings\.json$/m);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.match(written.hooks.SessionStart[0].hooks[0].command, /doctor --session --agent muse$/);
  assert.equal(written.hooks.PreToolUse[0].matcher, 'bash');
  assert.match(written.hooks.PreToolUse[0].hooks[0].command, /hook --agent muse --commands-only/);
  assert.match((await sandbox.call(['doctor'])).stdout, /ok +muse-user-hook/);
  const explainUser = (await sandbox.call(['explain', 'muse-user-hook'])).stdout;
  assert.match(explainUser, /session-start doctor and command guard/);
  assert.match(explainUser, /compares the SessionStart and PreToolUse hooks in its settings\.json/);
  assert.match((await sandbox.call(['install'])).stdout, /^same the Muse Code command guard in ~\/\.config\/muse\/settings\.json$/m);
  // The positive control: another runtime path is out of date, for both hooks.
  const env = { HOME: sandbox.home };
  assert.deepEqual(userHooksState(env, '/elsewhere/bin/yokoten.ts', 'gone'), { doctor: 'updated', guard: 'updated' });
  assert.deepEqual(addUserHooks(env, '/elsewhere/bin/yokoten.ts', 'gone'), { doctor: 'updated', guard: 'updated' });
  assert.match((await sandbox.call(['doctor'])).stdout, /note +muse-user-hook: the session-start doctor and the command guard in ~\/\.config\/muse\/settings\.json are out of date/);
});
