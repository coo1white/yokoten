// Everything yokoten knows about Claude Code: the shape of its tool calls, where its
// settings, skills and agents live, and how its hooks are written. Each other runtime
// gets a sibling file with the same tool-call exports (codex.ts, gemini.ts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { releaseFix } from '../../rules/guard/guards.ts';
import { homeIn, homeOf } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import { type Action, isWorkerType, readStopFields, type StopEvent } from '../../run/hook.ts';
import type { AgentAdapter } from './runtime.ts';
import { type Added, addHook, checkHooksFile, hasHook, isObject, type Problem, readTable, removeHook, type Settings, UnreadableHooksFile, writeSettings } from '../hooks-file.ts';
import type { RuntimeEnv } from '../desk/agent-env.ts';
import type { RuntimeDesk } from '../desk/desk.ts';

/**
 * A PreToolUse call, as an Action. The guard reads the fields, not the tool's name:
 * `tool_input.command` for a shell call, `file_path` (or `path`, `notebook_path`) for an
 * edit. A subagent is a worker only when its type is `worker`, or ends with `:worker`.
 */
export function readToolCall(input: unknown): Action {
  const call = (input ?? {}) as { cwd?: unknown; agent_type?: unknown; tool_name?: unknown; tool_input?: Record<string, unknown> };
  const tool = call.tool_input ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  // Claude Code's PowerShell tool names itself: its command is read as PowerShell (#332).
  const shell = text(call.tool_name)?.toLowerCase() === 'powershell' ? 'powershell' : undefined;
  return {
    command: typeof tool.command === 'string' ? tool.command : undefined,
    paths: [tool.file_path, tool.path, tool.notebook_path].map(text).filter((p) => p !== undefined),
    cwd: text(call.cwd),
    // Only a named PowerShell call carries the field: another reader compares the whole object.
    ...(shell ? { shell } : {}),
    worker: isWorkerType(text(call.agent_type) ?? ''),
  };
}

/**
 * How a refusal reaches Claude Code (#707). Its hook docs
 * (https://code.claude.com/docs/en/hooks) say "Exit 0 means success, and is the intended
 * exit code when you print JSON for structured control", and that
 * `permissionDecision: "deny"` "prevents the tool call". So a hook that was installed with
 * `--agent claude-code` answers in `hookSpecificOutput` on exit 0: no "PreToolUse:Bash
 * hook: error" line and no shell wrapper around the reason.
 *
 * The `--agent` the hook was installed with decides, never an environment variable: another
 * host that inherits `CLAUDECODE` must not get an answer that treats exit 0 as a block.
 * `YOKOTEN_HOOK_DENIAL=exit2` is the way back to the older answer.
 */
export const formatDenial = (reason: string, env: Env = {}): { stdout: string; exitCode: number } =>
  env.YOKOTEN_HOOK_DENIAL === 'exit2'
    ? fallbackDenial(reason)
    : { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }), exitCode: 0 };

/**
 * The answer for a hook not installed as Claude Code's: the reason as JSON on stdout, and
 * exit 2. GitHub Copilot CLI reads the same `.claude/settings.json` and refuses on the exit
 * code alone, so its hook keeps this answer.
 */
export const fallbackDenial = (reason: string): { stdout: string; exitCode: number } => ({ stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }), exitCode: 2 });

/**
 * How a question reaches the person before the call runs (#401): PreToolUse's `ask`
 * decision, on exit 0. Claude Code shows the reason and runs the call only after a yes.
 * A runtime that has no such question gets the ask from commands/hook.ts as a note.
 */
export const formatAsk = (reason: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } });

/**
 * Text added to the agent's context by an allowed PreToolUse call (#674): `additionalContext`
 * on exit 0, with no decision, so Claude Code's own permission rules still decide the call.
 */
