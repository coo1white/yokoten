// Translations that fell behind their English source (#87). English is the source
// (record 0007); a translation names, on its first line, the English file and the git
// blob of the English text it was made from:
//
//   <!-- source: docs/guide.md blob 3b18e512dba79e4c8300dd08aeb37f8e728b8dad -->
//
// An HTML comment, so GitHub shows nothing (front matter would show as a table).
//
// Committed, a translation is judged by what HEAD holds, not by the blob (#155). It is
// current when the last commit that changed its marker line is the same as, or later
// than, the last commit that changed the English (both in first-parent history). Two
// pull requests that change the English in parallel squash-merge to a blob neither
// branch had, so the blob alone goes stale even when both translations were done. The
// marker line, not any edit: a typo fix in the translation does not hide an English
// change it never followed.
//
// Before a commit, the blob decides: the work tree holds the exact English the marker
// was written for. The blob also says how far behind, when it is in the history. A
// shallow clone that can't see the commits gives a note, never a false "current".

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { type Finding, finding } from '../rules/message.ts';

const MARKER = /^<!--\s*source:\s*(\S+)\s+blob\s+([0-9a-f]{7,64})\s*-->\s*$/;
// The same line for `git log -G`, which takes a POSIX extended regex.
const MARKER_PATTERN = '^<!--[[:space:]]*source:[[:space:]]*[^[:space:]]+[[:space:]]+blob[[:space:]]+[0-9a-f]{7,64}[[:space:]]*-->[[:space:]]*$';
const TRANSLATION_FILE = /\.(md|markdown|html?)$/i;

/** The marker line for a source and its blob, as a translation's first line holds it. */
export const sourceMarker = (source: string, blob: string): string => `<!-- source: ${source} blob ${blob} -->`;

/** The source a translation names on its first line, or null when it names none. */
export function parseSourceMarker(text: string): { source: string; blob: string } | null {
  const match = text.split('\n', 1)[0].match(MARKER);
  return match ? { source: match[1], blob: match[2] } : null;
}

// Git with no shell. Its own error text is hidden: the note says what went wrong.
const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).trim();

/**
 * How many commits changed `source` since its text was `blob`: walks the file's history,
 * newest first, to the commit that left it at that blob. Null when no commit did.
 */
function countCommitsSince(root: string, source: string, blob: string): number | null {
  // --raw gives ":100644 100644 <old blob> <new blob> M\t<path>" under each commit.
  const log = git(root, ['-c', 'core.quotePath=false', 'log', '--format=tformat:commit', '--raw', '--no-abbrev', '--no-renames', '--', source]);
  let commits = 0;
  for (const line of log.split('\n')) {
    if (line === 'commit') commits++;
    else if (line.startsWith(':') && line.split(/\s+/)[3]?.startsWith(blob)) return commits - 1;
  }
  return null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Git's output, or null when git fails (no such path at HEAD, no commits yet). */
function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** Whether line 1 of the translation in the work tree differs from line 1 at HEAD. */
function isMarkerEdited(root: string, file: string, text: string): boolean {
  const committed = tryGit(root, ['show', `HEAD:${file}`]);
  return committed === null || committed.split('\n', 1)[0] !== text.split('\n', 1)[0];
}

/**
 * The committed state, from first-parent history: 0 when the last commit that changed the
 * translation's marker is the same as, or later than, the last that changed the English;
 * else how many commits changed the English since. Null when history can't tell.
 */
function countCommitsBehind(root: string, source: string, file: string, isShallow: boolean): { commits: number; since: string } | null {
  const english = tryGit(root, ['log', '-1', '--first-parent', '--format=%H', 'HEAD', '--', source]);
  const marker = tryGit(root, ['log', '-1', '--first-parent', '-E', '-G', MARKER_PATTERN, '--format=%H %P', 'HEAD', '--', file]);
  if (english === null || !marker) return null;
  const [since, ...parents] = marker.split(' ').filter(Boolean);
  if (english === '') return { commits: 0, since }; // the English was never committed
  let isLater = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', english, since], { cwd: root, stdio: 'ignore' });
  } catch (error) {
    if ((error as { status?: number }).status !== 1) return null;
    isLater = false;
  }
  if (isLater) {
    // A shallow clone's oldest commit seems to add every file: it may not be the change.
    return isShallow && parents.length === 0 ? null : { commits: 0, since };
  }
  const commits = Number(tryGit(root, ['rev-list', '--count', '--first-parent', `${since}..HEAD`, '--', source]));
  return Number.isInteger(commits) && commits > 0 ? { commits, since } : null;
}

