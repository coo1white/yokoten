// The tool-call hook. Before an agent runs a command or edits a file, its runtime asks
// the hook; a finding stops the action, null lets it go.
//
// The hook knows nothing about any one runtime. An adapter in src/agents/ turns the
// runtime's own call into an `Action` first.

import { existsSync } from 'node:fs';
import module from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { type Config, DEFAULTS, type Env, type IgnoredPart, loadConfig } from '../rules/config.ts';
import { checkCommand, checkEdit, realPath as real } from '../rules/guards.ts';
import { type Finding, finding } from '../rules/message.ts';

/** What an agent is about to do, in no runtime's terms. */
export interface Action {
  /** A shell command, as the agent wrote it. */
  command?: string;
  /** The files an edit touches, absolute or relative to `cwd`. */
  paths: string[];
  cwd?: string;
  /** The action comes from a worker, whatever the session's own role. */
  worker: boolean;
}

/** A repo whose file rules apply to an edit: its root, and the config read there. */
export interface Repo {
  root: string;
  config: Config;
}

/**
 * The config the hook works with: the repo's yokoten.json, or the defaults outside a repo.
 * The hook never fails open on its own config (#218): a file it cannot read gives the
 * defaults, and a key with the wrong shape gives only that key's default (#192, #228).
 * The core checks still run, and `warn` gets one line for each part it ignored, with why.
 */
export function loadHookConfig(root: string | null, warn: (line: string) => void): Config {
  if (!root) return DEFAULTS;
  return loadConfig(root, { onProblem: (problem, ignored) => warn(`yokoten hook: ${sayIgnored(ignored)}; the core checks still run. ${problem}`) });
}

const sayIgnored = (ignored: IgnoredPart) =>
  ignored === 'file' ? 'yokoten.json was ignored, so the defaults apply' : `yokoten.json "${ignored}" was ignored, so its default applies`;

/**
 * Why to stop the action (what, why, fix), or null. `root` is the session's repo root, or
 * null outside a repo. `commandsOnly` is the user-level hook: it runs in every repo, so it
 * keeps to the rules that hold everywhere (no tag pushes, no force pushes, no skipped
 * checks), and applies file rules only through `repos`.
 *
 * `repos` are the yokoten repos (with a `yokoten.json`) the edit's files are in (#307): a
 * worktree in another folder, or a session started above the repo, loads no project hook,
 * yet still gets the file's own repo's file rules. A file takes the rules of the deepest
 * repo that holds it.
 *
 * `cwd` is the folder the hook runs in, for an action that names no folder and has no root.
 */
export function judge(
  action: Action,
  { root, config, env, cwd, commandsOnly = false, repos = [] }: { root: string | null; config: Config; env: Env; cwd: string; commandsOnly?: boolean; repos?: Repo[] },
): Finding | null {
  // Set before the command check: the lead-only check on shell writes reads it (#402).
  if (action.worker) env = { ...env, YOKOTEN_ROLE: 'worker' };
  // The repos whose file rules apply: to an edit's files, and to a worker's shell writes (#402).
  const ruled = commandsOnly || !root ? repos : [{ root, config }, ...repos];
  // A command may also edit files (Codex runs apply_patch through the shell): check both.
  // The command runs in the call's folder: a hooks setting is judged in that repo (#217).
  if (action.command !== undefined) {
    // Titles follow a project's own rules: only its hook checks them, never the user-level one (#391).
    const titles = !commandsOnly && root !== null && existsSync(join(root, 'yokoten.json'));
    const ruledRepos = ruled.map((repo) => ({ root: repo.root, leadOnly: repo.config.leadOnly }));
    const reason = checkCommand(action.command, { env, config, cwd: action.cwd ?? root ?? cwd, titles, repos: ruledRepos });
    if (reason) return reason;
  }
  if (!ruled.length) return null;
  const reals = ruled.map((repo) => ({ config: repo.config, real: real(repo.root) }));
  for (const p of action.paths) {
    const file = real(resolve(action.cwd ?? root ?? cwd, p));
    let best: { rel: string; config: Config } | null = null;
    for (const repo of reals) {
      const rel = relative(repo.real, file);
      // A file outside the repo is not this repo's business.
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (!best || rel.length < best.rel.length) best = { rel, config: repo.config };
    }
    if (!best) continue;
    const reason = checkEdit(best.rel.split(sep).join('/'), { config: best.config, env });
    if (reason) return reason;
  }
  return null;
}

/** How long the guard may read one tool call. YOKOTEN_GUARD_DEADLINE_MS changes it. */
export const GUARD_DEADLINE_MS = 5000;
/** The most YOKOTEN_GUARD_DEADLINE_MS may set: well under the runtimes' own hook timeouts, which let the call through. */
export const GUARD_DEADLINE_MAX_MS = 30_000;

/**
 * The deadline YOKOTEN_GUARD_DEADLINE_MS asks for, in whole milliseconds. Anything else
 * (empty, 0, a sign, a fraction, hex, words) keeps the default, and a value past the cap
 * is cut to it, so the setting can never turn the deadline off.
 */
