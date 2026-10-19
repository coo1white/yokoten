// What yokoten knows about GitHub Copilot CLI's trust (#341). Copilot reads the hooks in
// `.claude/settings.json` (see claude-code.ts), but only in a folder the user trusts: in
// any other folder it skips them without a word.
//
// Copilot saves trust in `config.json` in `$COPILOT_HOME`, or `~/.copilot`: comment lines
// (`//`), then JSON with `trustedFolders`, a list of folders. Checked with Copilot CLI 1.0.98
// on 2026-10-20 in a scratch COPILOT_HOME: a trusted folder covers every folder inside it,
// and a trailing slash makes no difference. A folder that only starts with the same
// letters (`/a/par` for `/a/parent`) does not count. `copilot config` can't set the list.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type FolderTrust, folderKeys, isFolder } from '../folder-trust.ts';
import { isObject } from '../hooks-file.ts';

/** The one step that makes Copilot CLI run the project's hooks. */
export const TRUST_STEP = 'run `copilot` in this folder and choose "Yes, and remember this folder for future sessions"';

/**
 * Whether `folder` is `trusted` or inside it. Both without a trailing slash. A "/" entry
 * (empty here) covers every folder: inferred from the rule seen in a run, a folder covers
 * the folders inside it; no run has saved "/" itself.
 */
const isInside = (folder: string, trusted: string) => trusted === '' || folder === trusted || folder.startsWith(`${trusted}/`);

/** Whether Copilot CLI trusts the project at `root`, from its config file. Read-only. */
export function readTrust(root: string, env: Env): FolderTrust {
  const store = env.COPILOT_HOME ? '$COPILOT_HOME/config.json' : '~/.copilot/config.json';
  const home = env.COPILOT_HOME || join(env.HOME || homedir(), '.copilot');
  const file = join(home, 'config.json');
  if (!isFolder(home)) return { state: 'no home', store };
  if (!existsSync(file)) return { state: 'no store', store };
  let saved: unknown;
  try {
    // Copilot starts the file with `//` comment lines, which JSON does not allow.
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    saved = JSON.parse(text);
  } catch {
    return { state: 'unreadable', store };
  }
  if (!isObject(saved)) return { state: 'unreadable', store };
  const trusted = Array.isArray(saved.trustedFolders) ? saved.trustedFolders.filter((folder) => typeof folder === 'string' && folder.startsWith('/')).map((folder) => folder.replace(/\/+$/, '')) : [];
  const isTrusted = folderKeys(root).some((key) => trusted.some((folder) => isInside(key, folder)));
  return { state: isTrusted ? 'trusted' : 'untrusted', store };
}
