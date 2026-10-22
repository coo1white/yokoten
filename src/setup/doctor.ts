// `yokoten doctor`: a guide along the road (record 0004), and a check that this machine
// still runs the practices.
//
// Copying a setup once is not enough; it drifts. So doctor runs at the start of every
// session (`--session`, via the hook install adds). A beginner can't take in a list of
// everything missing, so a session hears three lines: the stage, the one next step, and
// why, and once a line about a new kit lesson that finds something here. Full `doctor`
// shows the whole map. A project that decided against a step says so
// in yokoten.json "notNow", and doctor stops asking.
//
// Doctor first checks itself: it feeds each check a known-bad input and expects a catch.
// A check that passes everything looks the same as a healthy project, so this comes first.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCommand, checkEdit } from '../rules/guards.ts';
import { type Config, DEFAULTS, type Env } from '../rules/config.ts';
import { checkBuildOutput, checkLayout } from '../rules/layout.ts';
import { type Finding, finding, formatFinding, type RuleId } from '../rules/message.ts';
import { homeIn, homeOf, loadMarks, machineAllowed, notUtc, ownMarks, POSITIVE_CONTROL, repoKey, sameNameMarks, scanText, skipsOwnName } from '../rules/privacy.ts';
import { SECRET_CONTROL } from '../rules/secrets.ts';
import { check } from '../run/check.ts';
import { judge } from '../run/hook.ts';
import { countNotes, type LessonPlace, listLessons, runLessons, waitingLine } from '../run/learn.ts';
import * as antigravity from '../agents/runtimes/antigravity.ts';
import { hasPlugin, hasProjectHook, hasSessionDoctor, readInstalledPlugin, readToolCall, tempDir as claudeTempDir, userSettingsProblem } from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as copilot from '../agents/copilot.ts';
import * as dsh from '../agents/runtimes/deepseek-harness.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as grok from '../agents/runtimes/grok.ts';
import * as muse from '../agents/runtimes/muse.ts';
import type { FolderTrust } from '../agents/folder-trust.ts';
import { commentedFile, HAND_ADD, handAddJson, type HookState, mergeHandAdds } from '../agents/hooks-file.ts';
import { type Gh, readServer, type ServerSettings, type Unread } from '../host/github.ts';
import { type Host, hostOf, isNoAdapter, noAdapter } from '../host/hosts.ts';
import { findTempDirs, readUnsaved, UNSAVED_CONTROL, unsavedNotes } from './advice/unsaved.ts';
import { HOME_DIR, KIT, runtimeVersion, VERSION } from './files.ts';
import { compareCoreRules, compareVersions, hookCliPath, isSelf, readCoreRules, summarizeUpdate, withGitReads, workflowNotes } from './init.ts';
import { assumeEmptyFolder, gitConfig } from '../run/check.ts';
import { EMPTY_MARKS_FIX, fillMarks, hasMarks, OFFER_MARKS_FIX, offerMarkKinds, launcherFile, PROFILE_LINE, filledLines, trySafely, installedPieces, isOnPath, launcherDir, machineMarks, machineStateFile, mailmapState, readMachineState, saveMachineState, writeFileAtomic, MAILMAP_SETTING, missingMarkKinds, paths, USER_CLI, USER_MISSING } from './install.ts';
import { type Mark, missingPaths, readDefaultBranchFiles, road, ROAD, ROAD_SERVER_IDS, type ServerCheck, serverChecks, type ServerRead, STAGES, stepFinding, stepText, uncheckedText, walk } from './road.ts';

/**
 * One check outside the road: its name in the report, whether it is in place, and the
 * finding when it is not. `detail` follows the name on an ok line, for what ok can't prove.
 */
interface Practice {
  name: string;
  ok: boolean;
  finding: Finding;
  detail?: string;
}

const practice = (name: string, id: RuleId, ok: boolean, what: string, fix: string): Practice => ({ name, ok, finding: finding(id, what, fix) });

/** The checks that must catch a known-bad input. Returns the names of any that did not. */
export function selfTest(): string[] {
  const failed: string[] = [];
  if (!checkCommand('git push origin --tags', { env: {}, cwd: null })) failed.push('release guard');
  if (!checkCommand('git commit --no-verify -m x', { env: {}, cwd: null })) failed.push('skip-check guard');
  if (!checkEdit('test/a.test.ts', { config: DEFAULTS, env: { YOKOTEN_FIX_TASK: '1' } })) failed.push('test guard');
  if (!checkEdit('AGENTS.md', { config: DEFAULTS, env: { YOKOTEN_ROLE: 'worker' } })) failed.push('lead-only guard');
  if (!isShellControlCaught()) failed.push('lead-only shell guard');
  if (scanText(POSITIVE_CONTROL, { file: 'control' }).length < 2) failed.push('privacy check');
  if (scanText(SECRET_CONTROL, { file: 'control' }).length < 2) failed.push('secret check');
  if (!notUtc('A <a@example.com> 1760745600 +0700') || notUtc('A <a@example.com> 1760745600 +0000')) failed.push('time zone check');
  if (checkLayout(Array.from({ length: 8 }, (_, i) => `d/${i}`), DEFAULTS).length !== 1) failed.push('layout check');
  if (checkBuildOutput([{ path: 'dist/a.js', binary: false }, { path: 'a.bin', binary: true }], DEFAULTS).length !== 2) failed.push('build output check');
  if (!isUnsavedControlCaught()) failed.push('unsaved work check');
  failed.push(...roadControl());
  const kit = '# rules\n\n## This project\n';
  if (compareCoreRules('# old rules\n\n## This project\n', kit).state !== 'behind' || compareCoreRules('# rules\n', kit).state !== "can't compare") failed.push('core rules check');
  failed.push(...coreRulesControl());
  failed.push(...machineControl());
  failed.push(...leftoverControl());
  return failed;
}

/**
 * A shell write to AGENTS.md from Claude Code's plugin worker, `yokoten:worker`, with no
 * YOKOTEN_ROLE (#402): the call must read as a worker's and be stopped, and the same call
 * from the lead must pass. The repo is the root of the file system yokoten runs from, taken
 * as given, and nothing is written.
 */
export function isShellControlCaught(): boolean {
  const root = parse(HOME_DIR).root;
  const call = (agentType?: string) => ({ agent_type: agentType, cwd: root, tool_input: { command: 'sed -i s/a/b/ AGENTS.md' } });
  const options = { root, config: DEFAULTS, env: {}, cwd: root };
  return judge(readToolCall(call('yokoten:worker')), options) !== null && judge(readToolCall(call()), options) === null;
}

/**
 * A clone with one of each kind of work only on this machine (#365), as facts: the notes
 * must name every kind, and say to delete no lock while doctor can't tell.
 */
