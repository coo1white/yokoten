// What yokoten knows about Meta's Muse Code: the shape of its PreToolUse and Stop events,
// and where its project hooks live. Source: https://dev.meta.ai/docs/muse-code/extending,
// checked against Muse Code 1.4.11 on 2026-10-22.
//
// What the real runs showed, past the docs page:
// - Muse loads `.muse/hooks.json` only in a trusted workspace; otherwise it skips it without a word.
// - It runs a hook with `/bin/bash -c`, its cwd at the workspace root, and a short env:
//   no project-dir variable, and no YOKOTEN_ROLE: the worker mark on its worktree tells a worker (#555).
// - Exit 2 with the reason on stderr refuses the call. Any other failure (exit 1, a
//   timeout, a hooks.json that won't parse) lets the call run.
// - `matcher: "*"` also matches Muse's own tools (read_skill...), so the matcher names the tools.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeIn, homeOf } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import type { Action } from '../../run/hook.ts';
import { type FolderTrust, folderKeys, isFolder, TRUST_COMMAND } from '../folder-trust.ts';
import { type TrustChange, type TrustPlan } from './codex.ts';
import { type Added, addHook, checkHooksFile, type HookArgs, type HookState, hookState, isObject } from '../hooks-file.ts';
import type { RuntimeEnv } from '../desk/agent-env.ts';
import type { RuntimeDesk } from '../desk/desk.ts';

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
    // Muse names no subagent role, and cuts YOKOTEN_ROLE from the hook's env: the worker mark decides (#555).
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
// Seconds Muse Code waits for a settings hook in `.muse/hooks.json`. Its hooks guide
// says this `timeout` is seconds (default 600). A plugin hook uses `timeoutMs` instead.
// Muse Code 1.4.11 keeps the two fields apart. A short value would cut the done-when
// command, and a timed-out hook lets the call run (#614).
const STOP_TIMEOUT = 600;
const stopArgs = (root: string, cli: string) =>
  [projectHooks(root), 'Stop', undefined, guardCommand(at(cli), 'hook --stop --agent muse', missingProjectRuntime(cli)), { timeout: STOP_TIMEOUT }] as const;

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
// `~/.config/muse`. Its shape, as Muse Code 1.4.11 wrote it on 2026-10-22:
// `{ "schema_version": 1, "projects": { "<folder>": { "decision": "trusted" } } }`.
// The folder is the git root: a session in a subfolder of a trusted repo is not asked
// again. A trusted folder does not cover a folder inside it that is not in a repo, and a
// key with a trailing slash trusts nothing: so doctor compares whole keys, exactly.

/** The one step that makes Muse run the project's hooks. */
export const TRUST_STEP = TRUST_COMMAND;

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

/**
 * What yokoten must write into `trust.json` to trust this folder (#661). Muse's trust is
 * per folder: this one decision is what makes yokoten's hooks run.
 */
export function trustProject(root: string, env: Env): TrustPlan {
  const store = env.XDG_CONFIG_HOME ? '$XDG_CONFIG_HOME/muse/trust.json' : '~/.config/muse/trust.json';
  const user = homeOf(env);
  const config = env.XDG_CONFIG_HOME || (user ? join(user, '.config') : '');
  if (!config) return { state: 'no home', store, changes: [] };
  const home = join(config, 'muse');
  const file = join(home, 'trust.json');
  let text = '';
  try {
    if (existsSync(file)) text = readFileSync(file, 'utf8');
  } catch {
    return { state: 'unreadable', store, changes: [] };
  }
  let projects: Record<string, unknown> = {};
  if (text !== '') {
    let saved: unknown;
    try {
      saved = JSON.parse(text);
    } catch {
      return { state: 'unreadable', store, changes: [] };
    }
    if (!isObject(saved) || saved.schema_version !== 1 || !isObject(saved.projects)) return { state: 'unreadable', store, changes: [] };
    projects = saved.projects;
  }
  const keys = folderKeys(root);
  const folder = keys.find((key) => Object.hasOwn(projects, key)) ?? keys[0];
  const entry = projects[folder];
  if (isObject(entry) && entry.decision === 'trusted') return { state: 'same', store, changes: [] };
  const before = isObject(entry) && typeof entry.decision === 'string' ? entry.decision : null;
  const change: TrustChange = { agent: 'Muse Code', store, file, format: 'json', path: ['projects', folder], key: 'decision', value: 'trusted', before };
  return { state: 'trusted', store, changes: [change], seed: { schema_version: 1, projects: {} } };
}

