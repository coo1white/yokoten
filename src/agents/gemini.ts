// What yokoten knows about Google's Gemini CLI: the shape of its BeforeTool and AfterAgent events, and where
// its project and user hooks live. Source: https://geminicli.com/docs/hooks/ (reference, and the
// tools pages for each tool's arguments).
//
// Gemini CLI fingerprints a project hook by its name and command, and warns once before
// it first runs a new or changed one.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { guardCommand, missingProjectRuntime } from '../run/cli.ts';
import type { Action } from '../run/hook.ts';
import { type Added, addHook, hasHook } from './hooks-file.ts';

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
 * The project's tool-call guard. GEMINI_PROJECT_DIR is the folder Gemini CLI was started
 * in, not a repo root. Gemini (v0.64.0) puts it into the command text already shell-quoted,
 * so the command leaves it unquoted, as the docs example does: quoting it again breaks a
 * path with a space, and the hook would fail open. An older quoted hook is updated in place.
 */
export const addProjectHook = (root: string, cli: string) =>
  addHook(projectSettings(root), 'BeforeTool', 'run_shell_command|write_file|replace', guardCommand(`$GEMINI_PROJECT_DIR/${cli}`, 'hook --agent gemini', missingProjectRuntime(cli)), {
    name: 'yokoten',
  });
export const hasProjectHook = (root: string): boolean => hasHook(projectSettings(root), 'BeforeTool', 'hook');

/**
 * The project's stop check (#211). Gemini's AfterAgent event runs when the agent ends its
 * turn; its input has `cwd` and `stop_hook_active`, and exit 2 with a reason on stderr
 * makes the agent try again.
 */
export const addProjectStopHook = (root: string, cli: string) =>
  addHook(projectSettings(root), 'AfterAgent', undefined, guardCommand(`$GEMINI_PROJECT_DIR/${cli}`, 'hook --stop --agent gemini', missingProjectRuntime(cli)), {
    name: 'yokoten-stop',
  });
export const hasProjectStopHook = (root: string): boolean => hasHook(projectSettings(root), 'AfterAgent', 'hook');

/** An AfterAgent event: the same fields as Claude Code's Stop (`cwd`, `stop_hook_active`). */
export { readStop } from './claude-code.ts';

/**
 * What a SessionStart hook prints: Gemini CLI reads the agent's context from JSON
 * (`hookSpecificOutput.additionalContext`), not from plain text.
 */
export const formatSessionContext = (text: string): string => JSON.stringify({ hookSpecificOutput: { additionalContext: text } });

const userSettings = (env: Env) => join(env.HOME || homedir(), '.gemini', 'settings.json');

/** The user's hooks, in every repo: doctor at session start, and the command guard on shell calls. `missing` is what they say when `cli` is gone. */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  return {
    doctor: addHook(userSettings(env), 'SessionStart', undefined, guardCommand(cli, 'doctor --session --agent gemini', missing, { isSessionStart: true, sessionOutput: 'json' }), { name: 'yokoten-session' }),
    guard: addHook(userSettings(env), 'BeforeTool', SHELL, guardCommand(cli, 'hook --agent gemini --commands-only', missing), { name: 'yokoten-guard' }),
  };
}

/** Whether Gemini CLI looks used on this machine: its user folder, ~/.gemini, exists. */
export const hasUserDir = (env: Env): boolean => existsSync(dirname(userSettings(env)));

/** Whether the user's hooks from `addUserHooks` are there: doctor at session start, and the command guard. */
export const hasUserHooks = (env: Env): { doctor: boolean; guard: boolean } => ({
  doctor: hasHook(userSettings(env), 'SessionStart', 'doctor'),
  guard: hasHook(userSettings(env), 'BeforeTool', 'hook'),
});
