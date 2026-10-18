// The hooks table that Claude Code, Codex and Gemini CLI all keep in a JSON file:
// { "hooks": { "<event>": [{ "matcher": "...", "hooks": [{ "type": "command", "command": "..." }] }] } }.
// Each adapter names its own file, event, matcher and command; this file only edits the
// table, and keeps everything else in the file as it was.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runs, subcommand } from '../run/cli.ts';

export type Added = 'same' | 'updated' | 'added';
/** What `hookState` finds: what `addHook` would do, or a file that won't parse. */
export type HookState = Added | 'unreadable';
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
 * A file `addHook` won't touch: it doesn't parse, or it isn't a hooks table (a `hooks`
 * key that isn't an object of event lists). `addHook` throws it before writing anything,
 * so the caller can name the file, skip it and go on (#248).
 */
export class UnreadableHooksFile extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`can't read ${path} (make it valid JSON, then run the command again)`);
    this.name = 'UnreadableHooksFile';
    this.path = path;
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The file's settings, or null when it won't parse, its top level is not an object, or its
 * `hooks` is not an object of lists of objects. A missing file is empty settings. Every
 * reader of a hooks file goes through this one check (#248, #254).
 */
export function readTable(path: string): Settings | null {
  let settings: unknown;
  try {
    settings = readSettings(path);
  } catch {
    return null;
  }
  if (!isObject(settings)) return null;
  const { hooks } = settings;
  if (hooks === undefined) return settings as Settings;
  if (!isObject(hooks)) return null;
  const tables = Object.values(hooks).every((groups) => Array.isArray(groups) && groups.every(isObject));
  return tables ? (settings as Settings) : null;
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
 * that changed it. A file that won't parse, or whose `hooks` is the wrong type, throws
 * `UnreadableHooksFile` and stays as it was.
 */
export function addHook(path: string, event: string, matcher: string | undefined, command: string, extra: Record<string, string> = {}): Added {
  const settings = readTable(path);
  if (!settings) throw new UnreadableHooksFile(path);
  const added = placeHook(settings, event, matcher, command, extra);
  if (added !== 'same') writeSettings(path, settings);
  return added;
}

/**
 * What `addHook` would do with these arguments, read-only: 'same' when the hook is there
 * as it would write it, 'updated' when it is there but out of date (command, matcher or
 * fields), 'added' when it is missing, and 'unreadable' when `addHook` would refuse the
 * file: it won't parse, or its `hooks` is the wrong type.
 */
export function hookState(path: string, event: string, matcher: string | undefined, command: string, extra: Record<string, string> = {}): HookState {
  const settings = readTable(path);
  return settings ? placeHook(settings, event, matcher, command, extra) : 'unreadable';
}

/** Whether the file has a hook for `event` that runs yokoten's `<sub>`. */
export function hasHook(path: string, event: string, sub: string): boolean {
  const settings = readTable(path);
  return (settings?.hooks?.[event] ?? []).some((g) => (Array.isArray(g.hooks) ? g.hooks : []).some((h) => typeof h?.command === 'string' && runs(sub).test(h.command)));
}