// ---- The user's hooks (#557) ----
//
// Muse reads a `hooks` block in its user settings, `$XDG_CONFIG_HOME/muse/settings.json`
// or `~/.config/muse/settings.json`, in every repo: a SessionStart hook's plain stdout
// reaches the model, as a PreToolUse refusal stops the call. Checked against Muse Code
// 1.4.11 on 2026-10-22: a SessionStart hook in that file fired in a headless run.

/** Muse's config folder: `$XDG_CONFIG_HOME/muse`, or `~/.config/muse`. */
const configDir = (env: Env): string => join(env.XDG_CONFIG_HOME || join(homeIn(env), '.config'), 'muse');

/** The user's settings file. With no home folder it throws NO_HOME, so nothing is written. */
const userSettings = (env: Env): string => join(configDir(env), 'settings.json');

/** The user's settings file, as the user would type it. */
export const userSettingsFile = (env: Env): string => (env.XDG_CONFIG_HOME ? '$XDG_CONFIG_HOME/muse/settings.json' : '~/.config/muse/settings.json');

/** The two user hooks, as `addHook`'s arguments: one builder for `addUserHooks` and `userHooksState`. */
const userHookArgs = (env: Env, cli: string, missing: string): Record<'doctor' | 'guard', HookArgs> => ({
  doctor: [userSettings(env), 'SessionStart', undefined, guardCommand(cli, 'doctor --session --agent muse', missing, { isSessionStart: true })],
  guard: [userSettings(env), 'PreToolUse', SHELL, guardCommand(cli, 'hook --agent muse --commands-only', missing, { isToolCall: true })],
});

/**
 * The user's hooks, in every repo: doctor at session start, and the command guard on
 * shell calls. `missing` is what they say when `cli` is gone. A settings file yokoten
 * can't edit throws `UnreadableHooksFile` before either hook is written.
 */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  const args = userHookArgs(env, cli, missing);
  checkHooksFile(args.doctor[0], [args.doctor[1], args.guard[1]]);
  return { doctor: addHook(...args.doctor), guard: addHook(...args.guard) };
}

/** Whether Muse Code looks used on this machine: its config folder is there. */
export function hasUserDir(env: Env): boolean {
  try {
    return isFolder(configDir(env));
  } catch {
    return false;
  }
}

/**
 * The user's hooks against what `addUserHooks` would write with the same `cli` and
 * `missing`, read-only (see `hookState`).
 */
export function userHooksState(env: Env, cli: string, missing: string): { doctor: HookState; guard: HookState } {
  const args = userHookArgs(env, cli, missing);
  return { doctor: hookState(...args.doctor), guard: hookState(...args.guard) };
}

/** The names this runtime's agent gets on top of the shared ones (#613). Muse Code: Meta's docs name the model API key MODEL_API_KEY. Its config is under XDG_CONFIG_HOME, which every agent gets. */
export const AGENT_ENV: RuntimeEnv = { login: ['MODEL_API_KEY'], config: [] };

/**
 * What a desk (#637) gives Muse Code. XDG_CONFIG_HOME and XDG_DATA_HOME point into the
 * desk's own folder; only `muse/auth.json` is copied in. Host: Meta's API. The binary
 * names HTTPS_PROXY, ALL_PROXY and MUSE_HTTP_PROXY.
 */
export const DESK: RuntimeDesk = {
  leadState: (env) => [configDir(env), join(env.XDG_DATA_HOME || join(homeIn(env), '.local', 'share'), 'muse')],
  login: (env) => [{ from: join(configDir(env), 'auth.json'), to: join('config', 'muse', 'auth.json') }],
  stateEnv: (state) => ({ XDG_CONFIG_HOME: join(state, 'config'), XDG_DATA_HOME: join(state, 'data') }),
  hosts: ['api.meta.ai'],
};
