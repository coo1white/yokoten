// The hooks table that Claude Code, Codex and Gemini CLI all keep in a JSON file:
// { "hooks": { "<event>": [{ "matcher": "...", "hooks": [{ "type": "command", "command": "..." }] }] } }.
// Each adapter names its own file, event, matcher and command; this file only edits the
// table, and keeps everything else in the file as it was.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runs, subcommand } from '../run/cli.ts';

export type Added = 'same' | 'updated' | 'added';
/**
 * Why `addHook` won't touch a file: it doesn't parse ('json'), a key it would edit has the
 * wrong type ('shape', and `hint` names the key and the type it should be), or it has
 * comments and a hook is missing or out of date ('comments', and `add` holds the hook groups
 * to add by hand, by event). Rewriting a commented file would drop the comments (#258).
 */
export type Problem = { kind: 'json' } | { kind: 'shape'; hint: string } | { kind: 'comments'; add: Record<string, HookGroup[]> };
/** What `hookState` finds: what `addHook` would do, or why it won't touch the file. */
export type HookState = Added | Problem;
/**
 * How a file is read. `comments`: line (`//`) and block (`/*`) comments are allowed, as
 * Gemini CLI allows them in its settings.json (it reads it with strip-json-comments).
 * Trailing commas are not: Gemini CLI doesn't allow them either.
 */
export interface ReadOptions {
  comments?: boolean;
}
/** `addHook`'s arguments: the file, event, matcher, command, extra fields and how to read the file. */
export type HookArgs = [path: string, event: string, matcher: string | undefined, command: string, extra?: Record<string, string | number>, options?: ReadOptions];

interface Handler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
export interface HookGroup {
  matcher?: string;
  hooks?: Handler[];
}
export interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/**
 * The text with each line (`//`) and block (`/*`) comment outside a string turned into
 * spaces (a newline stays a newline), so a parse error still points at the right place.
 * An unclosed block comment runs to the end, as in strip-json-comments.
 */
export function stripComments(text: string): string {
  let out = '';
  let pos = 0;
  while (pos < text.length) {
    const char = text[pos];
    let end = pos + 1;
    if (char === '"') {
      // A string, to its closing quote; a backslash escapes the next character.
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(pos, end + 1);
      end++;
    } else if (char === '/' && text[pos + 1] === '/') {
      // Only a newline ends it, as in Gemini CLI's parser: a lone \r does not.
      while (end < text.length && text[end] !== '\n') end++;
      out += text.slice(pos, end).replace(/[^\r]/g, ' ');
    } else if (char === '/' && text[pos + 1] === '*') {
      const close = text.indexOf('*/', pos + 2);
      end = close < 0 ? text.length : close + 2;
      out += text.slice(pos, end).replace(/[^\r\n]/g, ' ');
    } else out += char;
    pos = end;
  }
  return out;
}

/** The file's text, and whether it had comments: only when `options.comments` allows them. */
function readText(path: string, options: ReadOptions): { text: string; commented: boolean } {
  if (!existsSync(path)) return { text: '{}', commented: false };
  const raw = readFileSync(path, 'utf8');
  if (!options.comments) return { text: raw, commented: false };
  const text = stripComments(raw);
  return { text, commented: text !== raw };
}

export const readSettings = (path: string, options: ReadOptions = {}): Settings => JSON.parse(readText(path, options).text);

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
    super(problem.kind === 'json' ? `can't read ${path} (make it valid JSON)` : problem.kind === 'shape' ? `${path} has an unexpected shape (${problem.hint})` : commentedFile(path));
    this.name = 'UnreadableHooksFile';
    this.path = path;
    this.problem = problem;
  }
}

/** The line that says a file was skipped, `file` as the user should see it and `command` the one to run again. */
export function skippedBecause(file: string, problem: Problem, command: string): string {
  if (problem.kind === 'json') return `can't read ${file} (make it valid JSON, then run \`yokoten ${command}\` again)`;
  if (problem.kind === 'shape') return `${file} has an unexpected shape (${problem.hint})`;
  return `${commentedFile(file)}; ${HAND_ADD}, then run \`yokoten ${command}\` again:\n${handAddJson(problem.add, '  ')}`;
}

/** What doctor and the skip line say about a commented file with a hook missing (#258). */
export const commentedFile = (file: string): string => `${file} has comments, so yokoten won't rewrite it`;
export const HAND_ADD = 'add this under "hooks" by hand (each group in the list for its event, in place of an older yokoten one)';

/** The hook groups to add by hand, as JSON: indented by `indent` on each line, or on one line when it is null. */
export function handAddJson(add: Record<string, HookGroup[]>, indent: string | null): string {
  if (indent === null) return JSON.stringify(add);
  return JSON.stringify(add, null, 2)
    .split('\n')
    .map((line) => indent + line)
    .join('\n');
}

/** The 'comments' problems' groups as one, by event: doctor and the skip line show them together. */
export function mergeHandAdds(problems: readonly (HookState | null)[]): Problem | null {
  const add: Record<string, HookGroup[]> = {};
  for (const problem of problems) {
    if (typeof problem !== 'object' || problem === null || problem.kind !== 'comments') continue;
    for (const [event, groups] of Object.entries(problem.add)) (add[event] ??= []).push(...groups);
  }
  return Object.keys(add).length ? { kind: 'comments', add } : null;
}

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

/**
 * The file's settings when `placeHook` can edit `events` in it, or why it can't.
 * `commented` says the file had comments, so it must not be rewritten.
 */
