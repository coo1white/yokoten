// The layout rules. First: no folder below the root holds more than `maxEntries` entries, so the
// tree stays something a person (or an agent) can read at a glance. When a folder is
// full, the fix is a new level that names a group, not one more file. Second: no build output or binaries in a commit.

import { posix } from 'node:path';
import type { Config } from './config.ts';
import { matcher } from './config.ts';
import { type Finding, finding } from './message.ts';
import { CHANGES_DIR, codeOwnersWords, compileCodeOwnersPattern, isCodeOwnersHeader } from './pr.ts';

export { codeOwnersPatternMatches } from './pr.ts';

/**
 * The folder at the root that holds worker worktrees, one per issue (#571): inside the
 * project, git-ignored, where a restart can't wipe them. The layout check skips it, and
 * the guard reads a path under it from the worktree it is in.
 */
export const WORKTREES_DIR = '.worktrees';

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

/** Whether a folder is, or is inside, a folder of fetched files. The build output check names those (#521); counting their entries only repeats it. */
const isFetched = (dir: string): boolean => dir.split('/').some((part) => FETCHED_DIRS.includes(part));

/**
 * Problems for a list of file paths (relative, forward slashes), one per folder over the cap.
 * With `notes`, each exempt glob that matches no folder adds a note, so a stale entry shows.
 */
export function checkLayout(files: string[], { layout }: Pick<Config, 'layout'>, notes?: Finding[]): Finding[] {
  // Worker worktrees are whole checkouts, not the project's folders (#571).
  files = files.filter((file) => file !== WORKTREES_DIR && !file.startsWith(`${WORKTREES_DIR}/`));
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
    if (isFetched(dir) || isExempt(dir) || names.size <= layout.maxEntries) continue;
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

/** Folders that hold fetched or generated files, not the project's own (#521). One finding covers the folder. */
export const DEPENDENCY_DIRS = ['node_modules', 'vendor', '.venv', 'venv', 'target', '__pycache__'];

/** The dependency folders no project commits, so every file in them counts. A committed vendor/ (Go) can be on purpose. */
const FETCHED_DIRS = ['node_modules', '.venv', 'venv', '__pycache__'];

const folderFix = (folder: string) =>
  `run \`git rm -r --cached ${folder}\` (it stays on disk) and add \`${folder}/\` to .gitignore, or list the path in allowBuild in yokoten.json`;

/**
 * Problems for the files a commit adds or changes, each with whether git sees it as binary.
 * Files under one dependency folder, or two or more under one build folder, make one finding
 * for the folder; its file is the folder (#521).
 */
export function checkBuildOutput(files: { path: string; binary: boolean }[], { allowBuild }: Pick<Config, 'allowBuild'>): Finding[] {
  const allow = matcher(allowBuild);
  const flagged: { path: string; id: 'build-output' | 'binary'; folder?: string; isDependency: boolean; dir?: string }[] = [];
  for (const { path, binary } of files) {
    if (allow(path)) continue;
    const parts = path.split('/').slice(0, -1);
    const at = parts.findIndex((d) => DEPENDENCY_DIRS.includes(d) || BUILD_DIRS.includes(d));
    const dir = parts.find((d) => BUILD_DIRS.includes(d));
    const isBuild = dir !== undefined;
    const isDependency = at >= 0 && DEPENDENCY_DIRS.includes(parts[at]);
    const isFetchedFile = isDependency && FETCHED_DIRS.includes(parts[at]);
    if (!isFetchedFile && !isBuild && !BUILT.test(path) && !(binary && !MEDIA.test(path))) continue;
    flagged.push({ path, id: isBuild ? 'build-output' : 'binary', folder: at >= 0 ? parts.slice(0, at + 1).join('/') : undefined, isDependency, dir });
  }
  const count = new Map<string, number>();
  for (const { folder } of flagged) if (folder) count.set(folder, (count.get(folder) ?? 0) + 1);
  const problems: Finding[] = [];
  const seen = new Set<string>();
  for (const { path, id, folder, isDependency, dir } of flagged) {
    const isGrouped = folder !== undefined && (isDependency || (count.get(folder) ?? 0) > 1);
    if (isGrouped) {
      if (seen.has(folder)) continue;
      seen.add(folder);
      const n = count.get(folder);
      const what = isDependency
        ? `a dependency folder, with ${n} of its files in the commit`
        : `build output, with ${n} files in a ${dir}/ folder`;
      problems.push(finding(isDependency ? 'build-output' : id, what, folderFix(folder), { file: `${folder}/` }));
    } else if (id === 'build-output') problems.push(finding(id, `build output, in a ${dir}/ folder`, fix(path), { file: path }));
    else problems.push(finding(id, 'a binary file', fix(path), { file: path }));
  }
  return problems;
}

// ---- CODEOWNERS (#667) ----
//
// A CODEOWNERS line whose path matches no file protects nothing: a move or a rename leaves
// the old path behind, so the new path has no owner review, and nothing else says so.

/** The places GitHub reads CODEOWNERS from, first first. */
export const CODEOWNERS_PLACES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** A lead-only glob as the CODEOWNERS path init writes: `x/**` is the folder `/x/`. */
export const codeOwnersPath = (glob: string): string => `/${glob.replace(/\/\*\*$/, '/')}`;

/**
 * Problems for the rule lines of a CODEOWNERS file whose path matches none of `files`.
 * `file` is the place the file was read from, for the message. A path in `reserved` is a
 * lead-only path init writes before it exists, a guard for the future, not a stale line.
 */
export function checkCodeOwners(files: string[], text: string, file: string = CODEOWNERS_PLACES[0] as string, reserved: ReadonlySet<string> = new Set()): Finding[] {
  const problems: Finding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    // A blank line, a comment and a section header name no path, as on GitHub.
    if (isCodeOwnersHeader(line.trim())) return;
    const pattern = codeOwnersWords(line)[0];
    if (!pattern || reserved.has(pattern)) return;
    const matcher = compileCodeOwnersPattern(pattern);
    if (files.some((path) => matcher.test(path))) return;
    problems.push(finding('stale-codeowners', `${pattern} matches no file: this rule protects nothing; point it at the new path`, `ask the lead or owner to change it in ${file}`, {
      file,
      line: index + 1,
      why: 'a moved or renamed file leaves its CODEOWNERS line behind, so the new path has no owner review',
    }));
  });
  return problems;
}
