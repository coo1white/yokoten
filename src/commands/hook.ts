// `yokoten hook`: the tool-call guard, and with --stop the end-of-turn check.

import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as antigravity from '../agents/runtimes/antigravity.ts';
import * as claudeCode from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as deepseekHarness from '../agents/runtimes/deepseek-harness.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as grok from '../agents/runtimes/grok.ts';
import * as muse from '../agents/runtimes/muse.ts';
import { loadConfig } from '../rules/config.ts';
import { hardenRead, markNote, printsAccount, privateOutput, realPath, releaseFix, withWorkerMark, WORKER_MARK, workerMarkAt, workerRole, wrapForRedact } from '../rules/guards.ts';
import { type Finding, formatFinding, notRepoFinding } from '../rules/message.ts';
import { checkChanged, readGit } from '../run/check.ts';
import { type Action, type Guard, guardDeadline, judgeWithDeadline, loadHookConfig, type Repo } from '../run/hook.ts';
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
// reader can't tell them apart. Muse Code passes a hook only a short list of variables and
// loses YOKOTEN_ROLE; it is not known to pass the approval, so the owner releases outside it.
// Gemini CLI drops the variable only when its strict environment sanitization is on.
const approve = (start: string) => `\`YOKOTEN_RELEASE_APPROVAL=1 ${start}\``;
const RELEASE_FIXES: Record<string, string> = {
  'claude-code': releaseFix(`${approve('claude')} (or your agent's command)`),
  codex: releaseFix(approve('codex')),
  gemini: releaseFix(`${approve('gemini')} (if its strict environment sanitization is on, the variable is dropped: the owner releases outside Gemini CLI)`),
  antigravity: releaseFix(approve('agy')),
  muse: 'Muse Code is not known to pass YOKOTEN_RELEASE_APPROVAL to its hooks: it passes them only a short list of variables, and YOKOTEN_ROLE is lost. If the owner asked for this, stop and tell them to release outside Muse Code; do not look for another way',
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

// Each runtime's event for the end of a turn: Claude Code's, Codex's, Muse Code's and Grok CLI's Stop, Gemini CLI's AfterAgent (#211).
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
 * The stop check (#92). The agent runs it when it is about to end its turn
 * (code.claude.com/docs/en/hooks#stop). Findings in the changed files send the agent back
 * once: exit 2, with the findings on stderr as the reason. `stop_hook_active` means it was
 * already sent back, so the turn ends whatever is found: never a loop. On any error the
 * turn ends too, with one line on stderr: a broken check must not trap a session.
 */
function stopHook(invocation: Invocation, json: boolean, read: typeof claudeCode.readStop): number {
  const { env } = invocation;
  let event: ReturnType<typeof claudeCode.readStop>;
  try {
    event = read(JSON.parse(readInput(invocation.stdin)));
  } catch {
    event = null;
  }
  if (!event) {
    if (json) printJson(invocation, { blocked: false, stop: false });
    return 0;
  }
  if (event.active) {
    if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the agent was already sent back once', findings: [] });
    return 0;
  }
  let findings: Finding[];
  try {
    const root = rootOf(event.cwd ?? invocation.cwd, env);
    // A worker by YOKOTEN_ROLE or by the mark on its worktree: the one role check (#555).
    findings = root ? checkChanged(root, { config: loadConfig(root), env: withWorkerMark(env, [root, invocation.cwd]) }) : [];
  } catch (err) {
    say(invocation, `yokoten hook --stop: skipped, ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, invocation.stderr);
    if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the check failed', findings: [] });
    return 0;
  }
  if (json) printJson(invocation, { blocked: findings.length > 0, stop: true, findings });
  if (!findings.length) return 0;
  // Each runtime gives stderr to the agent as the reason to go on when this hook exits 2.
  print(invocation, [`yokoten: ${findings.length} problem(s) in the changed files. Fix them before you end the turn:`, ...bullets(findings)], invocation.stderr);
  return 2;
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
    if (found && role === 'mark' && WORKER_RULES.has(found.id)) found = { ...found, fix: `${found.fix}. ${capital(markNote(folders))}` };
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
 * mark is a file in the worktree's own git folder; `git worktree remove` removes it with
 * the worktree. The main checkout is the lead's, so it is never marked.
 */
export function runWorker(invocation: Invocation): number {
  const options = parse('worker', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [action, dir] = options.positional;
  if (action !== 'mark' || dir === undefined) return usage(invocation, 'say what to do and where: yokoten worker mark <dir>');
  const fail = (line: string) => {
    print(invocation, [`yokoten worker: ${line}`], invocation.stderr);
    return 1;
  };
  const folder = resolve(invocation.cwd, dir);
  let isFolder = false;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch {}
  if (!isFolder) return fail(`${dir} is not a folder. Make the worktree first: \`git worktree add ${dir} -b <branch>\`, then \`yokoten worker mark ${dir}\`.`);
  let answer: string[];
  try {
    // --show-superproject-working-tree prints nothing outside a submodule, so it comes last.
    answer = readGit(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-superproject-working-tree'], { env: invocation.env }).toString('utf8').trim().split('\n');
  } catch {
    return fail(formatFinding(notRepoFinding(folder)));
  }
  const [top, gitDir, common, superproject] = answer;
  if (realPath(gitDir) === realPath(resolve(folder, common ?? ''))) {
    if (superproject) return fail(`${top} is a submodule's checkout, not a worktree. Mark a worktree: \`git worktree add <dir> -b <branch>\`, then \`yokoten worker mark <dir>\`.`);
    return fail(`${top} is the main checkout, the lead's. Mark a worktree: \`git worktree add <dir> -b <branch>\`, then \`yokoten worker mark <dir>\`.`);
  }
  try {
    writeFileSync(join(gitDir, WORKER_MARK), "A worker's worktree: yokoten's guard treats every agent here as a worker. `git worktree remove` removes this mark.\n");
  } catch (error) {
    return fail(`can't write the mark in ${gitDir} (${(error as NodeJS.ErrnoException).code ?? 'error'}). Check that the lead can write there, then run it again.`);
  }
  // The guard finds the mark without git; check that it does here.
  if (workerMarkAt(folder) !== 'mark') return fail(`the mark is written in ${gitDir}, but the guard can't find it from ${top}.`);
  print(invocation, [`yokoten worker: marked the worktree at ${top}. The guard now treats every agent there as a worker. \`git worktree remove ${top}\` removes the mark.`]);
  return 0;
}
