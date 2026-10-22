// Everything yokoten knows about Claude Code: the shape of its tool calls, where its
// settings, skills and agents live, and how its hooks are written. Each other runtime
// gets a sibling file with the same tool-call exports (codex.ts, gemini.ts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeIn, homeOf } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import { type Action, readStopFields, type StopEvent } from '../../run/hook.ts';
import { type Added, addHook, checkHooksFile, hasHook, isObject, type Problem, readTable, removeHook, type Settings, UnreadableHooksFile, writeSettings } from '../hooks-file.ts';

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
 * How a refusal reaches the agent: the reason on stderr and exit 2, as Claude Code reads it.
 * GitHub Copilot CLI reads this file's hooks too (checked with 1.0.98 on 2026-10-19). It
 * refuses on exit 2 but tells the agent only "hook exited with code 2", unless stdout
 * names the reason. Claude Code ignores stdout on exit 2.
 */
export const formatDenial = (reason: string): { stdout: string; exitCode: number } => ({ stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }), exitCode: 2 });

/**
 * How the hook changes a shell command before it runs (#390): PreToolUse's
 * `updatedInput`, on exit 0. It replaces the whole tool input, so the other fields
 * (description, timeout) are copied. Claude Code applies `updatedInput` only with a
 * decision. `allow` skips the prompt for a command no permission rule covers; deny and
 * ask rules still apply. The hook rewrites only one plain read, so `allow` runs nothing
 * that changes or sends anything.
 */
export function formatRewrite(input: unknown, command: string, reason: string): string {
  const call = (input ?? {}) as { tool_input?: unknown };
  const tool = call.tool_input && typeof call.tool_input === 'object' ? call.tool_input : {};
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason, updatedInput: { ...tool, command } } });
}

/**
 * A SessionStart event, or null when the input is not one or has no usable session id
 * (#405). `source` is startup, resume, clear or compact. The id names a file, so only
 * letters, digits, `-` and `_` pass.
 */
export function readSessionStart(input: unknown): { sessionId: string; source: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const event = input as { session_id?: unknown; source?: unknown };
  if (typeof event.session_id !== 'string' || !/^[\w-]{1,128}$/.test(event.session_id)) return null;
  return { sessionId: event.session_id, source: typeof event.source === 'string' ? event.source : '' };
}

/**
 * Whether a SessionStart hook's input waits on stdin: Claude Code sets CLAUDE_PROJECT_DIR
 * for its hooks and writes the event to stdin. A terminal never has it, so doctor run by
 * hand never waits.
 */
export const hasSessionInput = (env: Env, isTerminal: boolean): boolean => Boolean(env.CLAUDE_PROJECT_DIR) && !isTerminal;

/**
 * A Stop or SubagentStop event (the agent or a worker subagent is about to end), or null
 * when the input is not one. `active` is Claude Code's `stop_hook_active`: a stop hook
 * already sent the agent back.
 */
export function readStop(input: unknown): StopEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return readStopFields(input);
}

/** Where Claude Code keeps a user's skills, agents and settings. */
export const userDir = (env: Env): string => join(homeIn(env), '.claude');
export const skillFile = (env: Env, name: string): string => join(userDir(env), 'skills', name, 'SKILL.md');
export const agentFile = (env: Env, file: string): string => join(userDir(env), 'agents', file);

const userSettings = (env: Env) => join(userDir(env), 'settings.json');
const projectSettings = (root: string) => join(root, '.claude', 'settings.json');

// The events yokoten adds to each file. A caller checks a file's events together before
// adding either hook, so a bad second event leaves the file as it was (#248, #254).
const USER_EVENTS = ['SessionStart', 'PreToolUse'];
const PROJECT_EVENTS = ['PreToolUse', 'Stop', 'SubagentStop'];
// Seconds Claude Code waits for the stop check, including a worker's done-when command (#614).
const STOP_TIMEOUT = 600;

/** The settings, when `setProjectEnv` can edit them: `env` is missing or an object. */
function withEnv(table: ReturnType<typeof readTable>): { settings: Settings } | { problem: Problem } {
  if ('problem' in table || table.settings.env === undefined || isObject(table.settings.env)) return table;
  return { problem: { kind: 'shape', hint: '`env` should be an object' } };
}

/**
 * Why yokoten won't edit the user's ~/.claude/settings.json, or null when it can (a missing
 * file is empty settings). Only the keys `addUserHooks` edits are checked (#254).
 */
export function userSettingsProblem(env: Env): Problem | null {
  const table = readTable(userSettings(env), USER_EVENTS);
  return 'problem' in table ? table.problem : null;
}

/**
 * Throw `UnreadableHooksFile` unless init can edit the project's .claude/settings.json: both
 * hook events and `env`. init calls it before writing any of the three (#254).
 */
