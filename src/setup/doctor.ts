// `yokoten doctor`: a guide along the road (record 0004), and a check that this machine
// still runs the practices.
//
// Copying a setup once is not enough; it drifts. So doctor runs at the start of every
// session (`--session`, via the hook install adds). A beginner can't take in a list of
// everything missing, so a session hears three lines: the stage, the one next step, and
// why. Full `doctor` shows the whole map. A project that decided against a step says so
// in yokoten.json "notNow", and doctor stops asking.
//
// Doctor first checks itself: it feeds each check a known-bad input and expects a catch.
// A check that passes everything looks the same as a healthy project, so this comes first.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCommand, checkEdit } from '../rules/guards.ts';
import { type Config, DEFAULTS, type Env } from '../rules/config.ts';
import { checkBuildOutput, checkLayout } from '../rules/layout.ts';
import { type Finding, finding, formatFinding, type RuleId } from '../rules/message.ts';
import { loadMarks, notUtc, POSITIVE_CONTROL, scanText } from '../rules/privacy.ts';
import { SECRET_CONTROL } from '../rules/secrets.ts';
import { check } from '../run/check.ts';
import { type LessonPlace, listLessons, runLessons } from '../run/learn.ts';
import { hasPlugin, hasSessionDoctor } from '../agents/claude-code.ts';
import * as codex from '../agents/codex.ts';
import * as gemini from '../agents/gemini.ts';
import { type Gh, readServer, repoOf, type ServerSettings, type Unread } from '../host/github.ts';
import { HOME_DIR, KIT, runtimeVersion, VERSION } from './files.ts';
import { compareCoreRules, readCoreRules, summarizeUpdate } from './init.ts';
import { paths } from './install.ts';
import { type Mark, road, ROAD, ROAD_SERVER_IDS, type ServerCheck, serverChecks, type ServerRead, STAGES, stepFinding, stepText, walk } from './road.ts';

/** One check outside the road: its name in the report, whether it is in place, and the finding when it is not. */
interface Practice {
  name: string;
  ok: boolean;
  finding: Finding;
}

const practice = (name: string, id: RuleId, ok: boolean, what: string, fix: string): Practice => ({ name, ok, finding: finding(id, what, fix) });

/** The checks that must catch a known-bad input. Returns the names of any that did not. */
export function selfTest(): string[] {
  const failed: string[] = [];
  if (!checkCommand('git push origin --tags', { env: {} })) failed.push('release guard');
  if (!checkCommand('git commit --no-verify -m x', { env: {} })) failed.push('skip-check guard');
  if (!checkEdit('test/a.test.ts', { config: DEFAULTS, env: { YOKOTEN_FIX_TASK: '1' } })) failed.push('test guard');
  if (!checkEdit('AGENTS.md', { config: DEFAULTS, env: { YOKOTEN_ROLE: 'worker' } })) failed.push('lead-only guard');
  if (scanText(POSITIVE_CONTROL, { file: 'control' }).length < 2) failed.push('privacy check');
  if (scanText(SECRET_CONTROL, { file: 'control' }).length < 2) failed.push('secret check');
  if (!notUtc('A <a@example.com> 1760745600 +0700') || notUtc('A <a@example.com> 1760745600 +0000')) failed.push('time zone check');
  if (checkLayout(Array.from({ length: 8 }, (_, i) => `d/${i}`), DEFAULTS).length !== 1) failed.push('layout check');
  if (checkBuildOutput([{ path: 'dist/a.js', binary: false }, { path: 'a.bin', binary: true }], DEFAULTS).length !== 2) failed.push('build output check');
  failed.push(...roadControl());
  const kit = '# rules\n\n## This project\n';
  if (compareCoreRules('# old rules\n\n## This project\n', kit).state !== 'behind' || compareCoreRules('# rules\n', kit).state !== "can't compare") failed.push('core rules check');
  return failed;
}

/**
 * The other agents' tool-call hooks. Reported, but not a missing practice yet: no real
 * Codex or Gemini CLI run has been seen to block through them (#30), and a project that
 * uses neither should not fail doctor over them.
 */
export function agentHooks(root: string): Practice[] {
  return [
    practice('codex-hook', 'codex-hook', codex.hasProjectHook(root), 'no tool-call guard in .codex/hooks.json', '`yokoten init` adds it'),
    practice('gemini-hook', 'gemini-hook', gemini.hasProjectHook(root), 'no tool-call guard in .gemini/settings.json', '`yokoten init` adds it'),
  ];
}

/**
 * Machine checks: the user-level hooks, the runtime, the private marks. The skills are a
 * step on the road. The Claude Code plugin brings its own hooks and runtime, so with it
 * on, those two checks pass; an old runtime that install left is still reported.
 */
