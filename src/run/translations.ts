// Translations that fell behind their English source (#87). English is the source
// (record 0007); a translation names, on its first line, the English file and the git
// blob of the English text it was made from:
//
//   <!-- source: docs/guide.md blob 3b18e512dba79e4c8300dd08aeb37f8e728b8dad -->
//
// An HTML comment, so GitHub shows nothing (front matter would show as a table). A blob,
// not a commit: a squash merge keeps the blob but drops the branch's commits, so a
// translation updated in the same pull request as its source stays right. And a shallow
// clone can still tell "behind" from "current"; it only can't count how far.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { type Finding, finding } from '../rules/message.ts';

const MARKER = /^<!--\s*source:\s*(\S+)\s+blob\s+([0-9a-f]{7,64})\s*-->\s*$/;
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

/** One note for one translation, or null when it is current. */
function checkTranslation(root: string, file: string, source: string, blob: string): Finding | null {
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
  let isShallow = false;
  let commits: number | null = null;
  try {
    isShallow = git(root, ['rev-parse', '--is-shallow-repository']) === 'true';
    commits = countCommitsSince(root, path, blob);
  } catch {
    // No commits yet, or git failed: how far is not known, and the note still stands.
  }
  if (commits === null) {
    const reason = isShallow ? 'this clone is shallow, so how far is not known' : `blob ${blob.slice(0, 12)} is not in its history, so how far is not known`;
    const fix = isShallow ? `compare it with ${path}, ${update}; in CI, check out the whole history (\`fetch-depth: 0\`) to see how far` : `compare it with ${path}, ${update}`;
    return note(`is behind ${path}: ${reason}`, fix);
  }
  const how = commits === 0 ? 'edits not yet committed' : plural(commits, 'commit');
  return note(`is behind ${path} by ${how}`, `see what changed with \`git diff ${blob.slice(0, 12)} HEAD:${path}\`, bring the translation up to date, ${update}`);
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
    const found = checkTranslation(root, file, marker.source, marker.blob);
    if (found) notes.push(found);
  }
  return notes;
}
