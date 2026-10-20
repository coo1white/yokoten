// What init and install share: where yokoten itself lives, copying its runtime, and
// writing files without stepping on what is already there.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** How a copy of the runtime went: written, or kept because `dest` is or holds the copy running now (#204). */
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

/** Whether `inner` is `outer` or inside it, after symlinks. */
export function isSameOrInside(inner: string, outer: string): boolean {
  const path = relative(resolveReal(outer), resolveReal(inner));
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Remove the temp folders that a copy to `dest` stopped by a crash or Ctrl-C left next to it. */
function removeLeftovers(dest: string): void {
  const parent = dirname(resolve(dest));
  if (!existsSync(parent)) return;
  const prefixes = ['new', 'old'].map((kind) => `.${basename(dest)}-${kind}-`);
  for (const name of readdirSync(parent)) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) rmSync(join(parent, name), { recursive: true, force: true });
  }
}

/**
 * Copy the runtime (bin, src, package.json) to `dest`, so hooks run with no network and
 * no global install. The machine copy also takes the kit, which install and the machine
 * checks read. A project's copy takes the kit's AGENTS.md, so `doctor` and `update` in
 * CI and the hooks compare against the kit the project vendored (#145), and the kit's
 * lessons, so `doctor` from the copy runs the lessons the project vendored too (#77), and the
 * kit's workflows with their list of hashes, so `doctor` can tell an old copy from an edited one (#456).
 * The copy is replaced whole; `VERSION` says which release it is.
 * It copies the .ts files, also from the npm package: `dest` is not under node_modules,
 * so Node runs them there as they are.
 *
 * When `dest` is the running copy, or holds it, nothing is copied: replacing it would
 * delete the files being run (#204). A `dest` inside the running copy gets its own copy,
 * unless it is inside a part that is copied: that copy would hold itself, so it is refused.
 * The new copy goes into a folder next to `dest` first, then takes its place, so a failed
 * copy leaves the old one working. Temp folders that a crash left there are removed first.
 * `copy` and `rename` are there for a test to make a step fail.
 */
export function copyRuntime(dest: string, { withKit = false, copy = cpSync, rename = renameSync }: { withKit?: boolean; copy?: typeof cpSync; rename?: typeof renameSync } = {}): CopyResult {
  if (isSameOrInside(HOME_DIR, dest)) return 'kept';
  // A yokoten with no lessons yet has no kit/lessons: the project copy then has none either.
  const lessons = join('kit', 'lessons');
  const parts = ['bin', 'src', 'package.json', ...(withKit ? ['kit'] : [join('kit', 'project', 'AGENTS.md'), join('kit', 'project', '.github', 'workflows'), join('kit', 'workflow-hashes.json'), lessons])].filter((part) => part !== lessons || existsSync(join(HOME_DIR, part)));
  const holder = parts.find((part) => isSameOrInside(dest, join(HOME_DIR, part)));
  if (holder) {
    const where = relative(resolveReal(HOME_DIR), resolveReal(dest)).split(sep).join('/');
    throw new Error(`cannot copy the runtime to ${where}, because it is inside ${holder}/ of the copy running now. Run yokoten from a copy outside that folder`);
  }
  removeLeftovers(dest);
  const parent = dirname(resolve(dest));
  mkdirSync(parent, { recursive: true });
  const fresh = mkdtempSync(join(parent, `.${basename(dest)}-new-`));
  let old: string | null = null;
  try {
    for (const part of parts) copy(join(HOME_DIR, part), join(fresh, part), { recursive: true });
    writeFileSync(join(fresh, 'VERSION'), `${VERSION}\n`);
    if (existsSync(dest)) {
      const aside = fresh.replace(/-new-(\w+)$/, '-old-$1');
      rename(dest, aside);
      old = aside;
    }
    rename(fresh, dest);
  } catch (error) {
    try {
      if (old) rename(old, dest);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
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

/** Text as init compares a project's file with the kit's: Unix line ends, one newline at the end (#456). */
export const normalizeText = (text: string): string => `${text.replace(/\r\n/g, '\n').replace(/\n*$/, '')}\n`;

/**
 * A file's text as init compares it with a kit copy: a file whose every line ends in CRLF (a
 * Windows checkout) in Unix line ends; any other text as it is. A file with one CRLF among LF
 * lines, or an added blank line at the end, is not the kit's copy (#456).
 */
export const lfText = (text: string): string => (text.includes('\r\n') && !/(?:^|[^\r])\n/.test(text) ? text.replace(/\r\n/g, '\n') : text);

/** The SHA-256 of `lfText(text)`: the bytes of a file, except that an all-CRLF file counts as an LF one. */
export const fileHash = (text: string): string => createHash('sha256').update(lfText(text)).digest('hex');

/**
 * The SHA-256 of `text` after `normalizeText`, as kit/workflow-hashes.json lists it. A kit
 * workflow must end in one newline and must not use `{{version}}`: a version in the text
 * would change its hash with every release and break the old hashes.
 */
export const textHash = (text: string): string => createHash('sha256').update(normalizeText(text)).digest('hex');

/** The list of every version of each kit workflow init has written, the newest last (#456). */
export const WORKFLOW_HASHES = join(KIT, 'workflow-hashes.json');

/** The hashes in kit/workflow-hashes.json by the file's path in a project; empty when this copy has no list. */
export function readWorkflowHashes(file: string = WORKFLOW_HASHES): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).files ?? {};
  } catch {
    return {};
  }
}
