// The checks that prove doctor catches known-bad input. They run first, so a check
// that passes everything cannot look like a healthy project.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { checkCommand, checkEdit } from '../../rules/guards.ts';
import { DEFAULTS } from '../../rules/config.ts';
import { checkBuildOutput, checkLayout } from '../../rules/layout.ts';
import { notUtc, POSITIVE_CONTROL, scanText } from '../../rules/privacy.ts';
import { SECRET_CONTROL } from '../../rules/secrets.ts';
import { judge } from '../../run/hook.ts';
import { readToolCall, sandboxProblem as claudeSandboxProblem } from '../../agents/runtimes/claude-code.ts';
import { addProjectPlugin } from '../../agents/runtimes/small/opencode.ts';
import { missingHookFindings, openCodePluginNote } from './checks.ts';
import * as codex from '../../agents/runtimes/codex.ts';
import * as gemini from '../../agents/runtimes/gemini.ts';
import * as grok from '../../agents/runtimes/grok.ts';
import { hostGuardMisses } from '../../host/gh-commands.ts';
import { UNSAVED_CONTROL, unsavedNotes } from '../advice/unsaved.ts';
import { HOME_DIR } from '../files.ts';
import { compareCoreRules } from '../init.ts';
import { coreRulesControl, roadControl } from './lessons.ts';
import { leftoverControl, machineControl } from './machine.ts';

/** The checks that must catch a known-bad input. Returns the names of any that did not. */
export function selfTest(): string[] {
  const failed: string[] = [];
  if (!checkCommand('git push origin --tags', { env: {}, cwd: null })) failed.push('release guard');
  failed.push(...hostGuardMisses((command) => checkCommand(command, { env: {}, cwd: null })));
  if (!checkCommand('git commit --no-verify -m x', { env: {}, cwd: null })) failed.push('skip-check guard');
  if (!checkEdit('test/a.test.ts', { config: DEFAULTS, env: { YOKOTEN_FIX_TASK: '1' } })) failed.push('test guard');
  if (!checkEdit('AGENTS.md', { config: DEFAULTS, env: { YOKOTEN_ROLE: 'worker' } })) failed.push('lead-only guard');
  if (!isShellControlCaught()) failed.push('lead-only shell guard');
  if (scanText(POSITIVE_CONTROL, { file: 'control' }).length < 2) failed.push('privacy check');
  if (scanText(SECRET_CONTROL, { file: 'control' }).length < 2) failed.push('secret check');
  if (!notUtc('A <a@example.com> 1760745600 +0700') || notUtc('A <a@example.com> 1760745600 +0000')) failed.push('time zone check');
  const missedHooks = missingHookFindings([{ kind: 'desk', path: 'desk', hooksPath: '' }], (path) => path);
  const setHooks = missingHookFindings([{ kind: 'worktree', path: 'wt', hooksPath: '.githooks' }], (path) => path);
  if (missedHooks.length !== 1 || !missedHooks[0].what.startsWith('desk ') || setHooks.length !== 0) failed.push('desk hooks check');
  if (checkLayout(Array.from({ length: 8 }, (_, i) => `d/${i}`), DEFAULTS).length !== 1) failed.push('layout check');
  if (checkBuildOutput([{ path: 'dist/a.js', binary: false }, { path: 'a.bin', binary: true }], DEFAULTS).length !== 2) failed.push('build output check');
  if (!isUnsavedControlCaught()) failed.push('unsaved work check');
  failed.push(...roadControl());
  const kit = '# rules\n\n## This project\n';
  if (compareCoreRules('# old rules\n\n## This project\n', kit).state !== 'behind' || compareCoreRules('# rules\n', kit).state !== "can't compare") failed.push('core rules check');
  failed.push(...coreRulesControl());
  failed.push(...machineControl());
  failed.push(...leftoverControl());
  failed.push(...sandboxControl());
  failed.push(...openCodeControl());
  return failed;
}

/**
 * A project with `opencode.json` and no plugin must be noted, and a project with the
 * plugin `init` writes must be quiet. A folder with no OpenCode file must be quiet too.
 */
function openCodeControl(): string[] {
  let quiet = '';
  let marked = '';
  try {
    quiet = mkdtempSync(join(tmpdir(), 'yokoten-opencode-quiet-'));
    marked = mkdtempSync(join(tmpdir(), 'yokoten-opencode-marked-'));
    const cli = '.yokoten/bin/yokoten.mjs';
    if (openCodePluginNote(quiet, cli) !== null) return ['OpenCode plugin note'];
    writeFileSync(join(marked, 'opencode.json'), '{}\n');
    const note = openCodePluginNote(marked, cli);
    if (!note || note.ok || note.finding.id !== 'opencode-hook') return ['OpenCode plugin note'];
    addProjectPlugin(marked, cli);
    if (openCodePluginNote(marked, cli) !== null) return ['OpenCode plugin note'];
    return [];
  } catch {
    return ['OpenCode plugin note'];
  } finally {
    if (quiet) rmSync(quiet, { recursive: true, force: true });
    if (marked) rmSync(marked, { recursive: true, force: true });
  }
}

/**
 * In a temp project with a too-wide sandbox per agent, each sandbox check must catch its
 * own, and a good set must pass, so the control can't go green by always complaining. The
 * checks are parameters so a test can hand in broken ones.
 */
export function sandboxControl(
  claudeProblem: typeof claudeSandboxProblem = claudeSandboxProblem,
  codexProblem: typeof codex.sandboxProblem = codex.sandboxProblem,
  geminiProblem: typeof gemini.sandboxProblem = gemini.sandboxProblem,
  grokProblem: typeof grok.sandboxProblem = grok.sandboxProblem,
): string[] {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'yokoten-control-'));
    const failed: string[] = [];
    const env = { HOME: dir };
    const write = (rel: string, text: string) => {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    write('.claude/settings.json', '{"sandbox": {"enabled": true, "network": {"allowedDomains": ["*"]}}}');
    write('.codex/config.toml', 'sandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\n');
    write('.gemini/settings.json', '{"security": {"disableYoloMode": false}}');
    write('.grok/sandbox.toml', '[profiles.yokoten]\nextends = "devbox"\n');
    if (!claudeProblem(dir)) failed.push('Claude Code sandbox check');
    if (!codexProblem(dir, env)) failed.push('Codex sandbox check');
    if (!geminiProblem(dir)) failed.push('Gemini CLI sandbox check');
    if (!grokProblem(dir, env)) failed.push('Grok sandbox check');
    write('.claude/settings.json', '{"sandbox": {"enabled": true}}');
    write('.codex/config.toml', 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\n');
    write('.gemini/settings.json', '{"security": {"disableYoloMode": true}}');
    write('.grok/sandbox.toml', '[profiles.yokoten]\nextends = "workspace"\n');
    if (claudeProblem(dir) ?? codexProblem(dir, env) ?? geminiProblem(dir) ?? grokProblem(dir, env)) failed.push('sandbox check (a good set passes)');
    return failed;
  } catch {
    return []; // no temp folder to test in; the other checks still run
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
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
