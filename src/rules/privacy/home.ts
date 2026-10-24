// The home folder, one topic of the privacy rule (#627). The CLI fills it in once, and every
// rule reads it from the env it is given, never from the process.

import { homedir, userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import type { Env } from '../config.ts';

/** Where the system says the home folder is, with no $HOME: the password file. Empty when it can't tell. */
export const systemHome = (): string => {
  try {
    return homedir() || userInfo().homedir || '';
  } catch {
    return '';
  }
};

/**
 * The home folder from the password database, never from `$HOME` (#739). `homedir()` follows
 * `$HOME`, so a command that changes `HOME` would hide this folder. Empty when it can't tell.
 */
function passwordHome(): string {
  try {
    const home = userInfo().homedir;
    return home && isAbsolute(home) ? home : '';
  } catch {
    return '';
  }
}

// One slot on the process, so a vendored copy of this file (a project's .yokoten/) sees the
// same stand-in as the copy the tests load (#739). A test sets it; production leaves it empty.
const REAL_HOME = Symbol.for('yokoten.readRealHome');
type RealHomeGlobal = typeof globalThis & { [REAL_HOME]?: () => string };

/** The read of the real home: a test's stand-in, or the password database. */
export function realHomeRead(): () => string {
  return (globalThis as RealHomeGlobal)[REAL_HOME] ?? passwordHome;
}

/** A test points the real-home read at a stand-in. The returned function puts the previous read back. */
export function useRealHome(read: () => string): () => void {
  const holder = globalThis as RealHomeGlobal;
  const previous = holder[REAL_HOME];
  holder[REAL_HOME] = read;
  return () => {
    if (previous === undefined) delete holder[REAL_HOME];
    else holder[REAL_HOME] = previous;
  };
}

/**
 * The home folder: `$HOME` when it is an absolute path. Null when it is not (#392): then
 * there is no place outside the repo, and a relative `.config` would land in the folder
 * the command runs in. Only the CLI entry fills HOME from the system (withHome, #356).
 * The marks reader still reads the real home when `$HOME` is missing (#739).
 */
export function homeOf(env: Env): string | null {
  return env.HOME && isAbsolute(env.HOME) ? env.HOME : null;
}

/** The home folder, as homeOf finds it. With none, it throws NO_HOME. */
export function homeIn(env: Env): string {
  const home = homeOf(env);
  if (!home) throw new Error(NO_HOME);
  return home;
}

/**
 * The CLI's environment: `env` with HOME from the system when HOME is empty or not a full
 * path (#392). The one place yokoten falls back to the system's home (#356); everything
 * else reads HOME from the env it is given.
 */
export function withHome(env: Env, system: () => string = systemHome): Env {
  if (homeOf(env)) return env;
  const home = system();
  return home && isAbsolute(home) ? { ...env, HOME: home } : env;
}

/** Thrown when there is no home folder, so nothing outside the repo can be read or written. */
export const NO_HOME = 'yokoten finds no home folder (HOME is empty or not a full path), so it has no place outside the repo';