export function guardDeadline(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return GUARD_DEADLINE_MS;
  const ms = Number(value);
  return ms > 0 ? Math.min(ms, GUARD_DEADLINE_MAX_MS) : GUARD_DEADLINE_MS;
}

type JudgeOptions = Parameters<typeof judge>[1];

// A worker does not share the main thread's compile cache, so it turns the cache on
// itself, in the main thread's folder (bin/yokoten.mjs), then loads this module (#286).
// It starts as plain JavaScript: this module's imports are compiled before any of its
// code runs, and the cache must be on by then. An error from the cache is ignored, as in
// bin/yokoten.mjs.
const workerStart = (cacheDir = module.getCompileCacheDir?.()) => `
const { enableCompileCache } = require('node:module');
try { enableCompileCache?.(${cacheDir === undefined ? '' : JSON.stringify(cacheDir)}); } catch {}
import(${JSON.stringify(import.meta.url)});
`;

/** The guard worker's stack, in MB: about the main thread's. */
const WORKER_STACK_MB = 1;

/** A guard worker, started before the tool call is read (`startGuard`). */
export interface Guard {
  /** `judge` in the worker, with a deadline: see `judgeWithDeadline`. Call it once. */
  judge(action: Action, options: JudgeOptions, deadlineMs: number): Promise<Finding | null>;
}

/**
 * Start the guard's worker now, before the tool call is known (#408). A worker takes tens
 * of milliseconds to start, as long as the rest of the hook; started first, it starts
 * while the hook loads and reads the call. It does not keep the process alive until
 * `judge` is called, so a hook that ends early (a usage error, no tool call) just exits.
 * A failure before `judge` is kept, and `judge` refuses the call with it.
 */
export function startGuard(): Guard {
  // The main thread's stack (V8's default, just under 1 MB), not a worker's default 4 MB:
  // the guard reads a command the same way in the worker as in `judge`, so a command too
  // deep to read there is refused here too, not let through.
  const worker = new Worker(workerStart(), { eval: true, workerData: { yokotenJudge: true }, resourceLimits: { stackSizeMb: WORKER_STACK_MB } });
  worker.unref();
  let ended: string | null = null;
  let onEnd: (what: string) => void = () => {};
  const end = (what: string) => {
    ended ??= what;
    onEnd(what);
  };
  worker.once('error', (err) => end(`the guard failed while reading this tool call: ${err.message}`));
  worker.once('exit', (code) => end(`the guard stopped (exit ${code}) before it read this tool call`));
  return {
    judge: (action, options, deadlineMs) =>
      new Promise((settle) => {
        let done = false;
        const finish = (found: Finding | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          settle(found);
          void worker.terminate();
        };
        const timer = setTimeout(() => finish(lateFinding(action, deadlineMs)), deadlineMs);
        if (ended !== null) return finish(unreadable(ended));
        onEnd = (what) => finish(unreadable(what));
        worker.once('message', (found: Finding | null) => finish(found));
        worker.ref();
        // Plain data only: process.env does not cross to a worker as it is.
        worker.postMessage({ action, options: { ...options, env: { ...options.env } } });
      }),
  };
}

// The worker bin/yokoten.mjs starts before it loads the command, for `takeGuard`.
let early: Guard | null = null;

/** Start the guard's worker for the tool call to come, before anything else loads; `takeGuard` hands it on. */
export function startGuardEarly(): void {
  early ??= startGuard();
}

/**
 * The worker `startGuardEarly` started, once, or undefined when none was: `judgeWithDeadline`
 * then starts one only when it judges. A command run in-process, as in a test, starts none early.
 */
export function takeGuard(): Guard | undefined {
  const guard = early ?? undefined;
  early = null;
  return guard;
}

/**
 * `judge`, in a worker thread, with a deadline. The runtimes let a tool call through when
 * the hook runs past their own timeout, so a slow guard would open the gate. A timer in
 * the same thread never fires while the guard reads, so the guard runs in a worker that
 * can be stopped. Past the deadline, or when the worker fails, the call is refused. The
 * deadline runs from this call; a worker from `startGuard` may have started before it.
 */
export function judgeWithDeadline(action: Action, options: JudgeOptions, deadlineMs: number, guard: Guard = startGuard()): Promise<Finding | null> {
  return guard.judge(action, options, deadlineMs);
}

/** The finding when the guard reads an action past its deadline. */
export const lateFinding = (action: Action, deadlineMs: number): Finding => unreadable(`the guard took longer than ${deadlineMs} ms to read this ${action.command === undefined ? 'edit' : 'command'}`);
const unreadable = (what: string): Finding => finding('unreadable-command', what, 'split the command into smaller ones');

// The worker's side: wait for one action, judge it and send the finding back.
if (!isMainThread && parentPort && workerData?.yokotenJudge) {
  const port = parentPort;
  port.once('message', ({ action, options }: { action: Action; options: JudgeOptions }) => port.postMessage(judge(action, options)));
}
