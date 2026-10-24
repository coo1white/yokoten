import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as antigravity from '../../agents/runtimes/small/antigravity.ts';
import { addProjectHook, addProjectSandbox as addClaudeSandbox, addProjectStopHook, checkProjectSettings, setProjectEnv } from '../../agents/runtimes/claude-code.ts';
import * as codex from '../../agents/runtimes/codex.ts';
import * as copilot from '../../agents/copilot.ts';
import * as dsh from '../../agents/runtimes/small/deepseek-harness.ts';
import * as gemini from '../../agents/runtimes/gemini.ts';
import * as grok from '../../agents/runtimes/grok.ts';
import * as muse from '../../agents/runtimes/muse.ts';
import * as opencode from '../../agents/runtimes/small/opencode.ts';
import { isFolder } from '../../agents/folder-trust.ts';
import { type Problem, skippedBecause, UnreadableHooksFile } from '../../agents/hooks-file.ts';
import { withGitReads } from '../../run/check.ts';
import { type Env } from '../../rules/config.ts';
import { homeOf } from '../../rules/privacy.ts';
import { type Gh, ghIn } from '../../host/github/index.ts';
import { writeTestsJob } from '../advice/tests-job.ts';
import type { Ask } from '../install.ts';
import { copyRuntime, describeWrite, HOME_DIR, KIT, render, VERSION, writeNew } from '../files.ts';
import { isCiFile, isCiOffIn, keepCiOff, lexists, privateRepoNote } from './ci-off.ts';
import { addCoreRules } from './core-rules.ts';
import { handOffBlocks, importRules, readHookSetup, setCommitCheck, writeGithooks } from './claude-hooks.ts';
import { cliPath, hookCliPath, isSelf, walk, writeCodeOwners, writeDependabot, writeGitignore } from './project-files.ts';
import { WORKFLOWS_DIR, writeWorkflow } from './workflows.ts';

export { findRulesGap, claudeReadsRules, withGitReads, readHookSetup, COMMIT_HOOKS, type CommitHook, hookFile, checkLines, isExecutable } from './claude-hooks.ts';
export { isCommitHook, type OldHook, readOldHooks, handOffLines, hasHandOff, placeHandOff, handOffBlocks, deadHookNotes } from './claude-hooks.ts';
export { PROJECT_HEADING, type MovedHeading, type MovedRules, splitFrontMatter, demoteHeadings, moveUnderProjectHeading, AGENTS_BACKUP, readKitVersion, compareVersions, type LineChange, type SectionChanges, type CoreRules, compareCoreRules, readCoreRules, summarizeUpdate, updateCoreRules } from './core-rules.ts';
export { NO_CI_REASON } from './ci-off.ts';
export { isSelf, cliPath, hookCliPath, OWNER_PLACEHOLDER, ownedPath, codeOwnersText, findEcosystems, formatDependabotBlock, readDependabotEcosystems } from './project-files.ts';
export { type WorkflowState, hasIntactKitJobs, compareWorkflow, workflowDiffCommand, workflowNotes } from './workflows.ts';

// `yokoten init`: put the practices into a project. It only adds: a file that is already
// there is kept, and the report says so. Some files get lines added, never removed: a
// CLAUDE.md, and a project's own pre-commit and pre-merge-commit (#206, #239). An
// AGENTS.md without `## This project` gets the core rules on top, and its own text moves
// under that heading (#378). A kit workflow the project never changed is replaced by the
// kit's newest (#456). A hook the
// clone has in .git/hooks keeps running from .githooks (#256). Deciding
// what to do with a project's own rules (keep, merge, or say not now) is the yokoten
// skill's job, not this command's.
//
// `yokoten update` is the one command that replaces text: the core rules in AGENTS.md,
// and only with --write. It is in `core-rules.ts`.

function agentHooks(name: string, file: string, add: () => string[]): { ok: boolean; lines: string[] } {
  try {
    return { ok: true, lines: add() };
  } catch (err) {
    if (!(err instanceof UnreadableHooksFile)) throw err;
    return { ok: false, lines: [`skipped ${name}: ${skippedBecause(file, err.problem, 'init')}`] };
  }
}

/** What init did with one agent's project sandbox: added, same, kept (yours differs), or why it skipped. */
type SandboxWrite = 'added' | 'same' | 'kept' | 'hand' | 'unreadable' | Problem;

