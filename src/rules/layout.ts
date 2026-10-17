// The layout rules. First: no folder below the root holds more than `maxEntries` entries, so the
// tree stays something a person (or an agent) can read at a glance. When a folder is
// full, the fix is a new level that names a group, not one more file. Second: no build output or binaries in a commit.

import { posix } from 'node:path';
import type { Config } from './config.ts';
import { matcher } from './glob.ts';

/** Problems for a list of file paths (relative, forward slashes), one per folder over the cap. */
export function checkLayout(files: string[], { layout }: Pick<Config, 'layout'>): string[] {
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
  const exempt = new Set(layout.exempt.map((d) => posix.normalize(d).replace(/\/$/, '')));
  const problems: string[] = [];
  for (const [dir, names] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
    if (exempt.has(dir) || names.size <= layout.maxEntries) continue;
    problems.push(`${dir}/ has ${names.size} entries, over the cap of ${layout.maxEntries}: ${[...names].sort().join(', ')}. Group them into a new folder, or add ${dir} to layout.exempt in yokoten.json if it is a log.`);
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

const fix = (path: string) => `Remove it with \`git rm --cached ${path}\` and add it to .gitignore, or list the path in allowBuild in yokoten.json.`;

/** Problems for the files a commit adds or changes, each with whether git sees it as binary. */
export function checkBuildOutput(files: { path: string; binary: boolean }[], { allowBuild }: Pick<Config, 'allowBuild'>): string[] {
  const allow = matcher(allowBuild);
  const problems: string[] = [];
  for (const { path, binary } of files) {
    if (allow(path)) continue;
    const dir = path.split('/').slice(0, -1).find((d) => BUILD_DIRS.includes(d));
    if (dir) problems.push(`${path}: build output, in a ${dir}/ folder. A build makes it again from the source, so a committed copy goes stale. ${fix(path)}`);
    else if (BUILT.test(path) || (binary && !MEDIA.test(path))) problems.push(`${path}: a binary file. A reviewer can't read it, and it may not match the source. ${fix(path)}`);
  }
  return problems;
}
