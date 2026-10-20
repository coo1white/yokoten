// What yokoten knows about Google's Gemini CLI: the shape of its BeforeTool and AfterAgent events, and where
// its project and user hooks live. Source: https://geminicli.com/docs/hooks/ (reference, and the
// tools pages for each tool's arguments).
//
// Gemini CLI fingerprints a project hook by its name and command, and warns once before
// it first runs a new or changed one.
//
// Gemini CLI reads settings.json with comments allowed (packages/cli/src/config/settings.ts,
// `JSON.parse(stripJsonComments(content))`), so yokoten reads it the same way. A file with
// comments is never rewritten, since that would drop them: a hook not there yet is printed
// for the user to add by hand (#258).

import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeIn } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import type { Action } from '../../run/hook.ts';
import { type Added, addHook, checkHooks, hasHook, type HookArgs, type HookState, hookState, type ReadOptions } from '../hooks-file.ts';

/** How yokoten reads a Gemini CLI settings file: comments allowed, as Gemini CLI allows them. */
const READ: ReadOptions = { comments: true };

// run_shell_command takes `command`; write_file and replace take `file_path`.
const SHELL = 'run_shell_command';
const EDITS = new Set(['write_file', 'replace']);

/** A BeforeTool call, as an Action. Any other tool (read_file, MCP) is neither. */
export function readToolCall(input: unknown): Action {
  const call = (input ?? {}) as { cwd?: unknown; tool_name?: unknown; tool_input?: unknown };
  const tool = (typeof call.tool_input === 'object' && call.tool_input !== null ? call.tool_input : {}) as Record<string, unknown>;
  const name = typeof call.tool_name === 'string' ? call.tool_name : '';
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const file = text(tool.file_path);
  return {
    command: name === SHELL && typeof tool.command === 'string' ? tool.command : undefined,
    paths: EDITS.has(name) && file ? [file] : [],
    cwd: text(call.cwd),
    // A BeforeTool call names no subagent type; YOKOTEN_ROLE decides. Gemini's strict
    // environment sanitization removes YOKOTEN_ROLE, and then no session is a worker.
    worker: false,
  };
}

const projectSettings = (root: string) => join(root, '.gemini', 'settings.json');

/**
 * The two project hooks, as `addHook`'s arguments.
 *
 * - guard: the tool-call guard. GEMINI_PROJECT_DIR is the folder Gemini CLI was started
 *   in, not a repo root. Gemini (v0.64.0) puts it into the command text already
 *   shell-quoted, so the command leaves it unquoted, as the docs example does: quoting it
 *   again breaks a path with a space, and the hook would fail open. An older quoted hook
 *   is updated in place.
 * - stop: the stop check (#211). Gemini's AfterAgent event runs when the agent ends its
 *   turn; its input has `cwd` and `stop_hook_active`, and exit 2 with a reason on stderr
 *   makes the agent try again.
 */
const projectHookArgs = (root: string, cli: string): Record<'guard' | 'stop', HookArgs> => ({
  guard: [projectSettings(root), 'BeforeTool', 'run_shell_command|write_file|replace', guardCommand(`$GEMINI_PROJECT_DIR/${cli}`, 'hook --agent gemini', missingProjectRuntime(cli), { isToolCall: true }), { name: 'yokoten' }, READ],
  stop: [projectSettings(root), 'AfterAgent', undefined, guardCommand(`$GEMINI_PROJECT_DIR/${cli}`, 'hook --stop --agent gemini', missingProjectRuntime(cli)), { name: 'yokoten-stop' }, READ],
});

export const addProjectHook = (root: string, cli: string) => addHook(...projectHookArgs(root, cli).guard);
export const hasProjectHook = (root: string): boolean => hasHook(projectSettings(root), 'BeforeTool', 'hook', READ);
export const addProjectStopHook = (root: string, cli: string) => addHook(...projectHookArgs(root, cli).stop);
export const hasProjectStopHook = (root: string): boolean => hasHook(projectSettings(root), 'AfterAgent', 'hook', READ);

/**
 * Throw `UnreadableHooksFile` unless both project hooks can go in the file: check before
 * adding either. A file with comments and a hook missing throws both hooks to add by hand.
 */
export const checkProjectHooks = (root: string, cli: string): void => {
  const args = projectHookArgs(root, cli);
  checkHooks([args.guard, args.stop]);
};

/** The project hooks against what `init` would write with the same `cli`, read-only (see `hookState`). */
export function projectHooksState(root: string, cli: string): { guard: HookState; stop: HookState } {
  const args = projectHookArgs(root, cli);
  return { guard: hookState(...args.guard), stop: hookState(...args.stop) };
}

/** An AfterAgent event: the same fields as Claude Code's Stop (`cwd`, `stop_hook_active`). */
export { readStop } from './claude-code.ts';

/**
 * What a SessionStart hook prints: Gemini CLI reads the agent's context from JSON
 * (`hookSpecificOutput.additionalContext`), not from plain text.
 */
export const formatSessionContext = (text: string): string => JSON.stringify({ hookSpecificOutput: { additionalContext: text } });

const userSettings = (env: Env) => join(homeIn(env), '.gemini', 'settings.json');

/** The two user hooks, as `addHook`'s arguments: one builder for `addUserHooks` and `userHooksState`. */
const userHookArgs = (env: Env, cli: string, missing: string): Record<'doctor' | 'guard', HookArgs> => ({
  doctor: [userSettings(env), 'SessionStart', undefined, guardCommand(cli, 'doctor --session --agent gemini', missing, { isSessionStart: true, sessionOutput: 'json' }), { name: 'yokoten-session' }, READ],
  guard: [userSettings(env), 'BeforeTool', SHELL, guardCommand(cli, 'hook --agent gemini --commands-only', missing, { isToolCall: true }), { name: 'yokoten-guard' }, READ],
});

/** The user's hooks, in every repo: doctor at session start, and the command guard on shell calls. `missing` is what they say when `cli` is gone. */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  const args = userHookArgs(env, cli, missing);
  checkHooks([args.doctor, args.guard]);
  return { doctor: addHook(...args.doctor), guard: addHook(...args.guard) };
}

/** Whether Gemini CLI looks used on this machine: its user folder, ~/.gemini, is a folder. */
export function hasUserDir(env: Env): boolean {
  try {
    return statSync(dirname(userSettings(env))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The user's hooks against what `addUserHooks` would write with the same `cli` and
 * `missing`, read-only (see `hookState`): a hook with another command, matcher or runtime
 * path is 'updated', one not there is 'added'.
 */
export function userHooksState(env: Env, cli: string, missing: string): { doctor: HookState; guard: HookState } {
  const args = userHookArgs(env, cli, missing);
  return { doctor: hookState(...args.doctor), guard: hookState(...args.guard) };
}
