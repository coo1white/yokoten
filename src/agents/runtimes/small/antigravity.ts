// What yokoten knows about Google's Antigravity CLI (`agy`): the shape of its PreToolUse event,
// how a hook refuses a call, and where its project hook lives.
// Source: https://antigravity.google/docs/hooks, checked against agy 1.4.2 on 2026-10-19.
//
// What the real runs showed, past the docs page:
// - agy runs a hook with its cwd at the hooks file's folder (`.agents/`), not the repo root.
// - A hook that exits non-zero refuses the call (it fails closed), and so does a missing
//   runtime. Empty stdout with exit 0 lets the call go on.
// - `--dangerously-skip-permissions` skips the hooks altogether.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from '../../../rules/config.ts';
import { homeIn } from '../../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../../run/cli.ts';
import type { Action } from '../../../run/hook.ts';
import { type Added, type HookState, isObject, type Problem, UnreadableHooksFile } from '../../hooks-file.ts';
import type { RuntimeEnv } from '../../desk/agent-env.ts';

// run_command takes `CommandLine` and `Cwd`; the three edit tools take `TargetFile`.
const SHELL = 'run_command';
const EDITS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);

/** A PreToolUse call, as an Action. Any other tool (view_file, browser, MCP) is neither. */
export function readToolCall(input: unknown): Action {
  const call = (isObject(input) ? input : {}) as { toolCall?: unknown; workspacePaths?: unknown };
  const toolCall = isObject(call.toolCall) ? call.toolCall : {};
  const args = isObject(toolCall.args) ? toolCall.args : {};
  const name = typeof toolCall.name === 'string' ? toolCall.name : '';
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const workspace = Array.isArray(call.workspacePaths) ? text(call.workspacePaths[0]) : undefined;
  const file = text(args.TargetFile);
  return {
    command: name === SHELL ? text(args.CommandLine) : undefined,
    paths: EDITS.has(name) && file ? [file] : [],
    cwd: (name === SHELL ? text(args.Cwd) : undefined) ?? workspace,
    // A PreToolUse call names no subagent role; YOKOTEN_ROLE decides.
    worker: false,
  };
}

/**
 * How a refusal reaches agy: a `deny` decision on stdout, exit 0. A non-zero exit refuses
 * too, but then agy shows "command failed" in place of the reason.
 */
export const formatDenial = (reason: string): { stdout: string; exitCode: number } => ({ stdout: JSON.stringify({ decision: 'deny', reason }), exitCode: 0 });

// agy's hooks.json maps a hook's name to its events: { "<name>": { "PreToolUse": [groups] } }.
// yokoten owns the entry named `yokoten`, and leaves every other entry as it was.
const NAME = 'yokoten';
const EVENT = 'PreToolUse';
const projectHooks = (root: string) => join(root, '.agents', 'hooks.json');

/**
 * The project's tool-call guard. agy runs it in `.agents/` and sets no project-dir
 * variable, so the path comes from the git root, as in Codex's hook.
 */
const projectGroup = (cli: string) => ({
  matcher: [SHELL, ...EDITS].join('|'),
  hooks: [{ type: 'command', command: guardCommand(`"$(git rev-parse --show-toplevel)/${cli}"`, 'hook --agent antigravity', missingProjectRuntime(cli), { isToolCall: true }) }],
});

/** The file's entries, or why yokoten won't edit it: not JSON, or `yokoten` is not an object. */
function readEntries(path: string): { entries: Record<string, unknown> } | { problem: Problem } {
  let entries: unknown = {};
  try {
    entries = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { problem: { kind: 'json' } };
  }
  if (!isObject(entries)) return { problem: { kind: 'shape', hint: 'the file should be a JSON object' } };
  if (entries[NAME] !== undefined && !isObject(entries[NAME])) return { problem: { kind: 'shape', hint: `\`${NAME}\` should be an object` } };
  return { entries };
}

