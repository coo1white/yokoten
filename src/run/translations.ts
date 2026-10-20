// Translations that fell behind their English source (#87). English is the source
// (record 0007); a translation names, on its first line, the English file it follows:
//
//   <!-- source: docs/guide.md -->
//
// An HTML comment, so GitHub shows nothing (front matter would show as a table).
//
// The line never changes, so branches that each update a translation never edit the
// same line (#166). An older form also names the English blob it was made from
// (`<!-- source: docs/guide.md blob 3b18e512… -->`); it is still read, and a blob equal
// to today's English is current at once. Only a relative path is a marker: a URL or an
// absolute path on line 1, as in an attribution comment, is not (#181).
//
// Otherwise the history decides, by what HEAD holds (#155, #181). Walking first-parent
// history back from HEAD, no further than where the translation was added, each commit
// that changed the English but not the translation puts the translation one commit
// behind, until a commit that changed only the translation. A commit that changes both is followed, but does not cover an
// English-only commit before it: pull request B changes only the English, A changes
// both, and whichever merges first, B's change is still noted. The costs: a commit that
// changes only the translation, such as a typo fix, counts as following every English
// change before it; and with squash merges, an English-only change stays noted until a
// commit changes only the translation, even if a later pull request translated it.
//
// In the work tree, an edit to the translation alone counts as following; an edit to
// the English alone makes it behind; an edit to both is like a commit that changes both.
//
// A shallow clone holds only part of the history. When the walk reaches the cut before
// it can tell, the translation is not checked, and one note for the run says so, never a
// note per file and never a problem (#181). An English-only commit seen before the cut
// is still behind.
//
// Git runs a fixed number of times per run, whatever the number of translations: one
// hash-object, one ls-tree, one rev-parse and one log, all batched. Never a fetch.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { type Finding, finding } from '../rules/message.ts';

const MARKER = /^<!--\s*source:\s*(\S+?)(?:\s+blob\s+([0-9a-f]{7,64}))?\s*-->\s*$/;
const TRANSLATION_FILE = /\.(md|markdown|html?)$/i;
// A URL (`https:`, `mailto:`), an absolute path, or a drive letter: not a path in the repo.
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|[/\\])/i;

/** The marker line for a source, as a translation's first line holds it. */
export const sourceMarker = (source: string): string => `<!-- source: ${source} -->`;

/** The source a translation names on its first line (and the blob, in the older form), or null. */
export function parseSourceMarker(text: string): { source: string; blob: string | null } | null {
  const match = text.split('\n', 1)[0].match(MARKER);
  if (!match || NOT_RELATIVE.test(match[1])) return null;
  return { source: match[1], blob: match[2] ?? null };
}

// Git with no shell; paths are literal, never patterns. Its own error text is hidden:
// the note says what went wrong.
const git = (root: string, args: string[]) =>
  execFileSync('git', ['--literal-pathspecs', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });

/** Git's output, or null when git fails (no such path, no commits yet). */
function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The blob of each path in the work tree, as git would store it: one call, or one per path when a path can't be read. */
function workTreeBlobs(root: string, paths: string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  const all = tryGit(root, ['hash-object', '--', ...paths]);
  if (all !== null) {
    all.trim().split('\n').forEach((blob, i) => blobs.set(paths[i], blob));
    return blobs;
  }
  for (const path of paths) {
    const blob = tryGit(root, ['hash-object', '--', path]);
    if (blob !== null) blobs.set(path, blob.trim());
  }
  return blobs;
}

/** The blob of each path HEAD holds, or null when there is no HEAD. */
function headBlobs(root: string, paths: string[]): Map<string, string> | null {
  const out = tryGit(root, ['ls-tree', '-r', '-z', 'HEAD', '--', ...paths]);
  if (out === null) return null;
  const blobs = new Map<string, string>();
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab !== -1) blobs.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]);
  }
  return blobs;
}

// Each path a commit changed, with how: A added, M modified, D deleted, T type changed.
type Commit = { hash: string; parent: string | undefined; paths: Map<string, string> };

/** First-parent history from HEAD, newest first, with how each commit changed the given paths. Null when git fails. */
function history(root: string, paths: string[]): Commit[] | null {
  // Each commit: \x01<hash> <parents>\0, then for each path it changed, <status>\0<path>\0.
  const out = tryGit(root, ['log', '--first-parent', '-m', '--no-renames', '--name-status', '-z', '--format=%x01%H %P', 'HEAD', '--', ...paths]);
  if (out === null) return null;
  return out.split('\x01').filter(Boolean).map((chunk) => {
    const [header, ...fields] = chunk.split('\0');
    const [hash, parent] = header.split(' ');
    const changed = new Map<string, string>();
    for (let i = 0; i + 1 < fields.length; i += 2) changed.set(fields[i + 1], fields[i].trim());
    return { hash, parent: parent || undefined, paths: changed };
  });
}

