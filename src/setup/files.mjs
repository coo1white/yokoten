// What init and install share: where yokoten itself lives, copying its runtime, and
// writing files without stepping on what is already there.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VERSION = JSON.parse(readFileSync(join(HOME_DIR, 'package.json'), 'utf8')).version;
export const KIT = join(HOME_DIR, 'kit');

/** A line that marks a file yokoten owns. Install replaces such a file; it never touches others. */
export const MANAGED = 'managed by yokoten';

/**
 * Copy the runtime (bin, src, package.json) to `dest`, so hooks run with no network and
 * no global install. The machine copy also takes the kit, which install and the machine
 * checks read. The copy is replaced whole; `VERSION` says which release it is.
 */
export function copyRuntime(dest, { withKit = false } = {}) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const part of ['bin', 'src', 'package.json', ...(withKit ? ['kit'] : [])]) cpSync(join(HOME_DIR, part), join(dest, part), { recursive: true });
  writeFileSync(join(dest, 'VERSION'), `${VERSION}\n`);
}

export const runtimeVersion = (dir) => {
  try {
    return readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
};

/** Write `content` to `path` unless a file is there. Returns what happened. */
export function writeNew(path, content, { mode } = {}) {
  if (existsSync(path)) return 'kept';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  return 'wrote';
}

/** Write a file yokoten owns: new, or replacing an older yokoten copy. A file without the mark is the user's. */
export function writeManaged(path, content) {
  const existed = existsSync(path);
  if (existed) {
    const old = readFileSync(path, 'utf8');
    if (!old.includes(MANAGED)) return 'kept (yours)';
    if (old === content) return 'same';
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return existed ? 'updated' : 'wrote';
}

/** Fill `{{name}}` in a template. */
export const render = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

/**
 * Add a command hook to a Claude Code settings file, once. A hook whose command mentions
 * `yokoten.mjs <sub>` counts as already there (an older path is updated in place).
 */
export function addHook(settingsPath, event, matcher, command) {
  let settings = {};
  if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const sub = command.match(/yokoten\.mjs"?\s+(\S+)/)?.[1];
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  for (const group of settings.hooks[event]) {
    for (const hook of group.hooks ?? []) {
      if (sub && new RegExp(`yokoten\\.mjs"?\\s+${sub}\\b`).test(hook.command ?? '')) {
        if (hook.command === command && (group.matcher ?? '') === (matcher ?? '')) return 'same';
        hook.command = command;
        if (matcher !== undefined) group.matcher = matcher;
        writeSettings(settingsPath, settings);
        return 'updated';
      }
    }
  }
  const group = { hooks: [{ type: 'command', command }] };
  if (matcher !== undefined) group.matcher = matcher;
  settings.hooks[event].push(group);
  writeSettings(settingsPath, settings);
  return 'added';
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Does a settings file run yokoten's `<sub>` on `event`? */
export function hasHook(settingsPath, event, sub) {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return (settings.hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => new RegExp(`yokoten\\.mjs"?\\s+${sub}\\b`).test(h.command ?? '')));
  } catch {
    return false;
  }
}
