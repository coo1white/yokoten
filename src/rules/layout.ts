// The layout rules. First: no folder below the root holds more than `maxEntries` entries, so the
// tree stays something a person (or an agent) can read at a glance. When a folder is
// full, the fix is a new level that names a group, not one more file. Second: no build output or binaries in a commit.

import { posix } from 'node:path';
import type { Config } from './config.ts';
import { matcher } from './config.ts';
import { type Finding, finding } from './message.ts';
import { CHANGES_DIR } from './pr.ts';

// A folder in layout.exempt may grow: a log (records, root-cause reports), or a third-party
// fixture set kept under its upstream names, with its NOTICE beside it (#381). Each entry is
// a folder from the root, or a glob of whole segments: `*` is one folder, `**` any number
// of folders (none too). Nothing else is special, so `crates/*/tests/data` is one entry for
// every crate of a Rust workspace. Each entry is still written by hand.

const trimFolder = (entry: string): string => posix.normalize(entry).replace(/\/$/, '');

/** A test for an exempt glob, or none when the entry is an exact folder. */
function compileExemptGlob(folder: string): RegExp | undefined {
  const parts = folder.split('/');
  if (!parts.some((part) => part === '*' || part === '**')) return undefined;
  // Matched against "/" + the folder path, so each segment carries its own slash.
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = parts.map((part) => (part === '**' ? '(?:/[^/]+)*' : part === '*' ? '/[^/]+' : `/${escape(part)}`)).join('');
  return new RegExp(`^${body}$`);
}

const EXEMPT_FIX = 'or add it to layout.exempt in yokoten.json if it may grow: a log, or a third-party fixture set kept under its upstream names with its NOTICE beside it';

/**
 * Problems for a list of file paths (relative, forward slashes), one per folder over the cap.
 * With `notes`, each exempt glob that matches no folder adds a note, so a stale entry shows.
 */
export function checkLayout(files: string[], { layout }: Pick<Config, 'layout'>, notes?: Finding[]): Finding[] {
  const children = new Map<string, Set<string>>();
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      let names = children.get(dir);
      if (!names) children.set(dir, (names = new Set()));
      names.add(parts[depth]);
    }
  }
  // The change files wait in one folder until a release empties it (#132), so it may grow.
  // Exact folders are one set lookup; each glob is compiled once per run.
  const exact = new Set([CHANGES_DIR]);
  const globs: { entry: string; pattern: RegExp; isUsed: boolean }[] = [];
  for (const entry of layout.exempt) {
    const folder = trimFolder(entry);
    const pattern = compileExemptGlob(folder);
    if (pattern) globs.push({ entry, pattern, isUsed: false });
    else exact.add(folder);
  }
  // Every glob is tried on every folder, so a glob that matches nothing is known at the end.
  const isExempt = (dir: string): boolean => {
    let isMatched = exact.has(dir);
    for (const glob of globs) {
      if (glob.pattern.test(`/${dir}`)) isMatched = glob.isUsed = true;
    }
    return isMatched;
  };
  const problems: Finding[] = [];
  for (const [dir, names] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
    if (isExempt(dir) || names.size <= layout.maxEntries) continue;
    problems.push(
      finding('layout', `${names.size} entries, over the cap of ${layout.maxEntries}: ${[...names].sort().join(', ')}`, `group them into a new folder, ${EXEMPT_FIX}`, { file: `${dir}/` }),
    );
  }
  for (const glob of globs.filter((glob) => !glob.isUsed)) {
    notes?.push(
      finding('layout', `layout.exempt "${glob.entry}" matches no folder`, 'fix the glob, or remove it if those folders are gone', {
        file: 'yokoten.json',
        why: 'a stale entry lets a folder made later with that path grow unseen',
      }),
    );
  }
  return problems;
}

// Build output and binaries (#56). Build output is made from the source, so a copy in the
// repo only goes stale. A reviewer can't read a binary. Images and fonts are binary too,
// but docs and sites need them, so they pass.
/** The folders a build writes to, at any depth. */
export const BUILD_DIRS = ['dist', 'build', 'out'];
const MEDIA = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?)$/i;
/** Files that are built, whatever git thinks of their bytes. */
export const BUILT = /\.(?:exe|dll|so|dylib|zip|tar|gz|tgz|jar|class|o|a|wasm|pyc|node)$/i;

/** Whether a path is build output: under a build folder, or a built file by its name. */
export function isBuildOutput(path: string, allow: (path: string) => boolean = () => false): boolean {
  if (allow(path)) return false;
  return path.split('/').slice(0, -1).some((dir) => BUILD_DIRS.includes(dir)) || BUILT.test(path);
}

const fix = (path: string) => `remove it with \`git rm --cached ${path}\` and add it to .gitignore, or list the path in allowBuild in yokoten.json`;

/** Problems for the files a commit adds or changes, each with whether git sees it as binary. */
export function checkBuildOutput(files: { path: string; binary: boolean }[], { allowBuild }: Pick<Config, 'allowBuild'>): Finding[] {
  const allow = matcher(allowBuild);
  const problems: Finding[] = [];
  for (const { path, binary } of files) {
    if (allow(path)) continue;
    const dir = path.split('/').slice(0, -1).find((d) => BUILD_DIRS.includes(d));
    if (dir) problems.push(finding('build-output', `build output, in a ${dir}/ folder`, fix(path), { file: path }));
    else if (BUILT.test(path) || (binary && !MEDIA.test(path))) problems.push(finding('binary', 'a binary file', fix(path), { file: path }));
  }
  return problems;
}
