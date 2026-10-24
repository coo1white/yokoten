// `yokoten learn` (#77): an incident issue becomes a check draft for a person to review.
// It is the first half of the loop: incident, draft, review. The second half is at the end
// of this file (#147): a reviewed lesson ships in the kit, and `doctor` runs it in every project.
// Last comes the inbox for gaps in yokoten itself, found in any project (#392).
//
// The draft comes from the issue's own sections, never from a guess: no model is called.
// Where the issue gives no answer, the draft says TODO and names the missing section. The
// draft's test is a positive control that fails until a person writes the check, so a
// draft never passes by itself.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Env } from '../rules/config.ts';
import { type Finding, finding, formatFinding } from '../rules/message.ts';
import { homeOf, loadMarkKinds, type Mark, makeMarkMatcher, makeRedactor, NO_HOME, PLACEHOLDERS, scanText } from '../rules/privacy.ts';

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
  matters: { heading: 'Why it matters', pattern: /^why it matters/i },
  why: { heading: 'Why it got through', pattern: /^why(?! it matters)/i },
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

/**
 * Text shaped to go inside a sentence: no full stop at the end, and the first letter lower
 * case when the first word is a capital followed only by lower-case letters ("The", "A").
 * A code span, an acronym (`CI`, `NO_PROXY`) or a word with another capital (`GitHub`)
 * stays as it is, and so does the word "I". A one-capital name ("Node") is lowered too: the
 * draft can't tell it from an ordinary word, and the reviewer fixes it. Doctor prints
 * "<what>; <fix>" as one sentence.
 */
function asClause(text: string): string {
  const clause = text.trim().replace(/\.$/, '');
  return /^(?!I(?![a-z]))[A-Z][a-z]*(?![\w-])/.test(clause) ? clause.charAt(0).toLowerCase() + clause.slice(1) : clause;
}

/** The symptom of an `area: symptom` title, shaped as a clause, as a finding's `what`. */
function readSymptom(title: string): string {
  return asClause(/^[\w./-]+:\s+(.+)$/.exec(title.trim())?.[1] ?? title);
}

// Issue text is anyone's text, and it lands in a .ts file that people run. JavaScript ends
// a line at CR LF, LF, a lone CR, U+2028 and U+2029, so each one could end a `//` comment
// and make the rest of the line code. Other control characters (C0 but tab, DEL, C1) have
// no place in a draft either. Bidi controls (LRM, RLM, ALM, the embeddings, overrides and
// isolates) can reorder what a reviewer sees ("trojan source"), so they are shown as `\uXXXX`.
const LINE_END = /\r\n|[\n\r\u2028\u2029]/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A character as a `\uXXXX` escape, which TypeScript reads back and a terminal shows as text. */
const unicodeEscape = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
/**
 * Issue text as one line that is safe in a `//` comment: each line end or control character
 * is a space, and each bidi control is shown as `\uXXXX` text.
 */
const commentText = (text: string) => text.split(LINE_END).join(' ').replace(CONTROL, ' ').replace(BIDI, unicodeEscape);
/** A TypeScript string in single quotes. A line end is a space; U+2028, U+2029, control and bidi characters are escaped. */
const quote = (text: string) =>
  `'${text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r\n|[\n\r]/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, unicodeEscape)
    .replace(BIDI, unicodeEscape)}'`;
/**
 * Issue text that is safe to print: each control character but tab and newline (so ESC,
 * CR, DEL and C1, which start ANSI and OSC codes) and each bidi control is shown as `\uXXXX`,
 * never sent raw.
 */