/** One init line for one agent's sandbox (#589). */
function sandboxLine(agent: string, file: string, why: string, write: SandboxWrite): string {
  if (write === 'added') return `added the ${agent} sandbox in ${file} (${why})`;
  if (write === 'same') return describeWrite('same', `the ${agent} sandbox in ${file}`);
  if (write === 'kept') return `kept your ${agent} sandbox in ${file} (doctor names what differs)`;
  if (write === 'hand') return `skipped the ${agent} sandbox: ${file} has comments, so add ${gemini.SANDBOX_HAND_ADD} by hand, then run \`yokoten init\` again`;
  if (write === 'unreadable') return `skipped the ${agent} sandbox: can't read ${file} (make it readable, then run \`yokoten init\` again)`;
  return `skipped the ${agent} sandbox: ${skippedBecause(file, write, 'init')}`;
}

/**
 * The project sandboxes init writes (#589): Claude's, Codex's, Gemini's YOLO block and
 * Grok's profile. Written whether or not the agent is installed here, like the hooks.
 * `ok` is false when a sandbox file was skipped; a sandbox the user set stays (`kept`).
 */
function sandboxLines(root: string): { ok: boolean; lines: string[] } {
  const writes: [string, string, string, SandboxWrite][] = [
    ['Claude Code', '.claude/settings.json', 'shell commands stay in the project; new network hosts ask first', addClaudeSandbox(root)],
    ['Codex', '.codex/config.toml', 'writes stay in the project; network is off; Codex asks before going beyond', codex.addProjectSandbox(root)],
    ['Gemini', '.gemini/settings.json', 'YOLO mode, which approves everything, stays off', gemini.addProjectSandbox(root)],
    ['Grok', '.grok/sandbox.toml', 'the yokoten profile keeps writes in the project', grok.addProjectSandbox(root)],
  ];
  return {
    ok: writes.every(([, , , write]) => write === 'added' || write === 'same' || write === 'kept'),
    lines: writes.map(([agent, file, why, write]) => sandboxLine(agent, file, why, write)),
  };
}

/** How long init waits for GitHub to say whether the remote owner is an organization. */
const ORG_LOOKUP_MS = 5000;

/**
 * Whether Copilot CLI looks used on this machine. Its home is `$COPILOT_HOME` when that
 * is set, and `~/.copilot` otherwise: the same folder its trust store lives in (#654).
 */
function hasCopilotHome(env: Env): boolean {
  const user = homeOf(env);
  const home = env.COPILOT_HOME || (user ? join(user, '.copilot') : '');
  return isFolder(home);
}

/** A trust step, or a DeepSeek bridge command. Printed only when that agent is installed (#654). */
function isTrustStep(line: string): boolean {
  return line.startsWith('GitHub Copilot CLI runs the hooks')
    || line.startsWith('to trust this folder in Copilot CLI')
    || line.startsWith('Codex runs the hooks')
    || line.startsWith('to trust them in Codex')
    || line.startsWith('Muse Code runs the hooks')
    || line.startsWith('Grok CLI runs the hooks')
    || line.includes('dsh plugin --profile')
    || line.includes('dsh <profile> --patch');
}

/**
 * Drop trust steps when `show` is false: the agent is not installed here. `omitted` is
 * true when a step was dropped, so the report can name the guide once. Hook lines stay.
 */
function keepInstalledSteps(lines: string[], show: boolean): { lines: string[]; omitted: boolean } {
  if (show) return { lines, omitted: false };
  let omitted = false;
  const kept = lines.filter((line) => {
    if (!isTrustStep(line)) return true;
    omitted = true;
    return false;
  });
  return { lines: kept, omitted };
}

/**
 * One line per thing done, kept or skipped; `ok` is false when a hooks or settings file was
 * skipped (#248, #254). `gh` asks GitHub two things: whether the remote owner is an
 * organization, and whether the repo is private (#377). `noCi` keeps CI off: see `keepCiOff`.
 * `ask` is the terminal question for the tests job (#550); without one, init only says
 * what it would add. Each git answer is kept for the run, until init sets core.hooksPath (#453).
 */
export function init(root: string, env: Env, gh: Gh = ghIn(root, env, ORG_LOOKUP_MS), { noCi = false, ask }: { noCi?: boolean; ask?: Ask } = {}): { ok: boolean; lines: string[] } {
  return withGitReads(() => initRun(root, env, gh, noCi, ask));
}

