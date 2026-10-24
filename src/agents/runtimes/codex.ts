// What yokoten knows about OpenAI's Codex CLI: the shape of its PreToolUse and Stop events, and where
// its project and user hooks live. Source: https://developers.openai.com/codex/hooks
//
// Codex runs a project's hooks only after the user trusts the project's .codex/ folder
// and reviews the hook (`/hooks`). It records trust against the hook's hash, so a changed
// command has to be trusted again.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { releaseFix } from '../../rules/guards.ts';
import { homeIn, homeOf } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import { type Action, isWorkerType } from '../../run/hook.ts';
import { type FolderTrust, folderKeys, isFolder, TRUST_COMMAND } from '../folder-trust.ts';
import { readStop } from './claude-code.ts';
import type { AgentAdapter } from './runtime.ts';
import { type Added, addHook, checkHooksFile, hasHook, type HookArgs, type HookState, hookState, isObject } from '../hooks-file.ts';
import type { RuntimeEnv } from '../desk/agent-env.ts';
import type { RuntimeDesk } from '../desk/desk.ts';

// The docs: "Bash and apply_patch use tool_input.command", and unified exec reports as Bash.
const SHELL = 'Bash';

/** The files an apply_patch envelope adds, updates, deletes or moves to. */
function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)[ \t]*$/gm)].map((m) => m[1]);
}

// A file header anywhere in a shell command: at a line start, or after a written `\n`
// (as in `printf '*** Begin Patch\n*** Add File: a\n'`). A `+` line is patch content.
const SHELL_HEADER = /(?:^|\\n)[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): ([^\n]+?)[ \t]*(?=\\n|$)/gm;
// A `cd`, `pushd`, `env -C` or `--chdir`, quoted or bare. Group 1, 2 or 3 is the dir.
const DIR_CHANGE = /(?:^|[\s;&|(`'"])(?:cd|pushd|-C|--chdir)[\s=]+(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/g;

/**
 * The files a shell command's apply_patch may touch. Codex sends a shell-run apply_patch
 * as a Bash call and fires no second hook (rust-v0.163.0). The shell can reach apply_patch
 * in many ways (`command apply_patch`, `FOO=1 apply_patch`, `| apply_patch`), so when the
 * command names apply_patch at all, every file header in it counts. A command that does
 * not, such as `cat > notes.md <<'EOF'`, only writes data. This errs toward refusing.
 *
 * The shell may change dir first. Each relative path counts from the session's cwd and
 * from every dir the command changes to. A dir only the shell knows (`~`, `-`, `$X`) may
 * be any folder above: then the path counts from each of those too, the repo root among them.
 */
function shellPatchPaths(command: string, cwd: string | undefined): string[] {
  if (!/apply_?patch/.test(command)) return [];
  const dirs = [...command.matchAll(DIR_CHANGE)].map((m) => m[1] ?? m[2] ?? m[3]);
  const knownDirs = dirs.filter((dir) => dir !== '' && !/^[~-]|\$/.test(dir));
  if (cwd && knownDirs.length < dirs.length) {
    const depth = resolve(cwd).split(sep).filter(Boolean).length;
    for (let up = 1; up <= depth; up++) knownDirs.push('../'.repeat(up));
  }
  const paths: string[] = [];
  for (const [, path] of command.matchAll(SHELL_HEADER)) {
    paths.push(path);
    if (!isAbsolute(path)) paths.push(...knownDirs.map((dir) => join(dir, path)));
  }
  return paths;
}

/**
 * A PreToolUse call, as an Action. A shell call's `tool_input.command` is the command, and
 * the file headers of an apply_patch it runs are the paths. An apply_patch call's
 * `tool_input.command` is the patch, and its file headers are the paths.
 * Any other tool (MCP, update_plan) is neither.
 */
export function readToolCall(input: unknown): Action {
  const call = (input ?? {}) as { cwd?: unknown; tool_name?: unknown; tool_input?: unknown; agent_type?: unknown };
  const tool = (typeof call.tool_input === 'object' && call.tool_input !== null ? call.tool_input : {}) as Record<string, unknown>;
  const name = typeof call.tool_name === 'string' ? call.tool_name : '';
  const command = typeof tool.command === 'string' ? tool.command : undefined;
  const cwd = typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : undefined;
  return {
    command: name === SHELL ? command : undefined,
    paths: !command ? [] : name === 'apply_patch' ? patchPaths(command) : name === SHELL ? shellPatchPaths(command, cwd) : [],
    cwd,
    // Since rust-v0.163.0 a subagent's call may carry `agent_type`: a built-in role
    // (default, worker, explorer) or a custom one's name from .codex/agents/*.toml. Not
    // on the docs page yet, so it is optional; without it YOKOTEN_ROLE decides. A type
    // is a worker only when it is `worker`, or it ends with `:worker` (#614).
    worker: isWorkerType(typeof call.agent_type === 'string' ? call.agent_type : ''),
  };
}

const projectHooks = (root: string) => join(root, '.codex', 'hooks.json');

/**
 * The project's tool-call guard. Codex runs a hook in the session's cwd and documents no
 * project-dir variable; its docs advise a path from the git root, as here.
 */
export const addProjectHook = (root: string, cli: string) =>
  addHook(projectHooks(root), 'PreToolUse', 'Bash|apply_patch', guardCommand(`"$(git rev-parse --show-toplevel)/${cli}"`, 'hook --agent codex', missingProjectRuntime(cli), { isToolCall: true }));
export const hasProjectHook = (root: string): boolean => hasHook(projectHooks(root), 'PreToolUse', 'hook');

// Seconds Codex waits for the stop check, including a worker's done-when command (#614).
const STOP_TIMEOUT = 600;

/**
 * The project's stop check (#211, #614): Codex's Stop event takes no matcher. Its input has
 * `cwd` and `stop_hook_active`, as Claude Code's does; exit 2 with a reason on stderr
 * makes the agent go on. The timeout covers the done-when command.
 */
export const addProjectStopHook = (root: string, cli: string) =>
  addHook(projectHooks(root), 'Stop', undefined, guardCommand(`"$(git rev-parse --show-toplevel)/${cli}"`, 'hook --stop --agent codex', missingProjectRuntime(cli)), { timeout: STOP_TIMEOUT });
export const hasProjectStopHook = (root: string): boolean => hasHook(projectHooks(root), 'Stop', 'hook');

/** Throw `UnreadableHooksFile` unless both project hooks can go in the file: check before adding either. */
export const checkProjectHooks = (root: string): void => checkHooksFile(projectHooks(root), ['PreToolUse', 'Stop']);

/** A Stop event: the same fields as Claude Code's (`cwd`, `stop_hook_active`). */
export { readStop };

const userHooks = (env: Env) => join(homeIn(env), '.codex', 'hooks.json');

/** The two user hooks, as `addHook`'s arguments: one builder for `addUserHooks` and `userHooksState`. */
const userHookArgs = (env: Env, cli: string, missing: string): Record<'doctor' | 'guard', HookArgs> => ({
  doctor: [userHooks(env), 'SessionStart', undefined, guardCommand(cli, 'doctor --session --agent codex', missing, { isSessionStart: true })],
  guard: [userHooks(env), 'PreToolUse', SHELL, guardCommand(cli, 'hook --agent codex --commands-only', missing, { isToolCall: true })],
});

/**
 * The user's hooks, in every repo: doctor at session start, and the command guard on
 * shell calls. Codex adds a SessionStart hook's plain stdout to the agent's context.
 * `missing` is what they say when `cli` is gone.
 */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  const args = userHookArgs(env, cli, missing);
  checkHooksFile(args.doctor[0], [args.doctor[1], args.guard[1]]);
  return { doctor: addHook(...args.doctor), guard: addHook(...args.guard) };
}

/** Whether Codex looks used on this machine: its user folder, ~/.codex, is a folder. */
export function hasUserDir(env: Env): boolean {
  try {
    return statSync(dirname(userHooks(env))).isDirectory();
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

// ---- Trust (#341) ----
//
// Codex runs a project's hooks only when both are true (read in openai/codex at
// rust-v0.163.0, codex-rs/config/src/loader/mod.rs and codex-rs/hooks/src/engine/discovery.rs):
// - the project is trusted: `[projects."<folder>"] trust_level = "trusted"` in config.toml,
//   for the folder, its git root, or the main checkout of a worktree. The key must match
//   exactly: no parent folder, no trailing slash.
// - each hook is trusted: `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]` has
//   `trusted_hash`, the hash of the hook as Codex reads it. A changed hook has another hash.
// config.toml is in `$CODEX_HOME`, or `~/.codex`.

/** The one step that makes Codex run the project's hooks. */
export const TRUST_STEP = TRUST_COMMAND;

/** What Codex's trust says, past the shared states: the project is trusted, the hooks are not. */
export type CodexTrust = FolderTrust<'hooks untrusted' | 'hooks changed' | 'hooks off'>;

/** One TOML key, bare or quoted, at the start of `text`: the key and the text after it. */
function readTomlKey(text: string): [string, string] | null {
  const rest = text.trimStart();
  const bare = /^[A-Za-z0-9_-]+/.exec(rest);
  if (bare) return [bare[0], rest.slice(bare[0].length)];
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
  if (basic) {
    try {
      return [JSON.parse(`"${basic[1]}"`) as string, rest.slice(basic[0].length)];
    } catch {
      return null;
    }
  }
  const literal = /^'([^']*)'/.exec(rest);
  return literal ? [literal[1], rest.slice(literal[0].length)] : null;
}

/** A dotted TOML key (`a."b c".d`): its parts and the text after it. Shared with the trust writer (#661). */
export function readTomlPath(text: string): [string[], string] | null {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const key = readTomlKey(rest);
    if (!key) return null;
    parts.push(key[0]);
    rest = key[1].trimStart();
    if (!rest.startsWith('.')) return [parts, rest];
    rest = rest.slice(1);
  }
}

/** A TOML value doctor needs: a string, a boolean, a number, or a one-line table of these. Undefined for any other. */
function readTomlValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const key = readTomlKey(trimmed);
    const after = key?.[1].trim() ?? '';
    return key && (after === '' || after.startsWith('#')) ? key[0] : undefined;
  }
  const value = trimmed.replace(/\s+#.*$/, '');
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('{') && value.endsWith('}')) {
    const table: Record<string, unknown> = {};
    for (const pair of value.slice(1, -1).split(',')) {
      const path = readTomlPath(pair);
      if (path && path[1].startsWith('=')) table[path[0].join('.')] = readTomlValue(path[1].slice(1));
    }
    return table;
  }
  return undefined;
}

/**
 * The bracket depth after `text`, from `depth`: `[` opens, `]` closes, but not inside a
 * string, and nothing after a comment. So `args = ["a]"] # [note` closes on its own line.
 */
function bracketDepth(text: string, depth: number): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '#') break;
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (c === '"' && text[i] === '\\') i++;
    } else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth;
}

