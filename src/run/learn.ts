// `yokoten learn` (#77): an incident issue becomes a check draft for a person to review.
// It is the first half of the loop: incident, draft, review. The second half is at the end
// of this file (#147): a reviewed lesson ships in the kit, and `doctor` runs it in every project.
//
// The draft comes from the issue's own sections, never from a guess: no model is called.
// Where the issue gives no answer, the draft says TODO and names the missing section. The
// draft's test is a positive control that fails until a person writes the check, so a
// draft never passes by itself.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/** The symptom of an `area: symptom` title, starting lower case, as a finding's `what`. */
function readSymptom(title: string): string {
  const symptom = (/^[\w./-]+:\s+(.+)$/.exec(title.trim())?.[1] ?? title).trim().replace(/\.$/, '');
  return /^[A-Z][a-z]/.test(symptom) ? symptom.charAt(0).toLowerCase() + symptom.slice(1) : symptom;
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
    fix: fill('fix', 'fix', 'write what to do when the check finds it'),
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
 * lesson's test fails: an unreviewed check never ships. `reference` is the id or the issue number.
 */
export function shipLesson(root: string, reference: string, version: string): { lesson: ShippedLesson } | { problems: string[] } {
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
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', join(draftDir, 'lesson.test.ts')], { cwd: root, env, encoding: 'utf8' });
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
