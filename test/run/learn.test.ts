// Tests for src/run/learn.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
} from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeSandbox, makeTempDir } from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import {
  homeOf,
  marksFile,
} from '../../src/rules/privacy.ts';
import { checkLayout } from '../../src/rules/layout.ts';
import {
  countNotes,
  draftLesson,
  findLessonFolders,
  findLessonGroup,
  formatDraft,
  formatLessonRow,
  formatLessonTable,
  type Incident,
  KIT_LESSONS_DIR,
  LESSONS_TABLE,
  listNotes,
  nameVariants,
  type NotePlace,
  originParts,
  readLessonTable,
  redactNote,
  removeNote,
  readSections,
  shipLesson,
  summarize,
  upstreamDir,
  waitingLine,
  writeDraft,
  writeNote,
} from '../../src/run/learn.ts';
import {
  findStateFile,
  formatLessonChecks,
  lessonChecks,
  readState,
  saveState,
  seenAfter,
} from '../../src/setup/doctor.ts';

// `yokoten learn` (#77): an incident issue becomes a check draft, from the issue's own
// sections. The issue text is stubbed here; nothing reaches the network.
const incidentOf = (body: string, title = 'check: misses a key in a JSON file'): Incident => ({ number: 12, title, body, url: 'https://example.com/issues/12', labels: ['incident'] });

// Shipped lessons (#147): a reviewed lesson moves into the kit, and doctor runs it in every
// project. The lessons here are small ones, written for the test.
const ENV_LESSON = [
  '// A lesson from incident #12: check: a .env file is committed',
  '// https://example.com/issues/12',
  "import { existsSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "export const lesson = { id: 'incident-12', what: 'a .env file is in the repo', why: 'it can hold a secret', fix: 'remove it, and add it to .gitignore' };",
  "export function findProblems(root: string) { return existsSync(join(root, '.env')) ? [lesson] : []; }",
  '',
].join('\n');

const ENV_LESSON_TEST = [
  "import assert from 'node:assert/strict';",
  "import { mkdtempSync, writeFileSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "import { test } from 'node:test';",
  "import { findProblems } from './lesson.ts';",
  "test('catches a .env file', () => {",
  "  const root = mkdtempSync(join(tmpdir(), 'lesson-'));",
  "  writeFileSync(join(root, '.env'), 'KEY=1\\n');",
  '  assert.equal(findProblems(root).length, 1);',
  '});',
  '',
].join('\n');

/** A folder that Node reads as ES modules, as yokoten's own folder is. */
function makeModuleDir(prefix: string): string {
  const root = makeTempDir(prefix);
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
  return root;
}

// #172: the first full doctor in a clone says a kit lesson is new, once. A session writes nothing.
test('lessons: full doctor notes a new lesson on the first run only; a session, not now and a broken state', () => {
  const sandbox = makeSandbox();
  const stateFile = join(sandbox.repo, '.git', 'yokoten', 'state.json');
  const newNote = /\n {2}note {4}new lesson: incident-138 \(a test calls a server on this machine and does not set NO_PROXY\); doctor now runs it in this project\n {2}ok {6}lesson incident-138\n/;
  let result = sandbox.run(['doctor', '--session']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(stateFile), 'a session writes nothing');
  // Not now: no new note, and the lesson is not marked seen.
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { 'incident-138': 'no local servers here' } }));
  result = sandbox.run(['doctor']);
  assert.ok(!/new lesson/.test(result.stdout), result.stdout);
  assert.ok(!existsSync(stateFile));
  rmSync(join(sandbox.repo, 'yokoten.json'));
  // The first run: the note, even with no problem found (positive control).
  result = sandbox.run(['doctor']);
  assert.match(result.stdout, newNote);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { seenLessons: ['incident-138'] });
  assert.equal(sandbox.git('status', '--porcelain').stdout, '', 'the state file is never in the tree');
  // The second run: the lesson's own line only.
  result = sandbox.run(['doctor']);
  assert.ok(!/new lesson/.test(result.stdout));
  assert.match(result.stdout, /\n {2}ok {6}lesson incident-138\n/);
  // A broken state file is an empty state: the note again, no crash, and the file is mended.
  writeFileSync(stateFile, '{ not json');
  result = sandbox.run(['doctor', '--json']);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).lessons.find((lesson: { id: string }) => lesson.id === 'incident-138'), { id: 'incident-138', mark: 'ok', isNew: true });
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { seenLessons: ['incident-138'] });
});