export function isUnsavedControlCaught(notes: typeof unsavedNotes = unsavedNotes): boolean {
  const found = new Set(notes(UNSAVED_CONTROL, { home: undefined, now: 1 }).map((f) => f.id));
  const kinds = ['uncommitted-changes', 'unpushed-commits', 'stashes', 'stale-index-lock', 'repo-on-tmpfs', 'repo-in-temp-folder', 'finished-worktree', 'missing-worktree'];
  const unsure = notes({ ...UNSAVED_CONTROL, isGitRunning: null }, { home: undefined, now: 1 }).find((f) => f.id === 'stale-index-lock');
  return kinds.every((kind) => found.has(kind)) && !!unsure && !/\b(rm|del|delete)\b/.test(unsure.fix);
}

/**
 * A file with comments that yokoten won't rewrite, and a hook not in it yet: the hooks to
 * add by hand, on one line (#258). Null when none of the states says so.
 */
function handAddPractice(id: RuleId, file: string, states: readonly HookState[]): Practice | null {
  const problem = mergeHandAdds(states);
  return problem?.kind === 'comments' ? practice(id, id, false, commentedFile(file), `${HAND_ADD}: ${handAddJson(problem.add, null)}`) : null;
}

/**
 * The note when an agent skips the project's hooks until the user trusts the folder
 * (#341), read from the agent's own trust store; ok only when the store says trusted. A
 * store doctor can't find or read is "can't check", never ok: Codex, Muse Code and Copilot
 * CLI all fail open, without a word. Null when the agent's home folder is not there: a
 * user who does not run that agent hears nothing about its trust.
 */
function trustPractice(id: RuleId, agent: string, file: string, trust: FolderTrust<codex.CodexTrust['state']>, step: string): Practice | null {
  const note = (what: string, fix: string) => practice(id, id, false, what, fix);
  switch (trust.state) {
    case 'no home':
      return null;
    case 'trusted':
      return practice(id, id, true, '', '');
    case 'untrusted':
      return note(`${agent} skips ${file} until you trust this folder`, step);
    case 'no store':
      return note(`can't check whether ${agent} trusts this folder: no ${trust.store}`, `if you use ${agent}: ${step}`);
    case 'unreadable':
      return note(`can't check whether ${agent} trusts this folder: can't read ${trust.store}`, `if you use ${agent}: ${step}`);
    case 'hooks untrusted':
      return note(`${agent} trusts this folder, but not yokoten's hooks in ${file}, so it skips them`, 'in a Codex session here, trust both in `/hooks`');
    case 'hooks changed':
      return note(`yokoten's hooks in ${file} changed after you trusted them, so ${agent} skips them`, 'in a Codex session here, trust both again in `/hooks`');
    case 'hooks off':
      return note(`a yokoten hook in ${file} is turned off in ${agent}`, 'in a Codex session here, turn it on in `/hooks`');
  }
}

/** The hook-file line when the agent's home is not there: the file is in place, and its trust is not checked. */
const unchecked = (id: RuleId, file: string, home: string): Practice => ({ name: id, ok: true, finding: finding(id, '', ''), detail: `${file} is in place; trust not checked, no ${home}` });

/**
 * The other agents' project hooks: the tool-call guard and the stop check. Reported, but
 * not a missing practice: a project that uses none of these agents should not fail doctor
 * over them. Real runs blocked through Codex, Antigravity CLI, Muse Code, DeepSeek Harness and Grok CLI; Gemini CLI is not run yet (#30).
 * A Gemini CLI file with comments, which init won't rewrite, gets the hooks to add by hand.
 * Codex, Muse Code, Copilot CLI and Grok CLI run the hooks only in a folder the user trusts:
 * `env` finds their trust stores (HOME, CODEX_HOME, XDG_CONFIG_HOME, COPILOT_HOME, GROK_HOME).
 */
export function agentHooks(root: string, env: Env, platform: string = process.platform): Practice[] {
  // Each step wants both project hooks: the tool-call guard and the stop check (#211).
  const missing = (guard: boolean, stop: boolean, file: string) =>
    [...(guard ? [] : ['no tool-call guard']), ...(stop ? [] : ['no stop check'])].join(' and ') + ` in ${file}`;
  const [codexGuard, codexStop] = [codex.hasProjectHook(root), codex.hasProjectStopHook(root)];
  const [geminiGuard, geminiStop] = [gemini.hasProjectHook(root), gemini.hasProjectStopHook(root)];
  const geminiState = geminiGuard && geminiStop ? null : gemini.projectHooksState(root, hookCliPath(root));
  // Copilot CLI reads Claude Code's hooks: the road checks the file, this line only the trust,
  // and only when Copilot looks used here.
  const copilotTrust = copilot.readTrust(root, env);
  const copilotLine =
    copilotTrust.state === 'no home'
      ? null
      : hasProjectHook(root)
        ? trustPractice('copilot-hook', 'Copilot CLI', '.claude/settings.json', copilotTrust, copilot.TRUST_STEP)
        : practice('copilot-hook', 'copilot-hook', false, 'no tool-call guard in .claude/settings.json', '`yokoten init` adds it');
  const codexTrust = codexGuard && codexStop ? codex.readTrust(root, env) : null;
  return [
    ...(copilotLine ? [copilotLine] : []),
    codexTrust
      ? (trustPractice('codex-hook', 'Codex', '.codex/hooks.json', codexTrust, codex.TRUST_STEP) ?? unchecked('codex-hook', '.codex/hooks.json', codexTrust.store.replace('/config.toml', '')))
      : practice('codex-hook', 'codex-hook', false, missing(codexGuard, codexStop, '.codex/hooks.json'), '`yokoten init` adds it'),
    (geminiState && handAddPractice('gemini-hook', '.gemini/settings.json', [geminiState.guard, geminiState.stop])) ??
      practice('gemini-hook', 'gemini-hook', geminiGuard && geminiStop, missing(geminiGuard, geminiStop, '.gemini/settings.json'), '`yokoten init` adds it'),
    antigravityPractice(antigravity.projectHookState(root, hookCliPath(root))),
    ...museLine(root, env),
    trustedHooksPractice('grok-hook', 'Grok CLI', grok.HOOKS_FILE, grok.projectHooksState(root, hookCliPath(root)), () => grok.readTrust(root, env), grok.TRUST_STEP),
    platform === 'win32' ? practice('deepseek-harness-hook', 'deepseek-harness-hook', false, dsh.WINDOWS_GAP, 'nothing to do yet: issue #332 adds a PowerShell guard') : dshPractice(dsh.projectHooksState(root, hookCliPath(root)), dsh.profilesWithBridge(env)),
  ];
}

/**
 * Muse Code's line. An untrusted folder with the hooks in place is a step on the road
 * (`tool-hook`, #554), so it gets no second line here.
 */
function museLine(root: string, env: Env): Practice[] {
  const states = muse.projectHooksState(root, hookCliPath(root));
  if (states.guard === 'same' && states.stop === 'same' && muse.isGuardOff(root, env)) return [];
  // The trust note names the headless way too: `muse exec --trust-workspace` (#557).
  return [trustedHooksPractice('muse-hook', 'Muse Code', '.muse/hooks.json', states, () => muse.readTrust(root, env), muse.TRUST_FIX)];
}

