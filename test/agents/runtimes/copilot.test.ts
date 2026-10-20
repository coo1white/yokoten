// Tests for src/agents/runtimes/copilot.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readTrust } from '../../../src/agents/runtimes/copilot.ts';
import { makeSandbox } from '../../repo/helpers.ts';

/** Write Copilot CLI's config.json in `home`, in the shape Copilot CLI 1.0.98 saved it (#341). */
function trustFolders(home: string, ...folders: string[]): string {
  const file = join(home, '.copilot', 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  const saved = { firstLaunchAt: '2026-10-20T00:00:00.000Z', trustedFolders: folders };
  writeFileSync(file, `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify(saved, null, 2)}\n`);
  return file;
}

test('copilot trust (#341): doctor says when Copilot CLI skips the hooks; a trusted parent folder counts', () => {
  const sandbox = makeSandbox();
  const doctor = () => sandbox.run(['doctor']).stdout;
  // No Copilot home: Copilot looks unused here, so no line at all.
  assert.doesNotMatch(doctor(), /copilot-hook/);
  mkdirSync(join(sandbox.home, '.copilot'));
  assert.match(doctor(), /note +copilot-hook: no tool-call guard in \.claude\/settings\.json; `yokoten init` adds it/);
  const init = sandbox.run(['init']);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /GitHub Copilot CLI runs the hooks in \.claude\/settings\.json only after you trust this folder\n.*to trust this folder in Copilot CLI: run `copilot` in this folder and choose "Yes, and remember this folder for future sessions"/);
  const root = realpathSync(sandbox.repo);
  assert.match(doctor(), /note +copilot-hook: can't check whether Copilot CLI trusts this folder: no ~\/\.copilot\/config\.json; if you use Copilot CLI: run `copilot` in this folder/);
  // The positive control: a config that trusts other folders, one of them a name that only starts like this one.
  const file = trustFolders(sandbox.home, '/somewhere/else', root.slice(0, -1));
  assert.match(doctor(), /note +copilot-hook: Copilot CLI skips \.claude\/settings\.json until you trust this folder; run `copilot` in this folder and choose "Yes, and remember this folder for future sessions"/);
  // Checked with Copilot CLI 1.0.98: the folder, a folder above it, or either with a trailing slash.
  trustFolders(sandbox.home, root);
  assert.match(doctor(), /ok +copilot-hook\n/);
  trustFolders(sandbox.home, `${dirname(root)}/`);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'trusted');
  trustFolders(sandbox.home, join(root, 'sub'));
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted', 'a folder inside does not trust the one above');
  writeFileSync(file, '{ not json');
  assert.match(doctor(), /note +copilot-hook: can't check whether Copilot CLI trusts this folder: can't read ~\/\.copilot\/config\.json/);
  // COPILOT_HOME moves the store, and the note names the variable, not the path.
  const elsewhere = join(sandbox.home, 'elsewhere');
  assert.deepEqual(readTrust(root, { HOME: sandbox.home, COPILOT_HOME: elsewhere }), { state: 'no home', store: '$COPILOT_HOME/config.json' });
  assert.doesNotMatch(sandbox.run(['doctor'], { extra: { COPILOT_HOME: elsewhere } }).stdout, /copilot-hook/, 'after init too: no home, no line');
  mkdirSync(elsewhere);
  assert.deepEqual(readTrust(root, { HOME: sandbox.home, COPILOT_HOME: elsewhere }), { state: 'no store', store: '$COPILOT_HOME/config.json' });
});
