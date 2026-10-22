// What yokoten knows about xAI's Grok CLI (`grok`): the shape of its PreToolUse and Stop
// events, where its hooks live, and its folder trust. Source: the hooks guide Grok CLI
// ships (~/.grok/docs/user-guide/10-hooks.md), checked against Grok CLI 1.0.52 with a
// real run on 2026-10-20 (#407).
//
// What the docs and the real run showed:
// - Grok reads hook files in `.grok/hooks/*.json` in a project, and `~/.grok/hooks/*.json`
//   (`$GROK_HOME/hooks`) for the user. The project's run only in a folder the user
//   trusts (`/hooks-trust`, or `grok --trust`); otherwise Grok skips them without a word.
// - The event has camelCase fields (`toolName`, `toolInput`, `stopHookActive`) and the
//   same in Claude Code's snake_case (`tool_name`, `tool_input`). A subagent's call
//   carries `subagentType`. The shell tool is `run_terminal_command`; a file edit is
//   `write` or `search_replace`; the matcher names every edit tool Grok's docs list.
// - Grok also runs the hooks in `.claude/settings.json` and `~/.claude/settings.json`
//   (its Claude compatibility, on by default), so a call may be guarded twice. That is on
//   purpose: a Grok hook can be skipped (an untrusted folder, an empty file a repo commits,
//   GROK_* variables set outside Grok), and a Claude hook that stepped aside for it would
//   leave the call unguarded. Safety comes before the second node start (#407).
// - A hook's default timeout is 5 seconds, and a timed-out hook lets the call run: the
//   guard's own deadline is 5 seconds, so these hooks set a longer `timeout`.
// - A deny is `permissionDecision: "deny"` on stdout; at exit 2 its reason, whole, is
//   what the model reads (stderr alone gives only its first line).

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeIn, homeOf } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import { type Action, readStopFields, type StopEvent } from '../../run/hook.ts';
import { type FolderTrust, folderKeys, isFolder } from '../folder-trust.ts';
import { type Added, addHook, checkHooksFile, type HookState, hookState, isObject } from '../hooks-file.ts';
import { readTomlTables } from './codex.ts';

// The shell tool takes `command` (and may take `cwd`); the edit tools take `file_path`.
const SHELL = new Set(['run_terminal_command', 'run_terminal_cmd', 'Bash']);
// Tools that read, search or fetch: neither a command nor an edit. An MCP tool
// (`server__tool`) is neither too.
const READ_ONLY = new Set(['read_file', 'grep', 'list_dir', 'web_search', 'web_fetch', 'todo_write', 'spawn_subagent', 'task']);
// The shell call and every tool that writes a file, by each name Grok's docs give them
// (1.0.52): Claude Code's names, which Grok maps to its own tools on every route, and
// Grok's own (`write`, `search_replace`, `write_file`). A matcher compares whole names.
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'EditNotebook', 'search_replace', 'write', 'write_file'];
const MATCHER = ['Bash', 'run_terminal_command', ...EDIT_TOOLS].join('|');
// Seconds Grok waits for the tool-call guard: well past its own deadline (GUARD_DEADLINE_MAX_MS).
const TIMEOUT = 60;
// Seconds Grok waits for the stop check: Grok's own default for Stop.
const STOP_TIMEOUT = 600;

/**
 * A PreToolUse call, as an Action: the shell call by its command, an edit by its file. A
 * read, a search, a web call or an MCP tool is neither. A subagent whose type names a
 * worker is a worker; YOKOTEN_ROLE, which Grok passes to its hooks, decides the rest.
 */