export function readTable(path: string, events: readonly string[], options: ReadOptions = {}): { settings: Settings; commented: boolean } | { problem: Problem } {
  let settings: unknown;
  let commented: boolean;
  try {
    const read = readText(path, options);
    commented = read.commented;
    settings = JSON.parse(read.text);
  } catch {
    return { problem: { kind: 'json' } };
  }
  const problem = shapeProblem(settings, events);
  return problem ? { problem } : { settings: settings as Settings, commented };
}

/**
 * Throw `UnreadableHooksFile` unless `addHook` can edit every one of `events` in the file.
 * A caller that adds more than one hook to a file checks them all first, so a bad second
 * event leaves the file as it was, not half written.
 */
export function checkHooksFile(path: string, events: readonly string[], options: ReadOptions = {}): void {
  const table = readTable(path, events, options);
  if ('problem' in table) throw new UnreadableHooksFile(path, table.problem);
}

/**
 * `checkHooksFile` for hooks that all go in one file, and more: when the file has
 * comments and any of them is missing or out of date, throw one 'comments' problem that
 * holds them all, so the user adds them by hand in one go (#258).
 */
export function checkHooks(hooks: readonly HookArgs[]): void {
  const [path, , , , , options] = hooks[0];
  checkHooksFile(path, hooks.map((hook) => hook[1]), options);
  const problem = mergeHandAdds(hooks.map((hook) => hookState(...hook)));
  if (problem) throw new UnreadableHooksFile(path, problem);
}

/** The group `placeHook` adds for a missing hook. */
function newGroup(matcher: string | undefined, command: string, extra: Record<string, string | number>): HookGroup {
  const group: HookGroup = { hooks: [{ type: 'command', command, ...extra }] };
  if (matcher !== undefined) group.matcher = matcher;
  return group;
}

/**
 * Put a command hook in `settings`, once, and say what that took. A hook that runs the
 * same yokoten `<sub>` counts as already there (an older path is updated in place).
 * `extra` holds more handler fields, such as Gemini CLI's `name` or Grok CLI's `timeout`. Only `settings` in
 * memory changes; `addHook` writes it and `hookState` throws it away.
 */
function placeHook(settings: Settings, event: string, matcher: string | undefined, command: string, extra: Record<string, string | number>): Added {
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
  groups.push(newGroup(matcher, command, extra));
  return 'added';
}

/**
 * Add a command hook to a settings file, once (see `placeHook`), and write the file when
 * that changed it. A file it can't edit (see `checkHooksFile`), or one with comments the
 * hook isn't in yet, throws `UnreadableHooksFile` and stays as it was.
 */
export function addHook(path: string, event: string, matcher: string | undefined, command: string, extra: Record<string, string | number> = {}, options: ReadOptions = {}): Added {
  const state = hookState(path, event, matcher, command, extra, options);
  if (typeof state === 'object') throw new UnreadableHooksFile(path, state);
  if (state === 'same') return state;
  const table = readTable(path, [event], options);
  if ('problem' in table) throw new UnreadableHooksFile(path, table.problem);
  placeHook(table.settings, event, matcher, command, extra);
  writeSettings(path, table.settings);
  return state;
}

/**
 * What `addHook` would do with these arguments, read-only: 'same' when the hook is there
 * as it would write it, 'updated' when it is there but out of date (command, matcher or
 * fields), 'added' when it is missing, and the `Problem` when `addHook` would refuse the
 * file. In a file with comments, a hook that isn't 'same' is a 'comments' problem holding
 * the group to add by hand.
 */
export function hookState(path: string, event: string, matcher: string | undefined, command: string, extra: Record<string, string | number> = {}, options: ReadOptions = {}): HookState {
  const table = readTable(path, [event], options);
  if ('problem' in table) return table.problem;
  const state = placeHook(table.settings, event, matcher, command, extra);
  return table.commented && state !== 'same' ? { kind: 'comments', add: { [event]: [newGroup(matcher, command, extra)] } } : state;
}

/** Whether the file has a hook for `event` that runs yokoten's `<sub>`; no for a file `addHook` can't edit. */
export function hasHook(path: string, event: string, sub: string, options: ReadOptions = {}): boolean {
  const table = readTable(path, [event], options);
  if ('problem' in table) return false;
  return (table.settings.hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => runs(sub).test(h.command ?? '')));
}

/**
 * Take out every hook for `event` that runs yokoten's `<sub>`, and the groups and events
 * left empty. Everything else in the file stays. A file that is not JSON throws, so the
 * caller can leave it alone and say so.
 */
export function removeHook(path: string, event: string, sub: string): 'removed' | 'not there' {
  if (!existsSync(path)) return 'not there';
  const settings = readSettings(path);
  const groups = settings.hooks?.[event];
  if (!settings.hooks || !Array.isArray(groups)) return 'not there';
  let removed = false;
  const kept: HookGroup[] = [];
  for (const group of groups) {
    const handlers = (group.hooks ?? []).filter((hook) => !runs(sub).test(hook.command ?? ''));
    if (handlers.length === (group.hooks ?? []).length) {
      kept.push(group);
      continue;
    }
    removed = true;
    if (handlers.length) kept.push({ ...group, hooks: handlers });
  }
  if (!removed) return 'not there';
  if (kept.length) settings.hooks[event] = kept;
  else delete settings.hooks[event];
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  // A file whose only content was the hooks goes too: install made it, so uninstall leaves
  // the home folder as it was (#904).
  if (!Object.keys(settings).length) {
    rmSync(path, { force: true });
    return 'removed';
  }
  writeSettings(path, settings);
  return 'removed';
}
