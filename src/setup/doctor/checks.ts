// Checks outside the road: agent hooks, machine setup, privacy notes, plugin age,
// the launcher, and the wording of a command. Practice is shared with the other parts.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Config, type Env } from '../../rules/config.ts';
import { type Finding, finding, type RuleId } from '../../rules/message.ts';
import { homeIn, homeOf, loadMarks, machineAllowed, ownMarks, repoKey, sameNameMarks, skipsOwnName } from '../../rules/privacy.ts';
import * as antigravity from '../../agents/runtimes/antigravity.ts';
import { hasPlugin, hasProjectHook, hasSessionDoctor, readInstalledPlugin, userDir, userSettingsProblem } from '../../agents/runtimes/claude-code.ts';
import * as codex from '../../agents/runtimes/codex.ts';
import * as copilot from '../../agents/copilot.ts';
import * as dsh from '../../agents/runtimes/deepseek-harness.ts';
import * as gemini from '../../agents/runtimes/gemini.ts';
import * as grok from '../../agents/runtimes/grok.ts';
import * as muse from '../../agents/runtimes/muse.ts';
import type { FolderTrust } from '../../agents/folder-trust.ts';
import { commentedFile, HAND_ADD, handAddJson, type HookState, mergeHandAdds } from '../../agents/hooks-file.ts';
import { runtimeVersion, VERSION } from '../files.ts';
import { compareVersions, hookCliPath, isSelf, readCoreRules, summarizeUpdate } from '../init.ts';
import { EMPTY_MARKS_FIX, marksState, UNREADABLE_MARKS, UNREADABLE_MARKS_FIX, OFFER_MARKS_FIX, offerMarkKinds, launcherFile, PROFILE_LINE, installedPieces, isOnPath, launcherDir, machineMarks, mailmapState, MAILMAP_SETTING, missingMarkKinds, paths, USER_CLI, USER_MISSING } from '../install.ts';

export interface Practice {
  name: string;
  ok: boolean;
  finding: Finding;
  detail?: string;
}

export const practice = (name: string, id: RuleId, ok: boolean, what: string, fix: string): Practice => ({ name, ok, finding: finding(id, what, fix) });


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
  const marksNow = marksState(env);
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
    marksNow === 'unreadable'
      ? practice('private-marks', 'private-marks', false, UNREADABLE_MARKS, UNREADABLE_MARKS_FIX)
      : practice('private-marks', 'private-marks', marksNow === 'some', `${target.marks} is missing or has no marks`, EMPTY_MARKS_FIX),
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
 * The note when Muse is set up here and Claude Code's user rules file is in the home
 * folder (#681). The file is named, never read. A desk hides the home folder.
 */
export function museClaudeRules(env: Env, root: string | null): Practice | null {
  if (!root || !homeOf(env)) return null;
  // Existence only. The file's text can name a person, so doctor never reads it.
  if (!existsSync(join(root, '.muse', 'hooks.json')) || !existsSync(join(userDir(env), 'CLAUDE.md'))) return null;
  return practice('muse-claude-rules', 'muse-claude-rules', false, "outside a desk, Muse can send ~/.claude/CLAUDE.md to Muse's model", 'run Muse in a desk (`yokoten desk muse`) so the home folder stays hidden');
}

/**
 * Notes that do not fail doctor (#390, #681): the git mailmap, the kinds of mark yokoten
 * can't find on its own, and Muse sending Claude Code's user rules to its model. Each is
 * a guess or a choice.
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
  const claudeRules = museClaudeRules(env, root);
  if (claudeRules) notes.push(claudeRules);
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