/** The commits where a shallow clone's history stops, or null when the clone is whole. */
function shallowCuts(root: string): Set<string> | null {
  const [isShallow, file] = (tryGit(root, ['rev-parse', '--is-shallow-repository', '--git-path', 'shallow']) ?? '').split('\n');
  if (isShallow !== 'true') return null;
  try {
    return new Set(readFileSync(resolve(root, file), 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

type Behind = { commits: number; oldest: Commit | undefined; cut: boolean };

/**
 * How far behind the history puts a translation: the English-only commits after the
 * last translation-only commit.
 * `cut` when a shallow clone's history ended before the answer was known.
 */
function walk(commits: Commit[], cuts: Set<string> | null, english: string, translation: string): Behind {
  let behind = 0;
  let oldest: Commit | undefined;
  for (const commit of commits) {
    if (cuts?.has(commit.hash)) return { commits: behind, oldest, cut: true };
    const changedEnglish = commit.paths.has(english);
    const changedTranslation = commit.paths.has(translation);
    if (changedTranslation && !changedEnglish) break;
    if (changedEnglish && !changedTranslation) {
      behind += 1;
      oldest = commit;
    }
    // Where the translation was added: the English before it is not its business.
    if (commit.paths.get(translation) === 'A') break;
  }
  return { commits: behind, oldest, cut: false };
}

type Entry = { file: string; source: string; path: string; blob: string | null };

/** Whether a note is the one for the whole run that says the clone is shallow: never a problem. */
export const isShallowNote = (note: Finding): boolean => note.id === 'translation-behind' && note.file === undefined;

/**
 * A note for each translation whose English source changed since it was translated.
 * `files` are the repo's files; only the ones whose first line names a source are read.
 * In a shallow clone, one note without a file says which translations weren't checked.
 */
export function translationNotes(root: string, files: string[]): Finding[] {
  const notes: Finding[] = [];
  const entries: Entry[] = [];
  for (const file of files.filter((f) => TRANSLATION_FILE.test(f))) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted in the work tree but not yet staged
    }
    const marker = parseSourceMarker(text);
    if (!marker) continue;
    const path = posix.normalize(marker.source);
    if (path.startsWith('../') || !existsSync(join(root, path))) {
      notes.push(finding('translation-behind', `names ${marker.source} as its English source, which is not in the repo`, `put the English file's path from the repo root on line 1, as \`${sourceMarker('<path>')}\``, { file, line: 1 }));
      continue;
    }
    entries.push({ file, source: marker.source, path, blob: marker.blob });
  }
  if (entries.length === 0) return notes;

  const paths = [...new Set(entries.flatMap((e) => [e.path, e.file]))];
  const now = workTreeBlobs(root, paths);
  const head = headBlobs(root, paths);
  let commits: Commit[] | null | undefined;
  let cuts: Set<string> | null = null;
  let unchecked = 0;

  for (const { file, path, blob } of entries) {
    const note = (what: string, fix: string) => notes.push(finding('translation-behind', what, fix, { file, line: 1 }));
    const english = now.get(path);
    const translation = now.get(file);
    if (english === undefined || translation === undefined) {
      note(`can't read ${english === undefined ? path : file}`, 'check that git can read the file');
      continue;
    }
    if (blob !== null && english.startsWith(blob)) continue;
    // The older form still works; the fix offers the line that never needs a refresh.
    const update = blob === null ? 'and commit it' : `and set line 1 to \`${sourceMarker(path)}\``;
    const translationEdited = head?.get(file) !== translation;
    const englishEdited = head?.get(path) !== english;
    if (translationEdited && !englishEdited) continue;
    if (englishEdited && !translationEdited) {
      note(`is behind ${path} by edits not yet committed`, `bring the translation up to date in the same commit as the English, ${update}`);
      continue;
    }
    if (head === null) continue; // no commits yet: nothing to fall behind
    if (commits === undefined) {
      cuts = shallowCuts(root);
      commits = history(root, paths);
    }
    if (commits === null) {
      note(`may be behind ${path}: git history can't tell`, `compare it with ${path}, bring the translation up to date, ${update}`);
      continue;
    }
    const behind = walk(commits, cuts, path, file);
    if (behind.commits === 0) {
      if (behind.cut) unchecked += 1;
      continue;
    }
    const count = `${behind.cut ? 'at least ' : ''}${plural(behind.commits, 'commit')}`;
    const parent = behind.oldest?.parent;
    const see = parent ? `\`git diff ${parent.slice(0, 12)} HEAD -- ${path}\`` : `\`git log --first-parent -p HEAD -- ${path}\``;
    note(`is behind ${path} by ${count}`, `see what changed with ${see}, bring the translation up to date in a commit that changes only the translation, ${update}`);
  }
  if (unchecked > 0) {
    const what = unchecked === 1 ? "1 translation wasn't checked" : `${unchecked} translations weren't checked`;
    notes.push(finding('translation-behind', `${what}: this clone is shallow`, 'fetch the whole history, e.g. `fetch-depth: 0` on the checkout in CI', {
      why: 'without the history, a translation that fell behind goes unseen',
    }));
  }
  return notes;
}
