// The hooks table that Claude Code, Codex and Gemini CLI all keep in a JSON file:
// { "hooks": { "<event>": [{ "matcher": "...", "hooks": [{ "type": "command", "command": "..." }] }] } }.
// Each adapter names its own file, event, matcher and command; this file only edits the
// table, and keeps everything else in the file as it was.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runs, subcommand } from '../run/cli.ts';

export type Added = 'same' | 'updated' | 'added';

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
 * Add a command hook to a settings file, once. A hook that runs the same yokoten `<sub>`
 * counts as already there (an older path is updated in place). `extra` holds more handler
 * fields, such as Gemini CLI's `name`.
 */
export function addHook(path: string, event: string, matcher: string | undefined, command: string, extra: Record<string, string> = {}): Added {
  const settings = readSettings(path);
  const sub = subcommand(command);
  const groups = ((settings.hooks ??= {})[event] ??= []);
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (sub && runs(sub).test(hook.command ?? '')) {
        if (hook.command === command && (group.matcher ?? '') === (matcher ?? '') && Object.entries(extra).every(([k, v]) => hook[k] === v)) return 'same';
        Object.assign(hook, extra, { command });
        if (matcher !== undefined) group.matcher = matcher;
        writeSettings(path, settings);
        return 'updated';
      }
    }
  }
  const group: HookGroup = { hooks: [{ type: 'command', command, ...extra }] };
  if (matcher !== undefined) group.matcher = matcher;
  groups.push(group);
  writeSettings(path, settings);
  return 'added';
}

/** Whether the file has a hook for `event` that runs yokoten's `<sub>`. */
export function hasHook(path: string, event: string, sub: string): boolean {
  try {
    const settings: Settings = JSON.parse(readFileSync(path, 'utf8'));
    return (settings.hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => runs(sub).test(h.command ?? '')));
  } catch {
    return false;
  }
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
  writeSettings(path, settings);
  return 'removed';
}
