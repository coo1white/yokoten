// Everything yokoten knows about Claude Code: the shape of its tool calls, where its
// settings, skills and agents live, and how its hooks are written. Each other runtime
// gets a sibling file with the same tool-call exports (codex.ts, gemini.ts).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { guardCommand, missingProjectRuntime } from '../run/cli.ts';
import type { Action } from '../run/hook.ts';
import { type Added, addHook, hasHook, isObject, readTable, type Settings, UnreadableHooksFile, writeSettings } from './hooks-file.ts';

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

/**
 * A Claude Code settings file, or null when yokoten won't touch it: it doesn't parse, its
 * top level isn't an object, or its `hooks` or `env` is the wrong type. Every reader and
 * writer of the user and project settings goes through this one check (#254).
 */
function readClaudeSettings(path: string): Settings | null {
  const table = readTable(path, []);
  const settings = 'problem' in table ? null : table.settings;
  return settings && (settings.env === undefined || isObject(settings.env)) ? settings : null;
}

/** The path, once it is known to be readable; else `UnreadableHooksFile`, before anything is written. */
function readable(path: string): string {
  if (!readClaudeSettings(path)) throw new UnreadableHooksFile(path, { kind: 'json' });
  return path;
}

/** Whether yokoten can read the user's ~/.claude/settings.json (a missing file is readable: it is empty). */
export const userSettingsReadable = (env: Env): boolean => readClaudeSettings(userSettings(env)) !== null;

/** The project's tool-call guard: every shell call and edit goes past `hook` first. */
export const addProjectHook = (root: string, cli: string) =>
  addHook(readable(projectSettings(root)), 'PreToolUse', 'Bash|Edit|Write|MultiEdit|NotebookEdit', guardCommand(`"$CLAUDE_PROJECT_DIR/${cli}"`, 'hook', missingProjectRuntime(cli)));
export const hasProjectHook = (root: string): boolean => readClaudeSettings(projectSettings(root)) !== null && hasHook(projectSettings(root), 'PreToolUse', 'hook');

/**
 * The project's stop check (#92): before the agent ends its turn, `hook --stop` checks the
 * changed files. It catches a file changed by sed or a script, which the tool-call guard
 * does not see. Stop takes no matcher.
 */
export const addProjectStopHook = (root: string, cli: string) =>
  addHook(readable(projectSettings(root)), 'Stop', undefined, guardCommand(`"$CLAUDE_PROJECT_DIR/${cli}"`, 'hook --stop', missingProjectRuntime(cli)));

/**
 * An environment variable for every agent session in the project (settings "env"). Used
 * for TZ=UTC, so the agents' commits record no time zone. A file that won't parse, or whose
 * `env` is the wrong type, throws `UnreadableHooksFile` and stays as it was.
 */
export function setProjectEnv(root: string, key: string, value: string): Added {
  const path = projectSettings(root);
  const settings = readClaudeSettings(path);
  if (!settings) throw new UnreadableHooksFile(path, { kind: 'json' });
  const env = (settings.env ??= {}) as Record<string, unknown>;
  if (env[key] === value) return 'same';
  const had = key in env;
  env[key] = value;
  writeSettings(path, settings);
  return had ? 'updated' : 'added';
}

/**
 * The user's hooks, in every repo: doctor at session start, and the command guard.
 * `missing` is what they say when `cli` is gone. A settings file yokoten can't read throws
 * `UnreadableHooksFile` before either hook is written.
 */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  const path = readable(userSettings(env));
  return {
    doctor: addHook(path, 'SessionStart', undefined, guardCommand(cli, 'doctor --session', missing, { isSessionStart: true })),
    guard: addHook(path, 'PreToolUse', 'Bash', guardCommand(cli, 'hook --commands-only', missing)),
  };
}
export const hasSessionDoctor = (env: Env): boolean => userSettingsReadable(env) && hasHook(userSettings(env), 'SessionStart', 'doctor');

/**
 * Whether the yokoten plugin is on in the user's settings (`enabledPlugins`, the key
 * `yokoten@<marketplace>`). The plugin brings the skills, the agents and both user-level
 * hooks, so it stands in for `install` in Claude Code.
 */
export function hasPlugin(env: Env): boolean {
  // A settings file yokoten can't read enables nothing.
  const enabled = readClaudeSettings(userSettings(env))?.enabledPlugins;
  return typeof enabled === 'object' && enabled !== null && Object.entries(enabled).some(([id, on]) => id.startsWith('yokoten@') && on === true);
}

/** What Claude Code recorded about the installed yokoten plugin: its commit and its package version. */
export interface InstalledPlugin {
  commit: string | null;
  version: string | null;
}

/**
 * The installed yokoten plugin, from ~/.claude/plugins/installed_plugins.json: the user
 * install, or the one for this project. Claude Code records the commit it installed and
 * the folder it copied; that folder's package.json has the yokoten version. Null when
 * there is no install or the file is not the shape we know.
 */
export function readInstalledPlugin(env: Env, root: string | null): InstalledPlugin | null {
  const plugins = join(userDir(env), 'plugins');
  let installs: unknown;
  try {
    installs = JSON.parse(readFileSync(join(plugins, 'installed_plugins.json'), 'utf8')).plugins;
  } catch {
    return null;
  }
  if (typeof installs !== 'object' || installs === null) return null;
  for (const [id, entries] of Object.entries(installs)) {
    if (!id.startsWith('yokoten@') || !Array.isArray(entries)) continue;
    const entry = entries.find((e) => e?.scope === 'user' || (root !== null && e?.projectPath === root));
    if (!entry) continue;
    const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    const folder = text(entry.installPath) ?? (text(entry.version) && join(plugins, 'cache', id.slice('yokoten@'.length), 'yokoten', entry.version));
    let version: string | null = null;
    try {
      if (folder) version = text(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).version);
    } catch {
      // no package.json in the install: the commit may still tell
    }
    return { commit: text(entry.gitCommitSha), version };
  }
  return null;
}
