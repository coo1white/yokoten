import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, type Env } from '../../rules/config.ts';
import { type Finding, finding, formatFinding } from '../../rules/message.ts';
import { homeOf } from '../../rules/privacy.ts';
import { guardLine } from '../../host/light.ts';
import { check } from '../../run/check.ts';
import { countNotes, waitingLine } from '../../run/learn.ts';
import { type Gh, readServer, type ServerSettings, type Unread } from '../../host/github/index.ts';
import { type Host, hostOf, isNoAdapter, noAdapter } from '../../host/hosts.ts';
import { readUnsaved, unsavedNotes } from '../advice/unsaved.ts';
import { VERSION } from '../files.ts';
import { hookCliPath, isSelf, withGitReads, workflowNotes } from '../init.ts';
import { gitConfig } from '../../run/check.ts';
import { fillMarks, marksState, UNREADABLE_MARKS, UNREADABLE_MARKS_FIX, filledLines, trySafely, machineMarks, paths } from '../install.ts';
import { type Mark, missingPaths, readDefaultBranchFiles, road, ROAD, ROAD_SERVER_IDS, type ServerCheck, serverChecks, type ServerRead, STAGES, stepFinding, stepText, uncheckedText, walk } from '../road.ts';
import { agentHooks, allowedMarkCount, commandWording, coreRulesCheck, doubleInstallCheck, editedKitCheck, launcherCheck, machineChecks, mergeTimeZones, museClaudeRules, pluginAgeCheck, privacyNotes, releaseChannel, userAgentHooks, type Practice } from './checks.ts';
import { findStateFile, formatLessonChecks, type LessonCheck, lessonChecks, readState, saveState, seenAfter, sessionLessonNote, stageFileFor, STATE_FILE } from './lessons.ts';
import { agentTempDirCheck, diskSpaceChecks, leftoverTempCheck, nodeSecurityCheck, type MachineProbe, REAL_MACHINE } from './machine.ts';
import { selfTest } from './self-test.ts';

/** What doctor can't read on the server yet, and the owner sets once per repo. */
const OWNER_STEPS = ['the bot: a GitHub App (or collaborator) with write access; CODEOWNERS sends CI changes to you'];

/** The settings to check by hand when doctor can't read the server. */
const BY_HAND = [
  'main: a ruleset with pull request required, the CI check required, code owner review, no force push, no deletion; squash merge only, delete branch on merge',
  'tags: a ruleset on v* so only you create, move or delete a release tag',
  'release: in Settings, Environments, create release, add yourself as a required reviewer, and add a Tag rule named v*',
  'security: in Settings, Advanced Security, turn on private vulnerability reporting, secret scanning with push protection, and Dependabot alerts',
];

/**
 * What a board needs that the host's API can't set (#156). Listed only when a board is
 * linked, and never a failure: the board is optional.
 */
const BOARD_BY_HAND = [
  'views: a Board view grouped by Status (and a Table or Roadmap view by milestone, if you like)',
  'workflow "Auto-add to project": on, for this repo\'s issues and pull requests',
  'workflow "Item closed": sets Status to Done',
  'workflow "Pull request merged": sets Status to Done',
];

/** The by-hand lines for each board linked to the repo; none when there is no board or it can't be read. */
export function listBoardSteps(server: ServerRead): string[] {
  if (!server || 'unread' in server || !Array.isArray(server.boards)) return [];
  return server.boards.flatMap((board) => BOARD_BY_HAND.map((step) => `  by hand     board "${board.title}": ${step}`));
}

/** How long full doctor waits for one GitHub read: past it, the server steps say they can't check, and why (#561). */
export const SERVER_TIMEOUT_MS = 3000;

/** Why the server can't be read in a repo with no origin remote; the road shows it once (#502). */
const NO_REMOTE = 'there is no origin remote yet';
const NO_REMOTE_FIX = 'make the repo on your code host, add it as origin with `git remote add origin <url>`, and push; then run `yokoten doctor` again';

