// The changelog, one file per change (#132). Two pull requests that each add a line at
// the top of CHANGELOG.md conflict; two that each add their own file never do. So a pull
// request adds `changes/<issue>-<slug>.md`, and at a release `yokoten changelog --write`
// moves the entries into CHANGELOG.md and deletes the files.
//
// A change file is plain Markdown: the section on line 1, a blank line 2, then the entry
// as it should read in the changelog. The text comes from a pull request, so a problem
// names the file and the line, and never prints the text back.

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, finding } from '../../rules/message.ts';
import { CHANGES_DIR, isChangeFile } from '../../rules/pr.ts';

/** The sections, in Keep a Changelog's order, and Internal for work users do not see. */
export const CHANGE_SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Internal'];

/** One change file, read: its section, and its entry as changelog lines. */
export interface Change {
  file: string;
  section: string;
  lines: string[];
}

const UNRELEASED = /^##\s+\[?Unreleased\]?\s*$/i;
const VERSION_HEADING = /^##\s/;
const SECTION_HEADING = /^###\s+(\S+)\s*$/;
const isBullet = (line: string) => /^[-*+] /.test(line);
// A Markdown heading (up to three spaces, one to six #, then a space or the end). In an
// entry it would land in CHANGELOG.md as is, and could add a fake version.
const isHeading = (line: string) => /^ {0,3}#{1,6}(\s|$)/.test(line);

/**
 * The entry as changelog lines. The collector adds `- ` when the text has no bullet of
 * its own, and indents the lines that follow, so a wrapped entry stays one bullet.
 */
function toBullets(text: string[]): string[] {
  if (isBullet(text[0])) return text;
  return [`- ${text[0]}`, ...text.slice(1).map((line) => (!line || /^\s/.test(line) ? line : `  ${line}`))];
}

/** A change file read, or the problems with it. `file` is the path from the repo root. */
export function parseChange(file: string, content: string): { change: Change | null; problems: Finding[] } {
  const fail = (what: string, fix: string, line?: number) => ({ change: null, problems: [finding('change-file', what, fix, { file, line })] });
  if (!file.endsWith('.md')) return fail('a change file is not Markdown', `rename it to end in .md, or move it out of ${CHANGES_DIR}/`);
  const lines = content.split(/\r?\n/).map((line) => line.trimEnd());
  const section = CHANGE_SECTIONS.find((name) => name.toLowerCase() === lines[0].trim().toLowerCase());
  if (!section) return fail('line 1 is not a section', `make line 1 one of: ${CHANGE_SECTIONS.join(', ')}`, 1);
  if (lines.length > 1 && lines[1].trim()) return fail('line 2 is not blank', 'leave line 2 empty, and start the entry on line 3', 2);
  const heading = lines.findIndex((line, index) => index > 1 && isHeading(line));
  if (heading > 0) return fail(`line ${heading + 1} is a heading`, 'write the entry as plain text or bullets; the section on line 1 is its only heading', heading + 1);
  const text = lines.slice(2);
  while (text.length && !text[0].trim()) text.shift();
  while (text.length && !text[text.length - 1].trim()) text.pop();
  if (!text.length) return fail('no entry after the section', 'write the entry from line 3, as it should read in CHANGELOG.md', 1);
  return { change: { file, section, lines: toBullets(text) }, problems: [] };
}

/**
 * Every change file in the repo, by file name (an issue number sorts as a number), or
 * the problems with them. README.md and dotfiles are not change files.
 */
export function readChanges(root: string): { changes: Change[]; problems: Finding[] } {
  const dir = join(root, CHANGES_DIR);
  const changes: Change[] = [];
  const problems: Finding[] = [];
  if (!existsSync(dir)) return { changes, problems };
  const names = readdirSync(dir).sort((first, second) => first.localeCompare(second, 'en', { numeric: true }));
  for (const name of names) {
    const file = `${CHANGES_DIR}/${name}`;
    if (!isChangeFile(file)) continue;
    const stat = lstatSync(join(dir, name));
    if (stat.isDirectory()) {
      problems.push(finding('change-file', 'a folder inside the changes folder', `move its files up into ${CHANGES_DIR}/`, { file }));
      continue;
    }
    // A link may point outside the repo, or nowhere; a change file is a plain file.
    if (!stat.isFile()) {
      problems.push(finding('change-file', 'a change file is a link or another special file, not a plain file', `replace it with a plain file in ${CHANGES_DIR}/`, { file }));
      continue;
    }
    const read = parseChange(file, readFileSync(join(dir, name), 'utf8'));
    if (read.change) changes.push(read.change);
    problems.push(...read.problems);
  }
  return { changes, problems };
}

