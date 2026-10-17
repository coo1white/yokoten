// The tool-call hook. The agent's runtime sends the call it is about to make as JSON on
// stdin; exit 2 with a reason on stderr stops it, exit 0 lets it go.
//
// The shape read is Claude Code's PreToolUse input: `tool_input.command` for a shell
// call, `tool_input.file_path` (or `path`, `notebook_path`) for an edit. The guard looks
// at the fields, not the tool's name, so a runtime that names its tools differently
// still gets checked as long as it uses those fields.

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Config, Env } from '../rules/config.ts';
import { checkCommand, checkEdit } from '../rules/guards.ts';

/** The fields of a PreToolUse call the guard reads. Anything else is ignored. */
export interface ToolCall {
  cwd?: string;
  agent_type?: string;
  tool_input?: { command?: unknown; file_path?: unknown; path?: unknown; notebook_path?: unknown };
}

/**
 * The reason to stop the call, or null. `root` is the repo root, or null outside a repo.
 * `commandsOnly` is the user-level hook: it runs in every repo, so it keeps to the rules
 * that hold everywhere (no tag pushes, no force pushes, no skipped checks) and leaves file
 * rules to each project's own hook.
 */
export function judge(
  input: ToolCall | null,
  { root, config, env, commandsOnly = false }: { root: string | null; config: Config; env: Env; commandsOnly?: boolean },
): string | null {
  const tool = input?.tool_input ?? {};
  if (typeof tool.command === 'string') return checkCommand(tool.command, { env });
  if (commandsOnly || !root) return null;
  // A subagent defined as a worker is a worker, whatever the session's own role.
  if (/worker/i.test(input?.agent_type ?? '')) env = { ...env, YOKOTEN_ROLE: 'worker' };
  for (const p of [tool.file_path, tool.path, tool.notebook_path]) {
    if (typeof p !== 'string' || p === '') continue;
    const rel = relative(real(root), real(resolve(input?.cwd ?? root, p)));
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
