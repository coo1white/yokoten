// What init and install share: where yokoten itself lives, copying its runtime, and
// writing files without stepping on what is already there.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The folder with package.json, kit/, bin/ and src/. This file is src/setup/files.ts in
 * the repo and in a vendored copy. In the npm package it also runs as
 * dist/src/setup/files.js (#31), one level deeper.
 */
export const homeDirOf = (moduleFile: string): string => join(dirname(moduleFile), '..', '..', ...(moduleFile.endsWith('.js') ? ['..'] : []));
export const HOME_DIR = homeDirOf(fileURLToPath(import.meta.url));
export const VERSION: string = JSON.parse(readFileSync(join(HOME_DIR, 'package.json'), 'utf8')).version;
export const KIT = join(HOME_DIR, 'kit');

/** A line that marks a file yokoten owns. Install replaces such a file; it never touches others. */
export const MANAGED = 'managed by yokoten';

/**
 * Copy the runtime (bin, src, package.json) to `dest`, so hooks run with no network and
 * no global install. The machine copy also takes the kit, which install and the machine
 * checks read. A project's copy takes only the kit's AGENTS.md, so `doctor` and
 * `update` in CI and the hooks compare against the kit the project vendored (#145).
 * The copy is replaced whole; `VERSION` says which release it is.
 * It copies the .ts files, also from the npm package: `dest` is not under node_modules,
 * so Node runs them there as they are.
 */
export function copyRuntime(dest: string, { withKit = false }: { withKit?: boolean } = {}): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const kitParts = withKit ? ['kit'] : [join('kit', 'project', 'AGENTS.md')];
  for (const part of ['bin', 'src', 'package.json', ...kitParts]) cpSync(join(HOME_DIR, part), join(dest, part), { recursive: true });
  writeFileSync(join(dest, 'VERSION'), `${VERSION}\n`);
}

export const runtimeVersion = (dir: string): string | null => {
  try {
    return readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
};

/** Write `content` to `path` unless a file is there. Returns what happened. */
export function writeNew(path: string, content: string, { mode }: { mode?: number } = {}): 'wrote' | 'kept' {
  if (existsSync(path)) return 'kept';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  return 'wrote';
}

/** Write a file yokoten owns: new, or replacing an older yokoten copy. A file without the mark is the user's. */
export function writeManaged(path: string, content: string): 'wrote' | 'updated' | 'same' | 'kept (yours)' {
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
export const render = (text: string, vars: Record<string, string>): string => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
