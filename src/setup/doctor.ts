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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { countNotes, type LessonPlace, listLessons, runLessons, waitingLine } from '../run/learn.ts';
import * as antigravity from '../agents/runtimes/antigravity.ts';
import { hasPlugin, hasProjectHook, hasSessionDoctor, readInstalledPlugin, userSettingsProblem } from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as copilot from '../agents/runtimes/copilot.ts';
import * as dsh from '../agents/runtimes/deepseek-harness.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as muse from '../agents/runtimes/muse.ts';
import type { FolderTrust } from '../agents/folder-trust.ts';
import { commentedFile, HAND_ADD, handAddJson, type HookState, mergeHandAdds } from '../agents/hooks-file.ts';
import { type Gh, readServer, repoOf, type ServerSettings, type Unread } from '../host/github.ts';
import { readUnsaved, UNSAVED_CONTROL, unsavedNotes } from './advice/unsaved.ts';
import { HOME_DIR, KIT, runtimeVersion, VERSION } from './files.ts';
import { cliPath, compareCoreRules, compareVersions, isSelf, readCoreRules, summarizeUpdate } from './init.ts';
import { countOwnMarks, fillMarks, filledLine, trySafely, installedPieces, machineMarks, mailmapState, MAILMAP_SETTING, missingMarkKinds, paths, USER_CLI, USER_MISSING } from './install.ts';
import { type Mark, road, ROAD, ROAD_SERVER_IDS, type ServerCheck, serverChecks, type ServerRead, STAGES, stepFinding, stepText, walk } from './road.ts';

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
  if (!checkCommand('git push origin --tags', { env: {} })) failed.push('release guard');
  if (!checkCommand('git commit --no-verify -m x', { env: {} })) failed.push('skip-check guard');
  if (!checkEdit('test/a.test.ts', { config: DEFAULTS, env: { YOKOTEN_FIX_TASK: '1' } })) failed.push('test guard');
  if (!checkEdit('AGENTS.md', { config: DEFAULTS, env: { YOKOTEN_ROLE: 'worker' } })) failed.push('lead-only guard');
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
  return failed;
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
 * over them. Real runs blocked through Codex, Antigravity CLI, Muse Code and DeepSeek Harness; Gemini CLI is not run yet (#30).
 * A Gemini CLI file with comments, which init won't rewrite, gets the hooks to add by hand.
 * Codex, Muse Code and Copilot CLI run the hooks only in a folder the user trusts: `env`
 * finds their trust stores (HOME, CODEX_HOME, XDG_CONFIG_HOME, COPILOT_HOME).
 */
export function agentHooks(root: string, env: Env, platform: string = process.platform): Practice[] {
  // Each step wants both project hooks: the tool-call guard and the stop check (#211).
  const missing = (guard: boolean, stop: boolean, file: string) =>
    [...(guard ? [] : ['no tool-call guard']), ...(stop ? [] : ['no stop check'])].join(' and ') + ` in ${file}`;
  const [codexGuard, codexStop] = [codex.hasProjectHook(root), codex.hasProjectStopHook(root)];
  const [geminiGuard, geminiStop] = [gemini.hasProjectHook(root), gemini.hasProjectStopHook(root)];
  const geminiState = geminiGuard && geminiStop ? null : gemini.projectHooksState(root, cliPath(root));
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
    antigravityPractice(antigravity.projectHookState(root, cliPath(root))),
    musePractice(muse.projectHooksState(root, cliPath(root)), () => muse.readTrust(root, env)),
    platform === 'win32' ? practice('deepseek-harness-hook', 'deepseek-harness-hook', false, dsh.WINDOWS_GAP, 'nothing to do yet: issue #332 adds a PowerShell guard') : dshPractice(dsh.projectHooksState(root, cliPath(root)), dsh.profilesWithBridge(env)),
  ];
}