/** One note for one translation, or null when it is current. */
function checkTranslation(root: string, file: string, text: string, source: string, blob: string): Finding | null {
  const note = (what: string, fix: string) => finding('translation-behind', what, fix, { file, line: 1 });
  const path = posix.normalize(source);
  if (path.startsWith('../') || path.startsWith('/') || !existsSync(join(root, path))) {
    return note(`names ${source} as its English source, which is not in the repo`, `put the English file's path from the repo root on line 1, as \`${sourceMarker('<path>', '<blob>')}\``);
  }
  let current: string;
  try {
    current = git(root, ['hash-object', '--', path]);
  } catch {
    return note(`can't read ${path}, its English source`, 'check that git can read the file');
  }
  if (current.startsWith(blob)) return null;
  const update = `then set line 1 to \`${sourceMarker(path, current)}\``;
  const isShallow = tryGit(root, ['rev-parse', '--is-shallow-repository']) === 'true';
  const sinceBlob = (() => {
    try {
      return countCommitsSince(root, path, blob);
    } catch {
      return null; // no commits yet, or git failed
    }
  })();
  const diffFromBlob = `see what changed with \`git diff ${blob.slice(0, 12)} HEAD:${path}\`, bring the translation up to date, ${update}`;
  if (!isMarkerEdited(root, file, text)) {
    const behind = countCommitsBehind(root, path, file, isShallow);
    if (behind && behind.commits > 0) {
      const fix = sinceBlob === null ? `see what changed with \`git diff ${behind.since.slice(0, 12)} HEAD -- ${path}\`, bring the translation up to date, ${update}` : diffFromBlob;
      return note(`is behind ${path} by ${plural(behind.commits, 'commit')}`, fix);
    }
    if (behind) {
      const isEnglishEdited = tryGit(root, ['rev-parse', `HEAD:${path}`]) !== current;
      return isEnglishEdited ? note(`is behind ${path} by edits not yet committed`, sinceBlob === null ? `compare it with ${path}, ${update}` : diffFromBlob) : null;
    }
  }
  if (sinceBlob === null) {
    const reason = isShallow ? 'this clone is shallow, so how far is not known' : `blob ${blob.slice(0, 12)} is not in its history, so how far is not known`;
    const fix = isShallow ? `compare it with ${path}, ${update}; in CI, check out the whole history (\`fetch-depth: 0\`) to see how far` : `compare it with ${path}, ${update}`;
    return note(`is behind ${path}: ${reason}`, fix);
  }
  const how = sinceBlob === 0 ? 'edits not yet committed' : plural(sinceBlob, 'commit');
  return note(`is behind ${path} by ${how}`, diffFromBlob);
}

/**
 * A note for each translation whose English source changed since it was translated.
 * `files` are the repo's files; only the ones whose first line names a source are read.
 */
export function translationNotes(root: string, files: string[]): Finding[] {
  const notes: Finding[] = [];
  for (const file of files.filter((f) => TRANSLATION_FILE.test(f))) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted in the work tree but not yet staged
    }
    const marker = parseSourceMarker(text);
    if (!marker) continue;
    const found = checkTranslation(root, file, text, marker.source, marker.blob);
    if (found) notes.push(found);
  }
  return notes;
}
