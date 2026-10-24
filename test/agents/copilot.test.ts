// Tests for src/agents/copilot.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addUserHooks, hasUserDir, readTrust, removeUserHooks, userHooksFile, userHooksState } from '../../src/agents/copilot.ts';
import { makeSandbox } from '../repo/helpers.ts';

/** Write Copilot CLI's config.json in `home`, in the shape Copilot CLI 1.0.98 saved it (#341). */
function trustFolders(home: string, ...folders: string[]): string {
  const file = join(home, '.copilot', 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  const saved = { firstLaunchAt: '2026-10-20T00:00:00.000Z', trustedFolders: folders };
  writeFileSync(file, `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify(saved, null, 2)}\n`);
  return file;
}

test('copilot trust (#341): doctor says when Copilot CLI skips the hooks; a trusted parent folder counts', async () => {
  const sandbox = makeSandbox();
  const doctor = async () => (await sandbox.call(['doctor'])).stdout;
  // No Copilot home: Copilot looks unused here, so no line at all.
  assert.doesNotMatch(await doctor(), /copilot-hook/);
  mkdirSync(join(sandbox.home, '.copilot'));
  assert.match(await doctor(), /note +copilot-hook: no tool-call guard in \.claude\/settings\.json; `yokoten init` adds it/);
  const init = await sandbox.call(['init']);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /GitHub Copilot CLI runs the hooks in \.claude\/settings\.json only after you trust this folder\n.*to trust this folder in Copilot CLI: run `copilot` in this folder and choose "Yes, and remember this folder for future sessions"/);
  const root = realpathSync(sandbox.repo);
  assert.match(await doctor(), /note +copilot-hook: can't check whether Copilot CLI trusts this folder: no ~\/\.copilot\/config\.json; if you use Copilot CLI: run `copilot` in this folder/);
  // The positive control: a config that trusts other folders, one of them a name that only starts like this one.
  const file = trustFolders(sandbox.home, '/somewhere/else', root.slice(0, -1));
  assert.match(await doctor(), /note +copilot-hook: Copilot CLI skips \.claude\/settings\.json until you trust this folder; run `copilot` in this folder and choose "Yes, and remember this folder for future sessions"/);
  // Checked with Copilot CLI 1.0.98: the folder, a folder above it, or either with a trailing slash.
  trustFolders(sandbox.home, root);
  assert.match(await doctor(), /ok +copilot-hook\n/);
  trustFolders(sandbox.home, `${dirname(root)}/`);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'trusted');
  trustFolders(sandbox.home, join(root, 'sub'));
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted', 'a folder inside does not trust the one above');
  writeFileSync(file, '{ not json');
  assert.match(await doctor(), /note +copilot-hook: can't check whether Copilot CLI trusts this folder: can't read ~\/\.copilot\/config\.json/);
  // COPILOT_HOME moves the store, and the note names the variable, not the path.
  const elsewhere = join(sandbox.home, 'elsewhere');
  assert.deepEqual(readTrust(root, { HOME: sandbox.home, COPILOT_HOME: elsewhere }), { state: 'no home', store: '$COPILOT_HOME/config.json' });
  assert.doesNotMatch((await sandbox.call(['doctor'], { extra: { COPILOT_HOME: elsewhere } })).stdout, /copilot-hook/, 'after init too: no home, no line');
  mkdirSync(elsewhere);
  assert.deepEqual(readTrust(root, { HOME: sandbox.home, COPILOT_HOME: elsewhere }), { state: 'no store', store: '$COPILOT_HOME/config.json' });
});

// #342: Copilot's user hooks folder is outside every project, so the guard runs in a repo
// without yokoten too. It follows $COPILOT_HOME, and it keeps a hook the user wrote.
test('copilot user hook: install writes the guard in ~/.copilot/hooks/yokoten.json and uninstall takes it out (#342)', () => {
  const sandbox = makeSandbox();
  const env = { HOME: sandbox.home };
  const file = join(sandbox.home, '.copilot', 'hooks', 'yokoten.json');
  const cli = '"$HOME/.local/share/yokoten/bin/yokoten.mjs"';
  const missing = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';
  assert.equal(userHooksFile(env), '~/.copilot/hooks/yokoten.json');
  assert.equal(hasUserDir(env), false, 'no ~/.copilot: Copilot looks unused');
  mkdirSync(dirname(file), { recursive: true });
  assert.equal(hasUserDir(env), true);
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }));
  assert.deepEqual(userHooksState(env, cli, missing), { guard: 'added' });
  assert.deepEqual(addUserHooks(env, cli, missing), { guard: 'added' });
  assert.deepEqual(userHooksState(env, cli, missing), { guard: 'same' });
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.hooks.PreToolUse[0].hooks[0].command, 'mine', "the user's hook stays");
  assert.equal(written.hooks.PreToolUse[1].matcher, 'Bash');
  assert.match(written.hooks.PreToolUse[1].hooks[0].command, / hook --agent claude-code --commands-only /);
  // $COPILOT_HOME moves the folder, and the report names the variable.
  const elsewhere = join(sandbox.home, 'elsewhere');
  mkdirSync(elsewhere);
  assert.equal(hasUserDir({ HOME: sandbox.home, COPILOT_HOME: elsewhere }), true);
  assert.equal(userHooksFile({ HOME: sandbox.home, COPILOT_HOME: elsewhere }), '$COPILOT_HOME/hooks/yokoten.json');
  assert.deepEqual(addUserHooks({ HOME: sandbox.home, COPILOT_HOME: elsewhere }, cli, missing), { guard: 'added' });
  assert.ok(readFileSync(join(elsewhere, 'hooks', 'yokoten.json'), 'utf8').includes('hook --agent claude-code'));
  assert.equal(removeUserHooks(env), 'removed');
  assert.equal(userHooksState(env, cli, missing).guard, 'added');
  assert.equal(removeUserHooks(env), 'not there');
  writeFileSync(file, '{ not json');
  assert.equal(removeUserHooks(env), null);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a file yokoten cannot read stays as it was');
});
