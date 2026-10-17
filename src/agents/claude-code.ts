// Everything yokoten knows about Claude Code: the shape of its tool calls, where its
// settings, skills and agents live, and how its hooks are written. Another runtime gets
// a sibling file with the same exports.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { runs, subcommand } from '../run/cli.ts';
import type { Action } from '../run/hook.ts';

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

/** The user's hooks, in every repo: doctor at session start, and the command guard. */
export function addUserHooks(env: Env, cli: string): { doctor: Added; guard: Added } {
  return {
    doctor: addHook(userSettings(env), 'SessionStart', undefined, `node ${cli} doctor --session`),
    guard: addHook(userSettings(env), 'PreToolUse', 'Bash', `node ${cli} hook --commands-only`),
  };
}
export const hasSessionDoctor = (env: Env): boolean => hasHook(userSettings(env), 'SessionStart', 'doctor');

type Added = 'same' | 'updated' | 'added';

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/**
 * Add a command hook to a settings file, once. A hook that runs the same yokoten `<sub>`
 * counts as already there (an older path is updated in place).
 */
function addHook(settingsPath: string, event: string, matcher: string | undefined, command: string): Added {
  let settings: Settings = {};
  if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const sub = subcommand(command);
  const groups = ((settings.hooks ??= {})[event] ??= []);
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (sub && runs(sub).test(hook.command ?? '')) {
        if (hook.command === command && (group.matcher ?? '') === (matcher ?? '')) return 'same';
        hook.command = command;
        if (matcher !== undefined) group.matcher = matcher;
        writeSettings(settingsPath, settings);
        return 'updated';
      }
    }
  }
  const group: HookGroup = { hooks: [{ type: 'command', command }] };
  if (matcher !== undefined) group.matcher = matcher;
  groups.push(group);
  writeSettings(settingsPath, settings);
  return 'added';
}

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function hasHook(settingsPath: string, event: string, sub: string): boolean {
  try {
    const settings: Settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return (settings.hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => runs(sub).test(h.command ?? '')));
  } catch {
    return false;
  }
}