export const terminalText = (text: string) => text.replace(CONTROL, unicodeEscape).replace(BIDI, unicodeEscape);
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
  // A finding's `why` says why it matters (#147). Older issues have only "Why it got
  // through", which names the missing check: it is a start, and the reviewer rewrites it.
  const matters = findSection(sections, 'matters');
  const gotThrough = findSection(sections, 'why');
  let why: string;
  if (matters !== null && summarize(matters)) why = summarize(matters);
  else if (gotThrough !== null && summarize(gotThrough)) {
    todos.push(`why: the issue has no "${SECTIONS.matters.heading}" section; the draft uses "${SECTIONS.why.heading}"`);
    why = `TODO(reviewer): the issue has no "${SECTIONS.matters.heading}" section; rewrite this from "${SECTIONS.why.heading}": ${summarize(gotThrough)}`;
  } else why = fill('why', 'matters', 'write why this matters');
  const finding: Finding = {
    id,
    what,
    why,
    // Doctor prints "<what>; <fix>", so the fix is shaped like the what (#182).
    fix: asClause(fill('fix', 'fix', 'write what to do when the check finds it')),
  };

  const context: string[] = [];
  for (const name of ['what', 'matters', 'why', 'fix', 'lesson', 'spread'] as const) {
    const text = findSection(sections, name);
    if (text !== null) context.push('//', `// ${SECTIONS[name].heading} (from the issue):`, ...commentLines(text));
  }
  const dir = `${LESSONS_DIR}/${id}`;
  const lesson = [
    `// A lesson from incident #${incident.number}: ${commentText(incident.title)}`,
    `// ${incident.url ? commentText(incident.url) : 'TODO(reviewer): gh gave no URL for the issue'}`,
    '//',
    '// A draft from `yokoten learn`. A person reviews it before it ships: fill in each TODO,',
    '// write findProblems, and make the test next to this file pass. Then, in yokoten,',
    `// \`yokoten learn --ship ${id}\` moves it into the kit.`,
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
    '/**',
    ' * The places in the repo at `root` where the incident can happen again: one finding for',
    ' * each place, [] when there is none. `yokoten doctor` runs it in every project that uses',
    ' * the kit, so it reads files only: no network, no writes, and fast. Import only from',
    ' * Node, so the lesson works on its own.',
    ' */',
    'export function findProblems(root: string): Finding[] {',
    '  // TODO(reviewer): write the check. Read the files under root that show the incident.',
    '  void root;',
    '  return [];',
    '}',
    '',
  ].join('\n');
  const test = [
    "import assert from 'node:assert/strict';",
    "import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { dirname, join } from 'node:path';",
    "import { after, test } from 'node:test';",
    "import { findProblems, lesson } from './lesson.ts';",
    '',
    '/** A throwaway repo with these files, by path. It is removed after the tests. */',
    'function makeRepo(files: Record<string, string>): string {',
    "  const root = mkdtempSync(join(tmpdir(), 'lesson-'));",
    '  after(() => rmSync(root, { recursive: true, force: true }));',
    '  for (const [path, text] of Object.entries(files)) {',
    '    mkdirSync(dirname(join(root, path)), { recursive: true });',
    '    writeFileSync(join(root, path), text);',
    '  }',
    '  return root;',
    '}',
    '',
    '// Positive control: the check must catch a known-bad case from the incident. This test',
    '// fails until findProblems is written, so the draft never passes by itself.',
    `test(${quote(`${id}: catches the known-bad case`)}, () => {`,
    '  // TODO(reviewer): replace with files that show the incident.',
    "  const knownBad = makeRepo({ 'TODO(reviewer)': '' });",
    '  assert.deepEqual(findProblems(knownBad).map((found) => found.id), [lesson.id]);',
    '});',
    '',
    `test(${quote(`${id}: passes a good case`)}, () => {`,
    '  // TODO(reviewer): replace with files where all is well.',
    '  const knownGood = makeRepo({});',
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
  if (draft.todos.length) lines.push(`The issue left ${draft.todos.length} field(s) open, each a TODO(reviewer):`, ...draft.todos.map((todo) => `- ${todo}`));
  else lines.push('The issue answers every field.');
  // `--ship` counts every TODO(reviewer) mark, so the count here must not look like all of them (#77).
  lines.push('The reviewer also writes the check (findProblems) and the cases in its test, each a TODO(reviewer) too.');
  for (const file of draft.files) lines.push('', `--- ${terminalText(file.path)}`, terminalText(file.text.trimEnd()));
  return lines;
}

/**
 * The draft's files in the repo. Adds only: a file that is there is kept, so a second run
 * never overwrites a reviewer's work.
 */
export function writeDraft(root: string, draft: Draft): { written: string[]; kept: string[] } {
  return writeLessonFiles(root, draft.files);
}

