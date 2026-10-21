// What yokoten knows about Meta's Muse Code: the shape of its PreToolUse and Stop events,
// and where its project hooks live. Source: https://dev.meta.ai/docs/muse-code/extending,
// checked against Muse Code 1.4.10 on 2026-10-19.
//
// What the real runs showed, past the docs page:
// - Muse loads `.muse/hooks.json` only in a trusted workspace; otherwise it skips it without a word.
// - It runs a hook with `/bin/bash -c`, its cwd at the workspace root, and a short env:
//   no project-dir variable, and no YOKOTEN_ROLE, so a worker can't be told from the lead.
// - Exit 2 with the reason on stderr refuses the call. Any other failure (exit 1, a
//   timeout, a hooks.json that won't parse) lets the call run.
// - `matcher: "*"` also matches Muse's own tools (read_skill...), so the matcher names the tools.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeOf } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import type { Action } from '../../run/hook.ts';
import { type FolderTrust, folderKeys, isFolder } from '../folder-trust.ts';
import { type Added, addHook, checkHooksFile, type HookState, hookState, isObject } from '../hooks-file.ts';

// bash takes `command` and `workdir`; the edit tools take `path`.
const SHELL = 'bash';
const EDITS = new Set(['write_file', 'edit_file', 'apply_patch']);
const MATCHER = [SHELL, ...EDITS].join('|');

/** A PreToolUse call, as an Action. Any other tool (read_file, read_skill, MCP) is neither. */
export function readToolCall(input: unknown): Action {
  const call = isObject(input) ? input : {};
  const tool = isObject(call.tool_input) ? call.tool_input : {};
  const name = typeof call.tool_name === 'string' ? call.tool_name : '';
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const path = text(tool.path);
  return {
    command: name === SHELL ? text(tool.command) : undefined,
    paths: EDITS.has(name) && path ? [path] : [],
    cwd: (name === SHELL ? text(tool.workdir) : undefined) ?? text(call.cwd),
    // Muse names no subagent role, and cuts YOKOTEN_ROLE from the hook's env.
    worker: false,
  };
}

/** A Stop event: the same fields as Claude Code's (`cwd`, `stop_hook_active`). */
export { readStop } from './claude-code.ts';

const projectHooks = (root: string) => join(root, '.muse', 'hooks.json');

// Muse sets no project-dir variable; the path comes from the git root, as in Codex's hook.
const at = (cli: string) => `"$(git rev-parse --show-toplevel)/${cli}"`;
const guardArgs = (root: string, cli: string) =>
  [projectHooks(root), 'PreToolUse', MATCHER, guardCommand(at(cli), 'hook --agent muse', missingProjectRuntime(cli), { isToolCall: true })] as const;
const stopArgs = (root: string, cli: string) => [projectHooks(root), 'Stop', undefined, guardCommand(at(cli), 'hook --stop --agent muse', missingProjectRuntime(cli))] as const;

// Muse 1.4.11 runs a SessionStart hook and gives its output to the model (#556), as Claude Code does.
const sessionArgs = (root: string, cli: string) =>
  [projectHooks(root), 'SessionStart', undefined, guardCommand(at(cli), 'doctor --session --agent muse', missingProjectRuntime(cli), { isSessionStart: true })] as const;

/**
 * Write the session doctor, the tool-call guard and the stop check into `.muse/hooks.json`,
 * keeping every other hook. A file yokoten can't edit throws `UnreadableHooksFile` and
 * stays as it was.
 */
export function addProjectHooks(root: string, cli: string): { guard: Added; stop: Added; doctor: Added } {
  checkHooksFile(projectHooks(root), ['PreToolUse', 'Stop', 'SessionStart']);
  return { guard: addHook(...guardArgs(root, cli)), stop: addHook(...stopArgs(root, cli)), doctor: addHook(...sessionArgs(root, cli)) };
}

/** What `addProjectHooks` would do, read-only, for each hook (see `hookState`). */
export const projectHooksState = (root: string, cli: string): { guard: HookState; stop: HookState } => ({
  guard: hookState(...guardArgs(root, cli)),
  stop: hookState(...stopArgs(root, cli)),
});

// ---- Trust (#341) ----
//
// Muse saves trust in `trust.json` in its config folder: `$XDG_CONFIG_HOME/muse`, or
// `~/.config/muse`. Its shape, from Muse Code 1.4.10 on 2026-10-20:
// `{ "schema_version": 1, "projects": { "<folder>": { "decision": "trusted" } } }`.
// The folder is the git root: a session in a subfolder of a trusted repo is not asked
// again. A trusted folder does not cover a folder inside it that is not in a repo, and a
// key with a trailing slash trusts nothing: so doctor compares whole keys, exactly.

/** The one step that makes Muse run the project's hooks. */
export const TRUST_STEP = 'run `muse` in this folder and choose "Trust and continue"';

/** The fix when the guard is off: both ways to trust a folder (#554). */
export const TRUST_FIX = `${TRUST_STEP}, or pass \`--trust-workspace\` to \`muse exec\``;

/**
 * Whether the project's Muse guard is off because the folder is not trusted (#554). True
 * when .muse/hooks.json is there and Muse's trust store does not list the folder, or is not
 * there at all. False when Muse looks unused on this machine (no config folder), or when the
 * store can't be read: doctor can't tell, and says so as a note.
 */
export function isGuardOff(root: string, env: Env): boolean {
  if (!existsSync(projectHooks(root))) return false;
  const { state } = readTrust(root, env);
  return state === 'untrusted' || state === 'no store';
}

/** Whether Muse trusts the project at `root`, from its trust store. Read-only. */
export function readTrust(root: string, env: Env): FolderTrust {
  const store = env.XDG_CONFIG_HOME ? '$XDG_CONFIG_HOME/muse/trust.json' : '~/.config/muse/trust.json';
  const user = homeOf(env);
  const config = env.XDG_CONFIG_HOME || (user ? join(user, '.config') : '');
  if (!config) return { state: 'no home', store };
  const home = join(config, 'muse');
  const file = join(home, 'trust.json');
  if (!isFolder(home)) return { state: 'no home', store };
  if (!existsSync(file)) return { state: 'no store', store };
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { state: 'unreadable', store };
  }
  if (!isObject(saved) || saved.schema_version !== 1 || !isObject(saved.projects)) return { state: 'unreadable', store };
  const projects = saved.projects;
  const isTrusted = folderKeys(root).some((key) => {
    const entry = Object.hasOwn(projects, key) ? projects[key] : undefined;
    return isObject(entry) && entry.decision === 'trusted';
  });
  return { state: isTrusted ? 'trusted' : 'untrusted', store };
}
