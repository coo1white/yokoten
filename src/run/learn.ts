// `yokoten learn` (#77): an incident issue becomes a check draft for a person to review.
// It is the first half of the loop: incident, draft, review, and later `doctor` in every
// project that uses the kit.
//
// The draft comes from the issue's own sections, never from a guess: no model is called.
// Where the issue gives no answer, the draft says TODO and names the missing section. The
// draft's test is a positive control that fails until a person writes the check, so a
// draft never passes by itself.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Finding } from '../rules/message.ts';

/** An incident issue, as the code host gives it. */
export interface Incident {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

/** One file of a draft, by its path from the repo root. */
export interface DraftFile {
  path: string;
  text: string;
}

/** A check draft: the finding, what the reviewer must still fill in, and the files. */
export interface Draft {
  finding: Finding;
  /** One line per field the issue left open: the field, then the missing section. */
  todos: string[];
  files: DraftFile[];
}

/** Where drafts go: one folder per lesson, so a lesson's check and test stay together. */
export const LESSONS_DIR = 'lessons';

/** The parts of an issue the draft reads, by the headings that name them. */
const SECTIONS = {
  what: { heading: 'What happened', pattern: /^what happened/i },
  why: { heading: 'Why it got through', pattern: /^why/i },
  fix: { heading: 'Fix', pattern: /^(fix|countermeasure)/i },
  lesson: { heading: 'Lesson', pattern: /^lesson/i },
  spread: { heading: 'Other places it can happen', pattern: /^other places/i },
};
type SectionName = keyof typeof SECTIONS;

// A Markdown heading (`## Fix`), or a bold label with a colon at the start of a line
// (`**Fix:** text`).
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_LABEL = /^\*\*(.+?)(?::\*\*|\*\*:)\s*(.*)$/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s/;
// What GitHub writes for an optional issue form field left empty.
const NO_RESPONSE = /^_?no response_?$/i;

/**
 * The issue body split at its headings: each heading's text, by heading, in order. Text
 * before the first heading is left out. An empty section, or one GitHub filled with
 * "No response", is left out too, so it counts as missing.
 */
export function readSections(body: string): { heading: string; text: string }[] {
  const sections: { heading: string; lines: string[] }[] = [];
  let isInFence = false;
  for (const line of body.split(/\r?\n/)) {
    // A `#` line inside a code block is code, not a heading.
    if (/^\s*(```|~~~)/.test(line)) isInFence = !isInFence;
    const heading = isInFence ? null : (HEADING.exec(line) ?? BOLD_LABEL.exec(line));
    if (heading) sections.push({ heading: heading[1].trim(), lines: heading[2] ? [heading[2]] : [] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections.map(({ heading, lines }) => ({ heading, text: lines.join('\n').trim() })).filter(({ text }) => text && !NO_RESPONSE.test(text));
}

/** The text of the first section whose heading matches, or null when the issue has none. */
function findSection(sections: { heading: string; text: string }[], name: SectionName): string | null {
  return sections.find(({ heading }) => SECTIONS[name].pattern.test(heading))?.text ?? null;
}

/**
 * One line for a finding field: the first paragraph, or the first item when it is a list.
 * List and checkbox marks go, spaces close up, and the full stop at the end goes (the text
 * form of a finding adds it).
 */
export function summarize(text: string): string {
  const lines = text.split(/\n\s*\n/)[0].split('\n');
  // A list item ends where the next item starts, or where a line is not indented.
  let end = lines.length;
  if (LIST_ITEM.test(lines[0])) for (end = 1; end < lines.length && /^\s+\S/.test(lines[end]) && !LIST_ITEM.test(lines[end]); end++);
  const first = lines.slice(0, end);
  return first
    .join(' ')
    .replace(/^\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:]$/, '');
}

/** The symptom of an `area: symptom` title, starting lower case, as a finding's `what`. */
function readSymptom(title: string): string {
  const symptom = (/^[\w./-]+:\s+(.+)$/.exec(title.trim())?.[1] ?? title).trim().replace(/\.$/, '');
  return /^[A-Z][a-z]/.test(symptom) ? symptom.charAt(0).toLowerCase() + symptom.slice(1) : symptom;
}

// Issue text is anyone's text, and it lands in a .ts file that people run. JavaScript ends
// a line at CR LF, LF, a lone CR, U+2028 and U+2029, so each one could end a `//` comment
// and make the rest of the line code. Other control characters (C0 but tab, DEL, C1) have
// no place in a draft either.
const LINE_END = /\r\n|[\n\r\u2028\u2029]/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** A character as a `\uXXXX` escape, which TypeScript reads back and a terminal shows as text. */
const unicodeEscape = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
/** Issue text as one line that is safe in a `//` comment: each line end or control character is a space. */
const commentText = (text: string) => text.split(LINE_END).join(' ').replace(CONTROL, ' ');
/** A TypeScript string in single quotes. A line end is a space; U+2028, U+2029 and control characters are escaped. */
const quote = (text: string) =>
  `'${text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r\n|[\n\r]/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, unicodeEscape)}'`;
/**
 * Issue text that is safe to print: each control character but tab and newline (so ESC,
 * CR, DEL and C1, which start ANSI and OSC codes) is shown as `\uXXXX`, never sent raw.
 */
export const terminalText = (text: string) => text.replace(CONTROL, unicodeEscape);
/** Text as `//` comment lines, indented under a label. */
const commentLines = (text: string) => text.split(LINE_END).map((line) => commentText(line)).map((line) => (line.trim() ? `//   ${line.trimEnd()}` : '//'));

/** The check draft for an incident. It reads only the issue, and writes nothing. */
export function draftLesson(incident: Incident): Draft {
  const sections = readSections(incident.body);
  const todos: string[] = [];
  const fill = (field: string, name: SectionName, write: string): string => {
    const text = findSection(sections, name);
    const summary = text === null ? '' : summarize(text);
    if (summary) return summary;
    todos.push(`${field}: the issue has no "${SECTIONS[name].heading}" section`);
    return `TODO(reviewer): the issue has no "${SECTIONS[name].heading}" section; ${write}`;
  };
  const id = `incident-${incident.number}`;
  let what = readSymptom(incident.title);
  if (!what) {
    todos.push('what: the issue has no title');
    what = 'TODO(reviewer): the issue has no title; write what the check finds';
  }
  const finding: Finding = {
    id,
    what,
    why: fill('why', 'why', 'write why this matters'),
    fix: fill('fix', 'fix', 'write what to do when the check finds it'),
  };

  const context: string[] = [];
  for (const name of ['what', 'why', 'fix', 'lesson', 'spread'] as const) {
    const text = findSection(sections, name);
    if (text !== null) context.push('//', `// ${SECTIONS[name].heading} (from the issue):`, ...commentLines(text));
  }
  const dir = `${LESSONS_DIR}/${id}`;
  const lesson = [
    `// A lesson from incident #${incident.number}: ${commentText(incident.title)}`,
    `// ${commentText(incident.url)}`,
    '//',
    '// A draft from `yokoten learn`. A person reviews it before it ships: fill in each TODO,',
    '// write findProblems, and make the test next to this file pass.',
    ...context,
    '',
    '/** The shape of a yokoten finding: what happened, why it matters, and the fix. */',
    'export interface Finding {',
    '  id: string;',
    '  what: string;',
    '  why: string;',
    '  fix: string;',
    '  docs?: string;',
    '}',
    '',
    'export const lesson: Finding = {',
    `  id: ${quote(finding.id)},`,
    `  what: ${quote(finding.what)},`,
    `  why: ${quote(finding.why)},`,
    `  fix: ${quote(finding.fix)},`,
    '};',
    '',
    '/** The places where the incident happens again: [lesson] when it is there, [] when not. */',
    'export function findProblems(input: string): Finding[] {',
    '  // TODO(reviewer): write the check. Choose what it reads (a file, a command, a setting).',
    '  void input;',
    '  return [];',
    '}',
    '',
  ].join('\n');
  const test = [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { findProblems, lesson } from './lesson.ts';",
    '',
    '// Positive control: the check must catch a known-bad case from the incident. This test',
    '// fails until findProblems is written, so the draft never passes by itself.',
    `test(${quote(`${id}: catches the known-bad case`)}, () => {`,
    '  // TODO(reviewer): replace with an input that shows the incident.',
    "  const knownBad = 'TODO(reviewer)';",
    '  assert.deepEqual(findProblems(knownBad).map((found) => found.id), [lesson.id]);',
    '});',
    '',
    `test(${quote(`${id}: passes a good case`)}, () => {`,
    '  // TODO(reviewer): replace with an input where all is well.',
    "  const knownGood = '';",
    '  assert.deepEqual(findProblems(knownGood), []);',
    '});',
    '',
  ].join('\n');
  return { finding, todos, files: [{ path: `${dir}/lesson.ts`, text: lesson }, { path: `${dir}/lesson.test.ts`, text: test }] };
}

/** The draft as text for a person: what to fill in, then each file. Writes nothing. */
export function formatDraft(incident: Incident, draft: Draft): string[] {
  const lines = [`a check draft from issue #${incident.number}, "${terminalText(incident.title)}".`];
  if (!incident.labels.includes('incident')) lines.push('Note: the issue has no `incident` label; it is drafted anyway.');
  if (draft.todos.length) lines.push(`${draft.todos.length} TODO(s) for the reviewer:`, ...draft.todos.map((todo) => `- ${todo}`));
  else lines.push('The issue answers every field. A reviewer still writes the check and its test.');
  for (const file of draft.files) lines.push('', `--- ${terminalText(file.path)}`, terminalText(file.text.trimEnd()));
  return lines;
}

/**
 * The draft's files in the repo. Adds only: a file that is there is kept, so a second run
 * never overwrites a reviewer's work.
 */
export function writeDraft(root: string, draft: Draft): { written: string[]; kept: string[] } {
  const written: string[] = [];
  const kept: string[] = [];
  for (const file of draft.files) {
    const path = join(root, file.path);
    if (existsSync(path)) {
      kept.push(file.path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
    written.push(file.path);
  }
  return { written, kept };
}
