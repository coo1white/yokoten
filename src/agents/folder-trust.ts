// Whether an agent runs this project's hooks: Codex, Muse Code, Copilot CLI and Grok CLI
// skip them without a word until the user trusts the folder (#341). Each keeps that trust in a file
// in the user's home. Doctor reads the file, read-only and offline, and never prints it:
// it holds the user's folder names.

import { realpathSync, statSync } from 'node:fs';

/**
 * What an agent's trust store says about the project. `store` is where the store is, as
 * the user would type it (`~/...` or `$VAR/...`), never the real path. 'no home' is an
 * agent this machine does not seem to use: its home folder is not there.
 */
export interface FolderTrust<State extends string = never> {
  state: 'trusted' | 'untrusted' | 'no home' | 'no store' | 'unreadable' | State;
  store: string;
}

/** Whether `dir` is a folder: an agent's home, which it makes on first run. */
export function isFolder(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
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
