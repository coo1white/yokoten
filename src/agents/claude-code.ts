// Everything yokoten knows about Claude Code: the shape of its tool calls, where its
// settings, skills and agents live, and how its hooks are written. Each other runtime
// gets a sibling file with the same tool-call exports (codex.ts, gemini.ts).

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import type { Action } from '../run/hook.ts';
import { type Added, addHook, hasHook, readSettings, writeSettings } from './hooks-file.ts';

/**
 * A PreToolUse call, as an Action. The guard reads the fields, not the tool's name:
 * `tool_input.command` for a shell call, `file_path` (or `path`, `notebook_path`) for an
 * edit. A subagent whose type names a worker is a worker.
 */
export function readToolCall(input: unknown): Action {
  const call = (input ?? {}) as { cwd?: unknown; agent_type?: unknown; tool_input?: Record<string, unknown> };
  const tool = call.tool_input ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    command: typeof tool.command === 'string' ? tool.command : undefined,
    paths: [tool.file_path, tool.path, tool.notebook_path].map(text).filter((p) => p !== undefined),
    cwd: text(call.cwd),
    worker: /worker/i.test(text(call.agent_type) ?? ''),
  };
}

/**
 * A Stop event (the agent is about to end its turn), or null when the input is not one.
 * `active` is Claude Code's `stop_hook_active`: a stop hook already sent the agent back.
 */
export function readStop(input: unknown): { cwd?: string; active: boolean } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const event = input as { cwd?: unknown; stop_hook_active?: unknown };
  return {
    cwd: typeof event.cwd === 'string' && event.cwd !== '' ? event.cwd : undefined,
    active: event.stop_hook_active === true,
  };
}

/** Where Claude Code keeps a user's skills, agents and settings. */
export const userDir = (env: Env): string => join(env.HOME || homedir(), '.claude');
export const skillFile = (env: Env, name: string): string => join(userDir(env), 'skills', name, 'SKILL.md');
export const agentFile = (env: Env, file: string): string => join(userDir(env), 'agents', file);

const userSettings = (env: Env) => join(userDir(env), 'settings.json');
const projectSettings = (root: string) => join(root, '.claude', 'settings.json');

/** The project's tool-call guard: every shell call and edit goes past `hook` first. */
export const addProjectHook = (root: string, cli: string) =>
  addHook(projectSettings(root), 'PreToolUse', 'Bash|Edit|Write|MultiEdit|NotebookEdit', `node "$CLAUDE_PROJECT_DIR/${cli}" hook`);
export const hasProjectHook = (root: string): boolean => hasHook(projectSettings(root), 'PreToolUse', 'hook');

/**
 * The project's stop check (#92): before the agent ends its turn, `hook --stop` checks the
 * changed files. It catches a file changed by sed or a script, which the tool-call guard
 * does not see. Stop takes no matcher.
 */
export const addProjectStopHook = (root: string, cli: string) =>
  addHook(projectSettings(root), 'Stop', undefined, `node "$CLAUDE_PROJECT_DIR/${cli}" hook --stop`);

/**
 * An environment variable for every agent session in the project (settings "env"). Used
 * for TZ=UTC, so the agents' commits record no time zone.
 */
export function setProjectEnv(root: string, key: string, value: string): Added {
  const path = projectSettings(root);
  const settings = readSettings(path);
  const env = (settings.env ??= {}) as Record<string, string>;
  if (env[key] === value) return 'same';
  const had = key in env;
  env[key] = value;
  writeSettings(path, settings);
  return had ? 'updated' : 'added';
}

/** The user's hooks, in every repo: doctor at session start, and the command guard. */
export function addUserHooks(env: Env, cli: string): { doctor: Added; guard: Added } {
  return {
    doctor: addHook(userSettings(env), 'SessionStart', undefined, `node ${cli} doctor --session`),
    guard: addHook(userSettings(env), 'PreToolUse', 'Bash', `node ${cli} hook --commands-only`),
  };
}
export const hasSessionDoctor = (env: Env): boolean => hasHook(userSettings(env), 'SessionStart', 'doctor');