/** The server settings of the origin's host, or why they can't be read. A host with no adapter is read without the network (#504). */
function readOrigin(host: Host, gh: Gh): ServerSettings | Unread {
  if (host.kind === 'none') return { unread: NO_REMOTE, fix: NO_REMOTE_FIX };
  return host.kind === 'github' ? readServer(gh, host.repo) : noAdapter(host);
}

/**
 * In yokoten's own repo only, a note when lessons from other projects wait in the inbox
 * (#392). Elsewhere nothing: the inbox is for whoever works on yokoten. One readdir and
 * the package.json read, no child process, so the session start stays fast.
 */
export function upstreamNote(root: string, env: Env): Finding | null {
  if (!isSelf(root)) return null;
  const line = waitingLine(countNotes(env));
  return line ? finding('upstream-inbox', line, 'open an issue for each, then remove its note with `yokoten learn --upstream --done <id>`') : null;
}

/** What a project with CI off leaves unchecked (#377): said once, in full doctor, so the trade-off stays visible. */
export const NO_CI_GAPS = 'CI is off ("notNow" names `ci`), so nothing on the server checks pull requests, issue titles or the workflows, no code scanning such as CodeQL runs, and a commit made with the hook off reaches main unchecked';

/**
 * The note for a project that keeps CI off (#377), or null when "notNow" does not name
 * `ci`. Its fix says what to run by hand instead. From stage 5, or when full doctor read
 * that the repo is public, it also says how to end the choice.
 */
export function noCiNote(notNow: Record<string, string>, stage: number | null, server: ServerRead): Finding | null {
  if (!Object.hasOwn(notNow, 'ci')) return null;
  const isPublic = server !== undefined && !('unread' in server) && server.isPrivate === false;
  const end = 'remove "ci" from "notNow" in yokoten.json, then run `yokoten init` to add the workflows';
  if (isPublic) return finding('no-ci', NO_CI_GAPS, `this repo is public now, and Actions cost no minutes on a public repo: ${end}`);
  const byHand = 'before each merge, run `yokoten check --pr <number>` and the tests';
  return finding('no-ci', NO_CI_GAPS, stage === null || stage >= 5 ? `${byHand}; when the repo goes public, ${end}` : byHand);
}

/** At most this many notes about unsaved work in a session; full doctor lists them all. */
const SESSION_UNSAVED_LIMIT = 3;

/** What the agent does with the unsaved-work lines. */
export const UNSAVED_OFFER = 'Tell the user what is only on this machine, and offer to run the command that saves it.';

/** How long a session may spend on the unsaved-work read: a session must not wait on a cold disk. Full doctor has no limit. */
export const SESSION_UNSAVED_BUDGET = 1000;

/** The line when the session's read ran out of time. */
export const STOPPED_EARLY = 'yokoten: doctor stopped early; `yokoten doctor` lists all.';

/**
 * What a session hears about work only on this machine (#365): only what is at risk, a
 * few lines at most, read within the time budget. `clock` is for a test.
 */
export function sessionUnsaved(root: string, env: Env, clock?: () => number): { lines: string[]; notes: Finding[]; commonDir: string | null } {
  const facts = readUnsaved(root, { env, budget: { ms: SESSION_UNSAVED_BUDGET, ...(clock ? { clock } : {}) } });
  // The git folder it read on the way, so the session's lesson note asks git no more (#339).
  const commonDir = facts?.commonDir || null;
  const notes = facts ? unsavedNotes(facts, { home: env.HOME, session: true }) : [];
  const stopped = facts?.isPartial ? [STOPPED_EARLY] : [];
  if (!notes.length) return { lines: stopped, notes, commonDir };
  const more = notes.length - SESSION_UNSAVED_LIMIT;
  const lines = notes.slice(0, SESSION_UNSAVED_LIMIT).map((f) => `yokoten: ${stepText(f)}.`);
  if (more > 0) lines.push(`yokoten: ${more} more like this; \`yokoten doctor\` lists them all.`);
  return { lines: [...lines, ...stopped, UNSAVED_OFFER], notes, commonDir };
}