export function machineChecks(env: Env): Practice[] {
  const target = paths(env);
  const runtime = runtimeVersion(target.runtime);
  const plugin = hasPlugin(env);
  return [
    practice('session-doctor', 'session-doctor', plugin || hasSessionDoctor(env), 'sessions do not start with doctor', 'run `yokoten install`, or install the Claude Code plugin'),
    // 'runtime' in the text, as before; the id differs from the road's runtime step.
    practice('runtime', 'machine-runtime', runtime === VERSION || (plugin && runtime === null), runtime ? `the installed runtime is ${runtime}, this yokoten is ${VERSION}` : 'no runtime installed', 'run `yokoten install` from this copy of yokoten'),
    practice('private-marks', 'private-marks', loadMarks(env).length > 0, `${target.marks} is missing or empty`, 'add your name, city, domain and server names to it, one per line'),
  ];
}

/**
 * The core rules in AGENTS.md against the kit's (#120). No AGENTS.md gives null: the
 * road's rules step asks for it. A file doctor can't compare is a note, never a guess.
 */
export function coreRulesCheck(root: string): { mark: 'ok' | 'MISSING' | 'note'; finding: Finding } | null {
  const rules = readCoreRules(root);
  if (rules === null) return null;
  const fix = 'run `yokoten update` to see the change, then `yokoten update --write`; the "This project" part stays as it is';
  if (rules.state === 'same') return { mark: 'ok', finding: finding('core-rules', 'the core rules in AGENTS.md are up to date', fix) };
  if (rules.state === "can't compare") return { mark: 'note', finding: finding('core-rules', `can't compare the core rules in AGENTS.md: ${rules.why}`, rules.fix) };
  // A project written by a newer yokoten is not behind: this yokoten is (#141).
  if (rules.state === 'newer') {
    return { mark: 'note', finding: finding('core-rules', `the core rules in AGENTS.md come from yokoten ${rules.version}, newer than this yokoten ${VERSION}`, 'update yokoten itself, not the project: `npx yokoten@latest install`, the latest Claude Code plugin, or a pull in your clone') };
  }
  return { mark: 'MISSING', finding: finding('core-rules', `the core rules in AGENTS.md are behind yokoten ${VERSION}'s, or were edited by hand (${summarizeUpdate(rules)})`, fix) };
}

/** A server with every setting off, no label and only a closed milestone: no server step on the road may pass it (#7, #10). */
const SERVER_CONTROL: ServerRead = {
  repo: 'octo/demo',
  defaultBranch: 'main',
  mergeMethods: ['merge', 'squash'],
  deleteBranchOnMerge: false,
  branch: { pullRequest: false, codeOwnerReview: false, mergeMethods: [], requiredChecks: [], noForcePush: false, noDeletion: false },
  tags: false,
  security: { secretScanning: false, pushProtection: false, privateReporting: false, dependabotAlerts: false },
  forgotten: [],
  planning: { repo: 'octo/demo', labels: [], milestones: [{ title: 'v0.1', open: false }] },
};

/**
 * In a folder with nothing but a todo file, a home with nothing in it, and a server with
 * every setting off, no step on the road may be done.
 */
function roadControl(): string[] {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'yokoten-control-'));
    writeFileSync(join(dir, 'TODO.md'), '- an item\n');
    return road(dir, { HOME: dir }, ROAD, SERVER_CONTROL)
      .filter((r) => r.found === true)
      .map((r) => `the ${r.step.key} step`);
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
 */
