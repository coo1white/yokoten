// The tool-call hook. Before an agent runs a command or edits a file, its runtime asks
// the hook; a finding stops the action, null lets it go.
//
// The hook knows nothing about any one runtime. An adapter in src/agents/ turns the
// runtime's own call into an `Action` first.

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Config, Env } from '../rules/config.ts';
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
 * Why to stop the action (what, why, fix), or null. `root` is the repo root, or null outside a repo.
 * `commandsOnly` is the user-level hook: it runs in every repo, so it keeps to the rules
 * that hold everywhere (no tag pushes, no force pushes, no skipped checks) and leaves file
 * rules to each project's own hook.
 */
export function judge(
  action: Action,
  { root, config, env, commandsOnly = false }: { root: string | null; config: Config; env: Env; commandsOnly?: boolean },
): Finding | null {
  // Set before the command check: no command rule reads the role yet, but one would see it.
  if (action.worker) env = { ...env, YOKOTEN_ROLE: 'worker' };
  // A command may also edit files (Codex runs apply_patch through the shell): check both.
  if (action.command !== undefined) {
    const reason = checkCommand(action.command, { env });
    if (reason) return reason;
  }
  if (commandsOnly || !root) return null;
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