/** Antigravity CLI's guard in .agents/hooks.json: one hook, no stop check (its Stop event has no `stop_hook_active`). */
function antigravityPractice(state: HookState): Practice {
  const file = '.agents/hooks.json';
  if (typeof state === 'object') return practice('antigravity-hook', 'antigravity-hook', false, state.kind === 'json' ? `can't read ${file}` : `${file} has an unexpected shape`, state.kind === 'shape' ? `${state.hint}; fix it, then run \`yokoten init\`` : 'make it valid JSON, then run `yokoten init`');
  if (state === 'updated') return practice('antigravity-hook', 'antigravity-hook', false, `the tool-call guard in ${file} is out of date or off`, '`yokoten init` updates it');
  return practice('antigravity-hook', 'antigravity-hook', state === 'same', `no tool-call guard in ${file}`, '`yokoten init` adds it');
}

/** Muse Code's tool-call guard and stop check in .muse/hooks.json: missing, out of date, a file init can't edit, or a folder Muse does not trust. */
function musePractice(states: { guard: HookState; stop: HookState }, readTrust: () => FolderTrust): Practice {
  const file = '.muse/hooks.json';
  const all = [states.guard, states.stop];
  const problem = all.find((state) => typeof state === 'object');
  if (problem) return practice('muse-hook', 'muse-hook', false, problem.kind === 'json' ? `can't read ${file}` : `${file} has an unexpected shape`, 'make it valid JSON with a "hooks" object, then run `yokoten init`');
  if (all.includes('updated')) return practice('muse-hook', 'muse-hook', false, `the hooks in ${file} are out of date`, '`yokoten init` updates them');
  if (!all.every((state) => state === 'same')) return practice('muse-hook', 'muse-hook', false, `no tool-call guard or stop check in ${file}`, '`yokoten init` adds them');
  const trust = readTrust();
  return trustPractice('muse-hook', 'Muse Code', file, trust, muse.TRUST_STEP) ?? unchecked('muse-hook', file, trust.store.replace('/trust.json', ''));
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
    // The marks yokoten found on the machine don't count: only the owner knows a city (#390).
    practice('private-marks', 'private-marks', countOwnMarks(env) > 0, loadMarks(env).length ? `${target.marks} has only the marks yokoten found on this machine` : `${target.marks} is missing or empty`, 'add your name, city, domain and server names to it, one per line'),
  ];
}

/** What doctor says when an agent can't filter command output, and how to opt in to the stop (#390). */
export const UNFILTERED = 'only Claude Code hides your details in command output; other agents show it as it is';
export const OUTPUT_STOP = 'to stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json';

/** Whether this machine or project is set up for an agent other than Claude Code. */
function usesOtherAgent(env: Env, root: string | null): boolean {
  if (codex.hasUserDir(env) || gemini.hasUserDir(env)) return true;
  if (!root) return false;
  const cli = cliPath(root);
  return codex.hasProjectHook(root) || gemini.hasProjectHook(root) || antigravity.projectHookState(root, cli) === 'same' || muse.projectHooksState(root, cli).guard === 'same' || dsh.projectHooksState(root, cli).guard === 'same';
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
  const missing = missingMarkKinds(marks, machineMarks(env, { cwd: root ?? undefined }));
  if (missing.length) notes.push(practice('private-mark-kinds', 'private-marks', false, `your private marks may lack ${missing.join(', ')}`, `add them to ${paths(env).marks}, one per line`));
  return notes;
}

/**
 * The other agents' user hooks, from `install`: doctor at session start and the command
 * guard (#211). Only for a CLI this machine looks to use, its folder ~/.codex or
 * ~/.gemini, so a Claude Code user hears nothing about tools they don't run.
 *
 * Each hook is compared with what `install` would write (command, matcher, runtime path),
 * so an old one is out of date, not ok. A note, never MISSING, so it never changes the
 * exit code: no real Codex or Gemini CLI run has been seen to block through these hooks
 * yet (#30), and a folder left by a CLI tried once is not proof the user wants yokoten there.
 */
