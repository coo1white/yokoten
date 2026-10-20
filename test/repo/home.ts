// Every test file imports this first (#356). Before any other module loads, it points the
// home folder at an empty temp folder: HOME, USERPROFILE (Windows) and XDG_CONFIG_HOME. The
// variables that name a folder in the real home are removed. So no test reads or writes the
// real home folder or ~/.config/yokoten, even when the suite runs without
// HOME=$(mktemp -d), and a test that still reaches for the home folder fails the same way on
// every machine. Child processes inherit it. The architecture test checks the import.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Variables that point into the real home folder, or at a file kept there. */
export const HOME_VARIABLES = [
  'CODEX_HOME',
  'COPILOT_HOME',
  'DSH_HOME',
  'GH_CONFIG_DIR',
  'GIT_CONFIG_GLOBAL',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'YOKOTEN_BOT_KEY',
  'YOKOTEN_PRIVATE_MARKS',
];

/** The empty home folder this test file runs with. Removed when the process exits. */
export const TEST_HOME = mkdtempSync(join(tmpdir(), 'yokoten-home-'));

for (const name of HOME_VARIABLES) delete process.env[name];
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.XDG_CONFIG_HOME = join(TEST_HOME, '.config');
process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }));
