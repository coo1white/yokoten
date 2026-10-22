// What yokoten knows about OpenAI's Codex CLI: the shape of its PreToolUse and Stop events, and where
// its project and user hooks live. Source: https://developers.openai.com/codex/hooks
//
// Codex runs a project's hooks only after the user trusts the project's .codex/ folder
// and reviews the hook (`/hooks`). It records trust against the hook's hash, so a changed
// command has to be trusted again.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeIn, homeOf } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import { type Action, isWorkerType } from '../../run/hook.ts';
import { type FolderTrust, folderKeys, isFolder } from '../folder-trust.ts';
import { type Added, addHook, checkHooksFile, hasHook, type HookArgs, type HookState, hookState, isObject } from '../hooks-file.ts';

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
export { readStop } from './claude-code.ts';

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
export const TRUST_STEP = 'run `codex` in this folder, trust it, then trust both yokoten hooks in `/hooks`';

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

/** A dotted TOML key (`a."b c".d`): its parts and the text after it. */
function readTomlPath(text: string): [string[], string] | null {
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