export function userAgentHooks(env: Env): Practice[] {
  const report = (id: 'codex-user-hook' | 'gemini-user-hook', hooks: { doctor: HookState; guard: HookState }, file: string): Practice => {
    const named = [['session-start doctor', hooks.doctor], ['command guard', hooks.guard]] as const;
    const missing = named.filter(([, state]) => state === 'added').map(([name]) => name);
    const stale = named.filter(([, state]) => state === 'updated').map(([name]) => name);
    const them = (names: readonly string[]) => (names.length > 1 ? 'them' : 'it');
    const problem = named.map(([, state]) => state).find((state) => typeof state === 'object');
    if (problem?.kind === 'json') return practice(id, id, false, `can't read ${file}`, 'make it valid JSON, then run `yokoten install`');
    const hand = handAddPractice(id, file, [hooks.doctor, hooks.guard]);
    if (hand) return hand;
    if (problem?.kind === 'shape') return practice(id, id, false, `${file} has an unexpected shape`, `${problem.hint}; fix it, then run \`yokoten install\``);
    if (missing.length && stale.length) return practice(id, id, false, `no ${missing[0]} and an out-of-date ${stale[0]} in ${file}`, '`yokoten install` adds one and updates the other');
    if (stale.length) return practice(id, id, false, `the ${stale.join(' and the ')} in ${file} ${stale.length > 1 ? 'are' : 'is'} out of date`, `\`yokoten install\` updates ${them(stale)}`);
    return practice(id, id, !missing.length, `${missing.map((name) => `no ${name}`).join(' and ')} in ${file}`, `\`yokoten install\` adds ${them(missing)}`);
  };
  const checks: Practice[] = [];
  if (codex.hasUserDir(env)) checks.push(report('codex-user-hook', codex.userHooksState(env, USER_CLI, USER_MISSING), '~/.codex/hooks.json'));
  if (gemini.hasUserDir(env)) checks.push(report('gemini-user-hook', gemini.userHooksState(env, USER_CLI, USER_MISSING), '~/.gemini/settings.json'));
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
function readDefaultBranch(root: string): string | null {
  for (const ref of DEFAULT_BRANCH_REFS) {
    try {
      return execFileSync('git', ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Not here; try the next one.
    }
  }
  return null;
}

/** Whether `older` is in the history of `newer` in `root`. False when git doesn't know `older`. */
function isAncestor(root: string, older: string, newer: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: root, stdio: 'ignore' });
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
  const tip = readDefaultBranch(root);
  if (!tip || tip === plugin.commit || !isAncestor(root, plugin.commit, tip)) return null;
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

/** The server settings of the project's origin remote, or why they can't be read. */
function readOrigin(root: string, gh: Gh): ServerSettings | Unread {
  let remote = '';
  try {
    remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // no origin remote
  }
  if (!remote.trim()) return { unread: 'there is no origin remote yet', fix: 'add one on GitHub to check the server settings, or check them by hand' };
  const repo = repoOf(remote);
  return repo ? readServer(gh, repo) : { unread: 'the origin remote is not on a host yokoten knows (GitHub for now)', fix: 'add a GitHub origin remote, or check these settings by hand' };
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
export function sessionUnsaved(root: string, env: Env, clock?: () => number): { lines: string[]; notes: Finding[] } {
  const facts = readUnsaved(root, { env, budget: { ms: SESSION_UNSAVED_BUDGET, ...(clock ? { clock } : {}) } });
  const notes = facts ? unsavedNotes(facts, { home: env.HOME, session: true }) : [];
  const stopped = facts?.isPartial ? [STOPPED_EARLY] : [];
  if (!notes.length) return { lines: stopped, notes };
  const more = notes.length - SESSION_UNSAVED_LIMIT;
  const lines = notes.slice(0, SESSION_UNSAVED_LIMIT).map((f) => `yokoten: ${stepText(f)}.`);
  if (more > 0) lines.push(`yokoten: ${more} more like this; \`yokoten doctor\` lists them all.`);
  return { lines: [...lines, ...stopped, UNSAVED_OFFER], notes };
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

/** The report, as text lines and as data, and whether doctor found no problem. */
export function doctor(
  root: string | null,
  { env, config, session = false, gh, fillMarks: isFilling = false }: { env: Env; config: Config; session?: boolean; gh?: Gh; fillMarks?: boolean },
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
  // Full doctor from the command line adds the obvious marks first (#390); a session writes nothing.
  const filled = isFilling && !session ? trySafely('the marks from this machine', () => [filledLine(fillMarks(env, machineMarks(env, { cwd: root, gh })), paths(env).marks)])[0] : null;
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
    // A stale plugin keeps old guard rules running; the session hears it (#198).
    const stale = pluginAgeCheck(root, env);
    if (stale) lines.push(`yokoten: ${formatFinding(stale)}`);
    const double = doubleInstallCheck(env);
    if (double) lines.push(`yokoten: ${formatFinding(double)}`);
    const unsaved = sessionUnsaved(root, env);
    lines.push(...unsaved.lines);
    // A lesson the kit learned reaches the project here: the session hears it (#120).
    if (core && isCoreBehind) {
      lines.push(`yokoten: ${formatFinding(core.finding)}`);
      findings.push(core.finding);
    }
    const waiting = upstreamNote(root, env);
    if (waiting) {
      lines.push(`yokoten: ${waiting.what}`);
      findings.push(waiting);
    }
    const ok = !failed.length && !isCoreBehind;
    return { ok, lines, report: { ...base, ok, repo: true, stage, next, findings, ...(unsaved.notes.length ? { notes: unsaved.notes } : {}) } };
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
  for (const c of agentHooks(root, env)) {
    lines.push(`  ${c.ok ? 'ok     ' : 'note   '} ${c.name}${c.ok ? (c.detail ? `: ${c.detail}` : '') : `: ${stepText(c.finding)}`}`);
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
  const nextSeen = seenAfter(seenLessons, lessons);
  if (nextSeen.length > seenLessons.length) saveState(stateFile, { ...state, seenLessons: nextSeen });
  lines.push(...formatLessonChecks(lessons));
  notes.push(...lessons.flatMap((lesson) => lesson.findings));
  const checkNotes: Finding[] = [];
  const problems = check(root, { config, env, notes: checkNotes });
  findings.push(...problems);
  lines.push(`  ${problems.length ? 'MISSING' : 'ok     '} tree: ${problems.length ? `${problems.length} problem(s), run \`yokoten check\`` : 'layout and privacy clean'}`);
  // check's own notes (#228), such as an unknown yokoten.json key or a translation behind: worded as check words them, and never a failure.
  for (const n of checkNotes) lines.push(`  note    ${formatFinding(n).replaceAll('\n', '\n        ')}`);
  notes.push(...checkNotes);
  // Work only on this machine (#365): notes, never a failure, and read only.
  const unsaved = readUnsaved(root, { env });
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
  if (filled) lines.push(`  note    ${filled}`);
  for (const c of privacyNotes(env, root, config.privacy.output)) {
    lines.push(`  note    ${c.name}: ${stepText(c.finding)}`);
    notes.push(c.finding);
  }
  for (const c of userAgentHooks(env)) {
    lines.push(`  ${c.ok ? 'ok     ' : 'note   '} ${c.name}${c.ok ? '' : `: ${stepText(c.finding)}`}`);
    if (!c.ok) notes.push(c.finding);
  }
  const stale = pluginAgeCheck(root, env);
  if (stale) {
    lines.push(`  note    plugin: ${stepText(stale)}`);
    notes.push(stale);
  }
  const double = doubleInstallCheck(env);
  if (double) {
    lines.push(`  note    plugin-and-install: ${stepText(double)}`);
    notes.push(double);
  }
  const waiting = upstreamNote(root, env);
  if (waiting) {
    lines.push(`  note    upstream-inbox: ${waiting.what}`);
    notes.push(waiting);
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
  lines.push(...listBoardSteps(server));
  // The road has no failed mark: a step is done, to do, not now or can't check. Steps
  // left are the way ahead, not problems, so they never fail doctor (#208).
  const ok = !failed.length && !isCoreBehind && !problems.length && machine.every((c) => c.ok);
  return { ok, lines, report: { ...base, ok, repo: true, stage: where.stage, next, findings, steps, notes, server: settings.map(({ id, mark }) => ({ id, mark })), lessons: lessons.map(({ id, mark, reason, isNew }) => ({ id, mark, ...(reason === undefined ? {} : { reason }), ...(isNew ? { isNew } : {}) })) } };
}