/** Antigravity CLI's guard in .agents/hooks.json: one hook, no stop check (its Stop event has no `stop_hook_active`). */
function antigravityPractice(state: HookState): Practice {
  const file = '.agents/hooks.json';
  if (typeof state === 'object') return practice('antigravity-hook', 'antigravity-hook', false, state.kind === 'json' ? `can't read ${file}` : `${file} has an unexpected shape`, state.kind === 'shape' ? `${state.hint}; fix it, then run \`yokoten init\`` : 'make it valid JSON, then run `yokoten init`');
  if (state === 'updated') return practice('antigravity-hook', 'antigravity-hook', false, `the tool-call guard in ${file} is out of date or off`, '`yokoten init` updates it');
  return practice('antigravity-hook', 'antigravity-hook', state === 'same', `no tool-call guard in ${file}`, '`yokoten init` adds it');
}

/**
 * An agent's tool-call guard and stop check in its own hooks file, which it runs only in a
 * folder the user trusts (Muse Code, Grok CLI): missing, out of date, a file init can't
 * edit, or a folder the agent does not trust.
 */
function trustedHooksPractice(id: 'muse-hook' | 'grok-hook', agent: string, file: string, states: { guard: HookState; stop: HookState }, readTrust: () => FolderTrust, step: string): Practice {
  const all = [states.guard, states.stop];
  const problem = all.find((state) => typeof state === 'object');
  if (problem) return practice(id, id, false, problem.kind === 'json' ? `can't read ${file}` : `${file} has an unexpected shape`, 'make it valid JSON with a "hooks" object, then run `yokoten init`');
  if (all.includes('updated')) return practice(id, id, false, `the hooks in ${file} are out of date`, '`yokoten init` updates them');
  if (!all.every((state) => state === 'same')) return practice(id, id, false, `no tool-call guard or stop check in ${file}`, '`yokoten init` adds them');
  const trust = readTrust();
  return trustPractice(id, agent, file, trust, step) ?? unchecked(id, file, trust.store.slice(0, trust.store.lastIndexOf('/')));
}

/**
 * DeepSeek Harness's guard (#334): the hook in .dsh/hooks.json, the launch patch, and the bridge
 * in a dsh profile. The bridge fails open without a word, so the files and packages being
 * there never prove the guard runs: the ok line says only a real deny does. On Windows the
 * guard can't run at all (dsh uses PowerShell), so agentHooks gives a note instead (#332).
 */
function dshPractice(states: { guard: HookState; patch: string }, profiles: { found: string[]; all: string[] } | null): Practice {
  const id = 'deepseek-harness-hook';
  const file = dsh.HOOKS_FILE;
  const add = dsh.pluginAddCommands('<profile>').join(' && ');
  const { guard, patch } = states;
  if (typeof guard === 'object') return practice(id, id, false, guard.kind === 'json' ? `can't read ${file}` : `${file} has an unexpected shape`, 'make it valid JSON with a "hooks" object, then run `yokoten init`');
  if (guard === 'added') return practice(id, id, false, `no tool-call guard in ${file}`, '`yokoten init` adds it');
  if (guard === 'updated') return practice(id, id, false, `the tool-call guard in ${file} is out of date`, '`yokoten init` updates it');
  if (patch !== 'same') return practice(id, id, false, `${dsh.PATCH_FILE} is ${patch === 'added' ? 'missing' : 'out of date'}`, `\`yokoten init\` ${patch === 'added' ? 'adds' : 'updates'} it`);
  if (!profiles) return practice(id, id, false, "can't check the bridge: no dsh home (DSH_HOME, or ~/.dsh)", `once dsh is installed, add the bridge to each profile you use: ${add}`);
  if (!profiles.found.length) return practice(id, id, false, 'no dsh profile has the bridge and its peer, so dsh runs no hooks', `add both to each profile you use (needs pnpm): ${add}`);
  return { name: id, ok: true, finding: finding(id, '', ''), detail: `the bridge is in profile ${profiles.found.join(', ')}; start dsh at the repo root with --patch ${dsh.PATCH_FILE}. Only a real deny proves it` };
}

/**
 * Machine checks: the user-level hooks, the runtime, the private marks. The skills are a
 * step on the road. The Claude Code plugin brings its own hooks and runtime, so with it
 * on, those two checks pass; an old runtime that install left is still reported, with
 * the advice to remove it: installing again would keep both (#300).
 */
export function machineChecks(env: Env): Practice[] {
  const target = paths(env);
  const runtime = runtimeVersion(target.runtime);
  const plugin = hasPlugin(env);
  // A settings file doctor can't use names the problem, never says "missing" (#254); the
  // same two wordings as the Codex and Gemini CLI user hooks.
  const problem = userSettingsProblem(env);
  const session =
    problem?.kind === 'json'
      ? practice('session-doctor', 'session-doctor', false, "can't read ~/.claude/settings.json", 'make it valid JSON, then run `yokoten install`')
      : problem?.kind === 'shape'
        ? practice('session-doctor', 'session-doctor', false, '~/.claude/settings.json has an unexpected shape', `${problem.hint}; fix it, then run \`yokoten install\``)
        : practice('session-doctor', 'session-doctor', plugin || hasSessionDoctor(env), 'sessions do not start with doctor', 'run `yokoten install`, or install the Claude Code plugin');
  return [
    session,
    // 'runtime' in the text, as before; the id differs from the road's runtime step.
    practice('runtime', 'machine-runtime', runtime === VERSION || (plugin && runtime === null), runtime ? `the installed runtime is ${runtime}, this yokoten is ${VERSION}` : 'no runtime installed', plugin ? 'remove it with `yokoten uninstall`; the plugin brings its own' : 'run `yokoten install` from this copy of yokoten'),
    // Any mark counts, the ones install found too: only a file with none is missing (#522).
    practice('private-marks', 'private-marks', hasMarks(env), `${target.marks} is missing or has no marks`, EMPTY_MARKS_FIX),
  ];
}

/**
 * How many private marks are allowed in this repo, by where the allow comes from: its
 * yokoten.json (#424) and this machine (#447), and how many are skipped because they are
 * the repo's name (#447, record 0014). Counts, never the marks. `unsure` says why the
 * machine allows nothing here when yokoten can't tell.
 */
export function allowedMarkCount(env: Env, config: Pick<Config, 'privacy'>, root: string): { project: number; machine: number; ownName: number; unsure: string | null } {
  let marks: string[];
  try {
    marks = loadMarks(env);
  } catch {
    return { project: 0, machine: 0, ownName: 0, unsure: null }; // An unreadable file: the private-marks check says so.
  }
  if (!marks.length) return { project: 0, machine: 0, ownName: 0, unsure: null };
  const key = repoKey(root, env);
  const machine = machineAllowed(env, root, key);
  const ownName = skipsOwnName(env, config.privacy) ? sameNameMarks(marks, key).length : 0;
  return { project: ownMarks(marks, config.privacy.allow).length, machine: ownMarks(marks, machine.allow).length, ownName, unsure: machine.unsure };
}

/** What doctor says when an agent can't filter command output, and how to opt in to the stop (#390). */
export const UNFILTERED = 'only Claude Code hides your details in command output; other agents show it as it is';
export const OUTPUT_STOP = 'to stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json';

