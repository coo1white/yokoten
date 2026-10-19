// The tool-call hook. Before an agent runs a command or edits a file, its runtime asks
// the hook; a finding stops the action, null lets it go.
//
// The hook knows nothing about any one runtime. An adapter in src/agents/ turns the
// runtime's own call into an `Action` first.

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Config, Env } from '../rules/config.ts';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { checkCommand, checkEdit } from '../rules/guards.ts';
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

/**
 * Why to stop the action (what, why, fix), or null. `root` is the repo root, or null outside a repo.
 * `commandsOnly` is the user-level hook: it runs in every repo, so it keeps to the rules
 * that hold everywhere (no tag pushes, no force pushes, no skipped checks) and leaves file
 * rules to each project's own hook.
 */
export function judge(
  action: Action,
  { root, config, env, commandsOnly = false }: { root: string | null; config: Config; env: Env; commandsOnly?: boolean },
): Finding | null {
  if (action.command !== undefined) return checkCommand(action.command, { env });
  if (commandsOnly || !root) return null;
  if (action.worker) env = { ...env, YOKOTEN_ROLE: 'worker' };
  for (const p of action.paths) {
    const rel = relative(real(root), real(resolve(action.cwd ?? root, p)));
    // A file outside the repo is not this repo's business.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    const reason = checkEdit(rel.split(sep).join('/'), { config, env });
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
// itself, then loads this module (#286). It starts as plain JavaScript: this module's
// imports are compiled before any of its code runs, and the cache must be on by then.
// An error from the cache is ignored, as in bin/yokoten.ts.
const WORKER_START = `
const { enableCompileCache } = require('node:module');
try { enableCompileCache?.(); } catch {}
import(${JSON.stringify(import.meta.url)});
`;

/** The guard worker's stack, in MB: about the main thread's. */
const WORKER_STACK_MB = 1;

/**
 * `judge`, in a worker thread, with a deadline. The runtimes let a tool call through when
 * the hook runs past their own timeout, so a slow guard would open the gate. A timer in
 * the same thread never fires while the guard reads, so the guard runs in a worker that
 * can be stopped. Past the deadline, or when the worker fails, the call is refused.
 */
export function judgeWithDeadline(action: Action, options: JudgeOptions, deadlineMs: number): Promise<Finding | null> {
  return new Promise((settle) => {
    // Plain data only: process.env does not cross to a worker as it is.
    // The main thread's stack (V8's default, just under 1 MB), not a worker's default 4 MB:
    // the guard reads a command the same way in the worker as in `judge`, so a command too
    // deep to read there is refused here too, not let through.
    const worker = new Worker(WORKER_START, {
      eval: true,
      workerData: { yokotenJudge: { action, options: { ...options, env: { ...options.env } } } },
      resourceLimits: { stackSizeMb: WORKER_STACK_MB },
    });
    let done = false;
    const finish = (found: Finding | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(found);
      void worker.terminate();
    };
    const refuse = (what: string) => finish(unreadable(what));
    const timer = setTimeout(() => finish(lateFinding(action, deadlineMs)), deadlineMs);
    worker.once('message', (found: Finding | null) => finish(found));
    worker.once('error', (err) => refuse(`the guard failed while reading this tool call: ${err.message}`));
    worker.once('exit', (code) => refuse(`the guard stopped (exit ${code}) before it read this tool call`));
  });
}

/** The finding when the guard reads an action past its deadline. */
export const lateFinding = (action: Action, deadlineMs: number): Finding => unreadable(`the guard took longer than ${deadlineMs} ms to read this ${action.command === undefined ? 'edit' : 'command'}`);
const unreadable = (what: string): Finding => finding('unreadable-command', what, 'split the command into smaller ones');

// The worker's side: judge one action and send the finding back.
if (!isMainThread && parentPort && workerData?.yokotenJudge) {
  const { action, options } = workerData.yokotenJudge as { action: Action; options: JudgeOptions };
  parentPort.postMessage(judge(action, options));
}

// The real path, through symlinks. git reports the repo root's real path, and a tool may
// send a path through a symlink (on macOS, /var is /private/var). A file that does not
// exist yet takes the real path of its nearest existing folder.
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(real(parent), basename(path));
  }
}