export function readToolCall(input: unknown): Action {
  const call = isObject(input) ? input : {};
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const name = text(call.toolName) ?? text(call.tool_name) ?? '';
  const tool = isObject(call.toolInput) ? call.toolInput : isObject(call.tool_input) ? call.tool_input : {};
  const cwd = text(call.cwd);
  const isShell = SHELL.has(name);
  const isEdit = !isShell && name !== '' && !READ_ONLY.has(name) && !name.includes('__');
  // A shell call's own `cwd`, when it has one, is where the command runs.
  const shellCwd = isShell ? text(tool.cwd) : undefined;
  const file = text(tool.file_path) ?? text(tool.path) ?? text(tool.notebook_path);
  return {
    command: isShell ? text(tool.command) : undefined,
    paths: isEdit && file ? [file] : [],
    cwd: shellCwd && (isAbsolute(shellCwd) || cwd) ? resolve(cwd ?? '', shellCwd) : cwd,
    worker: /worker/i.test(text(call.subagentType) ?? ''),
  };
}

/**
 * A Stop event, or null when there is nothing to check. Grok sends Stop at a turn's end
 * (`reason: "end_turn"`) and once more when the session ends (`"shutdown"`), which only
 * observes: that one is skipped. A worker subagent is a worker (#614).
 */
export function readStop(input: unknown): StopEvent | null {
  if (!isObject(input)) return null;
  if (typeof input.reason === 'string' && input.reason !== 'end_turn') return null;
  return readStopFields(input);
}

/** How a refusal reaches Grok: a deny on stdout, and exit 2, so the model reads the whole reason. */
export const formatDenial = (reason: string): { stdout: string; exitCode: number } => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  exitCode: 2,
});

/**
 * How the hook changes a shell command before it runs (#390): `updatedInput`, on exit 0,
 * with no decision. Grok checks it against the tool's schema and replaces the whole tool
 * input, so the other fields are copied. With no decision, the call keeps Grok's own
 * permission flow: the rewrite approves nothing.
 */
export function formatRewrite(input: unknown, command: string, reason: string): string {
  const call = isObject(input) ? input : {};
  const tool = isObject(call.toolInput) ? call.toolInput : isObject(call.tool_input) ? call.tool_input : {};
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...tool, command }, additionalContext: reason } });
}

/** The project's hook file: yokoten's own, next to any the user keeps in `.grok/hooks/`. */
export const HOOKS_FILE = '.grok/hooks/yokoten.json';
const projectHooks = (root: string) => join(root, HOOKS_FILE);

// Grok runs a hook in the workspace root and sets GROK_WORKSPACE_ROOT to it.
const at = (cli: string) => `"$GROK_WORKSPACE_ROOT/${cli}"`;
const guardArgs = (root: string, cli: string) =>
  [projectHooks(root), 'PreToolUse', MATCHER, guardCommand(at(cli), 'hook --agent grok', missingProjectRuntime(cli), { isToolCall: true }), { timeout: TIMEOUT }] as const;
const stopArgs = (root: string, cli: string) => [projectHooks(root), 'Stop', undefined, guardCommand(at(cli), 'hook --stop --agent grok', missingProjectRuntime(cli)), { timeout: STOP_TIMEOUT }] as const;

/**
 * Write the tool-call guard and the stop check into `.grok/hooks/yokoten.json`, keeping
 * every other hook. A file yokoten can't edit throws `UnreadableHooksFile` and stays as it was.
 */
export function addProjectHooks(root: string, cli: string): { guard: Added; stop: Added } {
  checkHooksFile(projectHooks(root), ['PreToolUse', 'Stop']);
  return { guard: addHook(...guardArgs(root, cli)), stop: addHook(...stopArgs(root, cli)) };
}

/** What `addProjectHooks` would do, read-only, for each hook (see `hookState`). */
export const projectHooksState = (root: string, cli: string): { guard: HookState; stop: HookState } => ({
  guard: hookState(...guardArgs(root, cli)),
  stop: hookState(...stopArgs(root, cli)),
});