export const formatContext = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });

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
 * (#405). `source` is startup, resume, clear or compact; `model`, when there, is the session's model. The id names a file, so only
 * letters, digits, `-` and `_` pass. `transcriptPath`, when there, is the session log.
 */
export function readSessionStart(input: unknown): { sessionId: string; source: string; model?: string; transcriptPath?: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const event = input as { session_id?: unknown; source?: unknown; model?: unknown; transcript_path?: unknown };
  if (typeof event.session_id !== 'string' || !/^[\w-]{1,128}$/.test(event.session_id)) return null;
  // The model names the session on the board only (#685): a plain short name, or nothing.
  const model = typeof event.model === 'string' && /^[\w.:\[\]-]{1,64}$/.test(event.model) ? event.model : '';
  const transcriptPath = typeof event.transcript_path === 'string' ? event.transcript_path : '';
  return { sessionId: event.session_id, source: typeof event.source === 'string' ? event.source : '', ...(model ? { model } : {}), ...(transcriptPath ? { transcriptPath } : {}) };
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
    // `--agent claude-code` names the host at install time (#707): only this file is read by
    // Claude Code alone, so only this hook answers with a JSON deny on exit 0. The project
    // hook is shared with Copilot CLI and Grok CLI, so it keeps exit 2.
    guard: addHook(path, 'PreToolUse', 'Bash', guardCommand(cli, 'hook --commands-only --agent claude-code', missing, { isToolCall: true })),
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

/** The three release channels, and the plugin name Claude Code installs for each (#632). */
export type PluginChannel = 'stable' | 'beta' | 'dev';

const PLUGIN_NAMES: Record<PluginChannel, string> = { stable: 'yokoten', beta: 'yokoten-beta', dev: 'yokoten-dev' };

/**
 * The channel a plugin id such as `yokoten-beta@yokoten` names. Null for another plugin.
 * One repo serves all three, so the name before `@` says which ref Claude Code installed.
 */
export function readPluginChannel(id: string): PluginChannel | null {
  const at = id.indexOf('@');
  if (at < 0) return null;
  const name = id.slice(0, at);
  return (Object.keys(PLUGIN_NAMES) as PluginChannel[]).find((channel) => PLUGIN_NAMES[channel] === name) ?? null;
}

/**
 * The channel of the yokoten plugin on in the user's settings; null when none is on.
 * `enabledPlugins` keys are `<plugin>@<marketplace>`, so the marketplace name may differ.
 */
export function enabledPluginChannel(env: Env): PluginChannel | null {
  // A settings file yokoten can't read, or none with no home folder, enables nothing.
  if (!homeOf(env)) return null;
  const table = readTable(userSettings(env), []);
  if ('problem' in table) return null;
  const enabled = table.settings.enabledPlugins;
  if (typeof enabled !== 'object' || enabled === null) return null;
  for (const [id, on] of Object.entries(enabled)) {
    const channel = readPluginChannel(id);
    if (channel !== null && on === true) return channel;
  }
  return null;
}

/**
 * Whether a yokoten plugin is on in the user's settings (`enabledPlugins`). Any of the
 * three channels counts. The plugin brings the skills, the agents and both user-level
 * hooks, so it stands in for `install` in Claude Code.
 */
export function hasPlugin(env: Env): boolean {
  return enabledPluginChannel(env) !== null;
}

/** What Claude Code recorded about the installed yokoten plugin: its id, commit and package version. */
export interface InstalledPlugin {
  /** The plugin id, such as `yokoten-beta@yokoten`. */
  id: string;
  /** The release channel the id names. */
  channel: PluginChannel;
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
    const channel = readPluginChannel(id);
    if (channel === null || !Array.isArray(entries)) continue;
    const entry = entries.find((e) => e?.scope === 'user' || (root !== null && e?.projectPath === root));
    if (!entry) continue;
    const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    const at = id.indexOf('@');
    const name = id.slice(0, at);
    const marketplace = id.slice(at + 1);
    const folder = text(entry.installPath) ?? (text(entry.version) && join(plugins, 'cache', marketplace, name, entry.version));
    let version: string | null = null;
    try {
      if (folder) version = text(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).version);
    } catch {
      // no package.json in the install: the commit may still tell
    }
    return { id, channel, commit: text(entry.gitCommitSha), version };
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

// ---- The project's sandbox (#589) ----
//
// Claude Code runs shell commands inside an OS sandbox when `sandbox.enabled` is true
// (https://code.claude.com/docs/en/sandboxing): writes stay in the working directory and
// the temp folder, and network goes through a proxy whose allowlist starts empty, so a new
// host asks first. `.worktrees/` is inside the project, so a worker's worktree is covered.
// Copilot CLI reads this file's hooks too, but its own sandbox is user-level (#589).

/** The project's sandbox file, relative to the root. */
export const SANDBOX_FILE = '.claude/settings.json';

/** The settings with a well-shaped `sandbox` block, or the shape problem. */
function withSandbox(settings: Settings): { settings: Settings } | { problem: { kind: 'shape'; hint: string } } {
  if (settings.sandbox !== undefined && !isObject(settings.sandbox)) return { problem: { kind: 'shape', hint: '`sandbox` should be an object' } };
  return { settings };
}

/**
 * Write the project's Claude sandbox: the block when it is missing, `enabled` when the
 * block lacks it, and nothing else. `false` stays: the user's explicit choice is theirs,
 * and doctor names what differs. Returns what that took, or why the file was skipped.
 */
export function addProjectSandbox(root: string): 'added' | 'same' | 'kept' | Problem {
  const path = projectSettings(root);
  const table = readTable(path, PROJECT_EVENTS);
  if ('problem' in table) return table.problem;
  const envChecked = withEnv(table);
  if ('problem' in envChecked) return envChecked.problem;
  const shaped = withSandbox(envChecked.settings);
  if ('problem' in shaped) return shaped.problem;
  const sandbox = shaped.settings.sandbox as Record<string, unknown> | undefined;
  if (sandbox === undefined) {
    table.settings.sandbox = { enabled: true };
    writeSettings(path, table.settings);
    return 'added';
  }
  if (!Object.hasOwn(sandbox, 'enabled')) {
    sandbox.enabled = true;
    writeSettings(path, table.settings);
    return 'added';
  }
  return sandbox.enabled === true ? 'same' : 'kept';
}

/**
 * The Claude sandbox against what init writes, or null when it is in place: a missing or
 * switched-off block (`yokoten init` turns a missing one on), and wider values (filesystem
 * isolation off, or `*` in the network allowlist). Other sandbox keys stay the user's own.
 */
export function sandboxProblem(root: string): { what: string; fix: string } | null {
  const file = SANDBOX_FILE;
  const table = readTable(join(root, file), PROJECT_EVENTS);
  if ('problem' in table) {
    // readTable never reports comments (only checkHooks builds that one): json or shape.
    const problem = table.problem as { kind: 'json' } | { kind: 'shape'; hint: string };
    return problem.kind === 'json'
      ? { what: `can't read ${file}`, fix: 'make it valid JSON, then run `yokoten init`' }
      : { what: `${file} has an unexpected shape`, fix: `${problem.hint}; fix it, then run \`yokoten init\`` };
  }
  const envChecked = withEnv(table);
  if ('problem' in envChecked) {
    const problem = envChecked.problem as { kind: 'shape'; hint: string };
    return { what: `${file} has an unexpected shape`, fix: `${problem.hint}; fix it, then run \`yokoten init\`` };
  }
  const shaped = withSandbox(envChecked.settings);
  if ('problem' in shaped) return { what: `${file} has an unexpected shape`, fix: `${shaped.problem.hint}; fix it, then run \`yokoten init\`` };
  const sandbox = shaped.settings.sandbox as Record<string, unknown> | undefined;
  if (sandbox === undefined || !Object.hasOwn(sandbox, 'enabled')) return { what: `no sandbox in ${file}`, fix: '`yokoten init` adds it' };
  if (sandbox.enabled !== true) return { what: `the sandbox in ${file} is off`, fix: `set sandbox.enabled to true in ${file}` };
  const filesystem = sandbox.filesystem as Record<string, unknown> | undefined;
  if (isObject(filesystem) && filesystem.disabled === true) return { what: `the sandbox in ${file} has filesystem isolation off`, fix: `take sandbox.filesystem.disabled out of ${file}` };
  const network = sandbox.network as Record<string, unknown> | undefined;
  // Only a bare `*` in the list is a problem: it allows every host, likely by mistake. A
  // scoped wildcard (`*.example.com`) is the user's explicit choice, like a named host. A
  // non-list `allowedDomains` allows nothing: the proxy's allowlist starts empty, so another
  // shape is not a silent widening.
  const allowed = isObject(network) && Array.isArray(network.allowedDomains) ? network.allowedDomains : null;
  if (allowed?.some((host) => typeof host === 'string' && host.trim() === '*')) {
    return { what: `the sandbox in ${file} allows every network host (*)`, fix: `list only the hosts the project needs in sandbox.network.allowedDomains in ${file}` };
  }
  return null;
}

/** The names this runtime's agent gets on top of the shared ones (#613). Claude Code signs in with its own login file; these are for an API key or a long-lived login token. */
export const AGENT_ENV: RuntimeEnv = { login: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], config: ['CLAUDE_CONFIG_DIR'] };

/**
 * What a desk (#637) gives Claude Code. CLAUDE_CONFIG_DIR points at the desk's own config
 * folder; only the login file (`.credentials.json`) is copied in, and `.claude.json` starts
 * fresh with onboarding done. The lead's `~/.claude` and `~/.claude.json` are never shown.
 * Hosts: the API, and platform.claude.com, where Claude Code renews an OAuth login. A
 * `claude setup-token` token in CLAUDE_CODE_OAUTH_TOKEN, or an API key, needs no renewal.
 * The binary names HTTPS_PROXY and NODE_USE_ENV_PROXY.
 */
export const DESK: RuntimeDesk = {
  leadState: (env) => [env.CLAUDE_CONFIG_DIR || join(homeIn(env), '.claude'), join(homeIn(env), '.claude.json')],
  login: (env) => [{ from: join(env.CLAUDE_CONFIG_DIR || join(homeIn(env), '.claude'), '.credentials.json'), to: '.credentials.json' }],
  starter: { '.claude.json': '{"hasCompletedOnboarding": true}\n' },
  stateEnv: (state) => ({ CLAUDE_CONFIG_DIR: state }),
  hosts: ['api.anthropic.com', 'platform.claude.com'],
};

const approve = (start: string) => `\`YOKOTEN_RELEASE_APPROVAL=1 ${start}\``;

/** The contract every adapter fills (#395). */
export const ADAPTER: AgentAdapter = {
  name: 'claude-code',
  label: 'Claude Code',
  projectHook: '`.claude/settings.json`: PreToolUse, Stop and SubagentStop',
  userHook: '~/.claude/settings.json',
  blocking: 'exit 2, the reason on stderr',
  capabilities: { canRewrite: true, hasStopHook: true, needsTrust: true, failsOpen: false, passesRole: true },
  readToolCall,
  readStop,
  formatDenial,
  formatAsk,
  formatContext,
  formatRewrite,
  releaseFix: releaseFix(`${approve('claude')} (or your agent's command)`),
  agentEnv: AGENT_ENV,
  desk: DESK,
  call: (command) => ({ cwd: '/repo', tool_name: 'Bash', tool_input: { command } }),
};
