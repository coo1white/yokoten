// What yokoten knows about Google's Antigravity CLI (`agy`): the shape of its PreToolUse event,
// how a hook refuses a call, and where its project hook lives.
// Source: https://antigravity.google/docs/hooks, checked against agy 1.4.2 on 2026-10-19.
//
// What the real runs showed, past the docs page:
// - agy runs a hook with its cwd at the hooks file's folder (`.agents/`), not the repo root.
// - A hook that exits non-zero refuses the call (it fails closed), and so does a missing
//   runtime. Empty stdout with exit 0 lets the call go on.
// - `--dangerously-skip-permissions` skips the hooks altogether.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import type { Action } from '../../run/hook.ts';
import { type Added, type HookState, isObject, type Problem, UnreadableHooksFile } from '../hooks-file.ts';
import type { RuntimeEnv } from '../agent-env.ts';

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

/** What `addProjectHook` would do, read-only: 'same', 'updated', 'added', or why it won't touch the file. */
export function projectHookState(root: string, cli: string): HookState {
  const read = readEntries(projectHooks(root));
  if ('problem' in read) return read.problem;
  const entry = read.entries[NAME] as Record<string, unknown> | undefined;
  if (entry?.[EVENT] === undefined) return 'added';
  return JSON.stringify(entry[EVENT]) === JSON.stringify([projectGroup(cli)]) && entry.enabled !== false ? 'same' : 'updated';
}

/**
 * Write the guard into `.agents/hooks.json`, as the `yokoten` entry's PreToolUse. An older
 * guard, or one turned off with `enabled: false`, is replaced. A file yokoten can't edit
 * throws `UnreadableHooksFile` and stays as it was.
 */
export function addProjectHook(root: string, cli: string): Added {
  const path = projectHooks(root);
  const read = readEntries(path);
  if ('problem' in read) throw new UnreadableHooksFile(path, read.problem);
  const state = projectHookState(root, cli);
  if (state === 'same') return state;
  const entry = (read.entries[NAME] ?? {}) as Record<string, unknown>;
  delete entry.enabled;
  read.entries[NAME] = { ...entry, [EVENT]: [projectGroup(cli)] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(read.entries, null, 2)}\n`);
  return state as Added;
}

/** Whether `.agents/hooks.json` has the guard, on, as `addProjectHook` writes it for `cli`. */
export const hasProjectHook = (root: string, cli: string): boolean => projectHookState(root, cli) === 'same';

/** The names this runtime's agent gets on top of the shared ones (#613). Antigravity signs in through its app, so it needs no login name. */
export const AGENT_ENV: RuntimeEnv = { login: [], config: [] };