/** The changes grouped by section, in Keep a Changelog's order, as Markdown lines. */
export function formatChanges(changes: Change[]): string[] {
  const out: string[] = [];
  for (const section of CHANGE_SECTIONS) {
    const entries = changes.filter((change) => change.section === section);
    if (!entries.length) continue;
    if (out.length) out.push('');
    out.push(`### ${section}`, '', ...entries.flatMap((change) => change.lines));
  }
  return out;
}

/** The index of the last line before `end` that is not blank, or `start` when there is none. */
function lastText(lines: string[], start: number, end: number): number {
  for (let index = end - 1; index > start; index--) if (lines[index].trim()) return index;
  return start;
}

/**
 * CHANGELOG.md with the changes under `## [Unreleased]`, or a problem when it has no
 * such heading. Each entry goes after the entries already in its section; a missing
 * section heading is added in Keep a Changelog's order. Released versions are not touched.
 */
export function mergeChanges(changelog: string, changes: Change[]): string | Finding {
  // Lines already there keep their bytes. New lines take a CR when the file has CRLF, so a
  // CRLF file stays CRLF, and one stray CRLF line doesn't change how the rest is read.
  const cr = changelog.includes('\r\n') ? '\r' : '';
  const added = (...text: string[]) => text.map((line) => line + cr);
  const lines = changelog.split('\n');
  const top = lines.findIndex((line) => UNRELEASED.test(line));
  if (top < 0) return finding('change-file', 'CHANGELOG.md has no `## [Unreleased]` heading', 'add `## [Unreleased]` above the first version, then run it again', { file: 'CHANGELOG.md' });
  for (const section of CHANGE_SECTIONS) {
    const entries = changes.filter((change) => change.section === section).flatMap((change) => change.lines);
    if (!entries.length) continue;
    // Worked out again for each section: the lines added before move everything below.
    let end = lines.findIndex((line, index) => index > top && VERSION_HEADING.test(line));
    if (end < 0) end = lines.length;
    const headings: { index: number; name: string }[] = [];
    for (let index = top + 1; index < end; index++) {
      const name = SECTION_HEADING.exec(lines[index])?.[1];
      if (name) headings.push({ index, name });
    }
    const found = headings.findIndex((heading) => heading.name.toLowerCase() === section.toLowerCase());
    const order = CHANGE_SECTIONS.indexOf(section);
    const later = headings.find((heading) => CHANGE_SECTIONS.findIndex((name) => name.toLowerCase() === heading.name.toLowerCase()) > order);
    if (found < 0 && later) {
      lines.splice(later.index, 0, ...added(`### ${section}`, '', ...entries, ''));
      continue;
    }
    // After the section's last entry, or after the last text of Unreleased with a new heading.
    const start = found >= 0 ? headings[found].index : top;
    const after = lastText(lines, start, found >= 0 ? (headings[found + 1]?.index ?? end) : end);
    const block = found >= 0 ? (after === start ? ['', ...entries] : entries) : ['', `### ${section}`, '', ...entries];
    // A blank line before whatever comes next: a heading, or the next version.
    lines.splice(after + 1, 0, ...added(...block, ...(lines[after + 1]?.trim() ? [''] : [])));
  }
  return lines.join('\n');
}

/**
 * `yokoten changelog --write`: the change files merged into CHANGELOG.md, and then
 * deleted. When any file is wrong, or CHANGELOG.md has no Unreleased heading, nothing is
 * written and nothing is deleted.
 */
export function writeChanges(root: string): { changes: Change[]; problems: Finding[] } {
  const { changes, problems } = readChanges(root);
  if (problems.length || !changes.length) return { changes: problems.length ? [] : changes, problems };
  const path = join(root, 'CHANGELOG.md');
  const merged = mergeChanges(existsSync(path) ? readFileSync(path, 'utf8') : '', changes);
  if (typeof merged !== 'string') return { changes: [], problems: [merged] };
  writeFileSync(path, merged);
  for (const change of changes) rmSync(join(root, change.file));
  return { changes, problems: [] };
}
