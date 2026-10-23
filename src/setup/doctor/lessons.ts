import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Env } from '../../rules/config.ts';
import { type Finding } from '../../rules/message.ts';
import { type LessonPlace, listLessons, runLessons } from '../../run/learn.ts';
import { HOME_DIR, KIT } from '../files.ts';
import { withGitReads } from '../init.ts';
import { assumeEmptyFolder } from '../../run/check/inspect.ts';
import { road, ROAD, type ServerRead, stepText } from '../road.ts';
import { coreRulesCheck } from './checks.ts';

/** A server with every setting off, no label and only a closed milestone: no server step on the road may pass it (#7, #10). */
const SERVER_CONTROL: ServerRead = {
  repo: 'octo/demo',
  defaultBranch: 'main',
  isPrivate: false,
  actionsCanApprove: false,
  mergeMethods: ['merge', 'squash'],
  deleteBranchOnMerge: false,
  branch: { pullRequest: false, codeOwnerReview: false, mergeMethods: [], requiredChecks: [], noForcePush: false, noDeletion: false, approvals: 0 },
  tags: false,
  security: { secretScanning: false, pushProtection: false, privateReporting: false, dependabotAlerts: false },
  forgotten: [],
  planning: { repo: 'octo/demo', labels: [], milestones: [{ title: 'v0.1', open: false }] },
};

/**
 * In a folder with nothing but a todo file, a home with nothing in it, and a server with
 * every setting off, no step on the road may be done. Git is not asked: the folder is in
 * no repo and has no config, so no setting of this machine counts and no git starts (#453).
 */
export function roadControl(): string[] {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'yokoten-control-'));
    writeFileSync(join(dir, 'TODO.md'), '- an item\n');
    const folder = dir;
    return withGitReads(() => {
      const env = { HOME: folder };
      assumeEmptyFolder(folder, env);
      return road(folder, env, ROAD, SERVER_CONTROL)
        .filter((r) => r.found === true)
        .map((r) => `the ${r.step.key} step`);
    });
  } catch {
    return []; // no temp folder to test in; the other checks still run
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The kit's lessons (#147): the .ts in the repo and in an installed copy, the built .js in
 * the npm package, where Node does not strip types (record 0008).
 */
export function kitLessons(): LessonPlace {
  const isBuilt = fileURLToPath(import.meta.url).endsWith('.js');
  const dir = join(KIT, 'lessons');
  return isBuilt ? { dir, codeDir: join(HOME_DIR, 'dist', 'kit', 'lessons'), codeFile: 'lesson.js' } : { dir, codeDir: dir, codeFile: 'lesson.ts' };
}

/** One lesson as doctor reports it. A lesson gives notes only: it never fails doctor. */
export interface LessonCheck {
  id: string;
  mark: 'ok' | 'note' | 'not now';
  findings: Finding[];
  reason?: string;
  /** The problem the lesson looks for, from its exported `lesson`. */
  what?: string;
  /** True the first time this clone's full doctor runs the lesson (#172). */
  isNew?: boolean;
}

/**
 * Each lesson the kit ships, run against this project: read only, offline and fast. A
 * lesson in yokoten.json "notNow" does not run. A lesson that can't run is a note too.
 * With `seen`, the lessons this clone already ran: a lesson that runs and is not in it is new.
 * A lesson that can't run is not new, so the note waits for the first run that works.
 */
export function lessonChecks(root: string, notNow: Record<string, string>, place: LessonPlace = kitLessons(), seen: string[] | null = null): LessonCheck[] {
  const isSkipped = (id: string) => Object.hasOwn(notNow, id);
  const runs = new Map(runLessons(root, place, isSkipped).map((run) => [run.id, run]));
  return listLessons(place).map(({ id }): LessonCheck => {
    const run = runs.get(id);
    // "Not now" silences the new-lesson note too.
    if (!run) return { id, mark: 'not now', findings: [], reason: notNow[id] };
    const known = { ...(run.what === undefined ? {} : { what: run.what }), ...(seen && !seen.includes(id) && !run.error ? { isNew: true } : {}) };
    if (run.error) return { id, mark: 'note', findings: [{ id, what: `can't run this lesson: ${run.error}`, why: 'a lesson from the kit could not check this project', fix: 'run `yokoten install` again; if it stays, report it in an issue' }], ...known };
    return { id, mark: run.findings.length ? 'note' : 'ok', findings: run.findings, ...known };
  });
}

/**
 * The lessons as lines of the project part: one per lesson, or one per place a lesson found.
 * A new lesson gets one line more before them, even when it finds no problem.
 */
export function formatLessonChecks(lessons: LessonCheck[]): string[] {
  return lessons.flatMap(({ id, mark, findings, reason, what, isNew }) => {
    const intro = isNew ? [`  note    new lesson: ${id}${what ? ` (${what})` : ''}; doctor now runs it in this project`] : [];
    if (mark === 'not now') return [`  not now lesson ${id}: ${reason}`];
    if (mark === 'ok') return [...intro, `  ok      lesson ${id}`];
    return [...intro, ...findings.map((f) => `  note    lesson ${id}: ${stepText(f)}`)];
  });
}

// What full doctor keeps between runs, per clone (record 0004). The file is in the git
// folder, so it is never committed. A missing or broken file is an empty state: losing it
// costs one repeated note, never a failed doctor.

/** The lessons seen after this run: the ones seen before, and the new ones that ran. */
export function seenAfter(seen: string[], lessons: LessonCheck[]): string[] {
  return [...seen, ...lessons.filter((lesson) => lesson.isNew).map((lesson) => lesson.id)];
}

/** Where the state file is, in the git folder that all worktrees of a clone share. */
export const STATE_FILE = 'yokoten/state.json';

/** What the state file holds. Keys this version does not know are kept as they are. */
export interface DoctorState {
  /** The ids of the kit's lessons that full doctor already ran in this clone (#172). */
  seenLessons?: string[];
  /** The ids of the kit's lessons a session start already ran in this clone (#339). */
  sessionLessons?: string[];
  /** The kit workflows with the project's changes that full doctor already noted, as "file kit-hash" (#456). */
  seenWorkflows?: string[];
  [key: string]: unknown;
}

/** The state file of the clone at `root`, or null outside a git repo. */
export function findStateFile(root: string, env: Env): string | null {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return gitDir ? join(gitDir, STATE_FILE) : null;
  } catch {
    return null;
  }
}