function initRun(root: string, env: Env, gh: Gh, noCi: boolean, ask?: Ask): { ok: boolean; lines: string[] } {
  const report: string[] = [];
  const isOff = noCi || isCiOffIn(root);
  const cli = cliPath(root);
  const hookCli = hookCliPath(root);
  if (!isSelf(root) && root !== HOME_DIR) {
    const copied = copyRuntime(join(root, '.yokoten'));
    report.push(copied === 'kept' ? 'kept .yokoten/ (the copy running now)' : 'wrote .yokoten/ (a copy of yokoten, about 90 files; committing it is the point)');
  }
  const hooks = readHookSetup(root, env);
  const kit = join(KIT, 'project');
  for (const file of walk(kit)) {
    const rel = relative(kit, file).split('\\').join('/');
    // The hooks are written below. A project with its own hooks folder keeps it, so it gets no .githooks/.
    if (rel.startsWith('.githooks/')) continue;
    // With CI off (#377), the CI files are left out. One that is there already is kept,
    // and with --no-ci, `keepCiOff` says what happens to it.
    if (isOff && isCiFile(rel)) {
      if (!lexists(join(root, rel))) report.push(`skipped ${rel} (yokoten.json "notNow" names ci)`);
      else if (!noCi) report.push(`kept ${rel}`);
      continue;
    }
    const text = render(readFileSync(file, 'utf8'), { cli, version: VERSION });
    // An AGENTS.md without "## This project" gets the core rules on top of its own text (#378).
    if (rel === 'AGENTS.md' && existsSync(join(root, rel))) {
      report.push(...addCoreRules(root, text, env));
      continue;
    }
    if (rel === '.github/dependabot.yml') {
      report.push(writeDependabot(root, text));
      continue;
    }
    if (rel.startsWith(WORKFLOWS_DIR)) {
      report.push(writeWorkflow(root, rel, text, env));
      continue;
    }
    report.push(`${writeNew(join(root, rel), text)} ${rel}`);
  }
  // The tests job for the project's language (#550): asked first, never overwritten. With
  // CI off there are no workflows, so nothing to add it to.
  if (!isOff) report.push(...writeTestsJob(root, { ask }));
  // Read before .githooks/ is written: whether it can run the hooks this clone has in .git/hooks (#256).
  const blocks = hooks.kind === 'plain' ? handOffBlocks(root, env) : [];
  if (hooks.kind !== 'own') report.push(...writeGithooks(root, cli, kit, blocks.length === 0, env));
  if (noCi) report.push(...keepCiOff(root, cli, kit));
  else if (!isOff) report.push(...privateRepoNote(root, gh, env));
  report.push(writeCodeOwners(root, gh, env));
  report.push(writeGitignore(root));
  const imported = importRules(root);
  if (imported) report.push(imported);
  // Claude Code's settings, the file people edit by hand most: skipped as one, never
  // rewritten, when it won't parse or has the wrong shape (#254).
  const claudeHooks = agentHooks('the Claude Code settings', '.claude/settings.json', () => {
    checkProjectSettings(root);
    return [
      describeWrite(addProjectHook(root, hookCli), 'the tool-call hook in .claude/settings.json'),
      describeWrite(addProjectStopHook(root, hookCli), "the stop check in .claude/settings.json (changed files, and a worker's done-when check, on Stop and SubagentStop)"),
      describeWrite(setProjectEnv(root, 'TZ', 'UTC'), 'TZ=UTC for agent sessions in .claude/settings.json (commit times carry no time zone)'),
      // Checked with a real run (#30): Copilot CLI reads these hooks, in a folder it trusts.
      // It skips them without a word otherwise (#341), so the line says how to trust it.
      'GitHub Copilot CLI runs the hooks in .claude/settings.json only after you trust this folder',
      `to trust this folder in Copilot CLI: ${copilot.TRUST_STEP}`,
    ];
  });
  // Codex, Gemini CLI, Antigravity CLI, OpenCode, Muse Code, DeepSeek Harness and Grok CLI get the same guard, whether or not they are
  // installed here: small files are easier to predict than a guess about which agents someone uses.
  // A file that won't parse, or has the wrong shape, is named and skipped, never rewritten (#248).
  const codexHooks = agentHooks('the Codex hooks', '.codex/hooks.json', () => {
    codex.checkProjectHooks(root);
    return [
      describeWrite(codex.addProjectHook(root, hookCli), 'the Codex tool-call hook in .codex/hooks.json'),
      describeWrite(codex.addProjectStopHook(root, hookCli), 'the Codex stop check in .codex/hooks.json'),
      'Codex runs the hooks in .codex/hooks.json only after you trust this folder and the hooks',
      `to trust them in Codex: ${codex.TRUST_STEP}`,
    ];
  });
  const geminiHooks = agentHooks('the Gemini CLI hooks', '.gemini/settings.json', () => {
    gemini.checkProjectHooks(root, hookCli);
    return [
      describeWrite(gemini.addProjectHook(root, hookCli), 'the Gemini CLI tool-call hook in .gemini/settings.json'),
      describeWrite(gemini.addProjectStopHook(root, hookCli), 'the Gemini CLI stop check in .gemini/settings.json (AfterAgent)'),
    ];
  });
  const antigravityHooks = agentHooks('the Antigravity CLI hook', '.agents/hooks.json', () => [
    describeWrite(antigravity.addProjectHook(root, hookCli), 'the Antigravity CLI tool-call hook in .agents/hooks.json'),
  ]);
  // OpenCode has no trust step in the docs we have. The plugin loads when OpenCode starts.
  const openCodePlugin = agentHooks('the OpenCode plugin', opencode.PLUGIN_FILE, () => [
    describeWrite(opencode.addProjectPlugin(root, hookCli), `the OpenCode tool-call plugin in ${opencode.PLUGIN_FILE}`),
  ]);
  const museHooks = agentHooks('the Muse Code hooks', '.muse/hooks.json', () => {
    const added = muse.addProjectHooks(root, hookCli);
    return [
      describeWrite(added.guard, 'the Muse Code tool-call hook in .muse/hooks.json'),
      describeWrite(added.stop, 'the Muse Code stop check in .muse/hooks.json'),
      describeWrite(added.doctor, 'the Muse Code session doctor in .muse/hooks.json'),
      `Muse Code runs the hooks in .muse/hooks.json only after you trust this folder: ${muse.TRUST_STEP}`,
    ];
  });
  // Grok CLI runs the project's hooks only in a folder the user trusts. yokoten never trusts
  // one for the user: the line says how (#407).
  const grokHooks = agentHooks('the Grok CLI hooks', grok.HOOKS_FILE, () => {
    const added = grok.addProjectHooks(root, hookCli);
    return [
      describeWrite(added.guard, `the Grok CLI tool-call hook in ${grok.HOOKS_FILE}`),
      describeWrite(added.stop, `the Grok CLI stop check in ${grok.HOOKS_FILE}`),
      `Grok CLI runs the hooks in ${grok.HOOKS_FILE} only after you trust this folder: ${grok.TRUST_STEP}`,
    ];
  });
  // DeepSeek Harness runs the hooks through a bridge each profile needs. init only prints
  // how to add it: it installs nothing and leaves ~/.dsh alone (#334).
  // On Windows the files are still written, ready for #332, but the lines say dsh is not checked.
  const dshHooks = agentHooks('the DeepSeek Harness hook', dsh.HOOKS_FILE, () => {
    const added = dsh.addProjectHooks(root, hookCli);
    return dsh.initLines([
      describeWrite(added.guard, `the DeepSeek Harness tool-call hook in ${dsh.HOOKS_FILE}`),
      describeWrite(added.patch, `the DeepSeek Harness launch patch in ${dsh.PATCH_FILE}`),
    ]);
  });
  // Trust steps print only for an agent installed on this machine (#654). The hook files
  // above are still written. Gemini CLI and Antigravity CLI have no trust step. One line
  // names the guide when any step was left out.
  let omittedTrustStep = false;
  const showSteps = (lines: string[], show: boolean): string[] => {
    const kept = keepInstalledSteps(lines, show);
    if (kept.omitted) omittedTrustStep = true;
    return kept.lines;
  };
  report.push(...showSteps(claudeHooks.lines, hasCopilotHome(env)));
  report.push(
    ...showSteps(codexHooks.lines, codex.hasUserDir(env)),
    ...geminiHooks.lines,
    ...antigravityHooks.lines,
    ...openCodePlugin.lines,
    ...showSteps(museHooks.lines, muse.hasUserDir(env)),
    // On Windows, initLines has no bridge command. The Windows line stays either way.
    ...showSteps(dshHooks.lines, dsh.profilesWithBridge(env) !== null),
    ...showSteps(grokHooks.lines, grok.hasUserDir(env)),
  );
  if (omittedTrustStep) report.push('other agents: see the guide');
  const sandboxes = sandboxLines(root);
  report.push(...sandboxes.lines);
  // Point git at the hooks last, so the files exist first. That call's first line leads
  // the report. Its other lines stay at the end (#654).
  const [hookLine, ...hookNotes] = setCommitCheck(root, cli, hooks, blocks, env);
  report.unshift(hookLine);
  report.push(...hookNotes);
  return { ok: claudeHooks.ok && codexHooks.ok && geminiHooks.ok && antigravityHooks.ok && openCodePlugin.ok && museHooks.ok && dshHooks.ok && grokHooks.ok && sandboxes.ok, lines: report };
}