/** Whether this machine or project is set up for an agent other than Claude Code. */
function usesOtherAgent(env: Env, root: string | null): boolean {
  if (codex.hasUserDir(env) || gemini.hasUserDir(env) || grok.hasUserDir(env)) return true;
  if (!root) return false;
  const cli = hookCliPath(root);
  return codex.hasProjectHook(root) || gemini.hasProjectHook(root) || antigravity.projectHookState(root, cli) === 'same' || muse.projectHooksState(root, cli).guard === 'same' || grok.projectHooksState(root, cli).guard === 'same' || dsh.projectHooksState(root, cli).guard === 'same';
}

/**
 * What keeps the owner out of command output, as notes (#390): the git mailmap, and the
 * kinds of mark yokoten can't find on its own. Never a failure: both are a guess or a choice.
 */
export function privacyNotes(env: Env, root: string | null, output: Config['privacy']['output'] = 'run'): Practice[] {
  const notes: Practice[] = [];
  if (output !== 'stop' && usesOtherAgent(env, root)) notes.push(practice('private-output', 'private-output', false, UNFILTERED, OUTPUT_STOP));
  const mailmap = mailmapState(env);
  if (mailmap === 'unset') notes.push(practice('mailmap', 'mailmap', false, 'git log and git show print your name and email as they are', 'run `yokoten install`; it sets a git mailmap outside every repo'));
  if (mailmap === 'other') notes.push(practice('mailmap', 'mailmap', false, `git uses your own mailmap file, not ${MAILMAP_SETTING}`, `add the lines of ${MAILMAP_SETTING} to your file`));
  let marks: string[] = [];
  try {
    marks = loadMarks(env);
  } catch {
    // An unreadable file: the private-marks check says so.
  }
  // An offer, only when the file has marks: with none, the private-marks check says what to do (#522).
  const missing = marks.length ? missingMarkKinds(marks, machineMarks(env, { cwd: root ?? undefined })) : [];
  if (missing.length) notes.push(practice('private-mark-kinds', 'private-marks', false, offerMarkKinds(missing), OFFER_MARKS_FIX));
  return notes;
}

/**
 * The other agents' user hooks, from `install`: doctor at session start and the command
 * guard (#211). Only for a CLI this machine looks to use, its folder ~/.codex or ~/.gemini,
 * ~/.grok, or Muse's settings, so a Claude Code user hears nothing about tools they don't run.
 * Grok CLI gets the command guard only.
 *
 * Each hook is compared with what `install` would write (command, matcher, runtime path),
 * so an old one is out of date, not ok. A note, never MISSING, so it never changes the
 * exit code: no real Codex, Gemini CLI or Muse Code run has been seen to block through
 * these hooks yet (#30), and a folder left by a CLI tried once is not proof the user wants
 * yokoten there.
 */