export function checkProjectSettings(root: string): void {
  const path = projectSettings(root);
  const table = withEnv(readTable(path, PROJECT_EVENTS));
  if ('problem' in table) throw new UnreadableHooksFile(path, table.problem);
}

/** The project's tool-call guard: every shell call and edit goes past `hook` first. */
export const addProjectHook = (root: string, cli: string) =>
  addHook(projectSettings(root), 'PreToolUse', 'Bash|Edit|Write|MultiEdit|NotebookEdit', guardCommand(`"$CLAUDE_PROJECT_DIR/${cli}"`, 'hook', missingProjectRuntime(cli), { isToolCall: true }));
export const hasProjectHook = (root: string): boolean => hasHook(projectSettings(root), 'PreToolUse', 'hook');

/**
 * The project's stop check (#92, #614): before the agent ends its turn, and when a
 * subagent ends, `hook --stop` checks the changed files and a worker's done-when command.
 * Stop and SubagentStop take no matcher.
 */
export function addProjectStopHook(root: string, cli: string): Added {
  const path = projectSettings(root);
  checkHooksFile(path, ['Stop', 'SubagentStop']);
  const command = guardCommand(`"$CLAUDE_PROJECT_DIR/${cli}"`, 'hook --stop', missingProjectRuntime(cli));
  const extra = { timeout: STOP_TIMEOUT };
  const stop = addHook(path, 'Stop', undefined, command, extra);
  const sub = addHook(path, 'SubagentStop', undefined, command, extra);
  if (stop === 'added' || sub === 'added') return 'added';
  if (stop === 'updated' || sub === 'updated') return 'updated';
  return 'same';
}

/**
 * An environment variable for every agent session in the project (settings "env"). Used
 * for TZ=UTC, so the agents' commits record no time zone. A file that won't parse, or whose
 * `env` is the wrong type, throws `UnreadableHooksFile` and stays as it was.
 */
export function setProjectEnv(root: string, key: string, value: string): Added {
  const path = projectSettings(root);
  const table = withEnv(readTable(path, []));
  if ('problem' in table) throw new UnreadableHooksFile(path, table.problem);
  const { settings } = table;
  const env = (settings.env ??= {}) as Record<string, unknown>;
  if (env[key] === value) return 'same';
  const had = key in env;
  env[key] = value;
  writeSettings(path, settings);
  return had ? 'updated' : 'added';
}

/**
 * The user's hooks, in every repo: doctor at session start, and the command guard.
 * `missing` is what they say when `cli` is gone. A settings file yokoten can't edit throws
 * `UnreadableHooksFile` before either hook is written.
 */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  const path = userSettings(env);
  checkHooksFile(path, USER_EVENTS);
  return {
    doctor: addHook(path, 'SessionStart', undefined, guardCommand(cli, 'doctor --session', missing, { isSessionStart: true })),
    guard: addHook(path, 'PreToolUse', 'Bash', guardCommand(cli, 'hook --commands-only', missing, { isToolCall: true })),
  };
}
// With no home folder there are no user settings to read: nothing is on (#356).
export const hasSessionDoctor = (env: Env): boolean => homeOf(env) !== null && hasHook(userSettings(env), 'SessionStart', 'doctor');
export const hasUserGuard = (env: Env): boolean => homeOf(env) !== null && hasHook(userSettings(env), 'PreToolUse', 'hook');

/**
 * Take out the two hooks addUserHooks adds, and nothing else in the file. Null when the
 * file is not JSON: then it is left as it is.
 */
export function removeUserHooks(env: Env): { doctor: 'removed' | 'not there'; guard: 'removed' | 'not there' } | null {
  try {
    return { doctor: removeHook(userSettings(env), 'SessionStart', 'doctor'), guard: removeHook(userSettings(env), 'PreToolUse', 'hook') };
  } catch {
    return null;
  }
}

/**
 * Whether the yokoten plugin is on in the user's settings (`enabledPlugins`, the key
 * `yokoten@<marketplace>`). The plugin brings the skills, the agents and both user-level
 * hooks, so it stands in for `install` in Claude Code.
 */
export function hasPlugin(env: Env): boolean {
  // A settings file yokoten can't read, or none with no home folder, enables nothing.
  if (!homeOf(env)) return false;
  const table = readTable(userSettings(env), []);
  const enabled = 'problem' in table ? undefined : table.settings.enabledPlugins;
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
  if (!homeOf(env)) return null;
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

/**
 * The folder Claude Code keeps its temp files in: `claude-<uid>` under CLAUDE_CODE_TMPDIR,
 * else under the system temp folder, as Node's `os.tmpdir()` finds it (read in Claude
 * Code's own code, 2026-10-20). Claude Code refuses to start when another user owns it.
 * Windows has no uid, so there is no such folder to check.
 */
export const tempDir = (env: Env, uid: number): string => join(env.CLAUDE_CODE_TMPDIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp', `claude-${uid}`);