/** A table header line: `[a."b"]` or `[[a]]`, then only a comment. Never an array element like `["a"],`. */
function isTableHeader(line: string): boolean {
  const close = line.startsWith('[[') ? ']]' : line.startsWith('[') ? ']' : null;
  const path = close ? readTomlPath(line.slice(close.length)) : null;
  return !!path && path[1].startsWith(close!) && /^\s*(#.*)?$/.test(path[1].slice(close!.length));
}

/** The two tables of config.toml that hold trust: `projects` and `hooks.state` (see `readTomlTables`). */
export function readTrustTables(text: string): { projects: Map<string, Record<string, unknown>>; hookStates: Map<string, Record<string, unknown>> } {
  const [projects, hookStates] = readTomlTables(text, [['projects'], ['hooks', 'state']]);
  return { projects, hookStates };
}

/**
 * The tables below each of `roots` (a dotted key, such as `hooks.state`), read without a
 * TOML library (no runtime dependencies): for each root, a map from the key below it (a
 * folder or a hook key) to its fields. Codex's config.toml and Grok CLI's
 * trusted_folders.toml use it. Table headers, dotted keys and one-line tables, as those
 * CLIs write them. Lines inside a multi-line string or array are skipped, but a table
 * header always ends an array: a header is never read as part of the table above it, so
 * a key below it is never put in the wrong folder.
 */
export function readTomlTables(text: string, roots: readonly (readonly string[])[]): Map<string, Record<string, unknown>>[] {
  const tables = roots.map(() => new Map<string, Record<string, unknown>>());
  const set = (path: string[], value: unknown) => {
    const index = roots.findIndex((root) => root.every((part, i) => path[i] === part));
    const [table, at] = index < 0 ? [null, 0] : [tables[index], roots[index].length];
    if (!table || path.length < at + 1) return;
    const key = path[at];
    const fields = table.get(key) ?? {};
    if (path.length === at + 1) {
      if (value && typeof value === 'object') Object.assign(fields, value);
    } else fields[path.slice(at + 1).join('.')] = value;
    table.set(key, fields);
  };
  let header: string[] | null = [];
  let skipUntil: string | null = null;
  let arrayDepth = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (skipUntil) {
      if (line.includes(skipUntil)) skipUntil = null;
      continue;
    }
    if (arrayDepth > 0) {
      if (isTableHeader(line)) arrayDepth = 0;
      else {
        arrayDepth = Math.max(0, bracketDepth(line, arrayDepth));
        continue;
      }
    }
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[[')) {
      header = null;
      continue;
    }
    if (line.startsWith('[')) {
      const path = readTomlPath(line.slice(1));
      header = path && path[1].startsWith(']') ? path[0] : null;
      continue;
    }
    const path = readTomlPath(line);
    if (!path || !path[1].startsWith('=')) continue;
    const value = path[1].slice(1).trim();
    const opener = ['"""', "'''"].find((quotes) => value.startsWith(quotes));
    if (opener && !value.slice(3).includes(opener)) {
      skipUntil = opener;
      continue;
    }
    if (value.startsWith('[')) {
      arrayDepth = Math.max(0, bracketDepth(value, 0));
      if (arrayDepth > 0) continue;
    }
    if (header) set([...header, ...path[0]], readTomlValue(value));
  }
  return tables;
}

/** Keys sorted at every level, as serde_json's `sort_all_objects` leaves them. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

// The events yokoten writes, by their name in hooks.json and in Codex's hook keys.
const TRUST_EVENTS = [
  ['PreToolUse', 'pre_tool_use'],
  ['Stop', 'stop'],
] as const;

/**
 * The hash Codex trusts a command hook by (`hook_hash` in discovery.rs): sha256 of the
 * hook as Codex reads it, with the defaults filled in, as JSON with sorted keys. A field
 * Codex leaves out when empty is left out here too. Checked against a real config.toml
 * of Codex 0.163.0: both of yokoten's hooks matched.
 */
export function hookHash(event: string, matcher: unknown, handler: Record<string, unknown>): string {
  const timeout = typeof handler.timeout === 'number' ? Math.max(1, handler.timeout) : 600;
  const limit = event === 'pre_tool_use' && typeof handler.additionalContextLimit === 'number' && handler.additionalContextLimit !== 2500 ? handler.additionalContextLimit : undefined;
  const hook = {
    type: 'command',
    command: handler.command,
    timeout,
    async: handler.async === true,
    ...(typeof handler.statusMessage === 'string' ? { statusMessage: handler.statusMessage } : {}),
    ...(limit === undefined ? {} : { additionalContextLimit: limit }),
  };
  const identity = { event_name: event, ...(event !== 'stop' && typeof matcher === 'string' ? { matcher } : {}), hooks: [hook] };
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex')}`;
}

/** The main checkout of a worktree at `root`, from its `.git` file; null for a plain checkout. Files only. */
function mainCheckout(root: string): string | null {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, '.git'), 'utf8'));
    if (!pointer) return null;
    const gitDir = resolve(root, pointer[1].trim());
    const common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    return common.endsWith(`${sep}.git`) ? dirname(common) : null;
  } catch {
    return null;
  }
}