export function userAgentHooks(env: Env): Practice[] {
  const report = (id: 'codex-user-hook' | 'gemini-user-hook' | 'grok-user-hook' | 'muse-user-hook', hooks: { doctor?: HookState; guard: HookState }, file: string): Practice => {
    // Grok CLI has no session-start doctor: it shows that output only to the user.
    const named = [...(hooks.doctor === undefined ? [] : [['session-start doctor', hooks.doctor] as const]), ['command guard', hooks.guard] as const];
    const missing = named.filter(([, state]) => state === 'added').map(([name]) => name);
    const stale = named.filter(([, state]) => state === 'updated').map(([name]) => name);
    const them = (names: readonly string[]) => (names.length > 1 ? 'them' : 'it');
    const problem = named.map(([, state]) => state).find((state) => typeof state === 'object');
    if (problem?.kind === 'json') return practice(id, id, false, `can't read ${file}`, 'make it valid JSON, then run `yokoten install`');
    const hand = handAddPractice(id, file, named.map(([, state]) => state));
    if (hand) return hand;
    if (problem?.kind === 'shape') return practice(id, id, false, `${file} has an unexpected shape`, `${problem.hint}; fix it, then run \`yokoten install\``);
    if (missing.length && stale.length) return practice(id, id, false, `no ${missing[0]} and an out-of-date ${stale[0]} in ${file}`, '`yokoten install` adds one and updates the other');
    if (stale.length) return practice(id, id, false, `the ${stale.join(' and the ')} in ${file} ${stale.length > 1 ? 'are' : 'is'} out of date`, `\`yokoten install\` updates ${them(stale)}`);
    return practice(id, id, !missing.length, `${missing.map((name) => `no ${name}`).join(' and ')} in ${file}`, `\`yokoten install\` adds ${them(missing)}`);
  };
  const checks: Practice[] = [];
  if (codex.hasUserDir(env)) checks.push(report('codex-user-hook', codex.userHooksState(env, USER_CLI, USER_MISSING), '~/.codex/hooks.json'));
  if (gemini.hasUserDir(env)) checks.push(report('gemini-user-hook', gemini.userHooksState(env, USER_CLI, USER_MISSING), '~/.gemini/settings.json'));
  if (grok.hasUserDir(env)) checks.push(report('grok-user-hook', grok.userHooksState(env, USER_CLI, USER_MISSING), grok.userHooksFile(env)));
  if (muse.hasUserDir(env)) checks.push(report('muse-user-hook', muse.userHooksState(env, USER_CLI, USER_MISSING), muse.userSettingsFile(env)));
  return checks;
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

/** The one command that updates the plugin, from a shell. */
export const PLUGIN_UPDATE = '`claude plugin update yokoten@yokoten`, then restart Claude Code';

/** The default branch refs doctor compares against, the first one present wins. Local only, no fetch. */
const DEFAULT_BRANCH_REFS = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/heads/main'];

/**
 * The commit at the tip of the default branch in `root`: `origin/HEAD`, else `origin/main`,
 * else `main`, whichever exists locally. Null when none does, or outside a git repo.
 */
function readDefaultBranch(root: string, env: Env): string | null {
  for (const ref of DEFAULT_BRANCH_REFS) {
    try {
      return execFileSync('git', ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Not here; try the next one.
    }
  }
  return null;
}

/** Whether `older` is in the history of `newer` in `root`. False when git doesn't know `older`. */
function isAncestor(root: string, older: string, newer: string, env: Env): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: root, env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A note when the enabled yokoten plugin is older than what doctor knows offline (#198).
 * Two comparisons, the first that can tell wins:
 * the plugin's package version against this yokoten's, and, in yokoten's own repo, the
 * plugin's commit against the default branch's tip: older only when it is in that tip's
 * history and not the tip. Not HEAD: on a feature branch HEAD descends from an up-to-date
 * plugin, and an update could not help.
 * Anything doctor can't compare (no install, an odd file, a commit git doesn't know) says
 * nothing. A note, never a failure. Files and local git only, so a session can run it.
 */
export function pluginAgeCheck(root: string | null, env: Env): Finding | null {
  if (!hasPlugin(env)) return null;
  const plugin = readInstalledPlugin(env, root);
  if (!plugin) return null;
  const note = (older: string, newer: string) => finding('plugin-version', `the yokoten plugin is older than this yokoten (${older} < ${newer})`, `update it: ${PLUGIN_UPDATE}`);
  if (plugin.version && compareVersions(plugin.version, VERSION) === -1) return note(plugin.version, VERSION);
  if (!root || !plugin.commit || !isSelf(root)) return null;
  const tip = readDefaultBranch(root, env);
  if (!tip || tip === plugin.commit || !isAncestor(root, plugin.commit, tip, env)) return null;
  return note(plugin.commit.slice(0, 12), tip.slice(0, 12));
}

/**
 * A note when the plugin is on and install's pieces are here too (#300): then the guard
 * and the session doctor run twice, and every skill shows up twice. It names what to
 * remove, and the one command that does it.
 */
export function doubleInstallCheck(env: Env): Finding | null {
  if (!hasPlugin(env)) return null;
  const pieces = installedPieces(env);
  if (!pieces.length) return null;
  return finding('machine-runtime', `the yokoten plugin is on, and \`yokoten install\` put these here too: ${pieces.join('; ')}`, 'remove them with `yokoten uninstall`; the plugin brings its own', {
    why: 'with both, the guard and the session doctor run twice and every skill shows up twice',
  });
}

/**
 * A note when install's runtime is here but no `yokoten` on the PATH runs it (#433): every
 * message says `yokoten init`, and that command is then not found. With the plugin on,
 * the plugin's own commands are used, so there is no note.
 */
export function launcherCheck(env: Env): Finding | null {
  if (hasPlugin(env)) return null;
  const { runtime } = paths(env);
  if (!existsSync(runtime) || isOnPath(env, runtime)) return null;
  const home = homeIn(env);
  const meanwhile = 'until then, `npx yokoten` runs yokoten';
  let fix = `run \`npx yokoten install\`; it puts a launcher in ${launcherDir(home)} and offers to add that folder to your PATH`;
  if (existsSync(launcherFile(home))) {
    fix = process.platform === 'win32'
      ? `add ${launcherDir(home)} to the Path for your account (search Windows for "environment variables for your account"), then open a new terminal; ${meanwhile}`
      : `add this line to your shell profile (~/.bashrc or ~/.zshrc), then open a new terminal: ${PROFILE_LINE}; ${meanwhile}`;
  }
  return finding('machine-runtime', 'the yokoten launcher is not on your PATH, so a bare yokoten command is not found', fix, {
    why: 'doctor names commands to run, and a command that is not found stops a beginner',
  });
}

/**
 * The one way to run yokoten in doctor's text (#500). Messages are written as `yokoten init`.
 * When no launcher on the PATH runs yokoten, that command is not found, so the text says
 * `npx yokoten init`, which works from anywhere. That is so when install's runtime is here but
 * off the PATH, and when this run is itself `npx` (npm sets `npm_command=exec`). With the plugin
 * on, its own commands are used. A command inside a hook that doctor shows for you to add by hand,
 * where the backtick has a backslash before it, stays as written: it must match the hook install writes.
 * Null when the messages stay as written.
 */
export function commandWording(env: Env): ((text: string) => string) | null {
  if (hasPlugin(env) || env.CLAUDE_PLUGIN_ROOT || homeOf(env) === null) return null;
  const { runtime } = paths(env);
  const isNpx = env.npm_command === 'exec';
  if (!isNpx && (!existsSync(runtime) || isOnPath(env, runtime))) return null;
  if (isNpx && isOnPath(env, runtime)) return null;
  return (text) => text.replace(/(?<!\\)`yokoten((?: [^`]*)?)`/g, '`npx yokoten$1`');
}

/** `value` with `reword` applied to every string in it (plain arrays and objects only). */
function rewordStrings<T>(value: T, reword: (text: string) => string): T {
  if (typeof value === 'string') return reword(value) as T;
  if (Array.isArray(value)) return value.map((item) => rewordStrings(item, reword)) as T;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewordStrings(item, reword)])) as T;
  }
  return value;
}

// Machine notes (record 0012): machine state that stops every agent session, where the
// agent can't see it. Read only and cheap. A session reads one filesystem and one small
// file, and never runs a child process. Each note is a note, never a failure, and a fix
// that needs sudo or Windows is printed for the owner to run, never run.

/** Free and total bytes of one filesystem. */
export interface DiskSpace {
  free: number;
  size: number;
}

/** What the machine notes read, so a test (and the self-test) can hand in a fake machine. */
export interface MachineProbe {
  /** The free and total bytes of the filesystem that holds `path`. Throws when it can't read them. */
  readDiskSpace(path: string): DiskSpace;
  /** The uid that owns `path`, or null when nothing is there. */
  readOwner(path: string): number | null;
  /** A program's stdout. Throws when it fails, or runs longer than `timeoutMs`. */
  runProgram(file: string, args: string[], timeoutMs: number): string;
  /** A file's text, or null when it can't be read. */
  readText(path: string): string | null;
  /** Write a file, making its folder. Throws when it can't. */
  writeText(path: string, text: string): void;
  /** This process's uid, or null where there is none (Windows). */
  uid: number | null;
  now(): Date;
  /** The running Node's version, as in `process.versions.node`. */
  nodeVersion: string;
}

/** The real machine. */
export const REAL_MACHINE: MachineProbe = {
  readDiskSpace(path) {
    const stats = statfsSync(path);
    return { free: Number(stats.bavail) * Number(stats.bsize), size: Number(stats.blocks) * Number(stats.bsize) };
  },
  readOwner(path) {
    try {
      return lstatSync(path).uid;
    } catch {
      return null;
    }
  },
  runProgram: (file, args, timeoutMs) => execFileSync(file, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }),
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: writeFileAtomic,
  uid: process.getuid?.() ?? null,
  now: () => new Date(),
  nodeVersion: process.versions.node,
};

const GB = 1024 ** 3;

/** How long full doctor waits for reg.exe. */
const REGISTRY_TIMEOUT_MS = 3000;

/** The file that tells a Linux process it runs in WSL. */
const WSL_INTEROP_FILE = '/proc/sys/fs/binfmt_misc/WSLInterop';

/** Where WSL keeps each distro's settings, its disk file's folder among them. */
const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

/**
 * Whether a disk is low on space. The default warns below 20 GB when that is also under
 * 10% of the disk. So a 250 GB drive with nothing free warns, and a 2 TB drive with
 * 150 GB free does not; a small disk is not warned at once. YOKOTEN_MIN_FREE_GB, when
 * set, is the one limit instead, in GB; 0 turns the warning off.
 */
export function isLowOnSpace(space: DiskSpace, env: Env): boolean {
  const limit = Number(env.YOKOTEN_MIN_FREE_GB);
  if (env.YOKOTEN_MIN_FREE_GB?.trim() && Number.isFinite(limit) && limit >= 0) return space.free < limit * GB;
  return space.free < 20 * GB && space.free < space.size / 10;
}

const formatGb = (bytes: number) => `${bytes < 10 * GB ? (bytes / GB).toFixed(1) : Math.round(bytes / GB)} GB`;
const formatSpace = (space: DiskSpace) => `${formatGb(space.free)} free of ${formatGb(space.size)}`;

/** Whether this Linux runs in WSL: WSL sets WSL_DISTRO_NAME, and the interop file is there. */
export const isWsl = (env: Env, probe: MachineProbe): boolean => Boolean(env.WSL_DISTRO_NAME) || probe.readText(WSL_INTEROP_FILE) !== null;

/** One WSL distro, as the registry lists it. */
export interface WslDistro {
  name: string;
  basePath: string;
  /** 1 or 2; WSL 2 when the registry does not say. */
  version: number;
}

/** The distros in the output of `reg.exe query <Lxss key> /s`. */
export function parseLxss(text: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const block of text.split(/\r?\n(?=HKEY_)/)) {
    const value = (name: string) => block.match(new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'm'))?.[1];
    const name = value('DistributionName');
    const basePath = value('BasePath');
    if (!name || !basePath) continue;
    distros.push({ name, basePath, version: Number.parseInt(value('Version') ?? '0x2', 16) === 1 ? 1 : 2 });
  }
  return distros;
}

/**
 * Where Linux mounts a Windows drive, from /proc/mounts: `C:\` on /mnt/c, for example.
 * Null when it is not mounted. Never a guess: a path that is not the drive would give
 * this Linux disk's numbers instead.
 */
export function findDriveMount(letter: string, mounts: string): string | null {
  const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
  for (const line of mounts.split('\n')) {
    const [source, target, type] = line.split(' ');
    if (!source || !target || !['9p', 'drvfs', 'virtiofs'].includes(type ?? '')) continue;
    if (unescape(source).toUpperCase().startsWith(`${letter.toUpperCase()}:`)) return unescape(target);
  }
  return null;
}

/** The Windows drive that holds this distro's disk file, as read now; or why it can't be read. */
export type HostDiskRead = { space: DiskSpace; distro: string; version: number } | { unread: string };

/**
 * In WSL, the Windows drive that holds this distro's disk file. Linux sees only the disk
 * file's own size, which can be far more than the drive has. Full doctor only: it runs
 * reg.exe, with a time cap.
 */
export function readHostDisk(env: Env, probe: MachineProbe): HostDiskRead {
  const distro = env.WSL_DISTRO_NAME;
  if (!distro) return { unread: 'WSL_DISTRO_NAME is not set' };
  const mounts = probe.readText('/proc/mounts') ?? '';
  const systemDrive = findDriveMount('C', mounts);
  const programs = ['reg.exe', ...(systemDrive ? [join(systemDrive, 'Windows', 'System32', 'reg.exe')] : [])];
  let text: string | null = null;
  for (const program of programs) {
    try {
      text = probe.runProgram(program, ['query', LXSS_KEY, '/s'], REGISTRY_TIMEOUT_MS);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { unread: 'reg.exe failed or took too long' };
    }
  }
  if (text === null) return { unread: 'reg.exe is not on the PATH' };
  const found = parseLxss(text).find((d) => d.name.toLowerCase() === distro.toLowerCase());
  if (!found) return { unread: 'the registry does not list this distro' };
  const letter = found.basePath.replace(/^\\\\\?\\/, '').match(/^([A-Za-z]):/)?.[1];
  if (!letter) return { unread: 'its disk file is not on a drive letter' };
  const mount = findDriveMount(letter, mounts);
  if (!mount) return { unread: `drive ${letter.toUpperCase()}: is not mounted in Linux` };
  try {
    return { space: probe.readDiskSpace(mount), distro: found.name, version: found.version };
  } catch {
    return { unread: `can't read drive ${letter.toUpperCase()}:` };
  }
}

