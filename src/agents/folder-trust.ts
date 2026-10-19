// Whether an agent runs this project's hooks: Codex, Muse Code and Copilot CLI skip them
// without a word until the user trusts the folder (#341). Each keeps that trust in a file
// in the user's home. Doctor reads the file, read-only and offline, and never prints it:
// it holds the user's folder names.

import { realpathSync } from 'node:fs';

/**
 * What an agent's trust store says about the project. `store` is where the store is, as
 * the user would type it (`~/...` or `$VAR/...`), never the real path.
 */
export interface FolderTrust<State extends string = never> {
  state: 'trusted' | 'untrusted' | 'no store' | 'unreadable' | State;
  store: string;
}

/**
 * The spellings of the project folder an agent may have saved: the path as given, and the
 * real path when a symlink is on the way. No trailing slash: each agent saves none.
 */
export function folderKeys(root: string): string[] {
  const keys = [root.replace(/\/+$/, '') || '/'];
  try {
    const real = realpathSync(root);
    if (!keys.includes(real)) keys.push(real);
  } catch {
    // a folder that is gone: the path as given is all there is
  }
  return keys;
}