/** The saved state, or an empty one when the file is missing or broken. */
export function readState(file: string | null): DoctorState {
  if (!file) return {};
  try {
    const state: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
    const { seenLessons, sessionLessons, seenWorkflows, ...rest } = state as DoctorState;
    const ids = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : null);
    const seen = ids(seenLessons);
    const ran = ids(sessionLessons);
    const workflows = ids(seenWorkflows);
    return { ...rest, ...(seen ? { seenLessons: seen } : {}), ...(ran ? { sessionLessons: ran } : {}), ...(workflows ? { seenWorkflows: workflows } : {}) };
  } catch {
    return {};
  }
}

/** Save the state. A file that can't be written is left as it is: state is never worth a failed doctor. */
export function saveState(file: string | null, state: DoctorState): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // a read-only git folder: the new-lesson note shows again next time
  }
}

/**
 * What a session start hears about the kit's lessons (#339): one line, the first time a
 * lesson new to this clone finds something here, and nothing after. A lesson is new while
 * full doctor has not seen it (#172) and no session start has run it. Each new lesson runs
 * at one session start per clone only, so later starts pay nothing for it. With no state
 * file there is no "new", so nothing runs. `doctor` names the command that shows it.
 */
export function sessionLessonNote(root: string, notNow: Record<string, string>, stateFile: string | null, doctorCommand: string, place: LessonPlace = kitLessons()): { line: string | null; findings: Finding[] } {
  const none = { line: null, findings: [] };
  if (!stateFile) return none;
  const state = readState(stateFile);
  const ran = state.sessionLessons ?? [];
  const known = new Set([...(state.seenLessons ?? []), ...ran]);
  const fresh = new Set(listLessons(place).map(({ id }) => id).filter((id) => !known.has(id) && !Object.hasOwn(notNow, id)));
  if (!fresh.size) return none;
  // A lesson that can't run stays new: full doctor reports why, and a later start tries again.
  const runs = runLessons(root, place, (id) => !fresh.has(id)).filter((run) => !run.error);
  if (!runs.length) return none;
  saveState(stateFile, { ...state, sessionLessons: [...ran, ...runs.map((run) => run.id)] });
  const found = runs.filter((run) => run.findings.length);
  const findings = found.flatMap((run) => run.findings);
  if (found.length === 1) {
    const [{ what, findings: [first] }] = found;
    return { line: `yokoten: a new lesson learned in another project found a problem here: ${what ?? first.what}. Run ${doctorCommand} to see where.`, findings };
  }
  if (found.length > 1) return { line: `yokoten: ${found.length} new lessons learned in other projects found problems here. Run ${doctorCommand} to see them.`, findings };
  return none;
}

/**
 * In a temp project, against the real kit: core rules edited by hand are MISSING, and
 * core rules from a newer kit are the `newer` note, never "ok" and never MISSING (#170).
 * `check` is a parameter so a test can hand in a broken one.
 */
export function coreRulesControl(check: typeof coreRulesCheck = coreRulesCheck): string[] {
  if (!existsSync(join(KIT, 'project', 'AGENTS.md'))) return []; // the copy in .yokoten/ has no kit to compare with
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'yokoten-control-'));
    const failed: string[] = [];
    writeFileSync(join(dir, 'AGENTS.md'), '# rules edited by hand\n\n## This project\n');
    if (check(dir)?.mark !== 'MISSING') failed.push('core rules check (edited by hand)');
    writeFileSync(join(dir, 'AGENTS.md'), '<!-- yokoten kit 9999.0.0 -->\n# rules from a newer kit\n\n## This project\n');
    const newer = check(dir);
    if (newer?.mark !== 'note' || !newer.finding.what.includes('newer than this yokoten')) failed.push('core rules check (newer kit)');
    return failed;
  } catch {
    return []; // no temp folder to test in; the other checks still run
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