/** The last reading of the Windows drive, kept so a session can repeat it without reg.exe. */
export interface HostDiskCache {
  free: number;
  size: number;
  /** When full doctor read it, in UTC. */
  readAt: string;
  distro: string;
  version: number;
}

/** The last reading, or null when there is none or the file is broken. */
export function readHostCache(env: Env, probe: MachineProbe): HostDiskCache | null {
  try {
    const cache = readMachineState(machineStateFile(env), probe).hostDisk as HostDiskCache | undefined;
    return cache && typeof cache.free === 'number' && typeof cache.size === 'number' && typeof cache.readAt === 'string' ? cache : null;
  } catch {
    return null;
  }
}

/** A kept reading older than this is not repeated: the drive may have changed since. */
const MAX_READING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The last reading when it is from the last 7 days, or null. */
export function readFreshHostCache(env: Env, probe: MachineProbe): HostDiskCache | null {
  const cache = readHostCache(env, probe);
  const age = cache ? probe.now().getTime() - Date.parse(cache.readAt) : Number.NaN;
  return cache && Number.isFinite(age) && age >= 0 && age <= MAX_READING_AGE_MS ? cache : null;
}

/** Keep the last reading. A file that can't be written is left: a session then says nothing about the host. */
export function saveHostCache(env: Env, probe: MachineProbe, cache: HostDiskCache): void {
  try {
    saveMachineState(machineStateFile(env), probe, 'hostDisk', cache);
  } catch {
    // no home, or a read-only one: the next full doctor reads the host again
  }
}

const SPACE_FIX = 'free some space: delete caches and build outputs you do not need, or move data to another disk';

/** The note for a disk low on space, or null when it has room. */
export function diskSpaceNote(where: string, space: DiskSpace, env: Env, fix: string = SPACE_FIX): Finding | null {
  return isLowOnSpace(space, env) ? finding('disk-space', `${where} has ${formatSpace(space)}`, fix) : null;
}

/** Microsoft's guide to a WSL disk file: how to compact it, and how to move it. */
export const WSL_DISK_GUIDE = 'https://learn.microsoft.com/windows/wsl/disk-space';

/**
 * The fix for a full Windows drive. A WSL 2 disk file only grows, so the fix points to
 * Microsoft's guide, never to a command: its sparse mode is marked unsafe (record 0012).
 */
export const HOST_DISK_FIX =
  `free some space on that drive in Windows. The VM's disk file only grows. Deleting files inside the VM frees nothing on the Windows drive. Back up your work to another drive first. Then free space on the Windows drive, or shrink or move the disk file: ${WSL_DISK_GUIDE}`;

const HOST_DRIVE = 'the Windows drive that holds this Linux disk';

/**
 * The disk notes: the disk that holds the repo, and in WSL the Windows drive under it.
 * Full doctor reads the Windows drive with reg.exe and keeps the reading. A session only
 * repeats the kept reading, and only when it was low.
 */