/** The entry's PreToolUse against `group`, or why the file won't be edited. */
function entryState(path: string, group: object): HookState {
  const read = readEntries(path);
  if ('problem' in read) return read.problem;
  const entry = read.entries[NAME] as Record<string, unknown> | undefined;
  if (entry?.[EVENT] === undefined) return 'added';
  return JSON.stringify(entry[EVENT]) === JSON.stringify([group]) && entry.enabled !== false ? 'same' : 'updated';
}

/**
 * Write `group` as the `yokoten` entry's PreToolUse. An older guard, or one turned off with
 * `enabled: false`, is replaced. A file yokoten can't edit throws `UnreadableHooksFile` and
 * stays as it was.
 */
function writeEntry(path: string, group: object): Added {
  const read = readEntries(path);
  if ('problem' in read) throw new UnreadableHooksFile(path, read.problem);
  const state = entryState(path, group);
  if (state === 'same') return state;
  const entry = (read.entries[NAME] ?? {}) as Record<string, unknown>;
  delete entry.enabled;
  read.entries[NAME] = { ...entry, [EVENT]: [group] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(read.entries, null, 2)}\n`);
  return state as Added;
}

/** What `addProjectHook` would do, read-only: 'same', 'updated', 'added', or why it won't touch the file. */
export const projectHookState = (root: string, cli: string): HookState => entryState(projectHooks(root), projectGroup(cli));

/** Write the guard into `.agents/hooks.json`, as the `yokoten` entry's PreToolUse. */
export const addProjectHook = (root: string, cli: string): Added => writeEntry(projectHooks(root), projectGroup(cli));

/** Whether `.agents/hooks.json` has the guard, on, as `addProjectHook` writes it for `cli`. */
export const hasProjectHook = (root: string, cli: string): boolean => projectHookState(root, cli) === 'same';

// ---- The user's guard (#342) ----
//
// agy runs ~/.gemini/config/hooks.json in every workspace, so a repo without yokoten is
// guarded too. The file has the project file's shape. agy cannot say which workspace it
// started in with a variable (the project hook asks git), so the command calls the
// installed runtime by absolute path, and the call's own `Cwd` or `workspacePaths` gives
// the guard its folder. No stop check: agy's Stop event has no `stop_hook_active`, so a
// "continue" decision could loop (#342).

const userHooks = (env: Env) => join(homeIn(env), '.gemini', 'config', 'hooks.json');

/** The user's file as the report shows it. */
export const userHooksFile = (_env: Env): string => '~/.gemini/config/hooks.json';

/** The user-level guard: shell calls only, as Claude Code's and Codex's user guards are. */
const userGroup = (cli: string, missing: string) => ({
  matcher: SHELL,
  hooks: [{ type: 'command', command: guardCommand(cli, 'hook --agent antigravity --commands-only', missing, { isToolCall: true }) }],
});

/** Whether agy looks used on this machine: its config folder, ~/.gemini/config, is a folder. */
export function hasUserDir(env: Env): boolean {
  try {
    return statSync(dirname(userHooks(env))).isDirectory();
  } catch {
    return false;
  }
}

/** The user's guard against what `addUserHooks` would write, read-only. */
export const userHooksState = (env: Env, cli: string, missing: string): { guard: HookState } => ({ guard: entryState(userHooks(env), userGroup(cli, missing)) });

/** Write the user's guard; `missing` is what it says when `cli` is gone. */
export function addUserHooks(env: Env, cli: string, missing: string): { guard: Added } {
  return { guard: writeEntry(userHooks(env), userGroup(cli, missing)) };
}

/** Take out the `yokoten` entry, or null when the file is not JSON and stays as it is. */
export function removeUserHooks(env: Env): 'removed' | 'not there' | null {
  const path = userHooks(env);
  const read = readEntries(path);
  if ('problem' in read) return null;
  if (!(NAME in read.entries)) return 'not there';
  delete read.entries[NAME];
  if (Object.keys(read.entries).length) writeFileSync(path, `${JSON.stringify(read.entries, null, 2)}\n`);
  else rmSync(path, { force: true });
  return 'removed';
}

/** The names this runtime's agent gets on top of the shared ones (#613). Antigravity signs in through its app, so it needs no login name. */
export const AGENT_ENV: RuntimeEnv = { login: [], config: [] };
