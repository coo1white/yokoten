// The tool-call hook. Before an agent runs a command or edits a file, its runtime asks
// the hook; a finding stops the action, null lets it go.
//
// The hook knows nothing about any one runtime. An adapter in src/agents/ turns the
// runtime's own call into an `Action` first.

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { type Config, DEFAULTS, type Env, type IgnoredPart, loadConfig } from '../rules/config.ts';
import { checkCommand, checkEdit } from '../rules/guards.ts';
import type { Finding } from '../rules/message.ts';

/** What an agent is about to do, in no runtime's terms. */
export interface Action {
  /** A shell command, as the agent wrote it. */
  command?: string;
  /** The files an edit touches, absolute or relative to `cwd`. */
  paths: string[];
  cwd?: string;
  /** The action comes from a worker, whatever the session's own role. */
  worker: boolean;
}

/**
 * The config the hook works with: the repo's yokoten.json, or the defaults outside a repo.
 * The hook never fails open on its own config (#218): a file it cannot read gives the
 * defaults, and a key with the wrong shape gives only that key's default (#192, #228).
 * The core checks still run, and `warn` gets one line for each part it ignored, with why.
 */
export function loadHookConfig(root: string | null, warn: (line: string) => void): Config {
  if (!root) return DEFAULTS;
  return loadConfig(root, { onProblem: (problem, ignored) => warn(`yokoten hook: ${sayIgnored(ignored)}; the core checks still run. ${problem}`) });
}

const sayIgnored = (ignored: IgnoredPart) =>
  ignored === 'file' ? 'yokoten.json was ignored, so the defaults apply' : `yokoten.json "${ignored}" was ignored, so its default applies`;

/**
 * Why to stop the action (what, why, fix), or null. `root` is the repo root, or null outside a repo.
 * `commandsOnly` is the user-level hook: it runs in every repo, so it keeps to the rules
 * that hold everywhere (no tag pushes, no force pushes, no skipped checks) and leaves file
 * rules to each project's own hook.
 */
export function judge(
  action: Action,
  { root, config, env, commandsOnly = false }: { root: string | null; config: Config; env: Env; commandsOnly?: boolean },
): Finding | null {
  // The command runs in the call's folder: a hooks setting is judged in that repo (#217).
  if (action.command !== undefined) return checkCommand(action.command, { env, config, cwd: action.cwd ?? root ?? undefined });
  if (commandsOnly || !root) return null;
  if (action.worker) env = { ...env, YOKOTEN_ROLE: 'worker' };
  for (const p of action.paths) {
    const rel = relative(real(root), real(resolve(action.cwd ?? root, p)));
    // A file outside the repo is not this repo's business.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    const reason = checkEdit(rel.split(sep).join('/'), { config, env });
    if (reason) return reason;
  }
  return null;
}

// The real path, through symlinks. git reports the repo root's real path, and a tool may
// send a path through a symlink (on macOS, /var is /private/var). A file that does not
// exist yet takes the real path of its nearest existing folder.
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(real(parent), basename(path));
  }
}