test('learn: the draft takes what, why and the fix from the issue\'s sections', () => {
  const body = '## What happened\n\nA key in a JSON file was not checked.\n\n## Why it matters\n\nA leaked key opens the account.\n\n## Why it got through\n\nThe privacy check read Markdown only.\n\n## Fix\n\nThe check reads JSON too.\nIt has a test.\n\nMore detail.\n';
  const draft = draftLesson(incidentOf(body));
  assert.deepEqual(draft.finding, { id: 'incident-12', what: 'misses a key in a JSON file', why: 'A leaked key opens the account', fix: 'the check reads JSON too. It has a test' });
  assert.deepEqual(draft.todos, []);
  assert.deepEqual(draft.files.map((file) => file.path), ['lessons/incident-12/lesson.ts', 'lessons/incident-12/lesson.test.ts']);
  const [lesson, check] = draft.files.map((file) => file.text);
  assert.match(lesson, /^\/\/ A lesson from incident #12: check: misses a key in a JSON file\n\/\/ https:\/\/example\.com\/issues\/12\n/);
  assert.match(lesson, /\n\/\/ Fix \(from the issue\):\n\/\/   The check reads JSON too\.\n\/\/   It has a test\.\n\/\/\n\/\/   More detail\.\n/);
  assert.match(lesson, /\n {2}why: 'A leaked key opens the account',\n/);
  assert.match(lesson, /\n\/\/ Why it got through \(from the issue\):\n\/\/   The privacy check read Markdown only\.\n/);
  // The check gets the repo's folder, as doctor runs it in a project (#147).
  assert.match(lesson, /export function findProblems\(root: string\): Finding\[\] \{\n {2}\/\/ TODO\(reviewer\)/);
  // The draft's own test is a positive control that fails until the check is written.
  assert.match(check, /import \{ findProblems, lesson \} from '\.\/lesson\.ts';/);
  assert.match(check, /test\('incident-12: catches the known-bad case'[^]*\[lesson\.id\]\);/);
  assert.match(formatDraft(incidentOf(body), draft).join('\n'), /The issue answers every field\.\nThe reviewer also writes the check \(findProblems\) and the cases in its test, each a TODO\(reviewer\) too\.\n[^]*\n--- lessons\/incident-12\/lesson\.ts\n/);
});

test('learn: a missing section gives a TODO for the reviewer, never a made-up answer (positive control)', () => {
  const draft = draftLesson(incidentOf('## What happened\n\nA key was not checked.\n\n## Why it got through\n\n_No response_\n'));
  assert.deepEqual(draft.todos, ['why: the issue has no "Why it matters" section', 'fix: the issue has no "Fix" section']);
  assert.match(draft.finding.why, /^TODO\(reviewer\): the issue has no "Why it matters" section; /);
  assert.match(draft.finding.fix, /^TODO\(reviewer\): the issue has no "Fix" section; /);
  assert.ok(!/No response/.test(draft.files[0].text), 'an empty form field is not copied as an answer');
  // No sections at all: every field the body should give is a TODO, and what comes from the title.
  const empty = draftLesson(incidentOf('Something broke.', 'Commit times carry a time zone'));
  assert.equal(empty.finding.what, 'commit times carry a time zone');
  assert.equal(empty.todos.length, 2);
  const lines = formatDraft({ ...incidentOf(''), labels: [] }, draftLesson(incidentOf(''))).join('\n');
  assert.match(lines, /Note: the issue has no `incident` label; it is drafted anyway\.\nThe issue left 2 field\(s\) open, each a TODO\(reviewer\):\n- why: /);
});

test('learn: with no "Why it matters", the why starts from "Why it got through", with a TODO (#147)', () => {
  const draft = draftLesson(incidentOf('## What happened\n\nA key was not checked.\n\n## Why it got through\n\nThe check read Markdown only.\n\n## Fix\n\nRead JSON too.\n'));
  assert.deepEqual(draft.todos, ['why: the issue has no "Why it matters" section; the draft uses "Why it got through"']);
  assert.equal(draft.finding.why, 'TODO(reviewer): the issue has no "Why it matters" section; rewrite this from "Why it got through": The check read Markdown only');
  // A bold label works too, and "Why it matters" is never read as "Why it got through".
  const labelled = draftLesson(incidentOf('**Why it matters:** a leak.\n**Why:** no check.\n**Fix:** a check.'));
  assert.deepEqual([labelled.finding.why, labelled.todos], ['a leak', []]);
});

test('learn: an issue made from the kit\'s incident template drafts with no TODO (#169)', () => {
  // GitHub writes an issue form as `### <label>`, a blank line, then the answer.
  const template = readFileSync(join(import.meta.dirname, '../..', 'kit/project/.github/ISSUE_TEMPLATE/incident.yml'), 'utf8');
  const labels = [...template.matchAll(/^\s+label: (.+)$/gm)].map((match) => match[1].trim());
  assert.ok(labels.includes('Fix'), 'the template has a "Fix" field');
  const body = labels.map((label) => `### ${label}\n\n${label === 'Fix' ? 'The check reads JSON too, with a test' : `An answer for ${label}`}`).join('\n\n');
  const draft = draftLesson(incidentOf(body));
  assert.deepEqual(draft.todos, []);
  // The first letter's case is the draft's to shape (#182), so it is not held here.
  assert.match(draft.finding.fix, /^[Tt]he check reads JSON too, with a test$/);
  // Positive control: the same issue with "Fix" left empty gets a TODO.
  const empty = draftLesson(incidentOf(body.replace('The check reads JSON too, with a test', '_No response_')));
  assert.deepEqual(empty.todos, ['fix: the issue has no "Fix" section']);
});

test('learn: sections by heading or bold label, outside code blocks; one line per field', () => {
  const sections = readSections('Intro.\n**What happened:** a commit kept its time zone.\n### Fix and check\n\n- [ ] The commit check refuses it,\n  with a test.\n- [ ] init sets TZ.\n\n```sh\n# a comment\n```\n');
  assert.deepEqual(sections.map((section) => section.heading), ['What happened', 'Fix and check']);
  assert.equal(sections[0].text, 'a commit kept its time zone.');
  assert.equal(summarize(sections[1].text), 'The commit check refuses it, with a test');
  assert.equal(summarize('1. First step:\n2. Second'), 'First step');
  // A quote in the issue stays inside the generated string.
  assert.match(draftLesson(incidentOf('## Fix\n\nIt\'s fixed with a \\ path.')).files[0].text, /fix: 'it\\'s fixed with a \\\\ path',/);
});

// #182: doctor prints "<what>; <fix>", so the fix is shaped like the what: lower case
// after the semicolon, no full stop. A code span or an acronym stays as it is.
test('learn: the fix reads as part of one sentence with the what (#182)', () => {
  const fixOf = (text: string) => draftLesson(incidentOf(`## Fix\n\n${text}\n`)).finding.fix;
  assert.equal(fixOf('The test sets X.'), 'the test sets X');
  assert.equal(fixOf('A check.'), 'a check');
  assert.equal(fixOf('`NO_PROXY` is set.'), '`NO_PROXY` is set');
  assert.equal(fixOf('CI runs it.'), 'CI runs it');
  assert.equal(fixOf('NO_PROXY is set.'), 'NO_PROXY is set');
  assert.equal(fixOf('GitHub keeps it.'), 'GitHub keeps it');
  assert.equal(fixOf('I set NO_PROXY in the test.'), 'I set NO_PROXY in the test', 'the word I stays');
  assert.equal(fixOf("I'm setting it."), "I'm setting it");
  assert.equal(fixOf('It sets it.'), 'it sets it');
  // A missing Fix section keeps its TODO as it is.
  assert.match(draftLesson(incidentOf('')).finding.fix, /^TODO\(reviewer\): /);
});

test('learn: issue text never becomes code in the draft (positive control: the payload is real code)', () => {
  // JavaScript ends a line at U+2028, U+2029 and a lone CR too. A title or body could end a
  // `//` comment there and run the rest when the draft's test imports lesson.ts.
  const [lineSeparator, paragraphSeparator] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
  const payload = "process.getBuiltinModule('node:fs').writeFileSync('PWNED','x');//";
  const hostile = (end: string) => `${end}${payload}`;
  const nasty = "*/ ${x} `tick` 'quote' \"dq\" \\ \u0000\u001b\u0085";
  const title = `repo: tests break${hostile(lineSeparator)}${hostile(paragraphSeparator)}${hostile('\r')}`;
  const body = [
    '## What happened',
    '',
    `It broke.${hostile(lineSeparator)}`,
    `Again.${hostile(paragraphSeparator)} ${nasty}`,
    '',
    '## Why it got through',
    '',
    `No check.${hostile('\r')}`,
    '',
    '## Fix',
    '',
    `A check.${hostile(lineSeparator)}${hostile(paragraphSeparator)}${hostile('\r')} ${nasty}`,
    '',
    '## Lesson',
    '',
    `Read twice.${hostile('\r\n')}`,
  ].join('\n');
  // Writes the draft to a new folder and imports its lesson.ts there, as the draft's own
  // test does: the import parses the file and runs any code in it.
  const importDraft = (made: ReturnType<typeof draftLesson>) => {
    const root = makeTempDir('yokoten-learn-hostile-');
    writeDraft(root, made);
    const path = made.files[0].path;
    // The path goes in as an argument, not into the code: the code is fixed text.
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', 'const { lesson } = await import(process.argv[1]); console.log(JSON.stringify(lesson));', pathToFileURL(join(root, path)).href], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    return { root, run, lesson: readFileSync(join(root, path), 'utf8') };
  };
  const draft = draftLesson({ ...incidentOf(body, title), url: `https://example.com/issues/12${hostile(lineSeparator)}` });
  const { root, run, lesson } = importDraft(draft);
  // The same with no lone CR: without the fix this draft parses, so the payload would run.
  const parsing = draftLesson({
    ...incidentOf(`## Fix\n\nA check.${hostile(lineSeparator)}${hostile(paragraphSeparator)}\n\n## Lesson\n\nRead twice.${hostile(paragraphSeparator)}`, `repo: tests break${hostile(lineSeparator)}${hostile(paragraphSeparator)}`),
    number: 13,
  });
  const second = importDraft(parsing);
  assert.ok(!existsSync(join(root, 'PWNED')), 'the payload did not run');
  assert.ok(!existsSync(join(second.root, 'PWNED')), 'the payload did not run (no lone CR)');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(second.run.status, 0, second.run.stderr);
  assert.equal(JSON.parse(second.run.stdout).what, parsing.finding.what);
  assert.ok(!/[\r\u{2028}\u{2029}]/u.test(lesson), 'no line end but LF in the draft');
  for (const line of lesson.split('\n').filter((line) => line.includes('writeFileSync'))) {
    assert.match(line, /^(\/\/|  (what|why|fix): ')/, `the payload is only in a comment or a string: ${JSON.stringify(line)}`);
  }
  // A string keeps its text, but for CR and LF, which become a space as before.
  const expected = Object.fromEntries(Object.entries(draft.finding).map(([key, value]) => [key, value.replace(/\r\n|[\n\r]/g, ' ')]));
  assert.deepEqual(JSON.parse(run.stdout), expected, 'the strings keep their text');
  assert.ok(draft.finding.fix.includes(payload) && draft.finding.what.includes(lineSeparator), 'the payload reached the draft as text');
});

test('learn: the printed draft sends no terminal escape from the issue, shown as \\uXXXX instead', () => {
  // Clear the line and move up: a title could hide or fake a line of the preview. OSC 8: a link.
  const title = 'repo: tests break \u001b[2K\u001b[1A \u001b]8;;https://example.com/x\u0007click\u001b]8;;\u0007 \u009b31m';
  const body = '## Fix\n\nA check \u001b[31mred\u001b[0m.\n\n## Lesson\n\nKeep \u001b]0;title\u0007 out.';
  const incident = { ...incidentOf(body, title), labels: [] };
  const text = formatDraft(incident, draftLesson(incident)).join('\n');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text), 'no control character but tab and newline');
  assert.match(text, /^a check draft from issue #12, "repo: tests break \\u001b\[2K\\u001b\[1A \\u001b\]8;;https:\/\/example\.com\/x\\u0007click\\u001b\]8;;\\u0007 \\u009b31m"\.\n/);
  assert.match(text, /\/\/ {3}A check {2}\[31mred \[0m\./, 'a comment in the draft has a space for each');
});

test('learn: bidi controls from the issue are shown as \\uXXXX in the preview and the draft (positive control: raw ones fail)', () => {
  // RLO and the isolates reorder what a reviewer sees ("trojan source"). Built by code, so
  // this file holds none of them raw.
  const bidi = [0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((code) => String.fromCharCode(code));
  const raw = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  const title = `repo: tests break ${bidi.join('x')} end`;
  const body = `## Fix\n\nA check ${bidi.join('')}.\n\n## Lesson\n\nKeep ${bidi[0]}out.`;
  const incident = { ...incidentOf(body, title), labels: [] };
  const draft = draftLesson(incident);
  const text = formatDraft(incident, draft).join('\n');
  assert.ok(!raw.test(text), 'no raw bidi control in the preview');
  assert.ok(text.includes('repo: tests break \\u202ex\\u2066x\\u2067x\\u2068x\\u2069 end'), 'the preview shows each as \\uXXXX');
  const root = makeTempDir('yokoten-learn-bidi-');
  writeDraft(root, draft);
  for (const file of draft.files) assert.ok(!raw.test(readFileSync(join(root, file.path), 'utf8')), `no raw bidi control in ${file.path}`);
  const lesson = readFileSync(join(root, draft.files[0].path), 'utf8');
  assert.ok(lesson.includes('// A lesson from incident #12: repo: tests break \\u202ex\\u2066x'), 'a comment shows each as \\uXXXX text');
  assert.ok(lesson.includes("  fix: 'a check \\u202e\\u2066\\u2067\\u2068\\u2069',"), 'a string escapes each');
});

test('learn: --write adds the draft\'s files and keeps a file that is there', () => {
  const root = makeTempDir('yokoten-learn-');
  const draft = draftLesson(incidentOf('## Fix\n\nA check.'));
  assert.deepEqual(writeDraft(root, draft), { written: ['lessons/incident-12/lesson.ts', 'lessons/incident-12/lesson.test.ts'], kept: [] });
  writeFileSync(join(root, 'lessons/incident-12/lesson.ts'), 'reviewed\n');
  assert.deepEqual(writeDraft(root, draft), { written: [], kept: ['lessons/incident-12/lesson.ts', 'lessons/incident-12/lesson.test.ts'] });
  assert.equal(readFileSync(join(root, 'lessons/incident-12/lesson.ts'), 'utf8'), 'reviewed\n', 'a reviewer\'s work is never overwritten');
});

test('lessons: the table gives each row\'s id, folder, incident and version; other lines are left out', () => {
  const text = ['# Lessons', '', 'Text with | a pipe.', '', '| Lesson | Folder | Incident | Added in |', '|---|---|---|---|', formatLessonRow({ id: 'incident-138', folder: '1/incident-138', url: 'https://example.com/issues/138', version: '0.1.0' }), '| incident-8 | 2/1/incident-8 | https://example.com/issues/8 | 0.2.0 |', ''].join('\n');
  assert.deepEqual(readLessonTable(text), [
    { id: 'incident-138', folder: '1/incident-138', url: 'https://example.com/issues/138', version: '0.1.0' },
    { id: 'incident-8', folder: '2/1/incident-8', url: 'https://example.com/issues/8', version: '0.2.0' },
  ]);
  // A row from before groups (#171): its folder is its id. A folder out of the groups, or not ending in the id, is no row.
  const old = ['| Lesson | Incident | Added in |', '|---|---|---|', '| incident-7 | https://example.com/issues/7 | 0.2.0 |', '| incident-9 | ../incident-9 | https://example.com/issues/9 | 0.2.0 |', '| incident-6 | 1/incident-5 | https://example.com/issues/6 | 0.2.0 |', '| 12 | 1/12 | https://example.com/issues/12 | 0.2.0 |'].join('\n');
  assert.deepEqual(readLessonTable(old), [{ id: 'incident-7', folder: 'incident-7', url: 'https://example.com/issues/7', version: '0.2.0' }]);
  // Written again, the table gets the folder column; the text around it stays.
  const rewritten = formatLessonTable(`# Lessons\n\nIntro.\n\n${old}\n\nAfter.\n`, readLessonTable(old));
  assert.equal(rewritten, '# Lessons\n\nIntro.\n\n| Lesson | Folder | Incident | Added in |\n|---|---|---|---|\n| incident-7 | incident-7 | https://example.com/issues/7 | 0.2.0 |\n\nAfter.\n');
  assert.match(formatLessonTable(null, []), /^# Lessons\n[^]*\n\n\| Lesson \| Folder \| Incident \| Added in \|\n\|---\|---\|---\|---\|\n$/);
});

// #171: lessons sit in numbered groups, so shipping any number of them never breaks the cap.
test('lessons: groups take 5 lessons and 2 groups, by levels; 100 lessons keep every folder within the cap', () => {
  const kit = makeTempDir('yokoten-groups-');
  writeFileSync(join(kit, 'README.md'), '# Lessons\n');
  const folders: string[] = [];
  for (let n = 1; n <= 100; n++) {
    const folder = `${findLessonGroup(kit)}/incident-${n}`;
    mkdirSync(join(kit, folder), { recursive: true });
    writeFileSync(join(kit, folder, 'lesson.ts'), '');
    writeFileSync(join(kit, folder, 'lesson.test.ts'), '');
    folders.push(folder);
  }
  assert.deepEqual([folders[0], folders[4], folders[5], folders[29], folders[30], folders[35], folders[42]], ['1/incident-1', '1/incident-5', '2/incident-6', '6/incident-30', '1/1/incident-31', '1/2/incident-36', '2/1/incident-43']);
  const files = [join(KIT_LESSONS_DIR, 'README.md'), ...folders.flatMap((folder) => ['lesson.ts', 'lesson.test.ts'].map((name) => join(KIT_LESSONS_DIR, folder, name)))];
  assert.deepEqual(checkLayout(files, DEFAULTS), []);
  assert.ok(Math.max(...folders.map((folder) => folder.split('/').length)) <= 4, 'the depth grows by levels, not one per lesson');
  assert.deepEqual(findLessonFolders(kit).sort(), [...folders].sort(), 'the walk finds each lesson');
});

test('lessons: --ship refuses a draft with a TODO or a failing test, and moves nothing (positive control)', (t) => {
  const root = makeModuleDir('yokoten-ship-');
  // The lesson's test runs in a child that makes its folder in TMPDIR: point it at a folder
  // that goes away with this test (#400).
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = makeTempDir('yokoten-lesson-tmp-');
  t.after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  });
  const draftDir = join(root, 'lessons/incident-12');
  assert.match(String((shipLesson(root, '12', '0.1.0') as { problems: string[] }).problems), /no kit\/ here/);
  mkdirSync(join(root, 'kit'));
  assert.match(String((shipLesson(root, '12', '0.1.0') as { problems: string[] }).problems), /no lesson in lessons\/incident-12: run `yokoten learn <issue> --write` first/);
  assert.match(String((shipLesson(root, '../x', '0.1.0') as { problems: string[] }).problems), /is not a lesson id/);
  // A fresh draft: TODOs in both files.
  writeDraft(root, draftLesson(incidentOf('## Why it matters\n\nA leak.\n\n## Fix\n\nA check.\n')));
  let shipped = shipLesson(root, '12', '0.1.0') as { problems: string[] };
  assert.deepEqual(shipped.problems.map((problem) => problem.replace(/\d+ TODO/, 'N TODO')), ['lessons/incident-12/lesson.ts still has N TODO(reviewer): fill each one in', 'lessons/incident-12/lesson.test.ts still has N TODO(reviewer): fill each one in']);
  // No TODO left, but the check finds nothing: its positive control fails.
  writeFileSync(join(draftDir, 'lesson.ts'), ENV_LESSON.replace("existsSync(join(root, '.env')) ? [lesson] : []", '[]'));
  writeFileSync(join(draftDir, 'lesson.test.ts'), ENV_LESSON_TEST);
  shipped = shipLesson(root, 'incident-12', '0.1.0') as { problems: string[] };
  assert.deepEqual(shipped.problems, ['the lesson\'s test fails: run `node --test lessons/incident-12/lesson.test.ts` to see why, and fix the check']);
  assert.ok(existsSync(join(draftDir, 'lesson.ts')) && !existsSync(join(root, 'kit/lessons')), 'nothing moved');
  // Reviewed: it moves, with a row in the table, and the empty drafts folder goes.
  writeFileSync(join(draftDir, 'lesson.ts'), ENV_LESSON);
  assert.deepEqual(shipLesson(root, '12', '0.1.0'), { lesson: { id: 'incident-12', folder: '1/incident-12', url: 'https://example.com/issues/12', version: '0.1.0' } });
  assert.ok(existsSync(join(root, 'kit/lessons/1/incident-12/lesson.test.ts')) && !existsSync(join(root, 'lessons')));
  assert.deepEqual(readLessonTable(readFileSync(join(root, 'kit/lessons/README.md'), 'utf8')).map((row) => row.id), ['incident-12']);
  writeDraft(root, draftLesson(incidentOf('')));
  assert.match(String((shipLesson(root, '12', '0.1.0') as { problems: string[] }).problems), /kit\/lessons\/1\/incident-12 is already there/);
});

test('lessons: doctor runs each lesson as a note; a broken lesson is a note for itself alone; not now skips one', () => {
  const kit = makeModuleDir('yokoten-kit-');
  const ids = ['incident-1', 'incident-2', 'incident-3', 'incident-4', 'incident-5'];
  writeFileSync(join(kit, 'README.md'), ['| Lesson | Incident | Added in |', '|---|---|---|', ...ids.map((id) => `| ${id} | https://example.com/issues/1 | 0.1.0 |`), ''].join('\n'));
  const write = (id: string, text: string) => {
    mkdirSync(join(kit, id));
    writeFileSync(join(kit, id, 'lesson.ts'), text);
  };
  write('incident-1', ENV_LESSON);
  write('incident-2', "export function findProblems() { throw new Error('a bug in the lesson'); }\n");
  // incident-3 has no code.
  write('incident-4', ENV_LESSON);
  write('incident-5', 'export function findProblems() { return [{ what: 1 }]; }\n');
  const project = makeTempDir('yokoten-project-');
  writeFileSync(join(project, '.env'), 'KEY=1\n');
  const place = { dir: kit, codeDir: kit, codeFile: 'lesson.ts' };
  const checks = lessonChecks(project, { 'incident-4': 'we keep a sample .env' }, place);
  assert.deepEqual(checks.map(({ id, mark }) => `${id} ${mark}`), ['incident-1 note', 'incident-2 note', 'incident-3 note', 'incident-4 not now', 'incident-5 note']);
  assert.deepEqual(formatLessonChecks(checks), [
    '  note    lesson incident-1: a .env file is in the repo; remove it, and add it to .gitignore',
    '  note    lesson incident-2: can\'t run this lesson: a bug in the lesson; run `yokoten install` again; if it stays, report it in an issue',
    '  note    lesson incident-3: can\'t run this lesson: there is no lesson.ts; run `yokoten install` again; if it stays, report it in an issue',
    '  not now lesson incident-4: we keep a sample .env',
    '  note    lesson incident-5: can\'t run this lesson: a finding has no what, why or fix; run `yokoten install` again; if it stays, report it in an issue',
  ]);
  // The finding takes the lesson's id, whatever the lesson said.
  assert.deepEqual(checks[0].findings, [{ id: 'incident-1', what: 'a .env file is in the repo', why: 'it can hold a secret', fix: 'remove it, and add it to .gitignore' }]);
  // A clean project: ok. No table (a project copy of yokoten has no kit): no lessons.
  assert.deepEqual(lessonChecks(makeTempDir('yokoten-clean-'), {}, place).map(({ mark }) => mark), ['ok', 'note', 'note', 'ok', 'note']);
  assert.deepEqual(lessonChecks(project, {}, { ...place, dir: join(kit, 'none') }), []);
});

// #171: doctor finds each lesson by the table's folder: in a group, or flat as before groups.
test('lessons: doctor runs a lesson in a group and a flat one from an older table', () => {
  const kit = makeModuleDir('yokoten-kit-');
  writeFileSync(join(kit, 'README.md'), ['| Lesson | Folder | Incident | Added in |', '|---|---|---|---|', '| incident-1 | 2/1/incident-1 | https://example.com/issues/1 | 0.1.0 |', '| incident-2 | incident-2 | https://example.com/issues/2 | 0.1.0 |', ''].join('\n'));
  for (const folder of ['2/1/incident-1', 'incident-2']) {
    mkdirSync(join(kit, folder), { recursive: true });
    writeFileSync(join(kit, folder, 'lesson.ts'), ENV_LESSON);
  }
  const project = makeTempDir('yokoten-project-');
  writeFileSync(join(project, '.env'), 'KEY=1\n');
  const checks = lessonChecks(project, {}, { dir: kit, codeDir: kit, codeFile: 'lesson.ts' });
  assert.deepEqual(checks.map(({ id, mark }) => `${id} ${mark}`), ['incident-1 note', 'incident-2 note']);
});

// #172: the first time a clone runs a lesson, doctor says so once, even when it finds nothing.
test('lessons: a lesson not yet seen is new, with what it looks for; not now and no state give no new note', () => {
  const kit = makeModuleDir('yokoten-kit-');
  writeFileSync(join(kit, 'README.md'), ['| Lesson | Incident | Added in |', '|---|---|---|', ...['incident-1', 'incident-2', 'incident-3'].map((id) => `| ${id} | https://example.com/issues/1 | 0.1.0 |`), ''].join('\n'));
  for (const id of ['incident-1', 'incident-2', 'incident-3']) {
    mkdirSync(join(kit, id));
    writeFileSync(join(kit, id, 'lesson.ts'), ENV_LESSON);
  }
  const place = { dir: kit, codeDir: kit, codeFile: 'lesson.ts' };
  const clean = makeTempDir('yokoten-clean-');
  const checks = lessonChecks(clean, { 'incident-3': 'not for us' }, place, ['incident-2']);
  assert.deepEqual(checks.map(({ id, isNew }) => `${id} ${isNew === true}`), ['incident-1 true', 'incident-2 false', 'incident-3 false']);
  assert.deepEqual(formatLessonChecks(checks), [
    '  note    new lesson: incident-1 (a .env file is in the repo); doctor now runs it in this project',
    '  ok      lesson incident-1',
    '  ok      lesson incident-2',
    '  not now lesson incident-3: not for us',
  ]);
  // A new lesson that finds a problem: the new line, then the problem.
  writeFileSync(join(clean, '.env'), 'KEY=1\n');
  assert.deepEqual(formatLessonChecks(lessonChecks(clean, {}, place, ['incident-2', 'incident-3'])).slice(0, 2), [
    '  note    new lesson: incident-1 (a .env file is in the repo); doctor now runs it in this project',
    '  note    lesson incident-1: a .env file is in the repo; remove it, and add it to .gitignore',
  ]);
  // No state (outside a git repo): nothing is new.
  assert.ok(lessonChecks(clean, {}, place).every((check) => !check.isNew));
  // A lesson that can't run is not new and is not saved as seen; once it is fixed, the note shows once.
  const broken = makeModuleDir('yokoten-broken-');
  mkdirSync(join(broken, 'incident-1'));
  writeFileSync(join(broken, 'incident-1', 'lesson.ts'), "export function findProblems() { throw new Error('a bug in the lesson'); }\n");
  const crashed = lessonChecks(clean, {}, { ...place, codeDir: broken }, ['incident-2', 'incident-3']);
  assert.ok(!formatLessonChecks(crashed).some((line) => line.includes('new lesson')), formatLessonChecks(crashed).join('\n'));
  assert.deepEqual(seenAfter(['incident-2', 'incident-3'], crashed), ['incident-2', 'incident-3']);
  const fixed = lessonChecks(clean, {}, place, seenAfter(['incident-2', 'incident-3'], crashed));
  assert.equal(formatLessonChecks(fixed)[0], '  note    new lesson: incident-1 (a .env file is in the repo); doctor now runs it in this project');
  assert.deepEqual(seenAfter(['incident-2', 'incident-3'], fixed), ['incident-2', 'incident-3', 'incident-1']);
});

test('lessons: the state file is in the git folder; missing, broken or unwritable state is empty, never an error', () => {
  const outside = makeTempDir('yokoten-outside-');
  assert.equal(findStateFile(outside), null, 'outside a git repo: no state');
  assert.deepEqual(readState(null), {});
  saveState(null, { seenLessons: ['incident-1'] });
  const repo = makeTempDir('yokoten-state-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const file = findStateFile(repo) as string;
  assert.equal(file, join(realpathSync(repo), '.git', 'yokoten', 'state.json'));
  assert.deepEqual(readState(file), {}, 'missing');
  for (const broken of ['{ not json', '[1]', 'null', '{"seenLessons": "incident-1"}']) {
    writeFileSync(join(repo, '.git', 'state-broken.json'), broken);
    assert.deepEqual(readState(join(repo, '.git', 'state-broken.json')), {}, broken);
  }
  // Keys this version does not know are kept; an id that is not text is dropped.
  saveState(file, { seenLessons: ['incident-1'], server: { ci: 'ok' } });
  assert.deepEqual(readState(file), { seenLessons: ['incident-1'], server: { ci: 'ok' } });
  writeFileSync(file, '{"seenLessons": ["incident-1", 7]}');
  assert.deepEqual(readState(file), { seenLessons: ['incident-1'] });
  // A path that can't be written: no throw.
  saveState(join(file, 'under-a-file.json'), { seenLessons: [] });
});

test('lessons: every lesson the kit ships has a row, its incident, no TODO, and a passing positive control', () => {
  const kitLessons = join(import.meta.dirname, '../..', KIT_LESSONS_DIR);
  const rows = readLessonTable(readFileSync(join(kitLessons, LESSONS_TABLE), 'utf8'));
  assert.ok(rows.length > 0, 'the kit ships at least one lesson');
  assert.deepEqual(findLessonFolders(kitLessons).sort(), rows.map((row) => row.folder).sort(), 'each folder has one row in the table, and each row a folder');
  for (const { id, folder, url, version } of rows) {
    assert.notEqual(folder, id, `${id}: the lesson is in a group (#171)`);
    assert.match(url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/, `${id}: the incident is an issue URL`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `${id}: the version is x.y.z`);
    const code = readFileSync(join(kitLessons, folder, 'lesson.ts'), 'utf8');
    const test = readFileSync(join(kitLessons, folder, 'lesson.test.ts'), 'utf8');
    assert.ok(code.includes(`// ${url}\n`), `${id}: lesson.ts names its incident`);
    assert.ok(!`${code}${test}`.includes('TODO(reviewer)'), `${id}: no TODO(reviewer) is left`);
    assert.ok(/known-bad case/.test(test), `${id}: lesson.test.ts has a positive control`);
    // Without NODE_TEST_CONTEXT, or the child reports to this run and exits 0 whatever happens.
    // TMPDIR: whatever the lesson's test leaves goes away with this test (#400).
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: makeTempDir('yokoten-lesson-tmp-') };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', join(kitLessons, folder, 'lesson.test.ts')], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, `${id}: its test passes\n${run.stdout}`);
  }
});

// #392: a note for the yokoten repo leaves the project with nothing that points at it.
const placeIn = (root: string | null, more: Partial<NotePlace> = {}): NotePlace => ({ root, projects: [], owners: [], hosts: [], marks: [], cwd: root ?? tmpdir(), ...more });
const kindsOf = (result: ReturnType<typeof redactNote>) => ('problems' in result ? result.problems.map((problem) => problem.id) : []);

test('upstream: a note hides the project, home and owner, and refuses a secret or what is left', () => {
  const home = makeTempDir('yokoten-upstream-');
  const env = { HOME: home };
  const root = join(home, 'work', 'acme-app');
  mkdirSync(root, { recursive: true });
  const place = placeIn(root, { projects: ['acme-app'], owners: ['Jane Roe'], hosts: ['git.corp.test'], marks: ['secret-city'] });
  const note = redactNote(`In ${root}/src/x.ts the hook\nfor Acme-App broke; Jane Roe saw it in ${join(home, 'logs')} and ${root}2, near Secret-City, on git.corp.test`, place, env);
  // `${root}2` is another folder: the path is not hidden as a prefix of it.
  assert.deepEqual(note, { text: 'In <project>/src/x.ts the hook for <project> broke; <owner> saw it in ~/logs and ~/work/acme-app2, near <mark>, on <host>' });
  // A secret is refused, not hidden; the finding names its kind, never the value.
  const token = `ghp_${'a'.repeat(36)}`;
  const refused = redactNote(`the token ${token} leaked`, place, env);
  assert.ok('problems' in refused && refused.problems.every((problem) => problem.id === 'secret' && !JSON.stringify(problem).includes(token)));
  // An IP address is not hidden by redact, so the scan refuses it.
  assert.deepEqual(kindsOf(redactNote(`the server ${[10, 1, 2, 3].join('.')} was down`, place, env)), ['ip']);
  // A mark inside a longer word is not a whole word for redact, but the scan still catches it.
  assert.deepEqual(kindsOf(redactNote('at secret-cityhall', place, env)), ['private-mark']);
  // An email address is kept as <email>, not refused.
  assert.deepEqual(redactNote(`mail jane${'@'}corp-mail.com`, place, env), { text: 'mail <email>' });
  // No repo: the home folder is still hidden.
  assert.deepEqual(redactNote(`see ${home}/a.txt`, placeIn(null), env), { text: 'see ~/a.txt' });
  rmSync(home, { recursive: true, force: true });
});

test('upstream: a symlink into the project, a relative path and a symlink into home are hidden too', () => {
  const base = realpathSync(makeTempDir('yokoten-upstream-'));
  const home = join(base, 'home');
  const root = join(base, 'code', 'acme-app');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(home, 'docs'), { recursive: true });
  symlinkSync(root, join(base, 'shortcut'));
  symlinkSync(join(home, 'docs'), join(base, 'docs-link'));
  const env = { HOME: home };
  const place = placeIn(root, { projects: ['acme-app'] });
  assert.deepEqual(redactNote(`broke at ${base}/shortcut/src/a.ts:12.`, place, env), { text: 'broke at <project>/src/a.ts:12.' });
  assert.deepEqual(redactNote('see ./src/new.ts and ../acme-app/src', place, env), { text: 'see <project>/src/new.ts and <project>/src' });
  assert.deepEqual(redactNote(`read ${base}/docs-link/plan.md`, place, env), { text: 'read ~/docs/plan.md' });
  // A path elsewhere stays, and a URL is not a path.
  assert.deepEqual(redactNote('ran /usr/bin/env from https://example.com/a/b', place, env), { text: 'ran /usr/bin/env from https://example.com/a/b' });
  rmSync(base, { recursive: true, force: true });
});

test('upstream: every spelling of the project name is hidden; a name under three letters is not', () => {
  assert.deepEqual(nameVariants('secret-proj').sort(), ['secret proj', 'secret-proj', 'secret_proj', 'secretproj']);
  assert.deepEqual(nameVariants('SecretProj').sort(), ['secret proj', 'secret-proj', 'secret_proj', 'secretproj']);
  assert.deepEqual(nameVariants('ab'), []);
  const env = { HOME: tmpdir() };
  const place = placeIn(null, { projects: ['secret-proj', 'ab'] });
  assert.deepEqual(redactNote('secret-proj, secret_proj, SecretProj, secretproj, SECRET PROJ and ab', place, env), { text: '<project>, <project>, <project>, <project>, <project> and ab' });
  assert.deepEqual(redactNote('secret-projector', place, env), { text: 'secret-projector' }, 'a whole name only');
});

test('upstream: a note refuses known secret shapes, by kind and never by value', () => {
  const env = { HOME: tmpdir() };
  const place = placeIn(null);
  const cases: [string, string][] = [
    [`https://deploy:${'hunter2pass'}@git.example.com/r`, 'a password in a URL'],
    [`password=${'correct-horse'}`, 'password='],
    [`api_key: ${'abcd1234efgh'}`, 'password='],
    [`TOKEN="${'s3cr3t-value'}"`, 'password='],
    [`${'eyJ'}hbGciOiJIUzI1NiJ9.${'eyJ'}zdWIiOiIxIn0.c2lnbmF0dXJl`, 'JSON web token'],
    [`${'sk-proj-'}abc123def456`, 'OpenAI key'],
  ];
  for (const [text, kind] of cases) {
    const result = redactNote(`it printed ${text}`, place, env);
    assert.ok('problems' in result, text);
    assert.ok(result.problems.some((problem) => problem.id === 'secret' && problem.what.includes(kind)), `${text}: ${JSON.stringify(result)}`);
    assert.ok(!JSON.stringify(result).includes(text.slice(-6)), `${text}: the value is never in the finding`);
  }
  // Ordinary words pass: a short value, a URL with no password, a word that only starts like one.
  for (const text of ['the token is short', 'token: abc', 'see https://example.com/a', 'passwords were fine']) assert.ok('text' in redactNote(text, place, env), text);
});

test('upstream: the inbox writes, counts, lists and removes notes, from an empty home', () => {
  const home = makeTempDir('yokoten-upstream-');
  const env = { HOME: home };
  assert.equal(upstreamDir(env), join(home, '.config', 'yokoten', 'upstream'));
  assert.equal(countNotes(env), 0, 'no inbox yet: none');
  assert.deepEqual(listNotes(env), []);
  assert.equal(waitingLine(0), null);
  const first = writeNote(env, { part: 'hook', what: 'one', fix: 'two' }, new Date('2026-10-20T12:00:00Z'));
  assert.match(first.id, /^20261020-120000-[0-9a-f]{4}$/);
  const inbox = join(home, '.config', 'yokoten', 'upstream');
  assert.equal(readFileSync(join(inbox, `${first.id}.md`), 'utf8'), 'when: 2026-10-20T12:00:00Z\npart: hook\nwhat: one\nfix: two\n');
  const second = writeNote(env, { part: 'unknown', what: 'three' }, new Date('2026-10-20T13:00:00Z'));
  writeFileSync(join(inbox, 'README.txt'), 'not a note\n');
  assert.equal(countNotes(env), 2, 'only note files count');
  assert.equal(waitingLine(2), '2 lessons from other projects wait to become issues: yokoten learn --upstream --list');
  assert.equal(waitingLine(1), '1 lesson from other projects waits to become an issue: yokoten learn --upstream --list');
  assert.deepEqual(listNotes(env), [first, second]);
  assert.equal(removeNote(env, '../private-marks'), false, 'an id is never a path');
  // A folder with a note's name is not a note: no crash, nothing removed.
  mkdirSync(join(inbox, '20261020-140000-dddd.md'));
  assert.equal(removeNote(env, '20261020-140000-dddd'), false);
  assert.ok(existsSync(join(inbox, '20261020-140000-dddd.md')));
  assert.equal(removeNote(env, first.id), true);
  assert.equal(removeNote(env, first.id), false);
  assert.deepEqual(listNotes(env).map((note) => note.id), [second.id]);
  rmSync(home, { recursive: true, force: true });
});

test('upstream: with no home folder as a full path, there is no inbox and nothing is written', () => {
  assert.equal(homeOf({ HOME: '' }), null);
  assert.equal(homeOf({}), null, 'no fallback to the system home: only the CLI entry has one (#356)');
  assert.equal(homeOf({ HOME: 'relative/home' }), null, 'a relative HOME is no home');
  assert.equal(homeOf({ HOME: '/h' }), '/h');
  assert.equal(upstreamDir({}), null);
  // marksFile throws rather than name a relative file; loadMarks then reads none.
  assert.equal(marksFile({ HOME: '', YOKOTEN_PRIVATE_MARKS: '/m' }), '/m');
});

test('upstream: every owner segment of a remote URL is an owner; the last one is the project', () => {
  assert.deepEqual(originParts('https://gitlab.example.com/group/sub/acme-app.git'), { owners: ['group', 'sub'], project: 'acme-app' });
  assert.deepEqual(originParts(`git${'@'}github.com:octo/acme-app.git`), { owners: ['octo'], project: 'acme-app' });
  assert.deepEqual(originParts('ssh://git@host.example.test:22/team/acme-app'), { owners: ['team'], project: 'acme-app' });
  assert.deepEqual(originParts(''), { owners: [], project: null });
  assert.deepEqual(originParts('/local/path'), { owners: [], project: null });
});