export function diskSpaceChecks(root: string, env: Env, probe: MachineProbe, session: boolean): Practice[] {
  const checks: Practice[] = [];
  const note = (name: string, found: Finding): Practice => ({ name, ok: false, finding: found });
  const fine = (name: string, detail: string): Practice => ({ name, ok: true, finding: finding('disk-space', '', ''), detail });
  try {
    const space = probe.readDiskSpace(root);
    const low = diskSpaceNote('the disk that holds this repo', space, env);
    checks.push(low ? note('disk-space', low) : fine('disk-space', formatSpace(space)));
  } catch {
    checks.push(note('disk-space', finding('disk-space', "can't read the free space of the disk that holds this repo", 'check it with `df -h .`, or in your file manager')));
  }
  // Without WSL_DISTRO_NAME (under sudo, or from systemd) there is no way to find the
  // drive, and a note every run would only nag: say nothing about it.
  if (!isWsl(env, probe) || !env.WSL_DISTRO_NAME) return checks;
  if (session) {
    const cache = readFreshHostCache(env, probe);
    const when = cache ? new Date(cache.readAt).toISOString().slice(0, 16).replace('T', ' ') : '';
    const low = cache && cache.version !== 1 && diskSpaceNote(`${HOST_DRIVE} (read ${when} UTC)`, cache, env, `${HOST_DISK_FIX}. Then run \`yokoten doctor\` to read the drive again`);
    if (low) checks.push(note('host-disk', low));
    return checks;
  }
  const host = readHostDisk(env, probe);
  // WSL 1 has no disk file: the repo's disk is that drive, and its note is above.
  if ('space' in host && host.version === 1) return checks;
  if ('unread' in host) {
    checks.push(note('host-disk', finding('disk-space', `can't read ${HOST_DRIVE}: ${host.unread}`, 'check its free space in Windows; when it fills, every session here stops')));
    return checks;
  }
  saveHostCache(env, probe, { free: host.space.free, size: host.space.size, readAt: probe.now().toISOString(), distro: host.distro, version: host.version });
  const low = diskSpaceNote(HOST_DRIVE, host.space, env, HOST_DISK_FIX);
  checks.push(low ? note('host-disk', low) : fine('host-disk', `${formatSpace(host.space)} on ${HOST_DRIVE}`));
  return checks;
}

/**
 * The note when another user owns Claude Code's temp folder, often root after a restart.
 * Claude Code then refuses to start, so the user runs full doctor in a terminal. The fix
 * needs sudo, so doctor prints it and never runs it. Null when there is no uid (Windows)
 * or no folder; ok when the folder is the user's.
 */
export function agentTempDirCheck(env: Env, probe: MachineProbe): Practice | null {
  if (probe.uid === null) return null;
  const dir = claudeTempDir(env, probe.uid);
  const owner = probe.readOwner(dir);
  if (owner === null) return null;
  if (owner === probe.uid) return { name: 'agent-temp-dir', ok: true, finding: finding('agent-temp-dir', '', '') };
  // A control character or a newline can't be pasted safely: name the folder, print no command.
  const isPastable = !/[\u0000-\u001f\u007f]/.test(dir);
  const shown = isPastable ? dir : JSON.stringify(dir);
  const fix = isPastable ? `run \`sudo rm -rf ${quoteForShell(dir)}\` yourself` : `remove the folder ${shown} yourself, with sudo`;
  return { name: 'agent-temp-dir', ok: false, finding: finding('agent-temp-dir', `${shown} belongs to uid ${owner}, not to you (uid ${probe.uid}), so Claude Code won't start`, `${fix}; Claude Code makes a new one when it starts`) };
}

/**
 * The first release of each supported Node line with the security fixes of 2026-10-21
 * (#572). Among them are TLS hostname checks, which yokoten's HTTPS calls to GitHub rely on:
 * https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
 * package.json "engines" and the docs name the same versions. A line not in this table and
 * older than the newest line in it (an odd line, or one past its end of life) gets no fixes.
 */
export const NODE_ADVISORY = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';
export const NODE_FIXED: Readonly<Record<number, string>> = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };

/**
 * The note when the running Node lacks the security fixes of October 2026 (#572): a
 * release older than its line's fix, or a line that gets no fixes at all. A Node line
 * newer than the table is fine: it came out after the fixes.
 */
export function nodeSecurityCheck(probe: Pick<MachineProbe, 'nodeVersion'>): Practice {
  const version = probe.nodeVersion.replace(/^v/, '');
  const line = Number.parseInt(version, 10);
  const fixed = NODE_FIXED[line];
  const lines = Object.keys(NODE_FIXED).map(Number);
  const newestLine = Math.max(...lines);
  const advisoryLink = `the advisory: ${NODE_ADVISORY}`;
  if (fixed && (compareVersions(version, fixed) ?? -1) < 0) {
    return { name: 'node-security', ok: false, finding: finding('node-security', `Node ${version} has known security holes that Node fixed in October 2026`, `upgrade Node to ${fixed} or later; ${advisoryLink}`) };
  }
  if (!fixed && line < newestLine) {
    const others = lines.filter((other) => other !== newestLine).map((other) => NODE_FIXED[other]).join(' or ');
    return { name: 'node-security', ok: false, finding: finding('node-security', `Node ${version} is not supported, because Node ${line} gets no more security fixes`, `install Node ${NODE_FIXED[newestLine]} or later (or ${others}); ${advisoryLink}`) };
  }
  return { name: 'node-security', ok: true, finding: finding('node-security', '', ''), detail: `Node ${version}` };
}

/** A leftover folder is one older than this: a test run that is still going is newer. */
const LEFTOVER_AGE_MS = 24 * 60 * 60 * 1000;

/** One `yokoten-*` folder in a temp folder, and when it last changed. */
export interface TempFolderEntry {
  name: string;
  mtimeMs: number;
}

/**
 * The `yokoten-*` folders in one temp folder: one read of the folder and one lstat per
 * match. Throws when the folder can't be read.
 */
export function readYokotenFolders(dir: string): TempFolderEntry[] {
  const entries: TempFolderEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.startsWith('yokoten-') || !entry.isDirectory()) continue;
    try {
      entries.push({ name: entry.name, mtimeMs: lstatSync(join(dir, entry.name)).mtimeMs });
    } catch {
      // removed while we read: it no longer counts
    }
  }
  return entries;
}

/**
 * The `yokoten-*` folders older than a day in the temp folders (#400): test runs left
 * them, and thousands of them fill a disk. Full doctor only. A count, no size: adding up
 * the size of thousands of folders takes a minute. Doctor prints the command, never runs it.
 * Null when there are none, or nothing can be read. `read` is a parameter so the self-test
 * can hand in folders that are not on the disk.
 */
export function leftoverTempCheck(env: Env, probe: MachineProbe, read: typeof readYokotenFolders = readYokotenFolders): Practice | null {
  const oldest = probe.now().getTime() - LEFTOVER_AGE_MS;
  let count = 0;
  const dirs: string[] = [];
  for (const dir of findTempDirs(env)) {
    try {
      const old = read(dir).filter((entry) => entry.mtimeMs < oldest).length;
      if (old) dirs.push(dir);
      count += old;
    } catch {
      // a temp folder that can't be read has nothing to say
    }
  }
  if (!count) return null;
  // A control character or a newline can't be pasted safely: name the folders, print no command.
  const isPastable = dirs.every((dir) => !/[\u0000-\u001f\u007f]/.test(dir));
  const where = dirs.map((dir) => (isPastable ? dir : JSON.stringify(dir))).join(' and ');
  const fix = isPastable
    ? `run \`find ${dirs.map(quoteForShell).join(' ')} -maxdepth 1 -name 'yokoten-*' -mmin +1440 -exec rm -rf {} +\` yourself; it removes only the ones older than a day`
    : 'remove the `yokoten-*` folders older than a day from those folders yourself';
  const folders = count === 1 ? '1 yokoten-* folder' : `${count} yokoten-* folders`;
  return { name: 'leftover-temp-folders', ok: false, finding: finding('leftover-temp-folders', `${folders} older than a day in ${where}`, fix) };
}

