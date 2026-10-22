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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeIn, homeOf } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import { type Action, isWorkerType, readStopFields, type StopEvent } from '../../run/hook.ts';
import { type FolderTrust, folderKeys, isFolder } from '../folder-trust.ts';
import { type Added, addHook, checkHooksFile, type HookState, hookState, isObject } from '../hooks-file.ts';
import { blankedToml, hasTomlArray, hasTomlHeader, hasTomlKey, hasTomlTable, isInsideProject, parseToml, readTomlTables } from './codex.ts';
import type { RuntimeEnv } from '../desk/agent-env.ts';
import type { RuntimeDesk } from '../desk/desk.ts';

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
 * read, a search, a web call or an MCP tool is neither. A subagent is a worker only
 * when its type is `worker`, or ends with `:worker`. YOKOTEN_ROLE decides the rest.
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
    worker: isWorkerType(text(call.subagentType) ?? ''),
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

// ---- The project's sandbox (#589) ----
//
// Grok keeps custom sandbox profiles in `.grok/sandbox.toml` in the project
// (`~/.grok/docs/user-guide/18-sandbox.md`, Grok CLI 1.0.52): `[profiles.<name>]` with
// `extends` naming a built-in. The built-in `workspace` is the recommended dev profile:
// writes stay in the working directory, reads go anywhere, child processes keep network.
// A project can't select the profile (`[sandbox] profile` is user-level), so workers run
// with `--sandbox yokoten`. `strict` also passes doctor: it writes the same folder with
// tighter reads; `devbox` and `read-only` don't, one too wide and one too narrow.

// The project's sandbox file, relative to the root.
export const SANDBOX_FILE = '.grok/sandbox.toml';

// The profile init writes, and what it builds on.
const PROFILE = 'yokoten';
const PROFILE_BASE = 'workspace';

// The file init writes when `.grok/sandbox.toml` is missing.
const FRESH_SANDBOX = `# The Grok sandbox profile for this project, written by yokoten init. Workers run with
# \`grok --sandbox yokoten\`: writes stay in the project. Your other profiles stay.
[profiles.yokoten]
extends = "workspace"
`;

/**
 * The `[profiles.yokoten]` table: parsed, `blocked` when `profiles` or `yokoten` is taken
 * in another shape (writing the table would corrupt the file), or null when missing. A
 * quoted header reads as empty (no base means workspace); an array header (`[[x]]`) is
 * blocked, as writing the table next to it would corrupt the file.
 */
function readProfile(text: string): Record<string, unknown> | 'blocked' | null {
  const parsed = parseToml(text);
  if (parsed.profiles !== undefined && !isObject(parsed.profiles)) return 'blocked';
  const yokoten = isObject(parsed.profiles) ? parsed.profiles.yokoten : undefined;
  if (yokoten !== undefined && !isObject(yokoten)) return 'blocked';
  if (isObject(yokoten)) return yokoten;
  if (hasTomlArray(text, ['profiles', PROFILE])) return 'blocked';
  if (hasTomlHeader(text, ['profiles', PROFILE])) return {};
  const blanked = blankedToml(text);
  return hasTomlTable(blanked, ['profiles', PROFILE]) || hasTomlKey(blanked, PROFILE) ? {} : null;
}

/**
 * Write the project's Grok sandbox: the `[profiles.yokoten]` table when it is missing,
 * and nothing else. A table the user set stays, even when it differs (`kept`).
 */
export function addProjectSandbox(root: string): 'added' | 'same' | 'kept' | 'unreadable' {
  const path = join(root, SANDBOX_FILE);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, FRESH_SANDBOX);
    return 'added';
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 'unreadable';
  }
  const profile = readProfile(text);
  if (profile === 'blocked') return 'kept';
  if (profile !== null) return profile.extends === undefined || profile.extends === PROFILE_BASE ? 'same' : 'kept';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  lines.push('', '[profiles.yokoten]', `extends = "${PROFILE_BASE}"`, '');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join(newline));
  return 'added';
}

/**
 * The Grok sandbox against what init writes, or null when the profile is in place: a
 * missing table (`yokoten init` adds it), a base that is too wide (`devbox`) or too
 * narrow (`read-only`), and writes outside the project (`read_write`). Never prints a
 * path: it may hold the user's home folder.
 */
export function sandboxProblem(root: string, env: Env): { what: string; fix: string } | null {
  const file = SANDBOX_FILE;
  if (!existsSync(join(root, file))) return { what: `no Grok sandbox profile in ${file}`, fix: '`yokoten init` adds it' };
  let text: string;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return { what: `can't read ${file}`, fix: 'make it readable, then run `yokoten init`' };
  }
  const profile = readProfile(text);
  if (profile === null) return { what: `no Grok sandbox profile in ${file}`, fix: '`yokoten init` adds it' };
  if (profile === 'blocked') return { what: `${file} has an unexpected shape`, fix: 'fix it, then run `yokoten init`' };
  const base = profile.extends;
  if (base === undefined) {
    if (hasTomlKey(blankedToml(text), 'extends')) return { what: `the Grok sandbox profile does not build on workspace or strict`, fix: `set extends to "${PROFILE_BASE}" in ${file}` };
  } else if (base === 'devbox') return { what: `the Grok sandbox profile writes almost everywhere (devbox)`, fix: `set extends to "${PROFILE_BASE}" in ${file}` };
  else if (base === 'read-only') return { what: `the Grok sandbox profile is read-only, so workers can't write`, fix: `set extends to "${PROFILE_BASE}" in ${file}` };
  else if (base !== 'workspace' && base !== 'strict') return { what: `the Grok sandbox profile does not build on workspace or strict`, fix: `set extends to "${PROFILE_BASE}" in ${file}` };
  const extra = profile.read_write;
  if (extra !== undefined || hasTomlKey(blankedToml(text), 'read_write')) {
    const entries = Array.isArray(extra) ? extra : null;
    if (entries === null || entries.some((entry) => typeof entry !== 'string' || !isInsideProject(entry, root, env))) {
      return { what: `the Grok sandbox profile may write outside the project (read_write)`, fix: `keep only project paths in read_write in ${file}` };
    }
  }
  return null;
}

/** The names this runtime's agent gets on top of the shared ones (#613). Grok CLI takes an xAI API key. */
export const AGENT_ENV: RuntimeEnv = { login: ['XAI_API_KEY', 'GROK_API_KEY'], config: ['GROK_HOME'] };

/**
 * What a desk (#637) gives Grok CLI. GROK_HOME points at the desk's own folder; only
 * `auth.json` is copied in. Grok's program sits in the lead's `~/.grok/bin`, so that one
 * folder is shown read-only. Host: xAI's API. The binary names HTTPS_PROXY.
 */
export const DESK: RuntimeDesk = {
  leadState: (env) => [env.GROK_HOME || join(homeIn(env), '.grok')],
  login: (env) => [{ from: join(env.GROK_HOME || join(homeIn(env), '.grok'), 'auth.json'), to: 'auth.json' }],
  stateEnv: (state) => ({ GROK_HOME: state }),
  programParts: (env) => [join(env.GROK_HOME || join(homeIn(env), '.grok'), 'bin')],
  hosts: ['api.x.ai'],
};
