// The tool-call hook. Before an agent runs a command or edits a file, its runtime asks
// the hook; a finding stops the action, null lets it go.
//
// The hook knows nothing about any one runtime. An adapter in src/agents/ turns the
// runtime's own call into an `Action` first.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import module from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { type Config, DEFAULTS, type Env, type IgnoredPart, loadConfig } from '../rules/config.ts';
import { checkCommand, checkEdit, checkWorkerMarkEdit, configFolder, gitLinkAbove, realPath as real } from '../rules/guards.ts';
import { type Finding, finding } from '../rules/message.ts';
import { findEnvironmentValues, makeSecretHider, SECRET } from '../rules/secrets.ts';

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
  /** The event is a subagent ending (Claude Code's SubagentStop), not the lead's own turn. */
  subagent: boolean;
  /** The session or subagent id, for the done-when try count. */
  sessionId?: string;
}

/**
 * A worker's agent type: exactly `worker`, or a name that ends with `:worker`
 * (such as `yokoten:worker`). A name that only contains those letters, such as
 * `coworker`, is not a worker (#614).
 */
export function isWorkerType(type: string): boolean {
  const name = type.toLowerCase();
  return name === 'worker' || name.endsWith(':worker');
}

/**
 * The shared Stop fields Claude Code, Codex, Muse, Gemini and Grok send (#614). An adapter
 * still decides whether the payload is a stop event at all.
 */
export function readStopFields(input: object): StopEvent {
  const call = input as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const type = text(call.agent_type) ?? text(call.agentType) ?? text(call.subagent_type) ?? text(call.subagentType) ?? '';
  const eventName = (text(call.hook_event_name) ?? text(call.hookEventName) ?? '').toLowerCase();
  return {
    cwd: text(call.cwd),
    active: call.stop_hook_active === true || call.stopHookActive === true,
    worker: isWorkerType(type),
    subagent: eventName === 'subagentstop',
    sessionId: text(call.agent_id) ?? text(call.agentId) ?? text(call.session_id) ?? text(call.sessionId),
  };
}

/**
 * How many times a worker is sent back for a failing check (#614). The next stop is
 * then allowed. The worker tells the lead the checks are failing. It never says done.
 */
export const DONE_TRY_LIMIT = 3;

/** How long the done-when command may run, in milliseconds. */
export const DONE_WHEN_MS = 120_000;

/** How long to wait for the last output after the shell exits, in milliseconds. */
const CLOSE_GRACE_MS = 200;

/** The file in a worktree's git folder that holds the task's done-when command. */
export const DONE_WHEN_FILE = 'yokoten-done-when';

/**
 * The agent's status file, at a linked worktree's root. The lead reads it.
 * The board will show `checks` later (#603). The guide shows its fields.
 */
export const AGENT_STATUS_FILE = '.yokoten-agent.json';

/** The largest status file that is read. A bigger file is left unread. */
export const STATUS_TEXT_LIMIT = 64 * 1024;

/**
 * A marker in the checkout's git folder when the try count could not be saved (#614).
 * The same worker is let through for this long after that refusal.
 */
export const REFUSED_MARK_DIR = 'yokoten-stop-refused';
export const REFUSED_WINDOW_MS = 5 * 60 * 1000;

const DONE_OUTPUT_CHARS = 2000;
const DONE_OUTPUT_CAP = 256 * 1024;
/** Count files older than this are removed when a new one is written (#614). */
const COUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  deleteOldCountFiles(dirname(path), basename(path));
  return count;
}

/** Drop count files in `dir` that are older than a day. `keepName` is the one just written. */
function deleteOldCountFiles(dir: string, keepName: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - COUNT_MAX_AGE_MS;
  for (const name of names) {
    if (name === keepName) continue;
    const path = join(dir, name);
    try {
      const stats = lstatSync(path);
      // A link is not a count file. Removing it by name would still be only the link,
      // but leave it: the count itself is a regular file.
      if (!stats.isFile() || stats.mtimeMs >= cutoff) continue;
      rmSync(path, { force: true });
    } catch {
      // An old count that cannot be removed must not trap the stop.
    }
  }
}

/**
 * Forget the worker's done-when try count, once the check passes or the worker is let
 * through. An error removing the file is ignored: it must not crash the hook (#614).
 */
export function clearDoneTries(env: Env, key: string): void {
  const path = triesPath(env, key);
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // The count file can stay. The hook still ends the turn.
  }
}

/** The shell that runs a done-when command: `cmd.exe` on Windows, `sh` on every other system. */
export function doneWhenShell(): string {
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}