// A compaction start (#405). The agent keeps a summary of what it heard, so hearing the
// same notes again after each compaction is noise. Each session keeps what it was told in
// a small file, by the agent's session id; a compaction start then says only what is new.

/** How the agent says a session started. `source` "compact" is a start after a compaction. */
export interface SessionStart {
  sessionId: string;
  source: string;
  /** The model the session runs, when the runtime says (#685), else ''. */
  model?: string;
}

/** A session's file is removed after this many days. */
const SESSION_FILE_DAYS = 7;

/** The folder of the per-session files. Throws NO_HOME with no home folder. */
export const sessionsDir = (env: Env): string => join(paths(env).config, 'sessions');

/**
 * The blocks to print at this start. A compaction start drops the blocks this session
 * was already told; any other start prints all, as before. Every start adds what it
 * prints to the session's file. With no session, or a file that can't be read or
 * written, it prints all.
 */
export function blocksToSay(env: Env, start: SessionStart | null, blocks: string[][], now = Date.now()): string[][] {
  if (!start) return blocks;
  try {
    const dir = sessionsDir(env);
    const file = join(dir, `${start.sessionId}.json`);
    const isCompact = start.source === 'compact';
    let said: string[] = [];
    if (isCompact) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(saved?.said)) said = saved.said.filter((text: unknown) => typeof text === 'string');
      } catch {
        // no file yet: the first start was before this version, so say all
      }
    } else removeOldSessionFiles(dir, now);
    const isSaid = new Set(said);
    const fresh = blocks.filter((block) => !isSaid.has(block.join('\n')));
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ said: [...said, ...fresh.map((block) => block.join('\n'))] })}\n`);
    return fresh;
  } catch {
    return blocks;
  }
}

/** Removes the session files not written to for SESSION_FILE_DAYS. A file that can't be removed stays. */
function removeOldSessionFiles(dir: string, now: number): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      if (now - statSync(join(dir, name)).mtimeMs > SESSION_FILE_DAYS * 86_400_000) rmSync(join(dir, name));
    } catch {
      // gone already, or not ours to remove
    }
  }
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
 * fix; `notes` never fail doctor. `ok` is false only for a problem (#208): the self-test,
 * core rules that are behind, a tree finding or a machine check. A road step not taken
 * yet is to do, not a problem, so it never makes `ok` false. A session (`--session`) gets the next step, the
 * private-marks finding, a behind `core-rules` finding and, in yokoten's own repo, the
 * `upstream-inbox` note only, as its lines do.
 */
export interface DoctorReport {
  version: string;
  /** The release channel this machine runs: stable, beta or dev (#632). */
  channel: string;
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

/** What doctor says when HOME is empty or not a full path, and the system names no home either (#404). */
export const NO_HOME_NOTE = "no home folder found; yokoten can't read or keep its settings (set HOME to your home folder's full path)";

/**
 * The report, as text lines and as data, and whether doctor found no problem. Each git
 * answer is kept for the run (`withGitReads`, #408).
 */
export const doctor = (root: string | null, options: Parameters<typeof doctorRun>[1]): ReturnType<typeof doctorRun> => {
  const result = withGitReads(() => doctorRun(root, options));
  const reword = commandWording(options.env);
  return reword ? rewordStrings(result, reword) : result;
};

/** `value` with `reword` applied to every string in it (plain arrays and objects only). */
function rewordStrings<T>(value: T, reword: (text: string) => string): T {
  if (typeof value === 'string') return reword(value) as T;
  if (Array.isArray(value)) return value.map((item) => rewordStrings(item, reword)) as T;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewordStrings(item, reword)])) as T;
  }
  return value;
}

/**
 * Why one stage that a jump passed does not hold the road back: what its steps are, by mark
 * (#514). A step already done and a step yokoten can't check yet get their own words, so the
 * line says which reason applies instead of joining both with "or".
 */
function stageJumpText(marks: Mark[]): string {
  const countOf = (mark: Mark) => marks.filter((each) => each === mark).length;
  const done = countOf('done');
  if (done === marks.length) return 'its steps were already in place';
  const unchecked = countOf("can't check");
  const later = countOf('not now');
  const parts: string[] = [];
  if (done) parts.push(`${done} of its steps ${done === 1 ? 'was' : 'were'} already in place`);
  if (unchecked) parts.push(`${unchecked} can't be checked yet`);
  if (later) parts.push(`${later} ${later === 1 ? 'is' : 'are'} marked not now`);
  return parts.join(', ').replace(/, ([^,]*)$/, ' and $1');
}