/**
 * The model and provider the user's `config.toml` names (#748): top-level `model` and
 * `model_provider`, as Codex reads them. Null when the file is missing, unreadable, or
 * names no model: the harness then keeps its own default. Read-only, no git.
 */
export function readModelIdentity(env: Env): { model: string; provider: string } | null {
  const user = homeOf(env);
  const home = env.CODEX_HOME || (user ? join(user, '.codex') : '');
  if (!home) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(join(home, 'config.toml'), 'utf8'));
  } catch {
    return null;
  }
  const text = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 64) : '');
  const model = text(parsed.model);
  if (!model) return null;
  return { model, provider: text(parsed.model_provider) };
}

/**
 * Whether Codex runs yokoten's hooks in the project at `root`, from its config.toml.
 * Read-only. Only hooks that run `--agent codex` count: those are the ones init writes.
 */
export function readTrust(root: string, env: Env): CodexTrust {
  const store = env.CODEX_HOME ? '$CODEX_HOME/config.toml' : '~/.codex/config.toml';
  const user = homeOf(env);
  const home = env.CODEX_HOME || (user ? join(user, '.codex') : '');
  if (!home) return { state: 'no home', store };
  const file = join(home, 'config.toml');
  if (!isFolder(home)) return { state: 'no home', store };
  if (!existsSync(file)) return { state: 'no store', store };
  let tables: ReturnType<typeof readTrustTables>;
  try {
    tables = readTrustTables(readFileSync(file, 'utf8'));
  } catch {
    return { state: 'unreadable', store };
  }
  let hooks: unknown = null;
  try {
    hooks = JSON.parse(readFileSync(projectHooks(root), 'utf8'));
  } catch {
    // no hooks file doctor can read: no yokoten hook for Codex to trust
  }
  // Codex looks in this order and stops at the first key it finds, trusted or not.
  const main = mainCheckout(root);
  const folders = [...folderKeys(root), ...(main ? folderKeys(main) : [])];
  const project = folders.map((folder) => tables.projects.get(folder)).find((fields) => fields?.trust_level !== undefined);
  if (project?.trust_level !== 'trusted') return { state: 'untrusted', store };
  const events = isObject(hooks) && isObject(hooks.hooks) ? hooks.hooks : {};
  const states: CodexTrust['state'][] = [];
  for (const [name, event] of TRUST_EVENTS) {
    const groups = Array.isArray(events[name]) ? events[name] : [];
    groups.forEach((group: unknown, groupIndex: number) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((handler: unknown, handlerIndex: number) => {
        if (!isObject(handler) || typeof handler.command !== 'string' || !handler.command.includes('--agent codex')) return;
        const saved = folderKeys(root)
          .map((folder) => tables.hookStates.get(`${join(folder, '.codex', 'hooks.json')}:${event}:${groupIndex}:${handlerIndex}`))
          .find((fields) => fields !== undefined);
        if (saved?.enabled === false) states.push('hooks off');
        else if (typeof saved?.trusted_hash !== 'string') states.push('hooks untrusted');
        else states.push(saved.trusted_hash === hookHash(event, group.matcher, handler) ? 'trusted' : 'hooks changed');
      });
    });
  }
  if (!states.length) return { state: 'hooks untrusted', store };
  return { state: (['hooks off', 'hooks untrusted', 'hooks changed'] as const).find((state) => states.includes(state)) ?? 'trusted', store };
}

/**
 * What yokoten must write into config.toml to trust the project and the hooks it wrote
 * (#661). Only fields that differ are named, so a second run writes nothing. It never
 * trusts a hook that is not yokoten's: the same filter `readTrust` uses.
 */
export function trustProject(root: string, env: Env): TrustPlan {
  const store = env.CODEX_HOME ? '$CODEX_HOME/config.toml' : '~/.codex/config.toml';
  const user = homeOf(env);
  const home = env.CODEX_HOME || (user ? join(user, '.codex') : '');
  if (!home) return { state: 'no home', store, changes: [] };
  const file = join(home, 'config.toml');
  let text = '';
  try {
    if (existsSync(file)) text = readFileSync(file, 'utf8');
  } catch {
    return { state: 'unreadable', store, changes: [] };
  }
  const tables = readTrustTables(text);
  const changes: TrustChange[] = [];
  const change = (path: string[], key: string, value: string, before: string | null, kind?: 'boolean'): TrustChange => ({ agent: 'Codex', store, file, format: 'toml', path, key, value, before, ...(kind ? { kind } : {}) });
  const folders = folderKeys(root);
  const main = mainCheckout(root);
  const keys = [...folders, ...(main ? folderKeys(main) : [])];
  // Codex stops at the first folder key it finds, trusted or not.
  const savedProject = keys.map((folder) => tables.projects.get(folder)).find((fields) => fields?.trust_level !== undefined);
  if (savedProject?.trust_level !== 'trusted') {
    const folder = folders.find((key) => tables.projects.has(key)) ?? folders[0];
    const before = typeof savedProject?.trust_level === 'string' ? savedProject.trust_level : null;
    changes.push(change(['projects', folder], 'trust_level', 'trusted', before));
  }
  let hooks: unknown = null;
  try {
    hooks = JSON.parse(readFileSync(projectHooks(root), 'utf8'));
  } catch {
    // no hooks file doctor can read: no yokoten hook for Codex to trust
  }
  const events = isObject(hooks) && isObject(hooks.hooks) ? hooks.hooks : {};
  for (const [name, event] of TRUST_EVENTS) {
    const groups = Array.isArray(events[name]) ? events[name] : [];
    groups.forEach((group: unknown, groupIndex: number) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((handler: unknown, handlerIndex: number) => {
        if (!isObject(handler) || typeof handler.command !== 'string' || !handler.command.includes('--agent codex')) return;
        const key = `${join(root, '.codex', 'hooks.json')}:${event}:${groupIndex}:${handlerIndex}`;
        const saved = folders
          .map((folder) => tables.hookStates.get(`${join(folder, '.codex', 'hooks.json')}:${event}:${groupIndex}:${handlerIndex}`))
          .find((fields) => fields !== undefined);
        if (saved?.enabled === false) changes.push(change(['hooks', 'state', key], 'enabled', 'true', 'false', 'boolean'));
        const hash = hookHash(event, group.matcher, handler);
        if (saved?.trusted_hash !== hash) changes.push(change(['hooks', 'state', key], 'trusted_hash', hash, typeof saved?.trusted_hash === 'string' ? saved.trusted_hash : null));
      });
    });
  }
  return { state: changes.length > 0 ? 'trusted' : 'same', store, changes };
}