/** Arguments for `taskkill` that stop `pid` and the programs it started, while that shell is still alive. */
export function windowsTreeKillArgs(pid: number): string[] {
  return ['/F', '/T', '/PID', String(pid)];
}

/**
 * Stop `pid` and the programs it started: the process group on POSIX, the tree on Windows.
 * On POSIX the group remains after the shell exits, so a kill then still stops what it
 * left behind (#641). On Windows, `taskkill /T` finds the tree only while the shell is
 * still running. `spawnSync`'s timeout kills `cmd.exe` first, and the tree would stay (#614).
 */
function killCommandTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', windowsTreeKillArgs(pid), { stdio: 'ignore', windowsHide: true });
      return;
    }
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process is already gone.
    }
  }
}

/** The path of the refusal marker for `key`, in the checkout's git folder, or null when there is none. */
export function refusedMarkerPath(folder: string, key: string): string | null {
  const link = gitLinkAbove(folder);
  if (!link || link.kind === 'broken') return null;
  return join(link.gitDir, REFUSED_MARK_DIR, key);
}

/** Whether `key` was refused in this checkout within the last five minutes. */
export function wasRefusedRecently(folder: string, key: string, now = Date.now()): boolean {
  const path = refusedMarkerPath(folder, key);
  if (!path) return false;
  try {
    const then = Date.parse(readFileSync(path, 'utf8').trim());
    if (!Number.isFinite(then)) return false;
    const age = now - then;
    return age >= 0 && age <= REFUSED_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Remember that `key` was refused now, so a later stop in the window can be let through. */
export function noteRefused(folder: string, key: string, now = new Date()): void {
  const path = refusedMarkerPath(folder, key);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeReplacing(path, `${now.toISOString()}\n`);
  } catch {
    // The next stop cannot see this refusal. stop_hook_active is the other way out.
  }
}

/** Forget a refusal marker. A pass starts the next failure from a real refusal. */
export function clearRefusedMarker(folder: string, key: string): void {
  const path = refusedMarkerPath(folder, key);
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // A marker that stays only widens the allow window.
  }
}

/**
 * Write `body` over `path` without following a link. A temp file in the same folder
 * is renamed onto the name, which replaces a link and does not open its target.
 */
function writeReplacing(path: string, body: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, body, { flag: 'wx' });
    try {
      renameSync(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can refuse to rename onto a name that exists. Removing the name
      // drops a link. It does not change the link's target.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
      rmSync(path, { force: true });
      renameSync(temp, path);
    }
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp file can stay. The caller still hears the original error.
    }
    throw error;
  }
}

/** Whether `opened` is the file `listed` saw. `dev` and `ino` both have to match. */
export function isSameFile(listed: { dev: number; ino: number }, opened: { dev: number; ino: number }): boolean {
  return listed.dev === opened.dev && listed.ino === opened.ino;
}

/**
 * The text of a regular file, or null. A link is not opened. The open does not wait
 * on a pipe. The open file is checked before any byte is read. It must be the same
 * file the list saw, and it must be under the size cap. Windows has no `O_NOFOLLOW`,
 * so that check compares `dev` and `ino`. `openFile` opens the path. A test passes
 * one that opens another file.
 */
