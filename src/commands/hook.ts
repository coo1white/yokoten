// `yokoten hook`: the tool-call guard, and with --stop the end-of-turn check.

import { existsSync, lstatSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as antigravity from '../agents/runtimes/antigravity.ts';
import * as claudeCode from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as deepseekHarness from '../agents/runtimes/deepseek-harness.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as grok from '../agents/runtimes/grok.ts';
import * as muse from '../agents/runtimes/muse.ts';
import type { DropReason, SortedEnv } from '../agents/agent-env.ts';
import { type Env, loadConfig } from '../rules/config.ts';
import { addWorkerPath, gitLinkAbove, hardenRead, markNote, printsAccount, privateOutput, realPath, releaseFix, removeWorkerPath, withWorkerMark, WORKER_MARK, workerMarkAt, workerRole, wrapForRedact } from '../rules/guards.ts';
import { type Finding, formatFinding, notRepoFinding } from '../rules/message.ts';
import { checkChanged, readGit } from '../run/check.ts';
import {
  type Action,
  bumpDoneTries,
  clearDoneTries,
  clearRefusedMarker,
  DONE_TRY_LIMIT,
  doneTryKey,
  type Guard,
  guardDeadline,
  judgeWithDeadline,
  loadHookConfig,
  noteRefused,
  readDoneWhen,
  type Repo,
  runDoneWhen,
  type StopEvent,
  wasRefusedRecently,
  writeAgentChecks,
} from '../run/hook.ts';
import { bullets, type Invocation, parse, print, printJson, readInput, rootOf, say, usage } from './shared.ts';

// Each runtime sends its tool call in its own shape; its adapter turns it into an Action.
export const READERS: Record<string, (input: unknown) => Action> = {
  'claude-code': claudeCode.readToolCall,
  codex: codex.readToolCall,
  gemini: gemini.readToolCall,
  antigravity: antigravity.readToolCall,
  muse: muse.readToolCall,
  'deepseek-harness': deepseekHarness.readToolCall,
  grok: grok.readToolCall,
};

// What a runtime reads on stdout when a call is refused, and the exit code it wants. The
// others take the reason on stderr and exit 2, with nothing on stdout. Muse Code takes
// either; stderr and exit 2 is the simpler one, and the model sees the same reason. Grok CLI
// shows the model only stderr's first line, so it gets the whole reason on stdout too.
const DENIALS: Record<string, (reason: string) => { stdout: string; exitCode: number }> = {
  'claude-code': claudeCode.formatDenial,
  antigravity: antigravity.formatDenial,
  grok: grok.formatDenial,
};

// How the owner approves a release in each runtime (#350): the command that starts it with
// YOKOTEN_RELEASE_APPROVAL=1. Copilot CLI sends Claude Code's shape, so the claude-code
// reader can't tell them apart. Muse Code passes a hook only a short list of variables;
// it is not known to pass the approval, so the owner releases outside it.
// Gemini CLI drops the variable only when its strict environment sanitization is on.
const approve = (start: string) => `\`YOKOTEN_RELEASE_APPROVAL=1 ${start}\``;
const RELEASE_FIXES: Record<string, string> = {
  'claude-code': releaseFix(`${approve('claude')} (or your agent's command)`),
  codex: releaseFix(approve('codex')),
  gemini: releaseFix(`${approve('gemini')} (if its strict environment sanitization is on, the variable is dropped: the owner releases outside Gemini CLI)`),
  antigravity: releaseFix(approve('agy')),
  muse: 'Muse Code is not known to pass YOKOTEN_RELEASE_APPROVAL to its hooks: it passes them only a short list of variables. If the owner asked for this, stop and tell them to release outside Muse Code; do not look for another way',
  'deepseek-harness': releaseFix(approve('dsh tui --patch .dsh/yokoten.patch.yml')),
  grok: releaseFix(approve('grok')),
};

// The runtimes whose hook can change a command before it runs (#390). In the others the
// command runs as it is, unless yokoten.json "privacy.output" is "stop": then it is refused,
// with the wrapped command as the fix. Codex, Gemini CLI, Antigravity CLI, Muse Code and
// DeepSeek Harness are not known to take a changed command from a hook. Grok CLI takes
// `updatedInput`, as Claude Code does.
const REWRITES: Record<string, typeof claudeCode.formatRewrite> = {
  'claude-code': claudeCode.formatRewrite,
  grok: grok.formatRewrite,
};

/**
 * How the wrapped command runs `yokoten redact`: the node that runs this hook and this
 * same copy of yokoten, each by its path, quoted for bash. Neither depends on the PATH.
 * The home folder is written `$HOME`, so the command names no user.
 */
export function redactCommand(node: string, cli: string, home: string | undefined): string {
  const homePath = home?.replaceAll('\\', '/').replace(/\/+$/, '');
  let realHome = homePath;
  try {
    if (home) realHome = realpathSync(home).replaceAll('\\', '/');
  } catch {}
  const quoted = (file: string) => {
    let path = file.replaceAll('\\', '/');
    try {
      path = realpathSync(file).replaceAll('\\', '/');
    } catch {}
    const escape = (text: string) => text.replace(/["$`\\]/g, (mark) => `\\${mark}`);
    for (const prefix of [homePath, realHome]) {
      if (prefix && path.startsWith(`${prefix}/`)) return `"$HOME/${escape(path.slice(prefix.length + 1))}"`;
    }
    return `"${escape(path)}"`;
  };
  return `${quoted(node)} ${quoted(cli)} redact`;
}

// Each runtime's event for the end of a turn: Claude Code's Stop and SubagentStop, Codex's,
// Muse Code's and Grok CLI's Stop, Gemini CLI's AfterAgent (#211, #614).
const STOP_READERS: Record<string, typeof claudeCode.readStop> = {
  'claude-code': claudeCode.readStop,
  codex: codex.readStop,
  gemini: gemini.readStop,
  muse: muse.readStop,
  grok: grok.readStop,
};

/**
 * The yokoten repos (those with a `yokoten.json`) an edit's files are in, past the
 * session's own (#307). A worktree in another folder, or a session started above the repo,
 * loads no project hook, so the guard applies the file's own repo's rules. One `rootOf`
 * per folder and one config per repo. A command's paths count too: Codex runs apply_patch
 * through the shell (#221).
 */
function editRepos(invocation: Invocation, action: Action, base: string, session: Repo | null, commandsOnly: boolean): Repo[] {
  const rootByFolder = new Map<string, string | null>([[base, session?.root ?? null]]);
  const repos = new Map<string, Repo | null>();
  // In the full hook, the session's root already has its rules.
  if (session) repos.set(session.root, commandsOnly && existsSync(join(session.root, 'yokoten.json')) ? session : null);
  for (const path of action.paths) {
    let folder = dirname(resolve(base, path));
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    if (!rootByFolder.has(folder)) rootByFolder.set(folder, rootOf(folder, invocation.env));
    const root = rootByFolder.get(folder);
    if (!root || repos.has(root)) continue;
    repos.set(root, existsSync(join(root, 'yokoten.json')) ? { root, config: loadHookConfig(root, (line) => say(invocation, `${line}\n`, invocation.stderr)) } : null);
  }
  return [...repos.values()].filter((repo) => repo !== null);
}

/**
 * The stop check (#92, #614). The agent runs it when it is about to end its turn
 * (code.claude.com/docs/en/hooks#stop). Findings in the changed files send a lead back
 * once: exit 2, with the findings on stderr as the reason. `stop_hook_active` means it was
 * already sent back, so a lead's turn ends whatever is found: never a loop.
 *
 * A worker also runs the task's done-when command (or the changed-file check when the
 * brief has none). A failing check sends the worker back, with the output in short. After
 * DONE_TRY_LIMIT refusals the next stop is let through. The worker's message to the lead
 * must start with "NOT DONE: checks failing". A linked worktree's `.yokoten-agent.json`
 * gets `checks` set to `failing`, so the lead can see it. The board will show it later
 * (#603). The main checkout is not written. A pass sets `checks` to `passing`.
 * A subagent is a worker only by its own type. On any error the turn ends too, with one
 * line on stderr: a broken check must not trap a session.
 */
async function stopHook(invocation: Invocation, json: boolean, read: typeof claudeCode.readStop): Promise<number> {
  const { env } = invocation;
  let event: StopEvent | null;
  try {
    event = read(JSON.parse(readInput(invocation.stdin)));
  } catch {
    event = null;
  }
  if (!event) {
    if (json) printJson(invocation, { blocked: false, stop: false });
    return 0;
  }
  const folder = event.cwd ?? invocation.cwd;
  const folders = [folder, invocation.cwd];
  // SubagentStop fires for every subagent. Its own type decides. The parent session's
  // role does not: a reviewer started by a worker is not checked (#614).
  const isWorker = event.subagent ? event.worker : event.worker || workerRole(env, folders) !== null;
  if (event.subagent && !event.worker) {
    if (json) printJson(invocation, { blocked: false, stop: true, findings: [] });
    return 0;
  }
  if (event.active && !isWorker) {
    if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the agent was already sent back once', findings: [] });
    return 0;
  }
  let findings: Finding[];
  let root: string | null;
  try {
    root = rootOf(folder, env);
    // A worker by YOKOTEN_ROLE, by the mark on its worktree, or by the event (#555, #614).
    const marked = withWorkerMark(env, folders);
    const workerEnv = isWorker ? { ...marked, YOKOTEN_ROLE: 'worker' } : marked;
    findings = root ? checkChanged(root, { config: loadConfig(root), env: workerEnv }) : [];
  } catch (err) {
    say(invocation, `yokoten hook --stop: skipped, ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, invocation.stderr);
    if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the check failed', findings: [] });
    return 0;
  }
  let doneWhen: { command: string; ok: boolean; output: string } | undefined;
  // A subagent runs in the worker's worktree only when the event's folder is that
  // worktree. Otherwise it shares the lead's folder (#614).
  const ranIn = isWorker && root ? (event.subagent ? subagentDir(folder) : root) : folder;
  if (isWorker && root) {
    const command = readDoneWhen(env, event.subagent ? ranIn : folder);
    if (command) {
      try {
        const ran = await runDoneWhen(command, ranIn, { ...env, YOKOTEN_ROLE: 'worker' });
        doneWhen = { command, ...ran };
      } catch (err) {
        say(invocation, `yokoten hook --stop: skipped, ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, invocation.stderr);
        if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the check failed', findings });
        return 0;
      }
    }
  }
  const failed = findings.length > 0 || doneWhen?.ok === false;
  const key = doneTryKey(event.sessionId, folder);
  if (!failed) {
    if (isWorker) {
      forgetDoneTries(env, key);
      clearRefusedMarker(folder, key);
      recordChecks(invocation, folder, 'passing');
    }
    if (json) printJson(invocation, { blocked: false, stop: true, findings });
    return 0;
  }
  if (!isWorker) {
    if (json) printJson(invocation, { blocked: true, stop: true, findings });
    print(invocation, [`yokoten: ${findings.length} problem(s) in the changed files. Fix them before you end the turn:`, ...bullets(findings)], invocation.stderr);
    return 2;
  }
  const bumped = bumpDoneTries(env, key);
  // No saved count: stop_hook_active, or a refusal of this worker in the last 5 minutes,
  // lets the stop through. A runtime that never sets stop_hook_active cannot trap it.
  if (bumped === null) {
    if (event.active || wasRefusedRecently(folder, key)) return allowFailingStop(invocation, json, findings, doneWhen, DONE_TRY_LIMIT, env, key, folder);
    noteRefused(folder, key);
    return refuseFailingStop(invocation, json, findings, doneWhen, 1, false);
  }
  if (bumped > DONE_TRY_LIMIT) return allowFailingStop(invocation, json, findings, doneWhen, bumped, env, key, folder);
  return refuseFailingStop(invocation, json, findings, doneWhen, bumped, true);
}

/**
 * The linked worktree's real root, or null for the main checkout and outside a repo.
 * `realpath` runs first. If it fails, nothing is written. A link into another worktree
 * is not this folder's worktree, so that worktree's status file stays as it is.
 */
function linkedWorktree(folder: string): string | null {
  let realFolder: string;
  try {
    realFolder = realpathSync(folder);
  } catch {
    return null;
  }
  const link = gitLinkAbove(realFolder);
  if (link?.kind !== 'file') return null;
  let top: string;
  try {
    top = realpathSync(link.top);
  } catch {
    return null;
  }
  return staysInsideWorktree(folder, top) ? top : null;
}

/** Whether `folder` is `top` or inside it, without following a symlink out. */
function staysInsideWorktree(folder: string, top: string): boolean {
  let dir = resolve(folder);
  for (;;) {
    try {
      if (!lstatSync(dir).isSymbolicLink() && realpathSync(dir) === top) return true;
    } catch {
      return false;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Write `checks` at a linked worktree's root. The main checkout is left unchanged. */
function recordChecks(invocation: Invocation, folder: string, checks: 'failing' | 'passing'): void {
  const root = linkedWorktree(folder);
  if (!root) return;
  writeAgentChecks(root, checks, new Date(), (line) => say(invocation, line, invocation.stderr));
}

/** The folder a subagent's command runs in: the linked worktree the event names, or the event's own folder. */
function subagentDir(folder: string): string {
  const link = gitLinkAbove(folder);
  return link?.kind === 'file' ? link.top : folder;
}

/** Drop the try count. `clearDoneTries` already ignores an `rmSync` error; this is the second wall. */
function forgetDoneTries(env: Invocation['env'], key: string): void {
  try {
    clearDoneTries(env, key);
  } catch {
    // A count file that cannot be removed must not crash the hook.
  }
}

/** The lines that send a worker back, and, on the last refusal, what to tell the lead. */
function refuseFailingStop(
  invocation: Invocation,
  json: boolean,
  findings: Finding[],
  doneWhen: { ok: boolean; output: string } | undefined,
  tries: number,
  saved: boolean,
): number {
  const lines: string[] = [];
  if (findings.length) lines.push(`yokoten: ${findings.length} problem(s) in the changed files. Fix them before you end the task:`, ...bullets(findings));
  if (doneWhen?.ok === false) {
    lines.push('yokoten: the done-when check failed. Fix what it reports, then end the task again:');
    if (doneWhen.output) lines.push(doneWhen.output);
  }
  // The last refusal is the one the worker can still read. The allowed stop's stderr reaches nobody.
  if (!saved || tries >= DONE_TRY_LIMIT) {
    lines.push(`This was try ${tries} of ${DONE_TRY_LIMIT}. The next stop is let through.`);
    lines.push('Your final message to the lead must start with "NOT DONE: checks failing" and quote the failing output.');
  } else lines.push(`This was try ${tries} of ${DONE_TRY_LIMIT}.`);
  if (json) printJson(invocation, { blocked: true, stop: true, findings, ...(doneWhen ? { doneWhen: { ok: false, output: doneWhen.output, tries, limit: DONE_TRY_LIMIT } } : {}) });
  print(invocation, lines, invocation.stderr);
  return 2;
}

/** Let the worker stop, and leave a record the lead can read. The try count starts again. */
function allowFailingStop(
  invocation: Invocation,
  json: boolean,
  findings: Finding[],
  doneWhen: { ok: boolean; output: string } | undefined,
  tries: number,
  env: Invocation['env'],
  key: string,
  folder: string,
): number {
  recordChecks(invocation, folder, 'failing');
  forgetDoneTries(env, key);
  const payload = { blocked: false, stop: true, findings, skipped: 'stopped with failing checks', ...(doneWhen ? { doneWhen: { ok: false, output: doneWhen.output, tries, limit: DONE_TRY_LIMIT } } : {}) };
  if (json) printJson(invocation, payload);
  print(invocation, ['yokoten: stopped with failing checks. The done-when check still fails. Tell the lead this task is not done.'], invocation.stderr);
  return 0;
}

/** `guard`: the guard's worker, when bin/main.ts started it early (#408). */
export function runHook(invocation: Invocation, guard?: Guard): number | Promise<number> {
  const { cwd } = invocation;
  const options = parse('hook', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const json = options.flags.has('--json');
  const agent = options.values['--agent'] ?? 'claude-code';
  if (options.flags.has('--stop')) {
    if (options.flags.has('--commands-only')) return usage(invocation, "--stop and --commands-only can't be used together");
    if (!Object.hasOwn(STOP_READERS, agent)) return usage(invocation, `unknown --agent ${agent}; use one of: ${Object.keys(STOP_READERS).join(', ')}`);
    return stopHook(invocation, json, STOP_READERS[agent]);
  }
  const read = Object.hasOwn(READERS, agent) ? READERS[agent] : undefined;
  if (!read) return usage(invocation, `unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`);
  let input: unknown;
  try {
    input = JSON.parse(readInput(invocation.stdin));
  } catch {
    // Not a tool call; nothing to judge. A runtime never sends one, and blocking here
    // would stop every tool call the day a runtime changes its input.
    if (json) printJson(invocation, { blocked: false, toolCall: false });
    return 0;
  }
  const action = read(input);
  const root = rootOf(action.cwd ?? cwd, invocation.env);
  // A worktree the lead marked makes every agent in it a worker, whatever env it passes (#555).
  // Both folders count: a call may name another folder (Muse's `workdir`) than the hook's own.
  const folders = [resolve(cwd, action.cwd ?? '.'), cwd];
  const role = workerRole(invocation.env, folders);
  const env = role === 'mark' ? { ...invocation.env, YOKOTEN_ROLE: 'worker' } : invocation.env;
  const config = loadHookConfig(root, (line) => say(invocation, `${line}\n`, invocation.stderr));
  const commandsOnly = options.flags.has('--commands-only');
  const repos = editRepos(invocation, action, action.cwd ?? root ?? cwd, root ? { root, config } : null, commandsOnly);
  const judged = judgeWithDeadline(action, { root, config, env, cwd, commandsOnly, repos }, guardDeadline(env.YOKOTEN_GUARD_DEADLINE_MS), guard);
  return judged.then((judgedFinding) => {
    // The guard names no agent; the hook knows which one it runs for.
    let found = judgedFinding?.id === 'release' && Object.hasOwn(RELEASE_FIXES, agent) ? { ...judgedFinding, fix: RELEASE_FIXES[agent] } : judgedFinding;
    // A command that may print the owner's details runs through `yokoten redact` (#390).
    const printed = !found && action.command !== undefined ? printsAccount(action.command) : null;
    if (printed && action.command !== undefined) {
      const wrapped = wrapForRedact(hardenRead(action.command), redactCommand(process.execPath, invocation.script, env.HOME));
      if (Object.hasOwn(REWRITES, agent)) {
        if (json) printJson(invocation, { blocked: false, toolCall: true, rewritten: wrapped });
        // Written as it is: hiding the home folder would change the command.
        else invocation.stdout.write(REWRITES[agent](input, wrapped, `yokoten: ${printed}, so its output goes through yokoten redact`));
        return 0;
      }
      if (config.privacy.output === 'stop') found = privateOutput(printed, wrapped);
    }
    // A worker by the mark hears why, and where the lead works (#555).
    if (found && role === 'mark' && WORKER_RULES.has(found.id)) found = { ...found, fix: `${found.fix}. ${capital(markNote(folders, invocation.env))}` };
    if (json) printJson(invocation, found ? { blocked: true, finding: found } : { blocked: false, toolCall: true });
    if (!found) return 0;
    // The runtimes read the reason from stderr when the hook exits 2; some read stdout (DENIALS).
    const reason = `yokoten: ${formatFinding(found)}`;
    say(invocation, `${reason}\n`, invocation.stderr);
    const denial = Object.hasOwn(DENIALS, agent) ? DENIALS[agent](reason) : { stdout: '', exitCode: 2 };
    if (!json && denial.stdout) say(invocation, denial.stdout, invocation.stdout);
    return json ? 2 : denial.exitCode;
  });
}

// The rules that apply to a worker only: a refusal by one of them names the mark, when the role came from it.
const WORKER_RULES = new Set(['lead-only', 'worker-push', 'worker-mark']);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * `worker mark <dir>`: mark the worktree at <dir> as a worker's (#555). The guard then
 * treats every agent there as a worker, whatever env its runtime passes to the hook. The
 * mark is a file in the worktree's own git folder, and its path on the worker list (#566),
 * outside the worktree, so moving `.git` away keeps the role. `git worktree remove`
 * removes the file with the worktree, and the guard skips the list entry whose folder is
 * gone; `worker unmark` clears an entry outright, and only the lead runs it. The main
 * checkout is the lead's, so it is never marked.
 */

/**
 * Mark the worktree at `dir` (from `cwd`) as a worker's, exactly as `yokoten worker
 * mark` does: the mark file in its own git folder, and its path on the worker list.
 * The board calls this for the worktree it makes or reuses, so runtimes that drop
 * YOKOTEN_ROLE still run as workers. Returns the worktree root, or the plain reason.
 */
export function markWorktree(cwd: string, dir: string, env: Env): { top: string } | { fail: string } {
  const folder = resolve(cwd, dir);
  let isFolder = false;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch {}
  if (!isFolder) return { fail: `${dir} is not a folder. Make the worktree first: \`git worktree add ${dir} -b <branch>\`, then \`yokoten worker mark ${dir}\`.` };
  let answer: string[];
  try {
    // --show-superproject-working-tree prints nothing outside a submodule, so it comes last.
    answer = readGit(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-superproject-working-tree'], { env }).toString('utf8').trim().split('\n');
  } catch {
    return { fail: formatFinding(notRepoFinding(folder)) };
  }
  const [top, gitDir, common, superproject] = answer;
  if (realPath(gitDir) === realPath(resolve(folder, common ?? ''))) {
    if (superproject) return { fail: `${top} is a submodule's checkout, not a worktree. Mark a worktree: \`git worktree add <dir> -b <branch>\`, then \`yokoten worker mark <dir>\`.` };
    return { fail: `${top} is the main checkout, the lead's. Mark a worktree: \`git worktree add <dir> -b <branch>\`, then \`yokoten worker mark <dir>\`.` };
  }
  try {
    writeFileSync(join(gitDir, WORKER_MARK), "A worker's worktree: yokoten's guard treats every agent here as a worker. `git worktree remove` removes this mark.\n");
  } catch (error) {
    return { fail: `can't write the mark in ${gitDir} (${(error as NodeJS.ErrnoException).code ?? 'error'}). Check that the lead can write there, then run it again.` };
  }
  try {
    addWorkerPath(env, top);
  } catch (error) {
    return { fail: `the mark is written in ${gitDir}, but the worker list can't be written (${(error as Error).message.split('\n')[0]}). Clear it with \`yokoten worker unmark ${top}\` once the list is writable, then mark again.` };
  }
  // The guard finds the mark without git; check that it does here.
  if (workerMarkAt(folder, env) !== 'mark') return { fail: `the mark is written in ${gitDir}, but the guard can't find it from ${top}.` };
  return { top };
}

export function runWorker(invocation: Invocation): number | Promise<number> {
  const options = parse('worker', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [action, dir] = options.positional;
  if (action === 'env') return runEnv(invocation, dir);
  if ((action !== 'mark' && action !== 'unmark') || dir === undefined) return usage(invocation, `say what to do and where: yokoten worker ${action === 'unmark' ? 'unmark' : 'mark'} <dir>, or yokoten worker env [runtime]`);
  const fail = (line: string) => {
    print(invocation, [`yokoten worker: ${line}`], invocation.stderr);
    return 1;
  };
  if (action === 'unmark') return runUnmark(invocation, dir, fail);
  const marked = markWorktree(invocation.cwd, dir, invocation.env);
  if ('fail' in marked) return fail(marked.fail);
  print(invocation, [`yokoten worker: marked the worktree at ${marked.top}. The guard now treats every agent there as a worker. \`git worktree remove ${marked.top}\` removes the mark. \`yokoten worker unmark ${marked.top}\` clears it sooner.`]);
  return 0;
}

/**
 * `worker env [runtime]`: the names an agent that yokoten starts would get from this
 * shell (#613), and how many are dropped and why. Names only: a value is never printed.
 * With a runtime, its own login and config names count too. The module loads only here,
 * so the guard's path never loads it.
 */
async function runEnv(invocation: Invocation, runtime: string | undefined): Promise<number> {
  const { sortAgentEnv } = await import('../agents/agent-env.ts');
  let sorted: SortedEnv;
  try {
    sorted = sortAgentEnv(invocation.env, runtime);
  } catch (error) {
    return usage(invocation, `${(error as Error).message}. Example: yokoten worker env claude-code`);
  }
  const count = (reason: DropReason) => sorted.dropped.filter((drop) => drop.reason === reason).length;
  const who = runtime === undefined ? 'An agent that yokoten starts' : `A ${runtime} agent that yokoten starts`;
  print(invocation, [
    `yokoten worker: ${who} would get ${sorted.kept.length} names from this shell. Values are never shown. No command starts an agent with this yet.`,
    ...(sorted.kept.length ? [`  ${sorted.kept.join(', ')}`] : []),
    `Dropped: ${count('secret name')} with a secret-looking name, ${count('secret value')} with a value shaped like a key or token, ${count('too long')} too long to check, ${count('not on the list')} not on the list.`,
    ...(runtime === undefined ? ['Add a runtime, such as `yokoten worker env claude-code`, to count its own login names too.'] : []),
  ]);
  return 0;
}

/**
 * `worker unmark <dir>`: forget the marked worktree at <dir> (#566). Only the lead runs
 * it: a worker's session, by YOKOTEN_ROLE or by the mark on its own worktree, is refused.
 * It drops the worktree's path from the worker list, and the mark file when `.git` still
 * names it. Given a folder with no `.git` (moved away), it still clears by path.
 */
function runUnmark(invocation: Invocation, dir: string, fail: (line: string) => number): number {
  if (workerRole(invocation.env, [invocation.cwd]) !== null) {
    return fail('only the lead unmarks a worktree: this session is a worker. Commit in your worktree and report; the lead unmarks after review.');
  }
  const folder = resolve(invocation.cwd, dir);
  let top = folder;
  let gitDir: string | undefined;
  try {
    const answer = readGit(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { env: invocation.env }).toString('utf8').trim().split('\n');
    if (answer[0]) top = answer[0];
    gitDir = answer[1];
  } catch {
    // No `.git` to read (moved away): the list entry is still cleared by path below.
  }
  if (gitDir) rmSync(join(gitDir, WORKER_MARK), { force: true });
  try {
    removeWorkerPath(invocation.env, top);
  } catch (error) {
    return fail(`can't clear the worker list (${(error as Error).message.split('\n')[0]}). Check HOME, then run it again.`);
  }
  print(invocation, [`yokoten worker: unmarked ${top}. The guard no longer treats agents there as workers.`]);
  return 0;
}