/**
 * A temp folder, in memory, with one `yokoten-*` folder two days old and one new: the
 * leftover check must count the old one only. No disk, so the session self-test stays fast.
 * `check` is a parameter so a test can hand in a broken one.
 */
export function leftoverControl(check: typeof leftoverTempCheck = leftoverTempCheck): string[] {
  const now = new Date(0);
  const probe: MachineProbe = { ...REAL_MACHINE, now: () => now };
  const read = () => [{ name: 'yokoten-old', mtimeMs: -2 * LEFTOVER_AGE_MS }, { name: 'yokoten-new', mtimeMs: 0 }];
  const note = check({ YOKOTEN_TEMP_DIRS: '/control' }, probe, read);
  return note?.ok === false && note.finding.what.startsWith('1 yokoten-* folder older') ? [] : ['leftover temp folder check'];
}

/** A word for a POSIX shell: in single quotes, each single quote inside closed, escaped and reopened. */
export const quoteForShell = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * A fake machine with no free space and a temp folder that root owns: both machine checks
 * must catch it, and in a fake WSL, the full Windows drive under it. The checks are
 * parameters so a test can hand in broken ones.
 */
export function machineControl(diskCheck: typeof diskSpaceChecks = diskSpaceChecks, tempCheck: typeof agentTempDirCheck = agentTempDirCheck, nodeCheck: typeof nodeSecurityCheck = nodeSecurityCheck): string[] {
  const fake: MachineProbe = {
    readDiskSpace: () => ({ free: 0, size: 250 * GB }),
    readOwner: () => 0,
    runProgram: () => {
      throw new Error('no programs in the control');
    },
    readText: () => null,
    writeText: () => {},
    uid: 1000,
    now: () => new Date(0),
    nodeVersion: '22.23.3',
  };
  const failed: string[] = [];
  if (diskCheck('/', {}, fake, true).every((c) => c.ok)) failed.push('disk space check');
  // The Windows drive is full while the Linux disk has room, as in the incident of record 0012.
  const registry = `${LXSS_KEY}\\{0}\r\n    DistributionName    REG_SZ    control\r\n    Version    REG_DWORD    0x2\r\n    BasePath    REG_SZ    \\\\?\\D:\\WSL\\control\r\n`;
  const wsl: MachineProbe = {
    ...fake,
    readDiskSpace: (path) => ({ free: path === '/mnt/d' ? 0 : 200 * GB, size: 250 * GB }),
    runProgram: () => registry,
    readText: (path) => (path === '/proc/mounts' ? 'none / ext4 rw 0 0\nD:\\134 /mnt/d 9p rw 0 0\n' : null),
  };
  const host = diskCheck('/', { WSL_DISTRO_NAME: 'control', HOME: '/nonexistent' }, wsl, false).find((c) => c.name === 'host-disk');
  if (host?.ok !== false || !host.finding.what.startsWith(`${HOST_DRIVE} has`)) failed.push('host drive check');
  if (tempCheck({}, fake)?.ok !== false) failed.push('agent temp dir check');
  if (nodeCheck(fake).ok || !nodeCheck({ nodeVersion: '24.22.1' }).ok) failed.push('node security check');
  return failed;
}

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
function roadControl(): string[] {
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

/** What doctor can't read on the server yet, and the owner sets once per repo. */
const OWNER_STEPS = ['the bot: a GitHub App (or collaborator) with write access; CODEOWNERS sends CI changes to you'];

/** The settings to check by hand when doctor can't read the server. */
const BY_HAND = [
  'main: a ruleset with pull request required, the CI check required, code owner review, no force push, no deletion; squash merge only, delete branch on merge',
  'tags: a ruleset on v* so only you create, move or delete a release tag',
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
const NO_REMOTE_FIX = 'run `git remote add origin <url>` with the url of the repo on your code host, then run `yokoten doctor` again';

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
  const base = { version: VERSION, selfTest: { ok: !failed.length, failed }, stages: STAGES };
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
    const double = hasHome ? doubleInstallCheck(env) : null;
    if (double) blocks.push([`yokoten: ${formatFinding(double)}`]);
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
    const notes = [...unsaved.notes, ...lesson.findings];
    const ok = !failed.length && !isCoreBehind;
    return { ok, lines: blocks.flat(), blocks, report: { ...base, ok, repo: true, stage, next, findings, ...(notes.length ? { notes } : {}) } };
  }

  lines.push(`yokoten ${VERSION}, self-test ${failed.length ? 'FAILED' : 'ok'}`);
  lines.push(where.stage ? `the road: stage ${where.stage} of ${STAGES.length}, ${STAGES[where.stage - 1]}` : `the road: ${ROAD_DONE.replace(/^yokoten: /, '')}`);
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
  // Work only on this machine (#365): notes, never a failure, and read only. Read here, so
  // the state file is found in the git folder it names, as a session start finds it (#453).
  const unsaved = readUnsaved(root, { env });
  const noCi = noCiNote(config.notNow, where.stage, server);
  if (noCi) {
    lines.push(`  note    no-ci: ${stepText(noCi)}`);
    notes.push(noCi);
  }
  // Full doctor keeps which lessons this clone has seen; a session start keeps only which it ran.
  const stateFile = unsaved?.commonDir ? join(unsaved.commonDir, STATE_FILE) : findStateFile(root, env);
  const state = readState(stateFile);
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
  lines.push(...formatLessonChecks(lessons));
  notes.push(...lessons.flatMap((lesson) => lesson.findings));
  const checkNotes: Finding[] = [];
  const problems = check(root, { config, env, notes: checkNotes });
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
  for (const c of [...userAgentHooks(env), ...diskSpaceChecks(root, env, probe, false), ...(agentTemp ? [agentTemp] : []), ...(leftovers ? [leftovers] : []), nodeSecurityCheck(probe)]) {
    lines.push(`  ${c.ok ? 'ok     ' : 'note   '} ${c.name}${c.ok ? (c.detail ? `: ${c.detail}` : '') : `: ${stepText(c.finding)}`}`);
    if (!c.ok) notes.push(c.finding);
  }
  const stale = pluginAgeCheck(root, env);
  if (stale) {
    lines.push(`  note    plugin: ${stepText(stale)}`);
    notes.push(stale);
  }
  const double = hasHome ? doubleInstallCheck(env) : null;
  if (double) {
    lines.push(`  note    plugin-and-install: ${stepText(double)}`);
    notes.push(double);
  }
  const launcher = hasHome ? launcherCheck(env) : null;
  if (launcher) {
    lines.push(`  note    command: ${stepText(launcher)}`);
    notes.push(launcher);
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
