// The private-marks file, one topic of the privacy rule (#627): where it is, and the lines
// it holds. The words are matched in text by privacy.ts, which reads them through here.

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Env } from '../config.ts';
import { homeIn, homeOf, realHomeRead } from './home.ts';

/**
 * The private-marks file yokoten writes, and the one the machine allow file sits beside: the
 * default ~/.config/yokoten/private-marks. With no home folder it is YOKOTEN_PRIVATE_MARKS, and
 * with neither it throws NO_HOME. The setting never takes the default's place (#656).
 */
export function marksFile(env: Env): string {
  if (!homeOf(env) && env.YOKOTEN_PRIVATE_MARKS) return env.YOKOTEN_PRIVATE_MARKS;
  return join(homeIn(env), '.config', 'yokoten', 'private-marks');
}

/**
 * Every private-marks file the check reads (#656): the default one, when there is a home
 * folder, and the one YOKOTEN_PRIVATE_MARKS names. The setting adds marks; it never removes
 * the default's. Empty with neither.
 */
export function marksFiles(env: Env): string[] {
  const files = homeOf(env) ? [join(homeIn(env), '.config', 'yokoten', 'private-marks')] : [];
  const extra = env.YOKOTEN_PRIVATE_MARKS;
  if (extra && !files.some((file) => resolve(file) === resolve(extra))) files.push(extra);
  return files;
}

/**
 * `env` with only the file yokoten writes to (`marksFile`) left to read (#656). Install and
 * `yokoten marks add` ask it whether a mark is there already: one only in the setting's file
 * still goes into the default file.
 */
export function writtenMarksOnly(env: Env): Env {
  return homeOf(env) ? { ...env, YOKOTEN_PRIVATE_MARKS: '' } : env;
}

/** Said when the real home has a marks file the check cannot read (#739). No path: a home path can name a person. */
const REAL_MARKS_UNREADABLE = 'the private-marks file in the real home folder cannot be read, so the check stops';

/** Whether `file` is the default marks file under `$HOME`, not the one `YOKOTEN_PRIVATE_MARKS` adds. */
function isDefaultMarks(env: Env, file: string): boolean {
  const home = homeOf(env);
  return home !== null && resolve(file) === resolve(join(home, '.config', 'yokoten', 'private-marks'));
}

/**
 * The marks text in the real home, from the password database (#739). Used when `$HOME`
 * has no marks of its own. A missing file there is empty. A file that cannot be read stops
 * the check, so a changed `$HOME` cannot hide it. A file that can be read is returned, so
 * those marks are used. The same folder as `$HOME` is not read again.
 */
function realMarksText(env: Env): string {
  const home = homeOf(env);
  const real = realHomeRead()();
  if (!real || !isAbsolute(real)) return '';
  // No `$HOME` still has a real home. The same folder is not read again.
  if (home && resolve(real) === resolve(home)) return '';
  try {
    return readFileSync(join(real, '.config', 'yokoten', 'private-marks'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(REAL_MARKS_UNREADABLE);
  }
}

/** Whether `text` holds a mark: a line that is not blank and not a comment. */
function hasMarkLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
}

/** The text of one marks file. A missing file is empty. Any other error throws, so the check fails closed. */
function readMarksFile(env: Env, file: string): string {
  try {
    const text = readFileSync(file, 'utf8');
    // An empty stand-in under a changed `$HOME` is still no marks. Use the real file.
    if (isDefaultMarks(env, file) && !hasMarkLine(text)) {
      const real = realMarksText(env);
      if (hasMarkLine(real)) return real;
    }
    return text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (isDefaultMarks(env, file)) return realMarksText(env);
    return '';
  }
}

/**
 * The text of every marks file, real home included (#739). With no `$HOME`, the real home
 * is the only default. A header in one file never names a line in the next: each text is
 * separate.
 */
export function marksTexts(env: Env): string[] {
  const texts = marksFiles(env).map((file) => readMarksFile(env, file));
  if (!homeOf(env)) {
    const real = realMarksText(env);
    if (hasMarkLine(real)) texts.unshift(real);
  }
  return texts;
}

/** The text of every private-marks file, one after the other. A missing file is empty; any other error throws, so the check fails closed. */
function readMarksText(env: Env): string {
  return marksTexts(env)
    .map((text) => (text === '' || text.endsWith('\n') ? text : `${text}\n`))
    .join('');
}

/** The owner's marks from every marks file, lowercased, each once. An empty list when no file is there. */
export function loadMarks(env: Env): string[] {
  const marks = readMarksText(env)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.toLowerCase());
  return [...new Set(marks)];
}
