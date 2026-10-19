// What init and install share: where yokoten itself lives, copying its runtime, and
// writing files without stepping on what is already there.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/** How a copy of the runtime went: written, or kept because it is the copy running now (#204). */
export type CopyResult = 'wrote' | 'kept';

/** `path` with symlinks resolved. A part that does not exist yet is kept as it is. */
function resolveReal(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(resolveReal(parent), basename(full));
  }
}

/** Whether two folders are the same, or one is inside the other, after symlinks. */
export function isSameOrNested(left: string, right: string): boolean {
  const [a, b] = [resolveReal(left), resolveReal(right)];
  const isInside = (inner: string, outer: string) => {
    const path = relative(outer, inner);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  return isInside(a, b) || isInside(b, a);
}

/**
 * Copy the runtime (bin, src, package.json) to `dest`, so hooks run with no network and
 * no global install. The machine copy also takes the kit, which install and the machine
 * checks read. A project's copy takes only the kit's AGENTS.md, so `doctor` and
 * `update` in CI and the hooks compare against the kit the project vendored (#145).
 * The copy is replaced whole; `VERSION` says which release it is.
 * It copies the .ts files, also from the npm package: `dest` is not under node_modules,
 * so Node runs them there as they are.
 *
 * When `dest` is the running copy (or one holds the other), nothing is copied: replacing
 * it would delete the files being run (#204). Otherwise the new copy goes into a folder
 * next to `dest` first, then takes its place, so a failed copy leaves the old one working.
 * `copy` is there for a test to make a copy fail.
 */
export function copyRuntime(dest: string, { withKit = false, copy = cpSync }: { withKit?: boolean; copy?: typeof cpSync } = {}): CopyResult {
  if (isSameOrNested(HOME_DIR, dest)) return 'kept';
  const parent = dirname(resolve(dest));
  mkdirSync(parent, { recursive: true });
  const fresh = mkdtempSync(join(parent, `.${basename(dest)}-new-`));
  try {
    const kitParts = withKit ? ['kit'] : [join('kit', 'project', 'AGENTS.md')];
    for (const part of ['bin', 'src', 'package.json', ...kitParts]) copy(join(HOME_DIR, part), join(fresh, part), { recursive: true });
    writeFileSync(join(fresh, 'VERSION'), `${VERSION}\n`);
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
  const old = existsSync(dest) ? fresh.replace(/-new-(\w+)$/, '-old-$1') : null;
  if (old) renameSync(dest, old);
  try {
    renameSync(fresh, dest);
  } catch (error) {
    if (old) renameSync(old, dest);
    rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
  if (old) rmSync(old, { recursive: true, force: true });
  return 'wrote';
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