export function readStatusText(path: string, openFile: (file: string, flags: number) => number = openSync): string | null {
  let listed: { dev: number; ino: number };
  try {
    const before = lstatSync(path);
    if (!before.isFile()) return null;
    listed = { dev: before.dev, ino: before.ino };
  } catch {
    return null;
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number | undefined;
  try {
    fd = openFile(path, flags);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !isSameFile(listed, opened) || opened.size > STATUS_TEXT_LIMIT) return null;
    const buffer = Buffer.alloc(opened.size);
    const count = readSync(fd, buffer, 0, opened.size, 0);
    return buffer.toString('utf8', 0, count);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseStatus(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the new checks replace it.
  }
  return {};
}

/**
 * Record `checks` in `.yokoten-agent.json` at `folder`. Other fields stay. `updated` is UTC.
 * A link, or any other non-file, is left unchanged and named on `warn` in one line.
 * The bytes go to a temp file in the same folder and are renamed over the path, so a
 * link that appears in between is replaced and never followed. A file that cannot be
 * written does not crash the hook.
 */
export function writeAgentChecks(folder: string, checks: 'failing' | 'passing', now: Date, warn: (line: string) => void): void {
  const path = join(folder, AGENT_STATUS_FILE);
  let status: Record<string, unknown> = {};
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) {
      warn(`yokoten: ${AGENT_STATUS_FILE} is not a regular file, so it was left unchanged.\n`);
      return;
    }
    status = parseStatus(readStatusText(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  status.checks = checks;
  status.updated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    writeReplacing(path, `${JSON.stringify(status, null, 2)}\n`);
  } catch {
    // The worker's own message still tells the lead. A locked file must not trap the stop.
  }
}

/** The last `DONE_OUTPUT_CHARS` of `text`, with secrets and the real values of secret-looking variables in `env` replaced (#616). */
export function shortenOutput(text: string, env: Env = {}): string {
  let hidden = makeSecretHider()(text.replace(/\s+$/, ''));
  for (const value of findEnvironmentValues(env)) hidden = hidden.replaceAll(value, SECRET);
  if (hidden.length <= DONE_OUTPUT_CHARS) return hidden;
  const cut = hidden.slice(hidden.length - DONE_OUTPUT_CHARS);
  const newline = cut.indexOf('\n');
  return newline >= 0 ? cut.slice(newline + 1) : cut;
}

/**
 * Run the task's done-when command in `cwd`. `ok` is true only on exit 0. The output is
 * short, with secrets hidden, for the worker to read.
 *
 * The command is started with `spawn`, and a timer in this process stops it. That timer
 * runs while the shell is still alive. On Windows it calls `taskkill /F /T /PID` then.
 * `spawnSync`'s timeout would have killed `cmd.exe` first, and the tree would stay (#614).
 * When the shell exits, programs still in its group are stopped the same way. The check
 * ends on the shell's own result. A short wait collects the last output, then the pipes
 * are dropped. A program that left the group is not stopped, and it cannot hold the
 * check open. The result is given once.
 */
export function runDoneWhen(
  command: string,
  cwd: string,
  env: Env,
  timeoutMs: number = DONE_WHEN_MS,
  killTree: (pid: number) => void = killCommandTree,
): Promise<{ ok: boolean; output: string }> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { ok: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolvePromise(value);
    };
    let child: ChildProcess;
    try {
      // A new process group on POSIX, so a timeout or a normal exit can stop what the shell started.
      // Windows stays in this process's tree: `taskkill /T` follows the parent, not a group.
      child = spawn(command, {
        shell: doneWhenShell(),
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, output: shortenOutput((error as Error).message.split('\n')[0], env) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const take = (have: string, chunk: string) => (have.length >= DONE_OUTPUT_CAP ? have : (have + chunk).slice(0, DONE_OUTPUT_CAP));
    const stoppedOutput = (output: string) => shortenOutput(output ? `${output}\nthe check ran too long and was stopped` : 'the check ran too long and was stopped', env);
    const resultFor = (code: number | null, signal: NodeJS.Signals | null) => {
      const output = `${stderr}${stdout}`.trimEnd();
      if (timedOut || signal === 'SIGTERM') return { ok: false, output: stoppedOutput(output) };
      const body = shortenOutput(output, env);
      if (code === 0) return { ok: true, output: body };
      return { ok: false, output: body || `the check exited ${code}` };
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = take(stderr, chunk);
    });
    // Drop our end of the pipes. A grandchild that left the group can hold the other end.
    const dropPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) killTree(child.pid);
        dropPipes();
      } catch {
        // The tree kill can throw. The check still ends below.
      } finally {
        finish(resultFor(null, null));
      }
    }, timeoutMs);
    child.once('error', (error) => finish({ ok: false, output: shortenOutput(error.message.split('\n')[0], env) }));
    child.once('exit', (code, signal) => {
      if (settled || timedOut) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // The shell has exited. Stop programs still in its group. A program that
      // called setsid is in another group, so this does not reach it (#641).
      try {
        if (child.pid) killTree(child.pid);
      } catch {
        // The tree kill can throw. The check still ends on the shell's status.
      }
      if (settled) return;
      grace = setTimeout(() => {
        try {
          dropPipes();
        } finally {
          finish(resultFor(code, signal));
        }
      }, CLOSE_GRACE_MS);
    });
    child.once('close', (status, signal) => finish(resultFor(status, signal)));
  });
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

// The guard worker loads this file alone. This layer cannot import the host layer
// (record 0004). Load the host command list before the worker reads a call.
await import('../host/gh-commands.ts');

// The worker's side: wait for one action, judge it and send the finding back.
if (!isMainThread && parentPort && workerData?.yokotenJudge) {
  const port = parentPort;
  port.once('message', ({ action, options }: { action: Action; options: JudgeOptions }) => port.postMessage(judge(action, options)));
}