// ---- The project's sandbox (#589) ----
//
// Codex reads `.codex/config.toml` in a trusted project: checked with `codex doctor --json`
// in a scratch CODEX_HOME on 2026-10-22 (codex-cli 0.163.0), a project model and sandbox_mode
// showed in the report once the folder was trusted, and not before. yokoten pins the safe
// mode there: writes stay in the workspace, network stays off, and Codex asks before going
// beyond. init only adds keys that are missing; a key the user set stays, and doctor names
// what differs.

/** The project's sandbox file, relative to the root. */
export const SANDBOX_FILE = '.codex/config.toml';

/** A TOML value init and doctor read: a string, boolean, number, list, or table. */
export type TomlValue = string | boolean | number | TomlValue[] | { [key: string]: TomlValue };

/**
 * The text as logical lines without comments: a newline inside `[]` or `{}` or a
 * triple-quoted string continues the line, so a multi-line list or string reads as one;
 * a `#` outside a string skips to the physical line's end (comments read inside lists
 * too). Line ends are LF.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  let depth = 0;
  let quote: string | null = null;
  let triple: string | null = null;
  let escaped = false;
  const chars = text.replace(/\r\n/g, '\n');
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (escaped) {
      line += char;
      escaped = false;
      continue;
    }
    if (quote !== null) {
      line += char;
      if (quote === '"' && char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (triple !== null) {
      if (triple === '"""' && char === '\\') {
        line += char + (chars[index + 1] ?? '');
        index++;
        continue;
      }
      if (chars.startsWith(triple, index)) {
        line += triple;
        index += 2;
        triple = null;
        continue;
      }
      line += char;
      continue;
    }
    if (char === '#') {
      // Skip to the newline, then let it run: it still ends (or joins) the line.
      const end = chars.indexOf('\n', index);
      index = (end < 0 ? chars.length : end) - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const marks = char.repeat(3);
      if (chars.startsWith(marks, index)) {
        triple = marks;
        line += marks;
        index += 2;
        continue;
      }
      quote = char;
      line += char;
      continue;
    }
    if (char === '[' || char === '{') depth++;
    if (char === ']' || char === '}') depth = Math.max(0, depth - 1);
    if (char === '\n' && depth === 0) {
      lines.push(line);
      line = '';
      continue;
    }
    line += char;
  }
  lines.push(line);
  return lines;
}

/** A comma-separated list split at its top-level commas; strings and nested brackets stay whole. */
function splitItems(text: string): string[] {
  const items: string[] = [];
  let item = '';
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      item += char;
      escaped = false;
      continue;
    }
    if (quote !== null) {
      item += char;
      if (quote === '"' && char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      item += char;
    } else if (char === '[' || char === '{') {
      depth++;
      item += char;
    } else if (char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      item += char;
    } else if (char === ',' && depth === 0) {
      items.push(item);
      item = '';
    } else item += char;
  }
  items.push(item);
  return items;
}

/** The first `=` outside a string: the key before it and the value after it. */
function splitPair(line: string): [string, string] | null {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== null) {
      if (quote === '"' && char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '=') return [line.slice(0, index), line.slice(index + 1)];
  }
  return null;
}

/** A basic triple-quoted string with its escapes read; enough for the values here. */
function unescapeBasic(text: string): string {
  return text.replace(/\\(\\|"|n|t|r)/g, (_, mark: string) => ({ '\\': '\\', '"': '"', n: '\n', t: '\t', r: '\r' })[mark] ?? mark);
}

/**
 * One TOML value: a string (triple-quoted too), boolean, number, list, or inline table.
 * Undefined when it does not parse: the caller skips the line, never throws.
 */
function parseTomlValue(text: string): TomlValue | undefined {
  const value = text.trim();
  if (value === '') return undefined;
  const first = value[0];
  if (first === '"' || first === "'") {
    const marks = first.repeat(3);
    if (value.startsWith(marks)) {
      const end = value.indexOf(marks, 3);
      if (end < 0 || value.slice(end + 3).trim() !== '') return undefined;
      const raw = value.slice(3, end);
      return first === '"' ? unescapeBasic(raw) : raw;
    }
    const key = readTomlKey(value);
    return key && key[1].trim() === '' ? key[0] : undefined;
  }
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const items: TomlValue[] = [];
    for (const item of splitItems(value.slice(1, -1))) {
      if (item.trim() === '') continue;
      const parsed = parseTomlValue(item);
      if (parsed === undefined) return undefined;
      items.push(parsed);
    }
    return items;
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const table: Record<string, TomlValue> = {};
    for (const item of splitItems(value.slice(1, -1))) {
      if (item.trim() === '') continue;
      const pair = splitPair(item);
      const path = pair && readTomlPath(pair[0]);
      const parsed = pair && parseTomlValue(pair[1]);
      if (!path || path[1].trim() !== '' || parsed === null || parsed === undefined || !placeValue(table, path[0], parsed)) return undefined;
    }
    return table;
  }
  return undefined;
}

/** Put `value` at `path` in `table`, making tables on the way. False when a scalar is in the way. */
function placeValue(table: Record<string, TomlValue>, path: string[], value: TomlValue): boolean {
  let at = table;
  for (const part of path.slice(0, -1)) {
    const next = at[part];
    if (next === undefined) at[part] = {};
    else if (typeof next !== 'object' || next === null || Array.isArray(next)) return false;
    at = at[part] as Record<string, TomlValue>;
  }
  at[path.at(-1) as string] = value;
  return true;
}

/**
 * The file as nested tables, read without a TOML library (no runtime dependencies):
 * `[a.b]` with `c = 1` reads as `tables.a.b.c`. Comments, dotted keys, inline tables,
 * quoted keys and multi-line lists read; an array-of-tables header (`[[x]]`) skips its
 * section, and a line that does not parse is skipped, never an error. So doctor never
 * crashes on a user's file.
 */
export function parseToml(text: string): Record<string, TomlValue> {
  const tables: Record<string, TomlValue> = {};
  let header: string[] | null = [];
  for (const line of logicalLines(text)) {
    const clean = line.trim();
    if (clean === '') continue;
    if (clean.startsWith('[[')) {
      header = null;
      continue;
    }
    if (clean.startsWith('[')) {
      const inner = /^\[([^\]]+)\]\s*$/.exec(clean)?.[1];
      const path = inner === undefined ? null : readTomlPath(inner);
      header = path && path[1].trim() === '' ? path[0] : null;
      continue;
    }
    if (header === null) continue;
    const pair = splitPair(clean);
    const path = pair && readTomlPath(pair[0]);
    const parsed = pair && parseTomlValue(pair[1]);
    if (!path || path[1].trim() !== '' || parsed === null || parsed === undefined) continue;
    placeValue(tables, [...header, ...path[0]], parsed);
  }
  return tables;
}

