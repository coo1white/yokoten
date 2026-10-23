// Every test file imports this first (#356). Before any other module loads, it points the
// home folder at an empty temp folder: HOME, USERPROFILE (Windows) and XDG_CONFIG_HOME. The
// variables that name a folder in the real home are removed. So no test reads or writes the
// real home folder or ~/.config/yokoten, even when the suite runs without
// HOME=$(mktemp -d), and a test that still reaches for the home folder fails the same way on
// every machine. Child processes inherit it. The architecture test checks the import.
//
// Yokoten's own variables are removed too (#712). A test must not see the session that
// started the suite: YOKOTEN_ROLE, YOKOTEN_DESK and the rest. The architecture test checks it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Drop yokoten's own variables from `env` (#712). A test must not see the session
 * that started the suite.
 */
export function clearYokotenEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith('YOKOTEN_')) delete env[name];
  }
}

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

clearYokotenEnv(process.env);
for (const name of HOME_VARIABLES) delete process.env[name];
// Nothing a child leaves running may write into a test's folder after the test removed it
// (#436). gh sends telemetry from a process it leaves behind, which writes into the home
// folder. Git runs automatic maintenance after a commit, in the background on newer
// versions, and its worktree prune can race a `git worktree add` (#442). makeSandbox sets
// the same for its own environment.
process.env.GH_TELEMETRY = '0';
process.env.GIT_CONFIG_COUNT = '2';
process.env.GIT_CONFIG_KEY_0 = 'maintenance.auto';
process.env.GIT_CONFIG_VALUE_0 = 'false';
process.env.GIT_CONFIG_KEY_1 = 'gc.auto';
process.env.GIT_CONFIG_VALUE_1 = '0';
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.XDG_CONFIG_HOME = join(TEST_HOME, '.config');
process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }));

/**
 * The compile cache every child node shares (#442): the one bin/yokoten.mjs turns on, in the
 * system temp folder, so a CLI child loads its modules type-stripped and compiled after the
 * first run on this machine, in any test file, and not again in each file's empty home.
 */
export const COMPILE_CACHE = join(tmpdir(), 'node-compile-cache');
process.env.NODE_COMPILE_CACHE = COMPILE_CACHE;

// The commit check reads the password-database home when $HOME has no marks file (#739).
// Point that read at nothing, after HOME is set, so no test opens the real marks file.
const { useRealHome } = await import('../../src/rules/privacy.ts');
useRealHome(() => '');

// A child does not import this file: that would point its HOME at a new empty folder.
// --import would load the child program as an ES module. Node then refuses a name it
// does not know, such as the fake gh.exe (#750). --require runs CommonJS, sets the same
// slot as useRealHome, and leaves the program's own format alone. The script is in the
// temp folder, so test/repo stays at 7 files (#739, #356).
const preloadFile = join(tmpdir(), 'yokoten-real-home.cjs');
writeFileSync(preloadFile, "globalThis[Symbol.for('yokoten.readRealHome')] = () => '';\n");
const flag = `--require ${JSON.stringify(preloadFile)}`;
if (!process.env.NODE_OPTIONS?.includes(flag)) {
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ${flag}` : flag;
}

// Tests call the guard without the hook. The host command list registers when its module
// loads. Load it here, after HOME is set, so nothing it imports reads the real home folder.
await import('../../src/host/gh-commands.ts');