/** Grok's home folder: `$GROK_HOME`, or ~/.grok; empty with neither (#356). Read-only uses. */
const homeDir = (env: Env) => {
  const user = homeOf(env);
  return env.GROK_HOME || (user ? join(user, '.grok') : '');
};
/** The user hook file; with no home folder it throws NO_HOME, so nothing is written in the repo. */
const userHooks = (env: Env) => join(env.GROK_HOME || join(homeIn(env), '.grok'), 'hooks', 'yokoten.json');
/** The user hook file, as the user would type it. */
export const userHooksFile = (env: Env): string => (env.GROK_HOME ? '$GROK_HOME/hooks/yokoten.json' : '~/.grok/hooks/yokoten.json');

// Only the command guard: Grok reads only `systemMessage` from a SessionStart hook, for the
// user, so a session-start doctor would not reach the agent.
const userGuardArgs = (env: Env, cli: string, missing: string) =>
  [userHooks(env), 'PreToolUse', 'Bash', guardCommand(cli, 'hook --agent grok --commands-only', missing, { isToolCall: true }), { timeout: TIMEOUT }] as const;

/** The user's command guard, in every repo: no tag pushes, no skipped checks. `missing` is what it says when `cli` is gone. */
export function addUserHooks(env: Env, cli: string, missing: string): { guard: Added } {
  checkHooksFile(userHooks(env), ['PreToolUse']);
  return { guard: addHook(...userGuardArgs(env, cli, missing)) };
}

/** The user's hook against what `addUserHooks` would write, read-only (see `hookState`). */
export const userHooksState = (env: Env, cli: string, missing: string): { guard: HookState } => ({ guard: hookState(...userGuardArgs(env, cli, missing)) });

/** Whether Grok CLI looks used on this machine: its home folder is there. */
export const hasUserDir = (env: Env): boolean => isFolder(homeDir(env));

// ---- Trust ----
//
// Grok saves trust in `trusted_folders.toml` in its home folder, as Grok CLI 1.0.52 wrote
// it in the real run: one `[folders."<folder>"]` table per folder, with `trusted = true` or
// `false`. `grok --trust` at a repo's root saved the root, with no trailing slash. Trust
// covers the folders inside the same repo, not a repo nested in it: so doctor compares
// whole keys, exactly. GROK_FOLDER_TRUST=0 (or false), or `[folder_trust] enabled = false`
// in Grok's config.toml, turns the gate off, and then every folder counts as trusted.

/** The one step that makes Grok run the project's hooks. yokoten never trusts a folder for the user. */
export const TRUST_STEP = 'run `grok` in this folder and type `/hooks-trust`';

/** Whether `[folder_trust] enabled = false` in Grok's config.toml turns its trust gate off. Read-only. */
function isTrustGateOff(home: string): boolean {
  try {
    const [tables] = readTomlTables(readFileSync(join(home, 'config.toml'), 'utf8'), [[]]);
    return tables.get('folder_trust')?.enabled === false;
  } catch {
    return false;
  }
}

/** Whether Grok trusts the project at `root`, from its trust store. Read-only. */
export function readTrust(root: string, env: Env): FolderTrust {
  const store = env.GROK_HOME ? '$GROK_HOME/trusted_folders.toml' : '~/.grok/trusted_folders.toml';
  const home = homeDir(env);
  const file = join(home, 'trusted_folders.toml');
  if (!isFolder(home)) return { state: 'no home', store };
  if (env.GROK_FOLDER_TRUST === '0' || env.GROK_FOLDER_TRUST?.toLowerCase() === 'false' || isTrustGateOff(home)) return { state: 'trusted', store };
  if (!existsSync(file)) return { state: 'no store', store };
  let folders: Map<string, Record<string, unknown>>;
  try {
    [folders] = readTomlTables(readFileSync(file, 'utf8'), [['folders']]);
  } catch {
    return { state: 'unreadable', store };
  }
  const isTrusted = folderKeys(root).some((key) => folders.get(key)?.trusted === true);
  return { state: isTrusted ? 'trusted' : 'untrusted', store };
}
