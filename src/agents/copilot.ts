// What yokoten knows about GitHub Copilot CLI's trust (#341) and its user-level guard
// (#342). Copilot reads the hooks in `.claude/settings.json` (see runtimes/claude-code.ts),
// but only in a folder the user trusts: in any other folder it skips them without a word.
// The one guard outside a folder is its user hooks, in `~/.copilot/hooks/`: a folder of
// JSON files in Claude Code's shape, one file per guard. yokoten owns `yokoten.json`.
//
// Copilot saves trust in `config.json` in `$COPILOT_HOME`, or `~/.copilot`: comment lines
// (`//`), then JSON with `trustedFolders`, a list of folders. Checked with Copilot CLI 1.0.98
// on 2026-10-20 in a scratch COPILOT_HOME: a trusted folder covers every folder inside it,
// and a trailing slash makes no difference. A folder that only starts with the same
// letters (`/a/par` for `/a/parent`) does not count. `copilot config` can't set the list.
//
// Copilot's docs say a hook that times out lets the call go on, so the guard sets no long
// timeout of its own and must finish fast: yokoten caps its heap.

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { homeIn, homeOf } from '../rules/privacy.ts';
import { guardCommand } from '../run/cli.ts';
import { type FolderTrust, folderKeys, isFolder, TRUST_COMMAND } from './folder-trust.ts';
import { type TrustChange, type TrustPlan } from './runtimes/codex.ts';
import { type Added, addHook, checkHooksFile, type HookState, hookState, isObject, readSettings, removeHook } from './hooks-file.ts';
import type { RuntimeEnv } from './desk/agent-env.ts';

/** The one step that makes Copilot CLI run the project's hooks. */
export const TRUST_STEP = TRUST_COMMAND;

/**
 * Whether `folder` is `trusted` or inside it. Both without a trailing slash. A "/" entry
 * (empty here) covers every folder: inferred from the rule seen in a run, a folder covers
 * the folders inside it; no run has saved "/" itself.
 */
const isInside = (folder: string, trusted: string) => trusted === '' || folder === trusted || folder.startsWith(`${trusted}/`);

/** Copilot's home folder: `$COPILOT_HOME`, or ~/.copilot; empty with neither. */
const homeDir = (env: Env): string => {
  const user = homeOf(env);
  return env.COPILOT_HOME || (user ? join(user, '.copilot') : '');
};

/** Whether Copilot CLI trusts the project at `root`, from its config file. Read-only. */
export function readTrust(root: string, env: Env): FolderTrust {
  const store = env.COPILOT_HOME ? '$COPILOT_HOME/config.json' : '~/.copilot/config.json';
  const home = homeDir(env);
  if (!home) return { state: 'no home', store };
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

/**
 * What yokoten must write into `config.json` to trust this folder (#661). Copilot reads
 * Claude Code's hooks, so one entry in `trustedFolders` is what makes them run here.
 * A file whose `//` comment lines sit inside the JSON is left alone: yokoten won't rewrite
 * a shape it cannot keep.
 */
export function trustProject(root: string, env: Env): TrustPlan {
  const store = env.COPILOT_HOME ? '$COPILOT_HOME/config.json' : '~/.copilot/config.json';
  const home = homeDir(env);
  if (!home) return { state: 'no home', store, changes: [] };
  const file = join(home, 'config.json');
  let saved: unknown = {};
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      saved = JSON.parse(text);
    } catch {
      return { state: 'unreadable', store, changes: [] };
    }
  }
  if (!isObject(saved)) return { state: 'unreadable', store, changes: [] };
  if (readTrust(root, env).state === 'trusted') return { state: 'same', store, changes: [] };
  const folder = folderKeys(root)[0];
  const change: TrustChange = { agent: 'Copilot CLI', store, file, format: 'json', path: [], key: 'trustedFolders', value: folder, before: null, kind: 'list' };
  return { state: 'trusted', store, changes: [change], seed: { trustedFolders: [] } };
}

// ---- The user's guard (#342) ----

/** Copilot's home folder: `$COPILOT_HOME` when set, else `~/.copilot`. `homeIn` throws with no home. */
const userHome = (env: Env): string => env.COPILOT_HOME || join(homeIn(env), '.copilot');

/** yokoten's own file in the user hooks folder, as Copilot reads it in every folder. */
const userHooks = (env: Env): string => join(userHome(env), 'hooks', 'yokoten.json');

/** The user's file as the report shows it. */
export const userHooksFile = (env: Env): string => (env.COPILOT_HOME ? '$COPILOT_HOME/hooks/yokoten.json' : '~/.copilot/hooks/yokoten.json');

/**
 * The user's command guard, as `addHook`'s arguments. Copilot sends Claude Code's shape, so
 * the default reader judges it. Commands only: file rules stay with the project. Copilot
 * refuses on exit 2 alone, so `--denial exit2` keeps that answer rather than Claude Code's
 * JSON deny on exit 0 (#707).
 */
const userGuardArgs = (env: Env, cli: string, missing: string) => [userHooks(env), 'PreToolUse', 'Bash', guardCommand(cli, 'hook --agent claude-code --commands-only --denial exit2', missing, { isToolCall: true })] as const;

/** Write the user's guard, in every folder; `missing` is what it says when `cli` is gone. */
export function addUserHooks(env: Env, cli: string, missing: string): { guard: Added } {
  const args = userGuardArgs(env, cli, missing);
  checkHooksFile(args[0], [args[1]]);
  return { guard: addHook(...args) };
}

/** Whether Copilot CLI looks used on this machine: its home folder is a folder. */
export function hasUserDir(env: Env): boolean {
  const home = homeOf(env);
  const folder = env.COPILOT_HOME || (home ? join(home, '.copilot') : '');
  if (!folder) return false;
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** The user's guard against what `addUserHooks` would write, read-only. */
export const userHooksState = (env: Env, cli: string, missing: string): { guard: HookState } => ({ guard: hookState(...userGuardArgs(env, cli, missing)) });

/** Take out the guard; null when the file is not JSON and stays as it is. */
export function removeUserHooks(env: Env): 'removed' | 'not there' | null {
  const path = userHooks(env);
  try {
    const state = removeHook(path, 'PreToolUse', 'hook');
    // The file is yokoten's own: take it away when the guard was all it held.
    if (state === 'removed' && !Object.keys(readSettings(path)).length) rmSync(path, { force: true });
    return state;
  } catch {
    return null;
  }
}

/** The names this runtime's agent gets on top of the shared ones (#613). Copilot CLI: only its own token name. GH_TOKEN and GITHUB_TOKEN are the owner's GitHub keys, so they never pass. */
export const AGENT_ENV: RuntimeEnv = { login: ['COPILOT_GITHUB_TOKEN'], config: ['COPILOT_HOME'] };