/** The first part of `relative` that is a symlink in `root`, a folder or the file itself; null when none is. */
function findLessonLink(root: string, relative: string): string | null {
  const parts = relative.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const part = parts.slice(0, depth).join('/');
    try {
      if (lstatSync(join(root, part)).isSymbolicLink()) return part;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The files in the repo, adds only: one that is there is kept, so a review is never overwritten.
 * Every path is checked for a link before the first write, so text from another project never
 * lands outside `lessons/<id>/`.
 */
export function writeLessonFiles(root: string, files: DraftFile[]): { written: string[]; kept: string[] } {
  for (const file of files) {
    const link = findLessonLink(root, file.path);
    if (link) throw new Error(`${link} is a link: a lesson writes only inside its own folder. Remove the link, then run the command again.`);
  }
  const written: string[] = [];
  const kept: string[] = [];
  for (const file of files) {
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

// A lesson travels as one small JSON file (#757): the incident, the check and its positive
// control. Export reads a lesson from `lessons/` or the kit; import shows it for review, and
// `--write` puts it in `lessons/` only. A lesson still runs nowhere until `--ship` moves it
// into the kit, so another project never gets a check nobody read.

/** The export format. A reader refuses a number it does not know. */
export const LESSON_PACK_VERSION = 1;
/** The two files a lesson is: the check, and its positive control. No other path is imported. */
const LESSON_PACK_FILES = ['lesson.ts', 'lesson.test.ts'] as const;
/** The most text one lesson file may hold, so an import stays small and a read stays fast. */
const LESSON_PACK_LIMIT = 256 * 1024;

/** One lesson as a file another project can import. */
export interface LessonPack {
  version: number;
  id: string;
  /** The incident issue the lesson came from. */
  incident: string;
  /** `lesson.ts` and `lesson.test.ts`, with the path from the lesson's folder. */
  files: DraftFile[];
}

/** Where a lesson is in `root`: a draft, or a row of the kit's table. */
function findLessonFolder(root: string, id: string): { folder: string; incident?: string } | null {
  const draft = `${LESSONS_DIR}/${id}`;
  if (existsSync(join(root, draft, 'lesson.ts'))) return { folder: draft };
  const table = readText(join(root, KIT_LESSONS_DIR, LESSONS_TABLE));
  const row = table === null ? undefined : readLessonTable(table).find((one) => one.id === id);
  return row ? { folder: `${KIT_LESSONS_DIR}/${row.folder}`, incident: row.url } : null;
}

/** An id from an issue number or a lesson id, or null when it is neither. */
const lessonIdOf = (reference: string): string | null => {
  const id = /^\d+$/.test(reference) ? `incident-${reference}` : reference;
  return LESSON_ID.test(id) ? id : null;
};

/**
 * A lesson as the small file that leaves this project: the incident, the check and its test.
 * It refuses a draft with a TODO left, a lesson with no incident, and any private detail the
 * privacy check finds, by place and never by value. Nothing is written.
 */
export function exportLesson(root: string, reference: string, env: Env): { pack: LessonPack; text: string } | { problems: string[] } {
  const id = lessonIdOf(reference);
  if (id === null) return { problems: [`${reference} is not a lesson id: give its number or its id, for example incident-138`] };
  const found = findLessonFolder(root, id);
  if (found === null) return { problems: [`no lesson ${id} in ${LESSONS_DIR}/ or ${KIT_LESSONS_DIR}/: write it with \`yokoten learn <issue> --write\`, or ship it first`] };
  const files: DraftFile[] = [];
  for (const name of LESSON_PACK_FILES) {
    const text = readText(join(root, found.folder, name));
    if (text === null) return { problems: [`${found.folder} has no ${name}: a lesson is its check and its positive control`] };
    if (text.length > LESSON_PACK_LIMIT) return { problems: [`${found.folder}/${name} is larger than ${LESSON_PACK_LIMIT / 1024} KiB: a lesson is small`] };
    files.push({ path: name, text });
  }
  const problems: string[] = [];
  for (const file of files) {
    const count = file.text.split('TODO(reviewer)').length - 1;
    if (count) problems.push(`${found.folder}/${file.path} still has ${count} TODO(reviewer): fill each one in`);
  }
  const incident = found.incident ?? readSourceUrl(files[0].text) ?? '';
  if (!incident) problems.push(`${found.folder}/lesson.ts does not name its incident: put the issue URL on a line \`// https://...\` near the top`);
  if (problems.length) return { problems };
  // The check is code from this project, so a private detail would travel with it. Refuse it
  // here, before anything leaves: the person can rewrite the lesson without it.
  const matcher = makeMarkMatcher(loadMarkKinds(env));
  const privateProblems = files.flatMap((file) => scanText(file.text, { file: `${found.folder}/${file.path}`, matcher, env }));
  if (privateProblems.length) {
    return { problems: privateProblems.map((problem) => `${formatFinding(problem)} Remove it from the lesson before exporting it.`) };
  }
  const pack: LessonPack = { version: LESSON_PACK_VERSION, id, incident, files };
  return { pack, text: `${JSON.stringify(pack, null, 2)}\n` };
}

/**
 * A lesson file read back: the shape checked, its files limited to the two a lesson is, and
 * its text scanned for a secret or a private detail. No file is written. `env` is there for
 * the check, so an import is refused before it reaches `lessons/`.
 */
export function importLesson(text: string, env: Env): { pack: LessonPack; files: DraftFile[] } | { problems: string[] } {
  if (text.length > LESSON_PACK_LIMIT * 2) return { problems: [`the file is larger than ${(LESSON_PACK_LIMIT * 2) / 1024} KiB: a lesson is small`] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problems: ['the file is not JSON: export a lesson with `yokoten learn --export <id>`'] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { problems: ['the file is not a lesson: it must be a JSON object'] };
  const record = value as Record<string, unknown>;
  if (record.version !== LESSON_PACK_VERSION) return { problems: [`the file says version ${String(record.version)}, but this yokoten reads version ${LESSON_PACK_VERSION}: update yokoten, or export it again`] };
  const id = typeof record.id === 'string' ? lessonIdOf(record.id) : null;
  if (id === null) return { problems: ['the file has no valid lesson id: give a lower-case id such as incident-138'] };
  const incident = typeof record.incident === 'string' ? record.incident : '';
  if (!/^https?:\/\/\S+$/.test(incident)) return { problems: ['the file does not name its incident: an http or https issue URL is required'] };
  if (!Array.isArray(record.files)) return { problems: ['the file has no files: a lesson is its check and its positive control'] };
  const files: DraftFile[] = [];
  const seen = new Set<string>();
  for (const entry of record.files) {
    if (typeof entry !== 'object' || entry === null) return { problems: ['a file in the lesson is not an object with a path and text'] };
    const file = entry as Record<string, unknown>;
    const name = typeof file.path === 'string' ? file.path : '';
    if (!(LESSON_PACK_FILES as readonly string[]).includes(name)) return { problems: [`${name || 'an empty path'} is not a lesson file: only lesson.ts and lesson.test.ts travel`] };
    if (seen.has(name)) return { problems: [`the file has ${name} twice`] };
    if (typeof file.text !== 'string') return { problems: [`${name} has no text`] };
    if (file.text.length > LESSON_PACK_LIMIT) return { problems: [`${name} is larger than ${LESSON_PACK_LIMIT / 1024} KiB: a lesson is small`] };
    seen.add(name);
    files.push({ path: name, text: file.text });
  }
  for (const name of LESSON_PACK_FILES) if (!seen.has(name)) return { problems: [`the file has no ${name}: a lesson is its check and its positive control`] };
  const problems: string[] = [];
  for (const file of files) {
    const count = file.text.split('TODO(reviewer)').length - 1;
    if (count) problems.push(`${file.path} still has ${count} TODO(reviewer): a lesson travels with its check written`);
  }
  // The incident is the `// https://...` line in `lesson.ts`, the same line export reads: a pack
  // whose JSON says one thing and whose file names no incident would lose the story on the way in.
  const source = readSourceUrl(files.find((file) => file.path === 'lesson.ts')?.text ?? '');
  if (!source) problems.push('lesson.ts does not name its incident: put the issue URL on a line `// https://...` near the top');
  else if (source !== incident) problems.push(`lesson.ts names incident ${source}, but the file says ${incident}: make them the same URL`);
  const matcher = makeMarkMatcher(loadMarkKinds(env));
  for (const file of files) for (const problem of scanText(file.text, { file: file.path, matcher, env })) problems.push(formatFinding(problem));
  if (problems.length) return { problems };
  const pack: LessonPack = { version: LESSON_PACK_VERSION, id, incident, files };
  return { pack, files: files.map((file) => ({ path: `${LESSONS_DIR}/${id}/${file.path}`, text: file.text })) };
}

/** The line that says what an import found, before its files. */
export const formatLessonPack = (pack: LessonPack): string => `a lesson ${pack.id} from ${pack.incident}, with ${pack.files.length} file(s): ${pack.files.map((file) => file.path).join(' and ')}. No TODO(reviewer) is left.`;

// Shipped lessons (#147), the second half of the loop. A reviewed lesson moves from
// `lessons/<id>/` into the kit, with a row in the kit's lessons table. `doctor` then runs
// each lesson's check in every project that uses the kit.
//
// A lesson is code from the kit that runs in another person's repo. So it reads files only,
// and a lesson that throws is reported, never fatal: a lesson gives notes, and a note never
// fails doctor.

/** Where shipped lessons live in yokoten, from the repo root, in numbered group folders. */
export const KIT_LESSONS_DIR = 'kit/lessons';

/** The lessons table, in the kit's lessons folder. Only a lesson in the table ships. */
export const LESSONS_TABLE = 'README.md';

// Lessons sit in numbered group folders (#171), so no folder passes the cap of 7 entries
// however many lessons ship. The top folder holds the table and up to 6 groups. A group
// holds up to 5 lessons and up to 2 groups. A lesson goes in the first group with room,
// by levels: `1/` to `6/`, then `1/1/`, `1/2/`, `2/1/` and so on. A lesson never moves once
// it ships, so its folder in the table stays right.
/** Groups in the top folder: the cap of 7, less the table. */
const TOP_GROUPS = 6;
/** Lessons in a group. With `GROUP_GROUPS`, a group is at the cap of 7. */
const GROUP_LESSONS = 5;
/** Groups in a group: room for the next level. */
const GROUP_GROUPS = 2;
/** A group folder's name: a number. A lesson id is never only a number. */
const GROUP_NAME = /^\d+$/;

/** A row of the lessons table. */
export interface ShippedLesson {
  id: string;
  /** The lesson's folder, from `kit/lessons`: `1/incident-138`. */
  folder: string;
  /** The incident issue the lesson came from. */
  url: string;
  /** The version in package.json when the lesson shipped. */
  version: string;
}

/** What a lesson's id looks like: `incident-<n>` from `learn`, or any lower-case words; never only a number. */
const LESSON_ID = /^(?!\d+$)[a-z0-9]+(-[a-z0-9]+)*$/;
/** A cell of the table: text with no space or pipe in it. */
const TABLE_CELL = /^[^|\s]+$/;
const TABLE_HEAD = ['| Lesson | Folder | Incident | Added in |', '|---|---|---|---|'];
const TABLE_START = [
  '# Lessons',
  '',
  'Each lesson here is from a real incident: a folder with a check (`lesson.ts`) and its test',
  '(`lesson.test.ts`). `yokoten doctor` runs every lesson in this table against the project,',
  'and reports what a lesson finds as a note. A note never fails doctor. To stop one, add',
  'its id to "notNow" in yokoten.json, with the reason.',
  '',
  '`yokoten learn --ship <id>` adds a lesson here. "Folder" is where it is, in numbered',
  'groups so no folder holds more than 7 entries: a group takes 5 lessons and 2 more groups.',
  '"Added in" is the version in package.json when the lesson shipped.',
  '',
];

/**
 * The rows of the lessons table. The header, the line under it, and any other text are left
 * out. A row from before groups (#171) has no folder: its folder is its id.
 */
export function readLessonTable(text: string): ShippedLesson[] {
  const rows: ShippedLesson[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
    if (!cells.every((cell) => TABLE_CELL.test(cell))) continue;
    const [id, folder, url, version] = cells.length === 4 ? cells : cells.length === 3 ? [cells[0], cells[0], cells[1], cells[2]] : [];
    if (!id || !LESSON_ID.test(id) || !isLessonFolder(folder, id)) continue;
    rows.push({ id, folder, url, version });
  }
  return rows;
}

/** True when `folder` is `id`, under groups only: never a path out of the kit. */
const isLessonFolder = (folder: string, id: string): boolean => {
  const parts = folder.split('/');
  return parts.pop() === id && parts.every((part) => GROUP_NAME.test(part));
};

/** A row of the lessons table as Markdown. */
export const formatLessonRow = (lesson: ShippedLesson): string => `| ${lesson.id} | ${lesson.folder} | ${lesson.url} | ${lesson.version} |`;

/**
 * The table's text with these rows: the text before the table and after it stays, and the
 * table is written whole, so a table from before groups gets the folder column.
 */
export function formatLessonTable(text: string | null, rows: ShippedLesson[]): string {
  const lines = text === null ? TABLE_START.slice(0, -1) : text.trimEnd().split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith('|'));
  if (start < 0) return `${[...lines, '', ...TABLE_HEAD, ...rows.map(formatLessonRow)].join('\n')}\n`;
  const end = lines.findIndex((line, index) => index > start && !line.trim().startsWith('|'));
  const before = lines.slice(0, start);
  const after = end < 0 ? [] : lines.slice(end);
  return `${[...before, ...TABLE_HEAD, ...rows.map(formatLessonRow), ...after].join('\n').trimEnd()}\n`;
}

/** The folders in `dir`, by name. */
const listFolders = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

/** The group folders in `dir`, by number. */
const listGroups = (dir: string): string[] => listFolders(dir).filter((name) => GROUP_NAME.test(name)).sort((a, b) => Number(a) - Number(b));

/** Every lesson folder under the kit's lessons folder `kitDir`, from it: `1/incident-138`. */
export function findLessonFolders(kitDir: string, group = ''): string[] {
  const dir = join(kitDir, group);
  const here = listFolders(dir).filter((name) => !GROUP_NAME.test(name)).sort().map((name) => (group ? `${group}/${name}` : name));
  return [...here, ...listGroups(dir).flatMap((name) => findLessonFolders(kitDir, group ? `${group}/${name}` : name))];
}

/**
 * The group for the next lesson, from `kitDir`: the first group with room for a lesson, by
 * levels, or else a new group in the first folder with room for one. It makes nothing.
 */
export function findLessonGroup(kitDir: string): string {
  const groups: string[] = [];
  for (let level = listGroups(kitDir); level.length; ) {
    groups.push(...level);
    level = level.flatMap((group) => listGroups(join(kitDir, group)).map((name) => `${group}/${name}`));
  }
  const open = groups.find((group) => listFolders(join(kitDir, group)).filter((name) => !GROUP_NAME.test(name)).length < GROUP_LESSONS);
  if (open) return open;
  // Every group is full of lessons: a new group, in the shallowest folder with room for one.
  for (const parent of ['', ...groups]) {
    const taken = listGroups(join(kitDir, parent));
    if (taken.length >= (parent ? GROUP_GROUPS : TOP_GROUPS)) continue;
    const name = String(taken.length ? Number(taken[taken.length - 1]) + 1 : 1);
    return parent ? `${parent}/${name}` : name;
  }
  // Not reached: the deepest groups always have room for a group.
  throw new Error(`no room for a lesson group in ${kitDir}`);
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** The incident URL on the second line of a lesson that `learn` drafted: `// https://...`. */
const readSourceUrl = (text: string): string | null => /^\/\/ (https?:\/\/\S+)\s*$/m.exec(text)?.[1] ?? null;

/**
 * Move a reviewed lesson from `lessons/<id>/` into a group of `kit/lessons/`, and add its row
 * to the lessons table. It refuses, and moves nothing, when a TODO(reviewer) is left or the
 * lesson's test fails: an unreviewed check never ships. `reference` is the id or the issue number;
 * the test runs with `env`.
 */
export function shipLesson(root: string, reference: string, version: string, env: Env): { lesson: ShippedLesson } | { problems: string[] } {
  const id = /^\d+$/.test(reference) ? `incident-${reference}` : reference;
  if (!LESSON_ID.test(id)) return { problems: [`${reference} is not a lesson id: give its number or its id, for example incident-138`] };
  if (!existsSync(join(root, 'kit'))) return { problems: ['there is no kit/ here: a lesson ships in a copy of yokoten, where kit/ is what other projects get'] };
  const draftDir = `${LESSONS_DIR}/${id}`;
  const kitDir = join(root, KIT_LESSONS_DIR);
  const tablePath = join(kitDir, LESSONS_TABLE);
  const table = readText(tablePath);
  const rows = table === null ? [] : readLessonTable(table);
  const taken = [...rows.map((row) => row.folder), ...findLessonFolders(kitDir)].find((folder) => folder.split('/').pop() === id);
  if (taken) return { problems: [`${KIT_LESSONS_DIR}/${taken} is already there: give the lesson a new id`] };
  const code = readText(join(root, draftDir, 'lesson.ts'));
  const test = readText(join(root, draftDir, 'lesson.test.ts'));
  if (code === null || test === null) return { problems: [`no lesson in ${draftDir}: run \`yokoten learn <issue> --write\` first, then review the draft`] };

  const problems: string[] = [];
  for (const [name, text] of [['lesson.ts', code], ['lesson.test.ts', test]]) {
    const count = text.split('TODO(reviewer)').length - 1;
    if (count) problems.push(`${draftDir}/${name} still has ${count} TODO(reviewer): fill each one in`);
  }
  const url = readSourceUrl(code);
  if (!url) problems.push(`${draftDir}/lesson.ts does not name its incident: put the issue URL on a line \`// https://...\` near the top`);
  if (problems.length) return { problems };
  // The positive control must pass here, before the lesson reaches any other project.
  // Without NODE_TEST_CONTEXT: inside a test run, it makes the child report to the parent and exit 0.
  const testEnv = { ...env };
  delete testEnv.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', join(draftDir, 'lesson.test.ts')], { cwd: root, env: testEnv, encoding: 'utf8' });
  if (run.status !== 0) return { problems: [`the lesson's test fails: run \`node --test ${draftDir}/lesson.test.ts\` to see why, and fix the check`] };

  const group = findLessonGroup(kitDir);
  const lesson: ShippedLesson = { id, folder: `${group}/${id}`, url: url as string, version };
  mkdirSync(join(kitDir, group), { recursive: true });
  renameSync(join(root, draftDir), join(kitDir, lesson.folder));
  // The drafts folder goes when its last draft has shipped.
  if (!readdirSync(join(root, LESSONS_DIR)).length) rmdirSync(join(root, LESSONS_DIR));
  writeFileSync(tablePath, formatLessonTable(table, [...rows, lesson]));
  return { lesson };
}

/** Where `runLessons` finds the lessons: the table's folder, and the code with its file name. */
export interface LessonPlace {
  /** The folder with the lessons table. */
  dir: string;
  /** The folder with the code, in the same groups as the table's folders; the npm package runs built `.js` (record 0008). */
  codeDir: string;
  /** `lesson.ts`, or `lesson.js` in the npm package. */
  codeFile: string;
}

/** What one lesson found in a project, or why it could not run. */
export interface LessonRun {
  id: string;
  findings: Finding[];
  /** The `what` of the lesson's exported `lesson`: the problem it looks for, when it says. */
  what?: string;
  error?: string;
}

/** The shipped lessons by the table, or [] when there is no table (a project copy has no kit). */
export function listLessons(place: LessonPlace): ShippedLesson[] {
  const table = readText(join(place.dir, LESSONS_TABLE));
  return table === null ? [] : readLessonTable(table);
}

/**
 * Run each lesson's `findProblems` against the repo at `root`, in the order of the table.
 * Ids in `skip` do not run. A lesson that can't load, throws or gives a wrong shape is an
 * error for that lesson alone; the other lessons still run.
 */
export function runLessons(root: string, place: LessonPlace, skip: (id: string) => boolean = () => false): LessonRun[] {
  const load = createRequire(import.meta.url);
  const runs: LessonRun[] = [];
  for (const { id, folder } of listLessons(place)) {
    if (skip(id)) continue;
    const path = join(place.codeDir, folder, place.codeFile);
    try {
      if (!existsSync(path)) throw new Error(`there is no ${place.codeFile}`);
      const module = load(path) as { findProblems?: unknown; lesson?: { what?: unknown } };
      if (typeof module.findProblems !== 'function') throw new Error('it has no findProblems function');
      const found: unknown = module.findProblems(root);
      if (!Array.isArray(found)) throw new Error('findProblems did not give a list');
      const findings = found.map((item): Finding => {
        const { what, why, fix } = (item ?? {}) as Partial<Finding>;
        if (typeof what !== 'string' || typeof why !== 'string' || typeof fix !== 'string') throw new Error('a finding has no what, why or fix');
        return { id, what, why, fix };
      });
      const what = module.lesson?.what;
      runs.push(typeof what === 'string' ? { id, findings, what } : { id, findings });
    } catch (err) {
      runs.push({ id, findings: [], error: String((err as Error)?.message ?? err).split('\n')[0].split(place.codeDir).join(KIT_LESSONS_DIR) });
    }
  }
  return runs;
}

// ---- Lessons for yokoten itself (#392) ----
//
// A gap found while yokoten runs in some project belongs in the yokoten repo, but that
// project's details must not go with it. `learn --upstream` keeps one short note per gap
// in an inbox outside every repo, with the project's name, its paths and the owner hidden
// first. In yokoten's own repo, the session start and doctor count the notes, and the lead
// turns each into an issue. Nothing is sent anywhere: the inbox is a folder on this machine.

/** The inbox, ~/.config/yokoten/upstream, next to the private marks. Null with no home folder. */
export const upstreamDir = (env: Env): string | null => {
  const home = homeOf(env);
  return home ? join(home, '.config', 'yokoten', 'upstream') : null;
};

/** One note in the inbox. Every text field is already redacted. */
export interface UpstreamNote {
  id: string;
  /** When it was written, in UTC: `2026-10-20T12:00:00Z`. */
  when: string;
  /** The yokoten area it is about, or `unknown`. */
  part: string;
  what: string;
  fix?: string;
}

/** A note's id: its UTC time and four hex digits, `20261020-120000-ab12`. It is also its file name. */
export const NOTE_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const NOTE_FILE = /^\d{8}-\d{6}-[0-9a-f]{4}\.md$/;

/** What the note may hold: the project at hand, the owner, and the marks. */
export interface NotePlace {
  /** The project's root folder, or null outside a repo. */
  root: string | null;
  /** The project's names: its folder, its package name, its origin repo. */
  projects: string[];
  /** The owner's names and the private hosts, as `redact` hides them. */
  owners: string[];
  hosts: string[];
  /** The marks as an old plain file stores them; `markKinds` carries a hashed file too (#665). */
  marks: string[];
  /** The same marks with their file's salt, when the caller has it. */
  markKinds?: Mark[];
  /** Where a relative path in the note starts: the folder the command runs in. */
  cwd: string;
}

/**
 * Secret shapes refused in a note on top of the commit check's tokens. They are looser
 * than those, so they stay here: in a commit, `token=` in a test or a doc is common.
 */
const NOTE_SECRETS: { kind: string; re: RegExp }[] = [
  { kind: 'a password in a URL', re: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { kind: 'a password or key after password=, token= or the like', re: /(?<![A-Za-z0-9])(?:password|passwd|secret|token|api_key|apikey)["']?\s*[=:]\s*["']?[^\s"',;]{8,}/i },
  { kind: 'a JSON web token', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/ },
  { kind: 'an OpenAI key', re: /(?<![A-Za-z0-9_-])sk-proj-[A-Za-z0-9_-]{8,}/ },
];

/** Text on one line, with no control characters: a note is one short line per field. */
const oneLine = (text: string) => terminalText(text.split(LINE_END).join(' ').replace(CONTROL, ' ')).replace(/\s+/g, ' ').trim();

/**
 * The spellings of a project name: any case, with `-`, `_`, a space or nothing between its
 * words, so `secret-proj` also hides `SecretProj` and `secret_proj`. A name of under three
 * letters gives none: it would hide half the text (a private mark covers it).
 */
export function nameVariants(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.join('').length < 3) return [];
  return [...new Set([name.toLowerCase(), ...['-', '_', ' ', ''].map((between) => words.join(between))])];
}

// A path in the text: absolute, or from ~/, ./ or ../. Not after a letter, a colon or a
// slash, so `and/or` and `https://` are not paths. It stops at a space, a quote or a colon.
const PATH_TOKEN = /(?<![\p{L}\p{N}_.~:/-])(?:~|\.{1,2})?\/[^\s'"`<>|;,:(){}[\]]*/gu;

const realOrSelf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The real path of the longest part of `path` that exists, and the parts after it. */
function longestReal(path: string): { real: string; rest: string[] } | null {
  const parts = path.split('/');
  for (let count = parts.length; count > 0; count--) {
    try {
      return { real: realpathSync(parts.slice(0, count).join('/') || '/'), rest: parts.slice(count) };
    } catch {}
  }
  return null;
}

/** `path` from `base`, when it is `base` or inside it; else null. */
const inside = (path: string, base: string): string | null => {
  const rel = relative(base, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? rel : null;
};

/**
 * Each path in the text, by where it really leads: into the project, it starts with
 * `<project>`, through a symlink too; else, absolute and into the home folder, with `~`.
 */
function hidePaths(text: string, root: string | null, home: string | null, cwd: string): string {
  const realRoot = root ? realOrSelf(root) : null;
  const realHome = home ? realOrSelf(home) : null;
  return text.replace(PATH_TOKEN, (token) => {
    const trail = /[.!?]+$/.exec(token)?.[0] ?? '';
    const path = token.slice(0, token.length - trail.length);
    const full = path.startsWith('~/') ? (home ? join(home, path.slice(2)) : null) : path.startsWith('/') ? path : join(cwd, path);
    const found = full ? longestReal(full) : null;
    if (!found) return token;
    const shown = (start: string, base: string) => {
      const rel = inside(found.real, base);
      return rel === null ? null : [start, ...rel.split(sep), ...found.rest].filter(Boolean).join('/') + trail;
    };
    return (realRoot && shown(PLACEHOLDERS.project, realRoot)) || (realHome && path.startsWith('/') && shown('~', realHome)) || token;
  });
}

/**
 * The owners and the repo in a remote URL: `https://host/group/sub/repo.git` gives
 * `group` and `sub` as owners and `repo` as the project. Every owner segment may name a person.
 */
export function originParts(url: string): { owners: string[]; project: string | null } {
  const path = (/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.*)$/i.exec(url) ?? /^(?:[^@/\s]+@)?[^/:\s]+:(?!\/\/)(.*)$/.exec(url))?.[1];
  const parts = (path ?? '').replace(/\.git\/?$|\/$/g, '').split('/').filter(Boolean);
  return parts.length < 2 ? { owners: [], project: null } : { owners: parts.slice(0, -1), project: parts[parts.length - 1] };
}

/** A function that hides the project, the home folder and the owner in a field, as a note keeps it. */
export function makeNoteCleaner(place: NotePlace, env: Env): (text: string) => string {
  const home = homeOf(env);
  const projects = place.projects.flatMap(nameVariants);
  const matcher = place.markKinds ? makeMarkMatcher(place.markKinds) : undefined;
  const redact = makeRedactor({ marks: place.marks, matcher, owners: place.owners, hosts: place.hosts, projects }, { ...env, HOME: home ?? undefined });
  return (text) => redact(hidePaths(oneLine(text), place.root, home, place.cwd));
}

/**
 * The note's text as it may leave the project: a known secret shape refused, then the
 * project's paths and names as `<project>`, the home folder as `~`, and the owner as
 * `redact` hides them. What the privacy check still finds after that refuses the note, by
 * kind, never by value.
 */
export function redactNote(text: string, place: NotePlace, env: Env): { text: string } | { problems: Finding[] } {
  const line = oneLine(text);
  // A secret is refused, not hidden: whoever pasted it should know, and may need to rotate it.
  const secrets = [
    ...scanText(line, { file: 'the note', env }).filter((problem) => problem.id === 'secret'),
    ...NOTE_SECRETS.filter(({ re }) => re.test(line)).map(({ kind }) => finding('secret', `a secret (${kind})`, 'take it out of the note')),
  ];
  if (secrets.length) return { problems: secrets };
  const out = makeNoteCleaner(place, env)(line);
  const problems = scanText(out, { file: 'the note', marks: place.marks, matcher: place.markKinds ? makeMarkMatcher(place.markKinds) : undefined, env });
  return problems.length ? { problems } : { text: out };
}

/** Write one note to the inbox. With no home folder it throws, never writing in the repo. `now` is there for a test. */
export function writeNote(env: Env, note: Omit<UpstreamNote, 'id' | 'when'>, now: Date = new Date()): UpstreamNote {
  const dir = upstreamDir(env);
  if (!dir) throw new Error(NO_HOME);
  const when = `${now.toISOString().slice(0, 19)}Z`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = when.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let id = '';
  do id = `${stamp}-${randomBytes(2).toString('hex')}`;
  while (existsSync(join(dir, `${id}.md`)));
  const written: UpstreamNote = { id, when, ...note };
  const lines = [`when: ${when}`, `part: ${written.part}`, `what: ${written.what}`, ...(written.fix ? [`fix: ${written.fix}`] : [])];
  writeFileSync(join(dir, `${id}.md`), `${lines.join('\n')}\n`, { mode: 0o600 });
  return written;
}

/** How many notes wait. One readdir, no file read, so the session start stays fast. */
export function countNotes(env: Env): number {
  const dir = upstreamDir(env);
  if (!dir) return 0;
  try {
    return readdirSync(dir).filter((name) => NOTE_FILE.test(name)).length;
  } catch {
    return 0;
  }
}

/** The notes, oldest first, as their files hold them. A file that can't be read is left out. */
export function listNotes(env: Env): UpstreamNote[] {
  const dir = upstreamDir(env);
  if (!dir) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => NOTE_FILE.test(name)).sort();
  } catch {
    return [];
  }
  const notes: UpstreamNote[] = [];
  for (const name of names) {
    const text = readText(join(dir, name));
    if (text === null) continue;
    const field = (key: string) => new RegExp(`^${key}: (.*)$`, 'm').exec(text)?.[1];
    const fix = field('fix');
    notes.push({ id: name.slice(0, -3), when: field('when') ?? '', part: field('part') ?? 'unknown', what: field('what') ?? '', ...(fix ? { fix } : {}) });
  }
  return notes;
}

/** Remove one note, after its issue is open. False when there is no such note file. */
export function removeNote(env: Env, id: string): boolean {
  const dir = upstreamDir(env);
  if (!dir || !NOTE_ID.test(id)) return false;
  const file = join(dir, `${id}.md`);
  try {
    if (!lstatSync(file).isFile()) return false;
  } catch {
    return false;
  }
  rmSync(file);
  return true;
}

/** The line the session start and doctor give in yokoten's own repo, or null with no note. */
export const waitingLine = (count: number): string | null =>
  count ? `${count} ${count === 1 ? 'lesson' : 'lessons'} from other projects ${count === 1 ? 'waits' : 'wait'} to become ${count === 1 ? 'an issue' : 'issues'}: yokoten learn --upstream --list` : null;