/**
 * What one guard call costs on this machine (#461): wall time and CPU time, from one real
 * run of the guard on a trivial command. The project's own copy when it has one, else the
 * copy that runs doctor. A report line, never a failure; null when there is nothing to run
 * or the machine can't measure. Full doctor only: a session must start fast.
 */
export function guardCostCheck(root: string, probe: MachineProbe, env: Env): Practice | null {
  if (!probe.measureGuard) return null;
  const own = join(root, hookCliPath(root));
  const cli = existsSync(own) ? own : fileURLToPath(new URL('../../../bin/yokoten.mjs', import.meta.url));
  const cost = probe.measureGuard(cli, root, env);
  return cost ? { name: 'guard', ok: true, finding: finding('guard-cost', '', ''), detail: guardLine(cost) } : null;
}

function doctorRun(
  root: string | null,
  { env, config, session = false, gh, fillMarks: isFilling = false, machine: probe = REAL_MACHINE }: { env: Env; config: Config; session?: boolean; gh?: Gh; fillMarks?: boolean; machine?: MachineProbe },
): { ok: boolean; lines: string[]; blocks?: string[][]; report: DoctorReport } {
  const lines: string[] = [];
  const failed = selfTest();
  const findings: Finding[] = [];
  if (failed.length) {
    lines.push(`yokoten is BROKEN: ${failed.join(', ')} let a known-bad input through. Do not trust any check until this is fixed.`);
    findings.push(finding('self-test', `${failed.join(', ')} let a known-bad input through`, 'do not trust any check until this is fixed; run `yokoten install` again, or report it in an issue'));
  }
  const base = { version: VERSION, channel: releaseChannel(root, env), selfTest: { ok: !failed.length, failed }, stages: STAGES };
  if (!root) return { ok: !failed.length, lines, report: { ...base, ok: !failed.length, repo: false, stage: null, next: null, findings } };

  // Read only, and only in full doctor: a session never calls the network (record 0004).
  // A host with no adapter needs no network, so a session knows it too (#504).
  const host = hostOf(gitConfig(root, 'remote.origin.url', env));
  const server: ServerRead = host.kind === 'other' ? noAdapter(host) : session ? undefined : gh ? readOrigin(host, gh) : { unread: 'no way to reach the code host was given', fix: 'run `yokoten doctor`' };
  const where = walk(road(root, env, ROAD, server, config), config.notNow);
  // Full doctor from the command line adds the obvious marks first (#390); a session writes nothing.
  // With no home folder, the checks that read or keep settings there are skipped, never crash (#404).
  const hasHome = homeOf(env) !== null;
  const filled = isFilling && !session && hasHome ? trySafely('the marks from this machine', () => filledLines(fillMarks(env, machineMarks(env, { cwd: root, gh })), paths(env).marks)) : [];
  const machine = hasHome ? machineChecks(env) : [];
  // A file missing here may be on the default branch (#405): one git call for every step
  // left. A session asks only when the step it names misses a file.
  const left = where.steps.filter((w) => w.mark === 'next' || w.mark === 'to do').map((w) => w.step);
  const isAsked = missingPaths(root, session ? left.slice(0, 1) : left, config).length > 0;
  const elsewhere = isAsked ? readDefaultBranchFiles(root, missingPaths(root, left, config), env) : null;
  const next = where.next ? stepFinding(where.next, root, env, { server, config, elsewhere }) : null;
  const core = coreRulesCheck(root);
  const isCoreBehind = core?.mark === 'MISSING';

  // A session reads files only, never the network, so it starts fast and works offline.
  if (session) {
    // Each note is a block of lines: a compaction start repeats only the blocks that changed (#405).
    const blocks: string[][] = lines.map((line) => [line]);
    const { stage } = where;
    if (stage && next) blocks.push([`yokoten: stage ${stage} of ${STAGES.length}, ${STAGES[stage - 1]}. Next: ${stepText(next)}.`, `Why: ${next.why}.`, env.CLAUDE_PLUGIN_ROOT ? `${OFFER} ${PLUGIN_COMMANDS}` : OFFER]);
    else blocks.push([ROAD_DONE]);
    if (next) findings.push(next);
    // Not a step on the road, but the privacy check is weaker until it is fixed.
    const marks = machine.find((c) => c.name === 'private-marks' && !c.ok);
    if (marks) {
      blocks.push([`yokoten: ${formatFinding(marks.finding)}`]);
      findings.push(marks.finding);
    }
    // A stale plugin keeps old guard rules running; the session hears it (#198).
    const stale = pluginAgeCheck(root, env);
    if (stale) blocks.push([`yokoten: ${formatFinding(stale)}`]);
    if (!hasHome) blocks.push([`yokoten: ${NO_HOME_NOTE}`]);
    // This note only. The other privacy notes stay out of a session (#681).
    const claudeRules = museClaudeRules(env, root);
    if (claudeRules) blocks.push([`yokoten: ${formatFinding(claudeRules.finding)}`]);
    const double = hasHome ? doubleInstallCheck(root, env) : null;
    if (double) blocks.push([`yokoten: ${formatFinding(double)}`]);
    // An edit stays, and a kit fix that waits behind it is named here, not after a surprise (#477).
    const edited = hasHome ? editedKitCheck(env) : null;
    if (edited) blocks.push([`yokoten: ${formatFinding(edited)}`]);
    // A full disk stops every session unseen (record 0012): statfs and one small file, no child process.
    for (const c of diskSpaceChecks(root, env, probe, true).filter((check) => !check.ok)) blocks.push([`yokoten: ${formatFinding(c.finding)}`]);
    const unsaved = sessionUnsaved(root, env);
    if (unsaved.lines.length) blocks.push(unsaved.lines);
    // A lesson the kit learned reaches the project here: the session hears it (#120).
    if (core && isCoreBehind) {
      blocks.push([`yokoten: ${formatFinding(core.finding)}`]);
      findings.push(core.finding);
    }
    const waiting = upstreamNote(root, env);
    if (waiting) {
      blocks.push([`yokoten: ${waiting.what}`]);
      findings.push(waiting);
    }
    // A lesson new to this clone that finds something here: one line, at one start only (#339).
    const stateFile = unsaved.commonDir ? join(unsaved.commonDir, STATE_FILE) : findStateFile(root, env);
    const lesson = sessionLessonNote(root, config.notNow, stateFile, env.CLAUDE_PLUGIN_ROOT ? '/yokoten:doctor' : '`yokoten doctor`');
    if (lesson.line) blocks.push([lesson.line]);
    const notes = [...unsaved.notes, ...lesson.findings, ...(claudeRules ? [claudeRules.finding] : [])];
    const ok = !failed.length && !isCoreBehind;
    return { ok, lines: blocks.flat(), blocks, report: { ...base, ok, repo: true, stage, next, findings, ...(notes.length ? { notes } : {}) } };
  }

  lines.push(`yokoten ${VERSION} (${base.channel}), self-test ${failed.length ? 'FAILED' : 'ok'}`);
  // Work only on this machine (#365): notes, never a failure, and read only. Read before the
  // road line, so the state file is found in the git folder it names (#453), as a session
  // start finds it, and a stage that jumped can say so next to the road (#514).
  const unsaved = readUnsaved(root, { env });
  // Full doctor keeps which lessons this clone has seen; a session start keeps only which it ran.
  const stateFile = unsaved?.commonDir ? join(unsaved.commonDir, STATE_FILE) : findStateFile(root, env);
  const state = readState(stateFile);
  // The road's stage has its own file, next to the lessons state (#514). A broken or missing
  // file has no stage: the first run has nothing to compare with.
  const stageFile = stageFileFor(stateFile);
  const savedStage = readState(stageFile).lastStage;
  const lastStage = typeof savedStage === 'number' && Number.isInteger(savedStage) && savedStage > 0 ? savedStage : null;
  lines.push(where.stage ? `the road: stage ${where.stage} of ${STAGES.length}, ${STAGES[where.stage - 1]}` : `the road: ${ROAD_DONE.replace(/^yokoten: /, '')}`);
  // A stage that moved by more than one since the last full doctor says which stages it
  // passed, and why each counts as done, one line each (#514). The first run has no stage to
  // compare with, and a move of one is the usual next step, so neither says anything.
  if (where.stage !== null && lastStage !== null && where.stage - lastStage >= 2) {
    for (let stage = lastStage + 1; stage < where.stage; stage++) {
      const marks = where.steps.filter((walked) => walked.step.stage === stage).map((walked) => walked.mark);
      const isDone = marks.every((mark) => mark === 'done');
      lines.push(`stage ${stage} ${isDone ? 'is done too' : 'counts as done'}: ${stageJumpText(marks)}`);
    }
  }
  const steps: StepState[] = [];
  // With no origin remote, the steps that read the server say so in one line, not one each (#502).
  const noRemote = server !== undefined && 'unread' in server && server.unread === NO_REMOTE;
  const needRemote = noRemote ? where.steps.filter(({ step, mark }) => mark === "can't check" && step.unchecked?.(server).includes(NO_REMOTE)).map(({ step }) => step.key) : [];
  STAGES.forEach((name, i) => {
    lines.push(`  ${i + 1}. ${name}`);
    for (const { step, mark } of where.steps.filter((w) => w.step.stage === i + 1)) {
      const state: StepState = { id: step.key, stage: step.stage, mark };
      if (step.standard) state.standard = step.standard;
      let note = '';
      // A step that needs CI waits with "notNow" `ci` (#377): its reason, then what covers it meanwhile.
      if (mark === 'not now') note = state.reason = Object.hasOwn(config.notNow, step.key) ? config.notNow[step.key] : `${config.notNow.ci} (notNow ci); ${step.withoutCi}`;
      else if (mark === 'next' || mark === 'to do') {
        const f = stepFinding(step, root, env, { server, config, elsewhere });
        findings.push(f);
        note = stepText(f);
      } else if (mark === "can't check") note = uncheckedText(step, server);
      steps.push(state);
      if (needRemote.includes(step.key)) {
        if (step.key === needRemote[0]) lines.push(`    can't check ${needRemote.join(', ')}: ${NO_REMOTE}, so doctor can't read the server; ${NO_REMOTE_FIX}`);
        continue;
      }
      lines.push(`    ${mark.padEnd(11)} ${step.key}${step.standard ? ` (${step.standard})` : ''}${note ? `: ${note}` : ''}`);
    }
  });
  lines.push('project:');
  const notes: Finding[] = [];
  for (const c of agentHooks(root, env)) {
    lines.push(`  ${c.ok ? 'ok     ' : 'note   '} ${c.name}${c.ok ? (c.detail ? `: ${c.detail}` : '') : `: ${stepText(c.finding)}`}`);
    if (!c.ok) notes.push(c.finding);
  }
  if (core) {
    lines.push(`  ${core.mark.padEnd(7)} core-rules${core.mark === 'ok' ? '' : `: ${stepText(core.finding)}`}`);
    if (core.mark === 'MISSING') findings.push(core.finding);
    else if (core.mark === 'note') notes.push(core.finding);
  }
  // A merge made in another zone stays in history (record 0027): a count to know, never a
  // failure, and one command shows the merges (#760). Full doctor only: a session reads no history.
  const zones = config.privacy.utc ? mergeTimeZones(root, env) : null;
  if (zones) {
    lines.push(`  note    time-zone: ${stepText(zones)}`);
    notes.push(zones);
  }
  const noCi = noCiNote(config.notNow, where.stage, server);
  if (noCi) {
    lines.push(`  note    no-ci: ${stepText(noCi)}`);
    notes.push(noCi);
  }
  const seenLessons = state.seenLessons ?? [];
  const lessons = lessonChecks(root, config.notNow, undefined, stateFile ? seenLessons : null);
  const nextSeen = seenAfter(seenLessons, lessons);
  // A kit workflow that is an old copy, or has the project's changes (#456): a note, never a
  // failure. A changed copy is noted once per kit version in this clone.
  const seenWorkflows = state.seenWorkflows ?? [];
  const workflows = workflowNotes(root).filter((w) => w.seen === undefined || !seenWorkflows.includes(w.seen));
  for (const { note } of workflows) {
    lines.push(`  note    kit-workflows: ${stepText(note)}`);
    notes.push(note);
  }
  const nextWorkflows = [...seenWorkflows, ...workflows.flatMap((w) => (w.seen === undefined ? [] : [w.seen]))];
  if (nextSeen.length > seenLessons.length || nextWorkflows.length > seenWorkflows.length) saveState(stateFile, { ...state, seenLessons: nextSeen, ...(nextWorkflows.length ? { seenWorkflows: nextWorkflows } : {}) });
  // A stage this run holds is saved for the next one. The done road (`where.stage === null`)
  // leaves the last stage where it was: there is no new stage to compare with.
  if (where.stage !== null && where.stage !== lastStage) saveState(stageFile, { lastStage: where.stage });
  lines.push(...formatLessonChecks(lessons));
  notes.push(...lessons.flatMap((lesson) => lesson.findings));
  const checkNotes: Finding[] = [];
  let problems: Finding[];
  try {
    problems = check(root, { config, env, notes: checkNotes });
  } catch (err) {
    // An unreadable marks file stops the privacy check (#656): doctor says so and goes on.
    if (marksState(env) !== 'unreadable') throw err;
    problems = [finding('private-marks', UNREADABLE_MARKS, UNREADABLE_MARKS_FIX)];
  }
  findings.push(...problems);
  const allowed = allowedMarkCount(env, config, root);
  if (allowed.project) lines.push(`  ok      own-marks: ${allowed.project} of your private marks allowed here by privacy.allow`);
  if (allowed.machine) lines.push(`  ok      own-marks: ${allowed.machine} of your private marks allowed here by this machine (\`yokoten marks allow\`)`);
  if (allowed.ownName) lines.push(`  ok      own-marks: ${allowed.ownName} of your private marks skipped here because they name this repo ("privacy": { "skipOwnName": false } turns this off)`);
  if (allowed.unsure) lines.push(`  note    own-marks: this machine allows no private mark here, because ${allowed.unsure}`);
  lines.push(`  ${problems.length ? 'MISSING' : 'ok     '} tree: ${problems.length ? `${problems.length} problem(s), run \`yokoten check\`` : 'layout and privacy clean'}`);
  // check's own notes (#228), such as an unknown yokoten.json key or a translation behind: worded as check words them, and never a failure.
  for (const n of checkNotes) lines.push(`  note    ${formatFinding(n).replaceAll('\n', '\n        ')}`);
  notes.push(...checkNotes);
  const unsavedFound = unsaved ? unsavedNotes(unsaved, { home: env.HOME }) : [];
  lines.push('unsaved work (only on this machine):');
  if (!unsaved) lines.push("  note    can't read this repo with git, so doctor can't tell what is only here");
  else if (!unsavedFound.length) lines.push('  ok      everything is committed and pushed');
  for (const n of unsavedFound) lines.push(`  note    ${n.id}: ${stepText(n)}`);
  notes.push(...unsavedFound);
  lines.push('machine:');
  for (const c of machine) {
    lines.push(`  ${c.ok ? 'ok     ' : 'MISSING'} ${c.name}${c.ok ? '' : `: ${stepText(c.finding)}`}`);
    if (!c.ok) findings.push(c.finding);
  }
  if (!hasHome) lines.push(`  note    ${NO_HOME_NOTE}`);
  for (const line of filled) lines.push(`  note    ${line}`);
  for (const c of hasHome ? privacyNotes(env, root, config.privacy.output) : []) {
    lines.push(`  note    ${c.name}: ${stepText(c.finding)}`);
    notes.push(c.finding);
  }
  // Machine notes (record 0012) never fail doctor: the disk, the agent's temp folder, old
  // test folders left in the temp folder (#400), and a Node without the security fixes (#572).
  const agentTemp = agentTempDirCheck(env, probe);
  const leftovers = leftoverTempCheck(env, probe);
  const guardCost = session || root === null ? null : guardCostCheck(root, probe, env);
  for (const c of [...userAgentHooks(env), ...diskSpaceChecks(root, env, probe, false), ...(agentTemp ? [agentTemp] : []), ...(leftovers ? [leftovers] : []), nodeSecurityCheck(probe), ...(guardCost ? [guardCost] : [])]) {
    lines.push(`  ${c.ok ? 'ok     ' : 'note   '} ${c.name}${c.ok ? (c.detail ? `: ${c.detail}` : '') : `: ${stepText(c.finding)}`}`);
    if (!c.ok) notes.push(c.finding);
  }
  const stale = pluginAgeCheck(root, env);
  if (stale) {
    lines.push(`  note    plugin: ${stepText(stale)}`);
    notes.push(stale);
  }
  const double = hasHome ? doubleInstallCheck(root, env) : null;
  if (double) {
    lines.push(`  note    plugin-and-install: ${stepText(double)}`);
    notes.push(double);
  }
  const launcher = hasHome ? launcherCheck(env) : null;
  if (launcher) {
    lines.push(`  note    command: ${stepText(launcher)}`);
    notes.push(launcher);
  }
  const edited = hasHome ? editedKitCheck(env) : null;
  if (edited) {
    lines.push(`  note    edited-kit: ${stepText(edited)}`);
    notes.push(edited);
  }
  const waiting = upstreamNote(root, env);
  if (waiting) {
    lines.push(`  note    upstream-inbox: ${waiting.what}`);
    notes.push(waiting);
  }
  // The road's stage 5 shows the settings it groups (#7); here are the rest, which never fail doctor.
  const settings = serverChecks(server ?? { unread: 'no way to reach the code host was given', fix: 'run `yokoten doctor`' }, { isCiOff: Object.hasOwn(config.notNow, 'ci') });
  lines.push('server (read only; the owner sets these once per repo):');
  for (const c of settings.filter((c) => !ROAD_SERVER_IDS.includes(c.id) && !(noRemote && c.id === 'server-settings'))) {
    lines.push(`  ${c.mark.padEnd(11)} ${c.id}${c.mark === 'ok' ? '' : `: ${stepText(c.finding)}`}`);
    if (c.mark !== 'ok') notes.push(c.finding);
  }
  // On a host with no adapter, each road step says what it asks; these lists name GitHub's menus (#504).
  if (!isNoAdapter(server)) {
    if (settings[0].id === 'server-settings') lines.push('  check these by hand:', ...BY_HAND.map((s) => `    ${s}`));
    lines.push(...OWNER_STEPS.map((s) => `  not checked ${s}`));
  }
  lines.push(...listBoardSteps(server));
  // The road has no failed mark: a step is done, to do, not now or can't check. Steps
  // left are the way ahead, not problems, so they never fail doctor (#208).
  const ok = !failed.length && !isCoreBehind && !problems.length && machine.every((c) => c.ok);
  return { ok, lines, report: { ...base, ok, repo: true, stage: where.stage, next, findings, steps, notes, server: settings.map(({ id, mark }) => ({ id, mark })), lessons: lessons.map(({ id, mark, reason, isNew }) => ({ id, mark, ...(reason === undefined ? {} : { reason }), ...(isNew ? { isNew } : {}) })) } };
}
