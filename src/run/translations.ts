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
// Otherwise the history decides, by what HEAD holds (#155, #181). In first-parent history
// since the translation was added, each commit that changed the English but not the
// translation, and came after the last commit that changed only the translation, puts it
// one commit behind. A commit that changes both is followed, but does not hide an
// English-only commit before it: two pull requests merged in turn, one that changed only
// the English, are still caught. The cost: a commit that changes only the translation,
// such as a typo fix, counts as following every English change before it.
//
// In the work tree, an edit to the translation counts as following; an edit to the
// English alone makes it behind. A shallow clone can't see the commits: one note for
// the run says the translations weren't checked, never a note per file.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
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

// Git with no shell. Its own error text is hidden: the note says what went wrong.
const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).trim();

/** Git's output, or null when git fails (no such path at HEAD, no commits yet). */
function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Whether the file in the work tree differs from HEAD, or HEAD does not hold it. */
const isEdited = (root: string, file: string, blob: string): boolean => tryGit(root, ['rev-parse', `HEAD:${file}`]) !== blob;

/**
 * The committed state, from first-parent history since the translation was added: how many
 * commits changed the English but not the translation after the last commit that changed
 * only the translation, and the commit to diff from (the parent of the oldest of them).
 * Null when history can't tell.
 */
function countCommitsBehind(root: string, source: string, file: string): { commits: number; since: string } | null {
  // Newest first: a line `@<commit> <parent>`, then the paths of the two it changed.
  const log = tryGit(root, ['log', '--first-parent', '--no-renames', '--name-only', '--format=@%H %P', 'HEAD', '--', source, file]);
  if (log === null) return null;
  const commits: { parent: string | undefined; english: boolean; translation: boolean }[] = [];
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) {
      const [, parent] = line.slice(1).split(' ');
      commits.push({ parent, english: false, translation: false });
    } else if (line && commits.length) {
      const last = commits[commits.length - 1];
      if (line === source) last.english = true;
      if (line === file) last.translation = true;
    }
  }
  // Commits before the translation was added are not its business.
  const added = commits.findLastIndex((c) => c.translation);
  if (added === -1) return null;
  let count = 0;
  let since: string | undefined;
  for (const commit of commits.slice(0, added + 1)) {
    if (commit.translation && !commit.english) break;
    if (commit.english && !commit.translation) {
      count += 1;
      since = commit.parent;
    }
  }
  if (count === 0) return { commits: 0, since: '' };
  return since ? { commits: count, since } : null;
}

// Why a translation got no answer: the clone is shallow, so its history is not there.
const UNCHECKED = Symbol('unchecked');

/** One note for one translation, null when it is current, or UNCHECKED in a shallow clone. */
function checkTranslation(root: string, file: string, source: string, blob: string | null, isShallow: () => boolean): Finding | null | typeof UNCHECKED {
  const note = (what: string, fix: string) => finding('translation-behind', what, fix, { file, line: 1 });
  const path = posix.normalize(source);
  if (path.startsWith('../') || !existsSync(join(root, path))) {
    return note(`names ${source} as its English source, which is not in the repo`, `put the English file's path from the repo root on line 1, as \`${sourceMarker('<path>')}\``);
  }
  let english: string;
  let translation: string;
  try {
    english = git(root, ['hash-object', '--', path]);
    translation = git(root, ['hash-object', '--', file]);
  } catch {
    return note(`can't read ${path}, its English source`, 'check that git can read the file');
  }
  if (blob !== null && english.startsWith(blob)) return null;
  // The older form still works; the fix offers the line that never needs a refresh.
  const update = blob === null ? 'and commit it' : `and set line 1 to \`${sourceMarker(path)}\``;
  if (isEdited(root, file, translation)) return null;
  if (isEdited(root, path, english)) return note(`is behind ${path} by edits not yet committed`, `bring the translation up to date in the same commit as the English, ${update}`);
  if (isShallow()) return UNCHECKED;
  const behind = countCommitsBehind(root, path, file);
  if (behind?.commits === 0) return null;
  if (behind) return note(`is behind ${path} by ${plural(behind.commits, 'commit')}`, `see what changed with \`git diff ${behind.since.slice(0, 12)} HEAD -- ${path}\`, bring the translation up to date, ${update}`);
  return note(`may be behind ${path}: git history can't tell`, `compare it with ${path}, bring the translation up to date, ${update}`);
}

/** Whether a note is the one for the whole run that says the clone is shallow: never a problem. */
export const isShallowNote = (note: Finding): boolean => note.id === 'translation-behind' && note.file === undefined;

/**
 * A note for each translation whose English source changed since it was translated.
 * `files` are the repo's files; only the ones whose first line names a source are read.
 * In a shallow clone, one note without a file says the translations weren't checked.
 */
export function translationNotes(root: string, files: string[]): Finding[] {
  const notes: Finding[] = [];
  let shallow: boolean | undefined;
  const isShallow = () => (shallow ??= tryGit(root, ['rev-parse', '--is-shallow-repository']) === 'true');
  let unchecked = false;
  for (const file of files.filter((f) => TRANSLATION_FILE.test(f))) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted in the work tree but not yet staged
    }
    const marker = parseSourceMarker(text);
    if (!marker) continue;
    const found = checkTranslation(root, file, marker.source, marker.blob, isShallow);
    if (found === UNCHECKED) unchecked = true;
    else if (found) notes.push(found);
  }
  if (unchecked) {
    notes.push(finding('translation-behind', "translations weren't checked: this clone is shallow", 'fetch the whole history, e.g. `fetch-depth: 0` on the checkout in CI', {
      why: 'without the history, a translation that fell behind goes unseen',
    }));
  }
  return notes;
}