/**
 * The text with strings and comments turned into spaces (a newline stays a newline), so a
 * key search never matches inside them. init uses it to tell a key that is really missing
 * from one set in a form the parser skips: only a name nowhere in the file is added, so
 * init never writes a key twice, which TOML reads as an error.
 */
export function blankedToml(text: string): string {
  let out = '';
  let index = 0;
  const chars = text.replace(/\r\n/g, '\n');
  while (index < chars.length) {
    const char = chars[index];
    if (char === '"' || char === "'") {
      const marks = char.repeat(3);
      if (chars.startsWith(marks, index)) {
        const end = chars.indexOf(marks, index + 3);
        const stop = end < 0 ? chars.length : end + 3;
        out += chars.slice(index, stop).replace(/[^\n]/g, ' ');
        index = stop;
        continue;
      }
      let end = index + 1;
      while (end < chars.length && chars[end] !== char && chars[end] !== '\n') end += char === '"' && chars[end] === '\\' ? 2 : 1;
      if (chars[end] === char) end++;
      out += ' '.repeat(end - index);
      index = end;
      continue;
    }
    if (char === '#') {
      const end = chars.indexOf('\n', index);
      const stop = end < 0 ? chars.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

/**
 * Whether `key` is set anywhere in blanked TOML text: `key =`, quoted, dotted (`a.key =`)
 * or in an inline table. Our keys are letters and `_`, so the name needs no escaping.
 */
export function hasTomlKey(blanked: string, key: string): boolean {
  return new RegExp(`(^|[\\s,{.])["']?${key}["']?\\s*=`, 'm').test(blanked);
}

/**
 * Whether blanked TOML text holds a `[a.b.c]` header (`[[x]]` never). Quoted parts don't
 * match: blanking clears strings, so the parser reads those and this only catches what
 * the parser skips.
 */
export function hasTomlTable(blanked: string, path: readonly string[]): boolean {
  const header = path.map((part) => `["']?${part}["']?`).join(String.raw`\s*\.\s*`);
  return new RegExp(`^\\s*\\[\\s*${header}\\s*\\]\\s*$`, 'm').test(blanked);
}

/** A `[table.path]` header line as its path, or null for `[[x]]` and other lines. Blanked text only. */
function headerPath(line: string): string[] | null {
  const inner = /^\s*\[([^[\]]+)\]\s*$/.exec(line)?.[1];
  if (inner === undefined) return null;
  return inner.split('.').map((part) => part.trim().replace(/^["'](.*)["']$/, '$1'));
}

/** A header line as its path and whether it is an array (`[[x]]`), or null. Reads the original line, so quoted parts parse. */
function headerShape(line: string): { path: string[]; isArray: boolean } | null {
  const trimmed = line.trim();
  const isArray = trimmed.startsWith('[[');
  const close = isArray ? ']]' : trimmed.startsWith('[') ? ']' : null;
  if (!close) return null;
  const path = readTomlPath(trimmed.slice(close.length));
  if (!path || !path[1].startsWith(close)) return null;
  if (!/^\s*(#.*)?$/.test(path[1].slice(close.length))) return null;
  return { path: path[0], isArray };
}

/** Whether the text holds the header for `path`, single or array. Only lines that are really headers (blanked still starts with `[`) count, so strings and comments never match. */
function hasHeaderShape(text: string, path: readonly string[], wantArray: boolean): boolean {
  const blanked = blankedToml(text).split('\n');
  return text.split('\n').some((line, index) => {
    if (!(blanked[index] ?? '').trimStart().startsWith('[')) return false;
    const header = headerShape(line);
    return !!header && header.isArray === wantArray && header.path.length === path.length && header.path.every((part, at) => part === path[at]);
  });
}

/**
 * Whether the text holds a `[a.b]` header for `path`, quoted or not. Blanked text misses quoted names, so this reads the original lines. Shared with Grok's profile (#589).
 */
export function hasTomlHeader(text: string, path: readonly string[]): boolean {
  return hasHeaderShape(text, path, false);
}

/**
 * Whether the text holds a `[[a.b]]` array header for `path`, quoted or not. An array where a table belongs is always the wrong shape. Shared with Grok's profile (#589).
 */
export function hasTomlArray(text: string, path: readonly string[]): boolean {
  return hasHeaderShape(text, path, true);
}

/** The sandbox keys init writes: top-level pairs, and the one table with its pair. */
const TOP_SANDBOX: (readonly [string, string])[] = [
  ['sandbox_mode', '"workspace-write"'],
  ['approval_policy', '"on-request"'],
];
const TABLE_SANDBOX: readonly [readonly string[], string, string] = [['sandbox_workspace_write'], 'network_access', 'false'];

/** The file init writes when `.codex/config.toml` is missing. */
const FRESH_SANDBOX = `# The Codex sandbox for this project, written by yokoten init. Writes stay in the
# project, network stays off, and Codex asks before going beyond. Your other keys stay.
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
`;

/** Whether a top-level key is set: parsed (quoted keys too), or in a form the parser skips. */
function isTopSet(parsed: Record<string, TomlValue>, blanked: string, key: string): boolean {
  return Object.hasOwn(parsed, key) || hasTomlKey(blanked, key);
}

/** Whether `name` is set at top level, outside any table: `name =` or `name.x =`. */
function isTopNameSet(blanked: string, name: string): boolean {
  const lines = blanked.split('\n');
  const firstHeader = lines.findIndex((line) => /^\s*\[/.test(line));
  const top = firstHeader < 0 ? lines : lines.slice(0, firstHeader);
  return top.some((line) => new RegExp(`^\\s*["']?${name}["']?\\s*(=|\\.)`).test(line));
}

/** Whether `name` is taken twice, at top level and by a table header: the file won't parse. */
function isTakenTwice(blanked: string, name: string): boolean {
  return isTopNameSet(blanked, name) && blanked.split('\n').some((line) => headerPath(line)?.[0] === name);
}

/** Whether a top-level `key =` can't be added: a table header already takes the name. */
function isTopBlocked(parsed: Record<string, TomlValue>, blanked: string, key: string): boolean {
  return !isTopSet(parsed, blanked, key) && blanked.split('\n').some((line) => headerPath(line)?.[0] === key);
}

/** Whether `network_access` is set: parsed in its table (quoted keys too), or in a form the parser skips. */
function isTableSet(parsed: Record<string, TomlValue>, blanked: string): boolean {
  const table = TABLE_SANDBOX[0].reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), parsed);
  return (isObject(table) && Object.hasOwn(table, TABLE_SANDBOX[1])) || hasTomlKey(blanked, TABLE_SANDBOX[1]);
}

/** Whether `network_access` can't be added: `sandbox_workspace_write` is a key, not a table. */
function isTableBlocked(parsed: Record<string, TomlValue>, blanked: string): boolean {
  if (isTableSet(parsed, blanked) || hasTomlTable(blanked, TABLE_SANDBOX[0])) return false;
  const lines = blanked.split('\n');
  const firstHeader = lines.findIndex((line) => /^\s*\[/.test(line));
  const top = firstHeader < 0 ? lines : lines.slice(0, firstHeader);
  const name = TABLE_SANDBOX[0].join('.');
  return top.some((line) => new RegExp(`^\\s*["']?${name}["']?\\s*=`).test(line));
}

/** Whether the table header exists in a form the blanked search misses: quoted (`["a"]`) or an array (`[[a]]`). Writing the table again would corrupt the file. */
function hasMissedTable(text: string, blanked: string): boolean {
  return (hasTomlHeader(text, TABLE_SANDBOX[0]) || hasTomlArray(text, TABLE_SANDBOX[0])) && !hasTomlTable(blanked, TABLE_SANDBOX[0]);
}

/**
 * Write the project's Codex sandbox: the keys that are missing, and only those. A key the
 * user set stays, even when it differs (`kept`); a key set in a form the parser skips
 * counts as set too, so init never writes a key twice. Returns what that took, or
 * `unreadable` when the file can't be read.
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
  const parsed = parseToml(text);
  const blanked = blankedToml(text);
  // A name anywhere in the file counts as set: adding it again would write a key twice.
  // A name taken in another shape blocks its insert: writing there would corrupt the file.
  // Doctor calls that a shape problem, so init and doctor agree on what is missing.
  const [tablePath, tableKey, tableValue] = TABLE_SANDBOX;
  const missingTop = TOP_SANDBOX.filter(([key]) => !isTopSet(parsed, blanked, key) && !isTopBlocked(parsed, blanked, key));
  const needsTableKey = !isTableSet(parsed, blanked) && !isTableBlocked(parsed, blanked) && !hasMissedTable(text, blanked);
  if (missingTop.length === 0 && !needsTableKey) {
    const tableParsed = tablePath.reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), parsed);
    const network = isObject(tableParsed) ? tableParsed[tableKey] : undefined;
    return parsed.sandbox_mode === 'workspace-write' && parsed.approval_policy === 'on-request' && network === false ? 'same' : 'kept';
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // Each search reads the lines as they are now, after the insert before it.
  const blankedNow = (): string[] => blankedToml(lines.join('\n')).split('\n');
  const isHeader = (line: string): boolean => /^\s*\[/.test(line);
  const isTable = (line: string): boolean => {
    const found = headerPath(line);
    return found !== null && found.length === tablePath.length && found.every((part, index) => part === tablePath[index]);
  };
  // Top-level keys go before the first table header; a file with no header takes them at the end.
  if (missingTop.length > 0) {
    const at = blankedNow().findIndex(isHeader);
    const insert = missingTop.map(([key, value]) => `${key} = ${value}`);
    if (at < 0) {
      while (lines.length > 0 && lines.at(-1) === '') lines.pop();
      lines.push(...insert, '');
    } else lines.splice(at, 0, ...insert);
  }
  if (needsTableKey) {
    const at = blankedNow().findIndex(isTable);
    if (at < 0) {
      while (lines.length > 0 && lines.at(-1) === '') lines.pop();
      lines.push('', `[${tablePath.join('.')}]`, `${tableKey} = ${tableValue}`, '');
    } else lines.splice(at + 1, 0, `${tableKey} = ${tableValue}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join(newline));
  return 'added';
}

/**
 * Whether a writable root stays inside the project or the temp folder: an absolute path
 * inside the root, or a relative one that stays in it. `~` grows from HOME, and `$VAR`
 * from the environment. Anything yokoten can't place (an unknown variable, a path that
 * escapes) is outside: unsure is not fine. Shared with Grok's `read_write` (#589).
 */
export function isInsideProject(entry: string, root: string, env: Env): boolean {
  let path = entry.trim();
  if (path === '') return false;
  if (path.startsWith('~')) {
    const home = homeOf(env);
    if (!home) return false;
    path = join(home, path.slice(1).replace(/^\/+/, ''));
  }
  path = path.replace(/\$(\w+)|\$\{(\w+)\}/g, (_, one: string, two: string) => env[one ?? two] ?? '');
  if (path.includes('$')) return false;
  if (!isAbsolute(path)) path = resolve(root, path);
  const real = (dir: string): string => {
    try {
      return realpathSync(dir);
    } catch {
      // A root need not exist yet: resolve the nearest parent that does, then
      // re-append the rest, so a symlinked parent (/tmp on macOS) still compares.
      const rest: string[] = [];
      let parent = resolve(dir);
      for (;;) {
        const next = dirname(parent);
        if (next === parent) return parent;
        rest.unshift(parent.slice(next.length + (next.endsWith(sep) ? 0 : sep.length)));
        parent = next;
        try {
          return join(realpathSync(parent), ...rest);
        } catch {
          // Keep climbing.
        }
      }
    }
  };
  const inside = (dir: string, parent: string): boolean => dir === parent || dir.startsWith(`${parent}${sep}`);
  const resolved = real(path);
  if (inside(resolved, real(root))) return true;
  return [tmpdir(), '/tmp', '/var/tmp'].some((temp) => inside(resolved, real(temp)));
}

/**
 * The Codex sandbox against what init writes, or null when it is in place: missing keys
 * (`yokoten init` adds them), values the user must change by hand (init keeps what the
 * user set), and wider values (a mode with no sandbox, network on, or writes outside the
 * project). Never prints a writable root: it may hold the user's home folder.
 */
export function sandboxProblem(root: string, env: Env): { what: string; fix: string } | null {
  const file = SANDBOX_FILE;
  if (!existsSync(join(root, file))) return { what: `no Codex sandbox in ${file}`, fix: '`yokoten init` adds it' };
  let text: string;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return { what: `can't read ${file}`, fix: 'make it readable, then run `yokoten init`' };
  }
  const parsed = parseToml(text);
  const blanked = blankedToml(text);
  const table = TABLE_SANDBOX[0].reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), parsed);
  const network = isObject(table) ? table[TABLE_SANDBOX[1]] : undefined;
  const mode = parsed.sandbox_mode;
  if (typeof mode === 'string') {
    if (mode === 'danger-full-access') return { what: `the Codex sandbox is danger-full-access, so nothing is contained`, fix: `set sandbox_mode to "workspace-write" in ${file}` };
    if (mode === 'read-only') return { what: `the Codex sandbox is read-only, so workers can't write`, fix: `set sandbox_mode to "workspace-write" in ${file}` };
    if (mode !== 'workspace-write') return { what: `the Codex sandbox has an unknown mode`, fix: `set sandbox_mode to "workspace-write" in ${file}` };
    // A table on the name reads below, as a shape problem; anything else set is unknown.
  } else if ((mode === undefined && hasTomlKey(blanked, 'sandbox_mode')) || (mode !== undefined && !isObject(mode))) {
    return { what: `the Codex sandbox has an unknown mode`, fix: `set sandbox_mode to "workspace-write" in ${file}` };
  }
  if (network === true) return { what: `the Codex sandbox allows network (network_access)`, fix: `set network_access to false in ${file}` };
  if (network !== false && isTableSet(parsed, blanked)) return { what: `the Codex sandbox may allow network (network_access)`, fix: `set network_access to false in ${file}` };
  const roots = isObject(table) ? table.writable_roots : undefined;
  if (roots !== undefined || hasTomlKey(blanked, 'writable_roots')) {
    const entries = Array.isArray(roots) ? roots : null;
    if (entries === null || entries.some((entry) => typeof entry !== 'string' || !isInsideProject(entry, root, env))) {
      return { what: `the Codex sandbox may write outside the project (writable_roots)`, fix: `keep only project paths in writable_roots in ${file}` };
    }
  }
  const approval = parsed.approval_policy;
  if (approval === 'never') return { what: `Codex never asks before risky commands (approval_policy is never)`, fix: `set approval_policy to "on-request" in ${file}` };
  // A table on the name reads below, as a shape problem; anything else set is judged here.
  if (approval !== 'on-request' && !isObject(approval) && isTopSet(parsed, blanked, 'approval_policy')) {
    return { what: `the Codex approval_policy is not "on-request"`, fix: `set approval_policy to "on-request" in ${file}` };
  }
  if (
    isObject(parsed.sandbox_mode) ||
    isObject(parsed.approval_policy) ||
    isTopBlocked(parsed, blanked, 'sandbox_mode') ||
    isTopBlocked(parsed, blanked, 'approval_policy') ||
    isTableBlocked(parsed, blanked) ||
    (hasMissedTable(text, blanked) && !isTableSet(parsed, blanked)) ||
    isTakenTwice(blanked, 'sandbox_mode') ||
    isTakenTwice(blanked, 'approval_policy') ||
    isTakenTwice(blanked, 'sandbox_workspace_write')
  ) {
    return { what: `${file} has an unexpected shape`, fix: 'fix it, then run `yokoten init`' };
  }
  const missing = ['sandbox_mode', 'approval_policy'].filter((key) => !isTopSet(parsed, blanked, key));
  if (!isTableSet(parsed, blanked)) missing.push('network_access');
  if (missing.length > 0) return { what: `the Codex sandbox in ${file} is missing ${missing.join(', ')}`, fix: '`yokoten init` adds it' };
  return null;
}

/** The names this runtime's agent gets on top of the shared ones (#613). Codex signs in with its own login file; these are for an API key. */
export const AGENT_ENV: RuntimeEnv = { login: ['OPENAI_API_KEY', 'CODEX_API_KEY'], config: ['CODEX_HOME'] };

/**
 * What a desk (#637) gives Codex. CODEX_HOME points at the desk's own folder; only
 * `auth.json` is copied in, never `config.toml`: pass a provider with `-c` on the command.
 * Hosts: the OpenAI API, and DeepSeek's, which yokoten's DeepSeek workers reach through
 * Codex. A ChatGPT login also needs `--host chatgpt.com,auth.openai.com`. The binary names
 * HTTPS_PROXY and ALL_PROXY. Inside the desk Codex runs with `--sandbox danger-full-access`:
 * its own sandbox blocks `.git` and the pipes tests use.
 */
export const DESK: RuntimeDesk = {
  leadState: (env) => [env.CODEX_HOME || join(homeIn(env), '.codex')],
  login: (env) => [{ from: join(env.CODEX_HOME || join(homeIn(env), '.codex'), 'auth.json'), to: 'auth.json' }],
  stateEnv: (state) => ({ CODEX_HOME: state }),
  hosts: ['api.openai.com', 'api.deepseek.com'],
  identity: readModelIdentity,
};

const approve = (start: string) => `\`YOKOTEN_RELEASE_APPROVAL=1 ${start}\``;

/** The contract every adapter fills (#395). */
export const ADAPTER: AgentAdapter = {
  name: 'codex',
  label: 'Codex CLI',
  projectHook: '`.codex/hooks.json`: PreToolUse and Stop',
  userHook: '~/.codex/hooks.json',
  blocking: 'exit 2, the reason on stderr',
  capabilities: { canRewrite: false, hasStopHook: true, needsTrust: true, failsOpen: false, passesRole: true },
  readToolCall,
  readStop,
  releaseFix: releaseFix(approve('codex')),
  agentEnv: AGENT_ENV,
  desk: DESK,
  call: (command) => ({ cwd: '/repo', tool_name: 'Bash', tool_input: { command } }),
};

// ---- Writing that trust (#661) ----
//
// `yokoten trust` writes each agent's trust store, and `yokoten trust --undo` puts back
// exactly what it changed (record 0014). A write touches only the entries yokoten names
// and keeps every other line. Codex and Grok keep trust in TOML, Muse Code and Copilot
// CLI in JSON; this writer is shared by all four.

/** How an agent's trust store is written: TOML (`config.toml`), or JSON (`trust.json`). */
export type TrustFormat = 'toml' | 'json';

/**
 * One value yokoten writes into an agent's trust store. `path` names the table (TOML) or
 * the objects (JSON) that hold it; `key` is the field inside. `before` is the value that was
 * there, or null when the field was missing: that is what undo puts back.
 */
export interface TrustChange {
  /** The agent's name for a report: Codex, Grok CLI, Muse Code, Copilot CLI. */
  agent: string;
  /** The store as the user would type it: `~/.codex/config.toml` or `$CODEX_HOME/...`. */
  store: string;
  /** The store's real path. */
  file: string;
  format: TrustFormat;
  path: string[];
  key: string;
  /** What yokoten writes, as a string: `trusted`, `true`, a hash, a folder. */
  value: string;
  /** What was there before, or null when the key was missing. */
  before: string | null;
  /** A true/false value in TOML or JSON, or a list item in Copilot's `trustedFolders`. */
  kind?: 'boolean' | 'list';
}

/** What one agent's trust store needs: entries to write, and what was there. */
export interface TrustPlan {
  state: 'trusted' | 'same' | 'unreadable' | 'no home';
  store: string;
  changes: TrustChange[];
  /** The shape of a missing store: Muse's schema version, or Copilot's list. */
  seed?: unknown;
}

/** One table path as TOML writes it: a bare key when it can be, a quoted one otherwise. */
const tomlKey = (part: string): string => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part));

/** A `[a."b"]` header line as its path, or null for any other line. */
function trustHeaderPath(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return null;
  const path = readTomlPath(trimmed.slice(1));
  if (!path || !path[1].startsWith(']') || !/^\s*(#.*)?$/.test(path[1].slice(1))) return null;
  return path[0];
}

/** Whether a header line names exactly `path`. */
const isTrustTable = (line: string, path: readonly string[]): boolean => {
  const found = trustHeaderPath(line);
  return !!found && found.length === path.length && found.every((part, at) => part === path[at]);
};

/** The value of a field as a string, from parsed TOML: a string or a boolean. */
function tomlValue(text: string, path: readonly string[], key: string): string | null {
  const table = path.reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), parseToml(text));
  const value = isObject(table) ? table[key] : undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  return null;
}

/** The lines of a file, and the newline it uses. */
const splitLines = (text: string): { lines: string[]; newline: string } => ({ lines: text.split(/\r?\n/), newline: text.includes('\r\n') ? '\r\n' : '\n' });

/** A field as TOML writes it: a boolean as it is, a string quoted as JSON, which TOML reads. */
const tomlField = (key: string, value: string, isBoolean: boolean): string => `${key} = ${isBoolean ? value : JSON.stringify(value)}`;

/**
 * Set one field in a TOML file, or remove it when `value` is null. The table is added when
 * it is missing; a dotted key is edited where it stands. When the value lives in a shape
 * this writer does not edit (an inline table), the text comes back the same: never a
 * second key, which TOML reads as an error.
 */
function setTomlField(text: string, path: readonly string[], key: string, value: string | null, kind?: 'boolean'): string {
  const { lines, newline } = splitLines(text);
  // A dotted key (`projects."/a".trust_level = "trusted"`) is one line: edit it where it is.
  for (let at = 0; at < lines.length; at++) {
    const found = readTomlPath(lines[at]);
    if (!found) continue;
    const isField = found[1].trimStart().startsWith('=') && found[0].length === path.length + 1 && path.every((part, index) => part === found[0][index]) && found[0].at(-1) === key;
    if (!isField) continue;
    if (value === null) lines.splice(at, 1);
    else lines[at] = tomlField(found[0].map(tomlKey).join('.'), value, kind === 'boolean');
    return lines.join(newline);
  }
  const start = lines.findIndex((line) => isTrustTable(line, path));
  if (start < 0) {
    if (value === null) return text;
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(`[${path.map(tomlKey).join('.')}]`, tomlField(key, value, kind === 'boolean'), '');
    return lines.join(newline);
  }
  let end = lines.length;
  for (let at = start + 1; at < lines.length; at++) {
    if (trustHeaderPath(lines[at])) {
      end = at;
      break;
    }
  }
  for (let at = start + 1; at < end; at++) {
    const pair = readTomlPath(lines[at]);
    if (!pair || pair[0].length !== 1 || pair[0][0] !== key || !pair[1].trimStart().startsWith('=')) continue;
    if (value === null) {
      lines.splice(at, 1);
      // A table yokoten made for one value goes with it, so undo leaves no empty header.
      let hasField = false;
      for (let line = start + 1; line < end - 1; line++) {
        const field = readTomlPath(lines[line]);
        if (field && field[1].trimStart().startsWith('=')) hasField = true;
      }
      if (!hasField) {
        lines.splice(start, 1);
        if (lines[start] === '' && (start === 0 || lines[start - 1] === '')) lines.splice(start, 1);
      }
    } else lines[at] = tomlField(key, value, kind === 'boolean');
    return lines.join(newline);
  }
  if (value === null) return text;
  lines.splice(start + 1, 0, tomlField(key, value, kind === 'boolean'));
  return lines.join(newline);
}

/**
 * A JSON file as its leading comment lines and its data. Copilot CLI writes `//` comment
 * lines before its JSON; they are kept exactly. A comment inside the JSON is not a shape
 * this writer edits: null, and the caller leaves the file alone.
 */
function readJson(text: string): { prefix: string; data: unknown } | null {
  const lines = text.split('\n');
  let at = 0;
  while (at < lines.length && (lines[at].trim() === '' || lines[at].trimStart().startsWith('//'))) at++;
  const prefix = lines.slice(0, at).join('\n') + (at > 0 ? '\n' : '');
  try {
    const data = JSON.parse(lines.slice(at).join('\n'));
    return isObject(data) ? { prefix, data } : null;
  } catch {
    return null;
  }
}

/** The object at `path` in a JSON value, made as it goes when `make` is true. */
function jsonObject(data: unknown, path: readonly string[], make: boolean): Record<string, unknown> | null {
  let at = data;
  for (const part of path) {
    if (!isObject(at)) return null;
    if (!isObject(at[part])) {
      if (!make) return null;
      at[part] = {};
    }
    at = at[part];
  }
  return isObject(at) ? at : null;
}

/** The value of a JSON field as a string, for a plain value. */
function jsonValue(data: unknown, path: readonly string[], key: string): string | null {
  const table = jsonObject(data, path, false);
  const value = table ? table[key] : undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  return null;
}

/** Set one field in JSON, add an item to a list, or remove it. False when the file's shape blocks it. */
function setJsonField(data: Record<string, unknown>, change: TrustChange, isUndo: boolean): boolean {
  const table = jsonObject(data, change.path, !isUndo);
  if (!table) return false;
  if (change.kind === 'list') {
    const list = Array.isArray(table[change.key]) ? (table[change.key] as unknown[]).filter((item): item is string => typeof item === 'string') : undefined;
    if (!list) return false;
    if (isUndo && !list.includes(change.value)) return false;
    table[change.key] = isUndo ? list.filter((item) => item !== change.value) : [...new Set([...list, change.value])];
    return true;
  }
  if (isUndo) {
    if (jsonValue(data, change.path, change.key) !== change.value) return false;
    if (change.before === null) {
      delete table[change.key];
      // An object yokoten made for one value goes with it.
      let parent = data;
      for (const part of change.path.slice(0, -1)) parent = isObject(parent[part]) ? (parent[part] as Record<string, unknown>) : parent;
      const last = change.path.at(-1);
      if (last && parent !== data && isObject(parent[last]) && Object.keys(parent[last] as object).length === 0) delete parent[last];
    } else table[change.key] = change.kind === 'boolean' ? change.before === 'true' : change.before;
    return true;
  }
  table[change.key] = change.kind === 'boolean' ? change.value === 'true' : change.value;
  return true;
}

/** Write the changes for one agent's store. 'kept' when the file holds the value in a shape yokoten won't edit. */
export function writeTrust(plan: TrustPlan): 'written' | 'kept' | 'unreadable' {
  const first = plan.changes[0];
  if (!first) return 'kept';
  const file = first.file;
  let text = '';
  if (existsSync(file)) {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return 'unreadable';
    }
  }
  let written = false;
  if (first.format === 'toml') {
    for (const change of plan.changes) {
      const before = text;
      text = setTomlField(text, change.path, change.key, change.value, change.kind === 'boolean' ? 'boolean' : undefined);
      if (text !== before) written = true;
      else if (tomlValue(before, change.path, change.key) !== change.value) return 'kept';
    }
  } else {
    const parsed = text === '' ? { prefix: '', data: plan.seed ?? {} } : readJson(text);
    if (!parsed) return 'unreadable';
    for (const change of plan.changes) if (setJsonField(parsed.data as Record<string, unknown>, change, false)) written = true;
    if (!written) return 'kept';
    text = `${parsed.prefix}${JSON.stringify(parsed.data, null, 2)}\n`;
  }
  if (!written) return 'kept';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return 'written';
}

/** Put one entry back the way it was. 'kept' when the user changed it since, or the file is gone. */
export function revertTrust(change: TrustChange): 'reverted' | 'kept' | 'unreadable' {
  if (!existsSync(change.file)) return 'kept';
  let text: string;
  try {
    text = readFileSync(change.file, 'utf8');
  } catch {
    return 'unreadable';
  }
  if (change.format === 'toml') {
    if (tomlValue(text, change.path, change.key) !== change.value) return 'kept';
    const next = setTomlField(text, change.path, change.key, change.before, change.kind === 'boolean' ? 'boolean' : undefined);
    if (next === text) return 'kept';
    writeFileSync(change.file, next);
    return 'reverted';
  }
  const parsed = readJson(text);
  if (!parsed) return 'unreadable';
  if (!setJsonField(parsed.data as Record<string, unknown>, change, true)) return 'kept';
  writeFileSync(change.file, `${parsed.prefix}${JSON.stringify(parsed.data, null, 2)}\n`);
  return 'reverted';
}
