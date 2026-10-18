// Shipped lessons (#147), the second half of the loop that `learn.ts` starts. A reviewed
// lesson moves from `lessons/<id>/` into the kit, with a row in the kit's lessons table.
// `doctor` then runs each lesson's check in every project that uses the kit.
//
// A lesson is code from the kit that runs in another person's repo. So it reads files only,
// and a lesson that throws is reported, never fatal: a lesson gives notes, and a note never
// fails doctor.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Finding } from '../rules/message.ts';
import { LESSONS_DIR } from './learn.ts';

/** Where shipped lessons live in yokoten, from the repo root: one folder per lesson. */
export const KIT_LESSONS_DIR = 'kit/lessons';

/** The lessons table, in the kit's lessons folder. Only a lesson in the table ships. */
export const LESSONS_TABLE = 'README.md';

/** A row of the lessons table. */
export interface ShippedLesson {
  id: string;
  /** The incident issue the lesson came from. */
  url: string;
  /** The version in package.json when the lesson shipped. */
  version: string;
}

/** What a lesson's id looks like: `incident-<n>` from `learn`, or any lower-case words. */
const LESSON_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TABLE_ROW = /^\|\s*([^|\s]+)\s*\|\s*([^|\s]+)\s*\|\s*([^|\s]+)\s*\|\s*$/;
const TABLE_HEAD = ['| Lesson | Incident | Added in |', '|---|---|---|'];
const TABLE_START = [
  '# Lessons',
  '',
  'Each folder here is a lesson from a real incident: a check (`lesson.ts`) and its test',
  '(`lesson.test.ts`). `yokoten doctor` runs every lesson in this table against the project,',
  'and reports what a lesson finds as a note. A note never fails doctor. To stop one, add',
  'its id to "notNow" in yokoten.json, with the reason.',
  '',
  '`yokoten learn --ship <id>` adds a lesson here. "Added in" is the version in',
  'package.json when the lesson shipped.',
  '',
  ...TABLE_HEAD,
];

/** The rows of the lessons table. The header, the line under it, and any other text are left out. */
export function readLessonTable(text: string): ShippedLesson[] {
  const rows: ShippedLesson[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = TABLE_ROW.exec(line.trim());
    if (!row || !LESSON_ID.test(row[1])) continue;
    rows.push({ id: row[1], url: row[2], version: row[3] });
  }
  return rows;
}

/** A row of the lessons table as Markdown. */
export const formatLessonRow = (lesson: ShippedLesson): string => `| ${lesson.id} | ${lesson.url} | ${lesson.version} |`;

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
 * Move a reviewed lesson from `lessons/<id>/` into `kit/lessons/<id>/`, and add its row to the
 * lessons table. It refuses, and moves nothing, when a TODO(reviewer) is left or the lesson's
 * test fails: an unreviewed check never ships. `reference` is the id or the issue number.
 */
export function shipLesson(root: string, reference: string, version: string): { lesson: ShippedLesson } | { problems: string[] } {
  const id = /^\d+$/.test(reference) ? `incident-${reference}` : reference;
  if (!LESSON_ID.test(id)) return { problems: [`${reference} is not a lesson id: give its number or its id, for example incident-138`] };
  if (!existsSync(join(root, 'kit'))) return { problems: ['there is no kit/ here: a lesson ships in a copy of yokoten, where kit/ is what other projects get'] };
  const draftDir = `${LESSONS_DIR}/${id}`;
  const shippedDir = `${KIT_LESSONS_DIR}/${id}`;
  if (existsSync(join(root, shippedDir))) return { problems: [`${shippedDir} is already there: give the lesson a new id`] };
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

  const lesson: ShippedLesson = { id, url: url as string, version };
  const tablePath = join(root, KIT_LESSONS_DIR, LESSONS_TABLE);
  const table = readText(tablePath) ?? `${TABLE_START.join('\n')}\n`;
  mkdirSync(join(root, KIT_LESSONS_DIR), { recursive: true });
  renameSync(join(root, draftDir), join(root, shippedDir));
  // The drafts folder goes when its last draft has shipped.
  if (!readdirSync(join(root, LESSONS_DIR)).length) rmdirSync(join(root, LESSONS_DIR));
  writeFileSync(tablePath, `${table.trimEnd()}\n${formatLessonRow(lesson)}\n`);
  return { lesson };
}

/** Where `runLessons` finds the lessons: the table's folder, and the code with its file name. */
export interface LessonPlace {
  /** The folder with the lessons table. */
  dir: string;
  /** The folder with a folder of code per lesson; the npm package runs built `.js` (record 0008). */
  codeDir: string;
  /** `lesson.ts`, or `lesson.js` in the npm package. */
  codeFile: string;
}

/** What one lesson found in a project, or why it could not run. */
export interface LessonRun {
  id: string;
  findings: Finding[];
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
  for (const { id } of listLessons(place)) {
    if (skip(id)) continue;
    const path = join(place.codeDir, id, place.codeFile);
    try {
      if (!existsSync(path)) throw new Error(`there is no ${place.codeFile}`);
      const module = load(path) as { findProblems?: unknown };
      if (typeof module.findProblems !== 'function') throw new Error('it has no findProblems function');
      const found: unknown = module.findProblems(root);
      if (!Array.isArray(found)) throw new Error('findProblems did not give a list');
      const findings = found.map((item): Finding => {
        const { what, why, fix } = (item ?? {}) as Partial<Finding>;
        if (typeof what !== 'string' || typeof why !== 'string' || typeof fix !== 'string') throw new Error('a finding has no what, why or fix');
        return { id, what, why, fix };
      });
      runs.push({ id, findings });
    } catch (err) {
      runs.push({ id, findings: [], error: String((err as Error)?.message ?? err).split('\n')[0].split(place.codeDir).join(KIT_LESSONS_DIR) });
    }
  }
  return runs;
}
