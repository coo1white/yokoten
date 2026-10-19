// The hooks table that Claude Code, Codex and Gemini CLI all keep in a JSON file:
// { "hooks": { "<event>": [{ "matcher": "...", "hooks": [{ "type": "command", "command": "..." }] }] } }.
// Each adapter names its own file, event, matcher and command; this file only edits the
// table, and keeps everything else in the file as it was.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runs, subcommand } from '../run/cli.ts';

export type Added = 'same' | 'updated' | 'added';
/**
 * Why `addHook` won't touch a file: it doesn't parse ('json'), or a key it would edit has
 * the wrong type ('shape', and `hint` names the key and the type it should be).
 */
export type Problem = { kind: 'json' } | { kind: 'shape'; hint: string };
/** What `hookState` finds: what `addHook` would do, or why it won't touch the file. */
export type HookState = Added | Problem;
/** `addHook`'s arguments: the file, event, matcher, command and extra fields. */
export type HookArgs = [path: string, event: string, matcher: string | undefined, command: string, extra?: Record<string, string>];

interface Handler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: Handler[];
}
export interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export const readSettings = (path: string): Settings => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});

export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * A file `addHook` won't touch (see `Problem`). It is thrown before anything is written,
 * so the caller can name the file, skip it and go on (#248).
 */
export class UnreadableHooksFile extends Error {
  readonly path: string;
  readonly problem: Problem;
  constructor(path: string, problem: Problem) {
    super(problem.kind === 'json' ? `can't read ${path} (make it valid JSON)` : `${path} has an unexpected shape (${problem.hint})`);
    this.name = 'UnreadableHooksFile';
    this.path = path;
    this.problem = problem;
  }
}

/** The line that says a file was skipped, `file` as the user should see it and `command` the one to run again. */
export const skippedBecause = (file: string, problem: Problem, command: string): string =>
  problem.kind === 'json' ? `can't read ${file} (make it valid JSON, then run \`yokoten ${command}\` again)` : `${file} has an unexpected shape (${problem.hint})`;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isObjectList = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every(isObject);

/**
 * Whether `placeHook` can edit `events` in these settings. Only the keys it walks are
 * checked: the top level and `hooks` are objects, each `hooks[event]` is missing or a list
 * of objects, and so is each of their `hooks`. Any other key, such as Gemini CLI's
 * `hooks.disabled`, is the user's and is left alone.
 */
function shapeProblem(settings: unknown, events: readonly string[]): Problem | null {
  const shape = (hint: string): Problem => ({ kind: 'shape', hint });
  if (!isObject(settings)) return shape('the file should be a JSON object');
  const { hooks } = settings;
  if (hooks === undefined) return null;
  if (!isObject(hooks)) return shape('`hooks` should be an object');
  for (const event of events) {
    const groups = hooks[event];
    if (groups === undefined) continue;
    if (!isObjectList(groups)) return shape(`\`hooks.${event}\` should be a list of objects`);
    const bad = groups.findIndex((group) => group.hooks !== undefined && !isObjectList(group.hooks));
    if (bad >= 0) return shape(`\`hooks.${event}[${bad}].hooks\` should be a list of objects`);
  }
  return null;
}

/** The file's settings when `placeHook` can edit `events` in it, or why it can't. */
export function readTable(path: string, events: readonly string[]): { settings: Settings } | { problem: Problem } {
  let settings: unknown;
  try {
    settings = readSettings(path);
  } catch {
    return { problem: { kind: 'json' } };
  }
  const problem = shapeProblem(settings, events);
  return problem ? { problem } : { settings: settings as Settings };
}

/**
 * Throw `UnreadableHooksFile` unless `addHook` can edit every one of `events` in the file.
 * A caller that adds more than one hook to a file checks them all first, so a bad second
 * event leaves the file as it was, not half written.
 */
export function checkHooksFile(path: string, events: readonly string[]): void {
  const table = readTable(path, events);
  if ('problem' in table) throw new UnreadableHooksFile(path, table.problem);
}

/**
 * Put a command hook in `settings`, once, and say what that took. A hook that runs the
 * same yokoten `<sub>` counts as already there (an older path is updated in place).
 * `extra` holds more handler fields, such as Gemini CLI's `name`. Only `settings` in
 * memory changes; `addHook` writes it and `hookState` throws it away.
 */
function placeHook(settings: Settings, event: string, matcher: string | undefined, command: string, extra: Record<string, string>): Added {
  const sub = subcommand(command);
  const groups = ((settings.hooks ??= {})[event] ??= []);
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (sub && runs(sub).test(hook.command ?? '')) {
        if (hook.command === command && (group.matcher ?? '') === (matcher ?? '') && Object.entries(extra).every(([k, v]) => hook[k] === v)) return 'same';
        Object.assign(hook, extra, { command });
        if (matcher !== undefined) group.matcher = matcher;
        return 'updated';
      }
    }
  }
  const group: HookGroup = { hooks: [{ type: 'command', command, ...extra }] };
  if (matcher !== undefined) group.matcher = matcher;
  groups.push(group);
  return 'added';
}

/**
 * Add a command hook to a settings file, once (see `placeHook`), and write the file when
 * that changed it. A file it can't edit (see `checkHooksFile`) throws
 * `UnreadableHooksFile` and stays as it was.
 */
export function addHook(path: string, event: string, matcher: string | undefined, command: string, extra: Record<string, string> = {}): Added {
  const table = readTable(path, [event]);
  if ('problem' in table) throw new UnreadableHooksFile(path, table.problem);
  const added = placeHook(table.settings, event, matcher, command, extra);
  if (added !== 'same') writeSettings(path, table.settings);
  return added;
}

/**
 * What `addHook` would do with these arguments, read-only: 'same' when the hook is there
 * as it would write it, 'updated' when it is there but out of date (command, matcher or
 * fields), 'added' when it is missing, and the `Problem` when `addHook` would refuse the file.
 */
export function hookState(path: string, event: string, matcher: string | undefined, command: string, extra: Record<string, string> = {}): HookState {
  const table = readTable(path, [event]);
  return 'problem' in table ? table.problem : placeHook(table.settings, event, matcher, command, extra);
}

/** Whether the file has a hook for `event` that runs yokoten's `<sub>`; no for a file `addHook` can't edit. */
export function hasHook(path: string, event: string, sub: string): boolean {
  const table = readTable(path, [event]);
  if ('problem' in table) return false;
  return (table.settings.hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => runs(sub).test(h.command ?? '')));
}
