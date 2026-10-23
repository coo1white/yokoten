// What yokoten knows about GitHub Copilot CLI's trust (#341). Copilot reads the hooks in
// `.claude/settings.json` (see runtimes/claude-code.ts), but only in a folder the user trusts: in
// any other folder it skips them without a word.
//
// Copilot saves trust in `config.json` in `$COPILOT_HOME`, or `~/.copilot`: comment lines
// (`//`), then JSON with `trustedFolders`, a list of folders. Checked with Copilot CLI 1.0.98
// on 2026-10-20 in a scratch COPILOT_HOME: a trusted folder covers every folder inside it,
// and a trailing slash makes no difference. A folder that only starts with the same
// letters (`/a/par` for `/a/parent`) does not count. `copilot config` can't set the list.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { homeOf } from '../rules/privacy.ts';
import { type FolderTrust, folderKeys, isFolder, TRUST_COMMAND } from './folder-trust.ts';
import { type TrustChange, type TrustPlan } from './runtimes/codex.ts';
import { isObject } from './hooks-file.ts';
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

/** Whether Copilot CLI looks used on this machine: its home folder is there. */
export const hasUserDir = (env: Env): boolean => isFolder(homeDir(env));

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

/** The names this runtime's agent gets on top of the shared ones (#613). Copilot CLI: only its own token name. GH_TOKEN and GITHUB_TOKEN are the owner's GitHub keys, so they never pass. */
export const AGENT_ENV: RuntimeEnv = { login: ['COPILOT_GITHUB_TOKEN'], config: ['COPILOT_HOME'] };