export function lessonChecks(root: string, notNow: Record<string, string>, place: LessonPlace = kitLessons(), seen: string[] | null = null): LessonCheck[] {
  const isSkipped = (id: string) => Object.hasOwn(notNow, id);
  const runs = new Map(runLessons(root, place, isSkipped).map((run) => [run.id, run]));
  return listLessons(place).map(({ id }): LessonCheck => {
    const run = runs.get(id);
    // "Not now" silences the new-lesson note too.
    if (!run) return { id, mark: 'not now', findings: [], reason: notNow[id] };
    const known = { ...(run.what === undefined ? {} : { what: run.what }), ...(seen && !seen.includes(id) ? { isNew: true } : {}) };
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

/** Where the state file is, in the git folder that all worktrees of a clone share. */
export const STATE_FILE = 'yokoten/state.json';

/** What the state file holds. Keys this version does not know are kept as they are. */
export interface DoctorState {
  /** The ids of the kit's lessons that full doctor already ran in this clone (#172). */
  seenLessons?: string[];
  [key: string]: unknown;
}

/** The state file of the clone at `root`, or null outside a git repo. */
export function findStateFile(root: string): string | null {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
    const { seenLessons, ...rest } = state as DoctorState;
    return Array.isArray(seenLessons) ? { ...rest, seenLessons: seenLessons.filter((id) => typeof id === 'string') } : rest;
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

/** What doctor can't read on the server yet, and the owner sets once per repo. */
const OWNER_STEPS = ['the bot: a GitHub App (or collaborator) with write access and no Workflows permission'];

/** The settings to check by hand when doctor can't read the server. */
const BY_HAND = [
  'main: a ruleset with pull request required, the CI check required, code owner review, no force push, no deletion; squash merge only, delete branch on merge',
  'tags: a ruleset on v* so only you create, move or delete a release tag',
  'security: in Settings, Advanced Security, turn on private vulnerability reporting, secret scanning with push protection, and Dependabot alerts',
];

/** The server settings of the project's origin remote, or why they can't be read. */
function readOrigin(root: string, gh: Gh): ServerSettings | Unread {
  let remote = '';
  try {
    remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // no origin remote
  }
  const repo = repoOf(remote);
  return repo ? readServer(gh, repo) : { unread: 'the origin remote is not on a host yokoten knows (GitHub for now)', fix: 'add a GitHub origin remote, or check these settings by hand' };
}

/** What a session hears when the road is done, as far as yokoten can check. */
export const ROAD_DONE = 'yokoten: every step yokoten can check is done, or marked not now.';

/** The last of a session's three lines: what the agent does with the step. */
export const OFFER = 'Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).';

/**
 * Added to that line when doctor runs from the Claude Code plugin's hook: there is no
 * `yokoten` command on the PATH, so the agent runs the plugin's commands.
 */
export const PLUGIN_COMMANDS = 'In this session, yokoten runs as /yokoten:init, /yokoten:doctor and /yokoten:update.';

/** One step in the JSON map: its mark, its outside standard, and the reason for "not now". */
export interface StepState {
  id: string;
  stage: number;
  mark: Mark;
  standard?: string;
  reason?: string;
}

/**
 * What `doctor --json` prints. `findings` is everything to do, each with what, why and
 * fix; `notes` never fail doctor. A session (`--session`) gets the next step, the
 * private-marks finding and a behind `core-rules` finding only, as its lines do.
 */
export interface DoctorReport {
  version: string;
  ok: boolean;
  selfTest: { ok: boolean; failed: string[] };
  /** False outside a git repo: then there is no road to walk. */
  repo: boolean;
  stage: number | null;
  stages: string[];
  next: Finding | null;
  findings: Finding[];
  steps?: StepState[];
  notes?: Finding[];
  server?: { id: string; mark: ServerCheck['mark'] }[];
  /** The kit's lessons, run against this project (#147). Their findings are in `notes`. */
  lessons?: { id: string; mark: LessonCheck['mark']; reason?: string; isNew?: boolean }[];
}

/** The report, as text lines and as data, and whether everything is in place. */
export function doctor(
  root: string | null,
  { env, config, session = false, gh }: { env: Env; config: Config; session?: boolean; gh?: Gh },
): { ok: boolean; lines: string[]; report: DoctorReport } {
  const lines: string[] = [];
  const failed = selfTest();
  const findings: Finding[] = [];
  if (failed.length) {
    lines.push(`yokoten is BROKEN: ${failed.join(', ')} let a known-bad input through. Do not trust any check until this is fixed.`);
    findings.push(finding('self-test', `${failed.join(', ')} let a known-bad input through`, 'do not trust any check until this is fixed; run `yokoten install` again, or report it in an issue'));
  }
  const base = { version: VERSION, selfTest: { ok: !failed.length, failed }, stages: STAGES };
  if (!root) return { ok: !failed.length, lines, report: { ...base, ok: !failed.length, repo: false, stage: null, next: null, findings } };

  // Read only, and only in full doctor: a session never calls the network (record 0004).
  const server: ServerRead = session ? undefined : gh ? readOrigin(root, gh) : { unread: 'no way to reach the code host was given', fix: 'run `yokoten doctor`' };
  const where = walk(road(root, env, ROAD, server), config.notNow);
  const machine = machineChecks(env);
  const next = where.next ? stepFinding(where.next, root, env, server) : null;
  const core = coreRulesCheck(root);
  const isCoreBehind = core?.mark === 'MISSING';

  // A session reads files only, never the network, so it starts fast and works offline.
  if (session) {
    const { stage } = where;
    if (stage && next) lines.push(`yokoten: stage ${stage} of ${STAGES.length}, ${STAGES[stage - 1]}. Next: ${stepText(next)}.`, `Why: ${next.why}.`, env.CLAUDE_PLUGIN_ROOT ? `${OFFER} ${PLUGIN_COMMANDS}` : OFFER);
    else lines.push(ROAD_DONE);
    if (next) findings.push(next);
    // Not a step on the road, but the privacy check is weaker until it is fixed.
    const marks = machine.find((c) => c.name === 'private-marks' && !c.ok);
    if (marks) {
      lines.push(`yokoten: ${formatFinding(marks.finding)}`);
      findings.push(marks.finding);
    }
    // A lesson the kit learned reaches the project here: the session hears it (#120).
    if (core && isCoreBehind) {
      lines.push(`yokoten: ${formatFinding(core.finding)}`);
      findings.push(core.finding);
    }
    const ok = !failed.length && !next && !isCoreBehind;
    return { ok, lines, report: { ...base, ok, repo: true, stage, next, findings } };
  }

  lines.push(`yokoten ${VERSION}, self-test ${failed.length ? 'FAILED' : 'ok'}`);
  lines.push(where.stage ? `the road: stage ${where.stage} of ${STAGES.length}, ${STAGES[where.stage - 1]}` : `the road: ${ROAD_DONE.replace(/^yokoten: /, '')}`);
  const steps: StepState[] = [];
  STAGES.forEach((name, i) => {
    lines.push(`  ${i + 1}. ${name}`);
    for (const { step, mark } of where.steps.filter((w) => w.step.stage === i + 1)) {
      const state: StepState = { id: step.key, stage: step.stage, mark };
      if (step.standard) state.standard = step.standard;
      let note = '';
      if (mark === 'not now') note = state.reason = config.notNow[step.key];
      else if (mark === 'next' || mark === 'to do') {
        const f = stepFinding(step, root, env, server);
        findings.push(f);
        note = stepText(f);
      } else if (mark === "can't check" && step.unchecked) note = step.unchecked(server);
      steps.push(state);
      lines.push(`    ${mark.padEnd(11)} ${step.key}${step.standard ? ` (${step.standard})` : ''}${note ? `: ${note}` : ''}`);
    }
  });
  lines.push('project:');
  const notes: Finding[] = [];
  for (const c of agentHooks(root)) {
    lines.push(`  ${c.ok ? 'ok     ' : 'note   '} ${c.name}${c.ok ? '' : `: ${stepText(c.finding)}`}`);
    if (!c.ok) notes.push(c.finding);
  }
  if (core) {
    lines.push(`  ${core.mark.padEnd(7)} core-rules${core.mark === 'ok' ? '' : `: ${stepText(core.finding)}`}`);
    if (core.mark === 'MISSING') findings.push(core.finding);
    else if (core.mark === 'note') notes.push(core.finding);
  }
  // Full doctor alone keeps which lessons this clone has seen; a session writes nothing.
  const stateFile = findStateFile(root);
  const state = readState(stateFile);
  const seenLessons = state.seenLessons ?? [];
  const lessons = lessonChecks(root, config.notNow, undefined, stateFile ? seenLessons : null);
  const newIds = lessons.filter((lesson) => lesson.isNew).map((lesson) => lesson.id);
  if (newIds.length) saveState(stateFile, { ...state, seenLessons: [...seenLessons, ...newIds] });
  lines.push(...formatLessonChecks(lessons));
  notes.push(...lessons.flatMap((lesson) => lesson.findings));
  const problems = check(root, { config, env });
  findings.push(...problems);
  lines.push(`  ${problems.length ? 'MISSING' : 'ok     '} tree: ${problems.length ? `${problems.length} problem(s), run \`yokoten check\`` : 'layout and privacy clean'}`);
  lines.push('machine:');
  for (const c of machine) {
    lines.push(`  ${c.ok ? 'ok     ' : 'MISSING'} ${c.name}${c.ok ? '' : `: ${stepText(c.finding)}`}`);
    if (!c.ok) findings.push(c.finding);
  }
  // The road's stage 5 shows the settings it groups (#7); here are the rest, which never fail doctor.
  const settings = serverChecks(server ?? { unread: 'no way to reach the code host was given', fix: 'run `yokoten doctor`' });
  lines.push('server (read only; the owner sets these once per repo):');
  for (const c of settings.filter((c) => !ROAD_SERVER_IDS.includes(c.id))) {
    lines.push(`  ${c.mark.padEnd(11)} ${c.id}${c.mark === 'ok' ? '' : `: ${stepText(c.finding)}`}`);
    if (c.mark !== 'ok') notes.push(c.finding);
  }
  if (settings[0].id === 'server-settings') lines.push('  check these by hand:', ...BY_HAND.map((s) => `    ${s}`));
  lines.push(...OWNER_STEPS.map((s) => `  not checked ${s}`));
  const ok = !failed.length && !where.next && !isCoreBehind && !problems.length && machine.every((c) => c.ok);
  return { ok, lines, report: { ...base, ok, repo: true, stage: where.stage, next, findings, steps, notes, server: settings.map(({ id, mark }) => ({ id, mark })), lessons: lessons.map(({ id, mark, reason, isNew }) => ({ id, mark, ...(reason === undefined ? {} : { reason }), ...(isNew ? { isNew } : {}) })) } };
}
