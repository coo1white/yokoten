// The tool-call hook. Before an agent runs a command or edits a file, its runtime asks
// the hook; a finding stops the action, null lets it go.
//
// The hook knows nothing about any one runtime. An adapter in src/agents/ turns the
// runtime's own call into an `Action` first.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import module from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { type Config, DEFAULTS, type Env, type IgnoredPart, loadConfig } from '../rules/config.ts';
import { checkCommand, checkEdit, checkWorkerMarkEdit, configFolder, gitLinkAbove, realPath as real } from '../rules/guards.ts';
import { type Finding, finding } from '../rules/message.ts';
import { makeSecretHider } from '../rules/secrets.ts';

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
 * An end-of-turn event, in no runtime's terms. Each adapter maps its own Stop (or
 * SubagentStop, AfterAgent) payload into this.
 */
export interface StopEvent {
  cwd?: string;
  /** A stop hook already sent the agent back (`stop_hook_active`). */
  active: boolean;
  /** The event comes from a worker subagent. */
  worker: boolean;
  /** The session or subagent id, for the done-when try count. */
  sessionId?: string;
}

/**
 * The shared Stop fields Claude Code, Codex, Muse, Gemini and Grok send (#614). An adapter
 * still decides whether the payload is a stop event at all.
 */
export function readStopFields(input: object): StopEvent {
  const call = input as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const type = text(call.agent_type) ?? text(call.agentType) ?? text(call.subagent_type) ?? text(call.subagentType) ?? '';
  return {
    cwd: text(call.cwd),
    active: call.stop_hook_active === true || call.stopHookActive === true,
    worker: /worker/i.test(type),
    sessionId: text(call.agent_id) ?? text(call.agentId) ?? text(call.session_id) ?? text(call.sessionId),
  };
}

/**
 * How many times a worker is sent back for a failing done-when check (#614). The next
 * stop is allowed, and the lead sees "stopped with failing checks", never "done".
 */
export const DONE_TRY_LIMIT = 3;

/** How long the done-when command may run, in milliseconds. */
export const DONE_WHEN_MS = 120_000;

/** The file in a worktree's git folder that holds the task's done-when command. */
export const DONE_WHEN_FILE = 'yokoten-done-when';

const DONE_OUTPUT_CHARS = 2000;

/** The done-when command from the brief (`YOKOTEN_DONE_WHEN` or the git-folder file), or undefined. */
export function readDoneWhen(env: Env, folder: string): string | undefined {
  const fromEnv = env.YOKOTEN_DONE_WHEN?.trim();
  if (fromEnv) return fromEnv;
  const link = gitLinkAbove(folder);
  if (!link || link.kind === 'broken') return undefined;
  try {
    const text = readFileSync(join(link.gitDir, DONE_WHEN_FILE), 'utf8');
    const line = text.split('\n').find((row) => {
      const trimmed = row.trim();
      return trimmed !== '' && !trimmed.startsWith('#');
    });
    return line?.trim();
  } catch {
    return undefined;
  }
}

/** A key for the done-when try count: the session id when it is a safe name, else a hash of `cwd`. */
export function doneTryKey(sessionId: string | undefined, cwd: string): string {
  if (sessionId && /^[\w-]{1,128}$/.test(sessionId)) return sessionId;
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

const triesPath = (env: Env, key: string): string | null => {
  const folder = configFolder(env);
  return folder ? join(folder, 'done-tries', key) : null;
};

/**
 * Add one to the worker's done-when try count and return it. Null when the count cannot
 * be kept (no config folder, or the file cannot be written): the caller must not trap the
 * session.
 */
export function bumpDoneTries(env: Env, key: string): number | null {
  const path = triesPath(env, key);
  if (!path) return null;
  let count = 0;
  try {
    count = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (!Number.isInteger(count) || count < 0) count = 0;
  } catch {
    count = 0;
  }
  count += 1;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${count}\n`);
  } catch {
    return null;
  }
  return count;
}

/** Forget the worker's done-when try count, once the check passes. */
export function clearDoneTries(env: Env, key: string): void {
  const path = triesPath(env, key);
  if (path) rmSync(path, { force: true });
}

/** The last `DONE_OUTPUT_CHARS` of `text`, with secrets replaced. */
export function shortenOutput(text: string): string {
  const hidden = makeSecretHider()(text.replace(/\s+$/, ''));
  if (hidden.length <= DONE_OUTPUT_CHARS) return hidden;
  const cut = hidden.slice(hidden.length - DONE_OUTPUT_CHARS);
  const newline = cut.indexOf('\n');
  return newline >= 0 ? cut.slice(newline + 1) : cut;
}

/**
 * Run the task's done-when command in `cwd`. `ok` is true only on exit 0. The output is
 * short, with secrets hidden, for the worker to read.
 */
export function runDoneWhen(command: string, cwd: string, env: Env): { ok: boolean; output: string } {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  const result = spawnSync(command, {
    shell: process.platform === 'win32' ? true : '/bin/sh',
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: DONE_WHEN_MS,
    maxBuffer: 256 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trimEnd();
  if (code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    return { ok: false, output: shortenOutput(output ? `${output}\nthe check ran too long and was stopped` : 'the check ran too long and was stopped') };
  }
  if (result.error) {
    return { ok: false, output: shortenOutput(result.error.message.split('\n')[0]) };
  }
  const body = shortenOutput(output);
  if (result.status === 0) return { ok: true, output: body };
  return { ok: false, output: body || `the check exited ${result.status}` };
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
  // A worker's edit inside a git folder may change the worker mark (#555), in any repo;
  // one inside yokoten's config folder may change the worker list (#591).
  if (env.YOKOTEN_ROLE === 'worker') {
    const folder = resolve(action.cwd ?? root ?? cwd);
    for (const p of action.paths) {
      const reason = checkWorkerMarkEdit(resolve(folder, p), folder, env);
      if (reason) return reason;
    }
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
