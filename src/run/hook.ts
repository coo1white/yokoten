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
import { checkCommand, checkEdit, checkTeamEdit, checkWorkerMarkEdit, configFolder, gitLinkAbove, realPath as real } from '../rules/guards.ts';
import { type Finding, finding } from '../rules/message.ts';
import { findEnvironmentValues, makeSecretHider, SECRET } from '../rules/secrets.ts';

/** What an agent is about to do, in no runtime's terms. */
export interface Action {
  /** A shell command, as the agent wrote it. */
  command?: string;
  /** Every command on one call, when it carries more than one. The guard refuses if any entry is refused. */
  commands?: string[];
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

/** Arguments for `taskkill` that stop `pid` and the programs it started, while that process is still alive. */
export function windowsTreeKillArgs(pid: number): string[] {
  return ['/F', '/T', '/PID', String(pid)];
}

/**
 * The done-when command, passed to the Windows job host in the environment and removed
 * before `cmd.exe` starts, so the command does not see its own text there (#735).
 */
const DONE_COMMAND_ENV = 'YOKOTEN_DONE_COMMAND';

/**
 * PowerShell that puts `cmd.exe` in a job and closes the job when `cmd.exe` exits.
 * `taskkill /T` finds a tree only while its root is still running, and the root is already
 * gone by the time a passing check returns (#735). The job holds the tree. No native module:
 * Windows PowerShell compiles this once per check. If that fails, the script runs `cmd.exe`
 * the old way, and a program it left behind can keep running.
 */
const WINDOWS_JOB_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$command = [string]$env:${DONE_COMMAND_ENV}
Remove-Item Env:\\${DONE_COMMAND_ENV} -ErrorAction SilentlyContinue
$comspec = [string]$env:ComSpec
if (-not $comspec) { $comspec = 'cmd.exe' }
$csharp = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class YokotenJob {
  const uint CREATE_SUSPENDED = 4;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const int JobObjectExtendedLimitInformation = 9;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int kind);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public IntPtr reserved;
    public IntPtr desktop;
    public IntPtr title;
    public int x;
    public int y;
    public int xSize;
    public int ySize;
    public int xCountChars;
    public int yCountChars;
    public int fillAttribute;
    public int flags;
    public short showWindow;
    public short reserved2Length;
    public IntPtr reserved2;
    public IntPtr stdInput;
    public IntPtr stdOutput;
    public IntPtr stdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr process;
    public IntPtr thread;
    public int processId;
    public int threadId;
  }

  static void MakeInheritable(IntPtr handle) {
    if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
    SetHandleInformation(handle, 1, 1);
  }

  static void TryKillOnClose(IntPtr job) {
    JOBOBJECT_BASIC_LIMIT_INFORMATION basic = new JOBOBJECT_BASIC_LIMIT_INFORMATION();
    basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation = basic;
    int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr ptr = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(info, ptr, false);
      SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length);
    } finally {
      Marshal.FreeHGlobal(ptr);
    }
  }

  public static int Run(string comspec, string command) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    bool haveJob = job != IntPtr.Zero;
    if (haveJob) {
      try { TryKillOnClose(job); }
      catch { CloseHandle(job); haveJob = false; job = IntPtr.Zero; }
    }
    STARTUPINFO startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.flags = 0x101;
    startup.showWindow = 0;
    startup.stdInput = GetStdHandle(-10);
    startup.stdOutput = GetStdHandle(-11);
    startup.stdError = GetStdHandle(-12);
    MakeInheritable(startup.stdInput);
    MakeInheritable(startup.stdOutput);
    MakeInheritable(startup.stdError);
    int capacity = (command == null ? 0 : command.Length) + (comspec == null ? 0 : comspec.Length) + 64;
    StringBuilder line = new StringBuilder(capacity);
    line.Append('"').Append(comspec).Append("\\" /d /s /c \\"").Append(command).Append('"');
    PROCESS_INFORMATION info;
    bool created = CreateProcess(null, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref startup, out info);
    if (!created) {
      // A bad standard handle fails the start. Try again with the parent's own handles.
      startup.flags = 1;
      startup.stdInput = IntPtr.Zero;
      startup.stdOutput = IntPtr.Zero;
      startup.stdError = IntPtr.Zero;
      line.Length = 0;
      line.Append('"').Append(comspec).Append("\\" /d /s /c \\"").Append(command).Append('"');
      created = CreateProcess(null, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref startup, out info);
    }
    if (!created) {
      if (haveJob) CloseHandle(job);
      throw new InvalidOperationException("create");
    }
    try {
      if (haveJob) AssignProcessToJobObject(job, info.process);
      ResumeThread(info.thread);
      WaitForSingleObject(info.process, uint.MaxValue);
      uint code;
      if (!GetExitCodeProcess(info.process, out code)) code = 1;
      if (haveJob) TerminateJobObject(job, 1);
      return unchecked((int)code);
    } finally {
      CloseHandle(info.thread);
      CloseHandle(info.process);
      if (haveJob) CloseHandle(job);
    }
  }
}
'@
try {
  Add-Type -TypeDefinition $csharp -Language CSharp
  $codeExit = [YokotenJob]::Run($comspec, $command)
  exit $codeExit
} catch {
  & $comspec /d /s /c $command
  exit $LASTEXITCODE
}
`;

/** Arguments that run the job host: Windows PowerShell, with the script encoded so quotes stay intact. */
export function windowsJobArgs(): string[] {
  const encoded = Buffer.from(WINDOWS_JOB_SCRIPT, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

/** `powershell.exe` on Windows, or null so the caller starts `cmd.exe` itself. */
function windowsPowerShell(env: Record<string, string>): string | null {
  if (process.platform !== 'win32') return null;
  const root = env.SystemRoot;
  if (!root) return 'powershell.exe';
  const path = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(path) ? path : 'powershell.exe';
}

/** The session id from one `/proc` stat line, or null when the line is not a stat. */
export function sessionFromStat(text: string): number | null {
  const end = text.lastIndexOf(')');
  if (end < 0 || end + 2 >= text.length) return null;
  const session = Number(text.slice(end + 2).split(' ')[3]);
  return Number.isInteger(session) && session > 0 ? session : null;
}

/** Pids in `text` from `ps -o pid=,sess=` whose session is `session`. */
export function pidsFromSessionTable(text: string, session: number): number[] {
  const found: number[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const sid = Number(parts[1]);
    if (Number.isInteger(pid) && pid > 0 && sid === session) found.push(pid);
  }
  return found;
}

function ownSessionId(): number | null {
  try {
    return sessionFromStat(readFileSync('/proc/self/stat', 'utf8'));
  } catch {
    return null;
  }
}

function pidsFromProc(session: number): number[] {
  const found: number[] = [];
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (sessionFromStat(readFileSync(join('/proc', name, 'stat'), 'utf8')) === session) found.push(Number(name));
    } catch {
      // The process exited while it was listed.
    }
  }
  return found;
}

function pidsWithSession(session: number): number[] {
  if (existsSync('/proc/self/stat')) return pidsFromProc(session);
  const listed = spawnSync('ps', ['-ax', '-o', 'pid=,sess='], { encoding: 'utf8', windowsHide: true });
  return listed.status === 0 && typeof listed.stdout === 'string' ? pidsFromSessionTable(listed.stdout, session) : [];
}

/**
 * Stop processes whose session is `session`. A new process group stays in the session, so
 * killing the group alone misses it. `setsid` starts a new session, so it is not here (#735).
 * The id is the shell's pid, because the shell was started as a session leader. If that
 * start failed, the id is not a session and this stops nothing.
 */
function killSessionMembers(session: number): void {
  if (session <= 1) return;
  const own = ownSessionId();
  if (own !== null && session === own) return;
  for (const member of pidsWithSession(session)) {
    if (member <= 1 || member === process.pid || member === process.ppid) continue;
    try {
      process.kill(member, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Stop `pid` and the programs it started: the process group and the session on POSIX,
 * the tree on Windows. On POSIX the group remains after the shell exits, so a kill then
 * still stops what it left behind (#641). A new process group in that session is stopped
 * too. A new session, such as `setsid`, is not (#735). On Windows the job host closes the
 * tree; `taskkill /T` also runs while the host is alive, which is the timeout path (#614).
 */
function killCommandTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', windowsTreeKillArgs(pid), { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process is already gone.
    }
  }
  killSessionMembers(pid);
}

/** Start the done-when command. On Windows the host is a job; elsewhere it is a new session. */
function spawnDoneWhen(command: string, cwd: string, env: Record<string, string>): ChildProcess {
  const powershell = windowsPowerShell(env);
  if (powershell) {
    return spawn(powershell, windowsJobArgs(), {
      cwd,
      env: { ...env, [DONE_COMMAND_ENV]: command },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return spawn(command, {
    shell: doneWhenShell(),
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
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
 * Why a status file was not read. The words are plain, for the warning on stderr.
 */
export type StatusRefusal = 'too large' | 'cannot be read' | 'changed while it was read';

/** The text of a status file, or the reason it was refused. */
export type StatusReadResult = { text: string } | { refused: StatusRefusal };

/**
 * Read a regular status file, or say why it was refused. A link is not opened. The
 * open does not wait on a pipe. The open file is checked before any byte is read. It
 * must be the same file the list saw, and it must be under the size cap. Windows has
 * no `O_NOFOLLOW`, so that check compares `dev` and `ino`. `openFile` opens the path.
 * A test passes one that opens another file.
 */
export function readStatusResult(path: string, openFile: (file: string, flags: number) => number = openSync): StatusReadResult {
  let listed: { dev: number; ino: number };
  try {
    const before = lstatSync(path);
    if (!before.isFile()) return { refused: 'cannot be read' };
    listed = { dev: before.dev, ino: before.ino };
  } catch {
    return { refused: 'cannot be read' };
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number | undefined;
  try {
    try {
      fd = openFile(path, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { refused: code === 'ENOENT' || code === 'ELOOP' ? 'changed while it was read' : 'cannot be read' };
    }
    const opened = fstatSync(fd);
    if (!opened.isFile() || !isSameFile(listed, opened)) return { refused: 'changed while it was read' };
    if (opened.size > STATUS_TEXT_LIMIT) return { refused: 'too large' };
    const buffer = Buffer.alloc(opened.size);
    const count = readSync(fd, buffer, 0, opened.size, 0);
    if (count !== opened.size) return { refused: 'changed while it was read' };
    return { text: buffer.toString('utf8', 0, count) };
  } catch {
    return { refused: 'cannot be read' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The text of a regular status file, or null when it was refused. */
export function readStatusText(path: string, openFile: (file: string, flags: number) => number = openSync): string | null {
  const result = readStatusResult(path, openFile);
  return 'text' in result ? result.text : null;
}

/** One warning line for a refused status file. It never contains the file's text. */
function statusRefusalLine(reason: StatusRefusal): string {
  const phrase = reason === 'too large' ? 'is too large' : reason;
  return `yokoten: ${AGENT_STATUS_FILE} ${phrase}, so it was left unchanged.\n`;
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
 * A refused status file is left unchanged and named on `warn` in one line. That
 * includes a link or other non-file, a file over the size cap, a file that cannot be
 * read, and a file that changed while it was read.
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
    const result = readStatusResult(path);
    if ('refused' in result) {
      warn(statusRefusalLine(result.refused));
      return;
    }
    status = parseStatus(result.text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(statusRefusalLine('cannot be read'));
      return;
    }
  }
  status.checks = checks;
  status.updated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    writeReplacing(path, `${JSON.stringify(status, null, 2)}\n`);
  } catch {
    // The worker's own message still tells the lead. A locked file must not trap the stop.
  }
}

/** How often an allowed tool call rewrites the status file, at most (#685). */
export const STATUS_EVERY_MS = 5000;
/** The file in a desk clone's git folder that says it is a desk (#685). `yokoten desk` writes it. */
export const DESK_FILE = 'yokoten-desk';
/** The file in a repo's shared git folder that lists its desks, one path a line (#685). */
export const DESK_LIST_FILE = 'yokoten-desks';

/** One checkout an agent works in: its root, its own git folder, and the shared git folder of all its worktrees. */
export interface StatusCheckout {
  top: string;
  gitDir: string;
  common: string;
  /** A main checkout or a plain clone, not a linked worktree. */
  isMain: boolean;
  /** A clone that `yokoten desk` set up. */
  isDesk: boolean;
}

/**
 * The checkout at or above `folder` whose status file the hooks keep (#685), or null. It
 * must hold `yokoten.json`, so a repo that does not use yokoten never gets the file.
 * The folder's real path is used, so a link out of it names no other checkout.
 */
export function findStatusCheckout(folder: string): StatusCheckout | null {
  let link: ReturnType<typeof gitLinkAbove>;
  try {
    link = gitLinkAbove(real(folder));
  } catch {
    return null;
  }
  if (!link || link.kind === 'broken' || !existsSync(join(link.top, 'yokoten.json'))) return null;
  if (link.kind === 'folder') return { top: link.top, gitDir: link.gitDir, common: link.gitDir, isMain: true, isDesk: existsSync(join(link.gitDir, DESK_FILE)) };
  return { top: link.top, gitDir: link.gitDir, common: commonGitDir(link.top) ?? link.gitDir, isMain: false, isDesk: false };
}

/**
 * Whether a session may keep the status file of `checkout`: the main checkout's file is
 * the lead's, so a worker writes only in its own worktree or desk.
 */
export const canKeepStatus = (checkout: StatusCheckout, isWorker: boolean): boolean => !isWorker || !checkout.isMain || checkout.isDesk;

/** Add the status file to the repo's own exclude list once, so `git status` never shows it, even without a `.gitignore` line. */
function excludeStatusFile(common: string): void {
  const path = join(common, 'info', 'exclude');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // No exclude file yet: it is made below.
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === AGENT_STATUS_FILE || line.trim() === `/${AGENT_STATUS_FILE}`)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# yokoten board: each agent's live status (#685)\n${AGENT_STATUS_FILE}\n`);
}

/** A change to a status file: `set` replaces fields (null removes one), `fill` sets fields only where they are missing. */
export interface StatusChange {
  set?: Record<string, string | null>;
  fill?: Record<string, string>;
  /** Skip the write when the file changed less than this long ago. A new file is always written. */
  throttleMs?: number;
}

/**
 * Change the agent's status file at `checkout`'s root (#685). Other fields stay, so an
 * agent's own `task` or `question` is kept. `updated` is UTC. A link or any other non-file
 * is left unchanged. The write replaces the file through a temp file, as writeAgentChecks
 * does. Returns whether it wrote; it never throws, so the hook never fails on it.
 */
export function changeAgentStatus(checkout: StatusCheckout, change: StatusChange, now: Date = new Date()): boolean {
  const path = join(checkout.top, AGENT_STATUS_FILE);
  try {
    let status: Record<string, unknown> = {};
    let isNew = false;
    try {
      const stats = lstatSync(path);
      if (!stats.isFile()) return false;
      if (change.throttleMs && now.getTime() - stats.mtimeMs < change.throttleMs) return false;
      status = parseStatus(readStatusText(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      isNew = true;
    }
    for (const [name, value] of Object.entries(change.fill ?? {})) if (typeof status[name] !== 'string' || !status[name]) status[name] = value;
    for (const [name, value] of Object.entries(change.set ?? {})) {
      if (value === null) delete status[name];
      else status[name] = value;
    }
    status.updated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (isNew) excludeStatusFile(checkout.common);
    writeReplacing(path, `${JSON.stringify(status, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The shared git folder of the checkout at or above `folder`, with no git process, or null outside one. */
export function commonGitDir(folder: string): string | null {
  const link = gitLinkAbove(folder);
  if (!link || link.kind === 'broken') return null;
  if (link.kind === 'folder') return link.gitDir;
  try {
    return resolve(link.gitDir, readFileSync(join(link.gitDir, 'commondir'), 'utf8').trim());
  } catch {
    return link.gitDir;
  }
}

/**
 * Note a desk clone for the board (#685): a mark in the desk's own git folder, so its
 * hooks keep a status file there, and its path on the list in the lead's repo, so the
 * board shows it though `git worktree list` does not. Returns why it could not, or ''.
 */
export function registerDesk(leadFolder: string, desk: string): string {
  const deskGit = join(desk, '.git');
  try {
    if (!lstatSync(deskGit).isDirectory()) return 'the desk is not a plain clone';
    writeFileSync(join(deskGit, DESK_FILE), 'A desk that yokoten desk started: its agent shows on the lead\'s board.\n');
  } catch {
    return 'the desk has no git folder yet';
  }
  const common = commonGitDir(leadFolder);
  if (!common) return 'the lead is not in a repo';
  const list = join(common, DESK_LIST_FILE);
  try {
    let text = '';
    try {
      text = readFileSync(list, 'utf8');
    } catch {
      // The first desk makes the list.
    }
    const paths = text.split('\n').filter((line) => line && existsSync(line));
    if (!paths.includes(desk)) paths.push(desk);
    writeFileSync(list, `${paths.join('\n')}\n`);
  } catch {
    return 'the desk list can\'t be written';
  }
  return '';
}

/** The fields a session starts with: who runs, in which role, where, when it started, and that it works. */
export function startFields(vendor: string, isWorker: boolean, checkout: StatusCheckout, model: string): { set: Record<string, string>; fill: Record<string, string> } {
  return {
    set: { vendor, state: 'working', ...(model ? { model } : {}) },
    // `started` is set once. Later writes keep it, so the timeline bar does not move.
    fill: { role: isWorker ? 'engineer' : 'lead', worktree: checkout.top, started: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
  };
}

/** What a tool call does, in a few words for the board: the program it runs, or the file it edits. Secrets are hidden. */
export function describeAction(action: Action): string {
  if (action.command !== undefined) {
    const words = action.command.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const shown = words.slice(0, 2).map((word) => word.replace(/['"`]/g, '').slice(0, 40)).filter(Boolean);
    return shown.length ? makeSecretHider()(`running ${shown.join(' ')}`) : '';
  }
  const [path] = action.paths;
  return path ? makeSecretHider()(`editing ${basename(path)}`.slice(0, 80)) : '';
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
 * runs while the shell is still alive. On Windows it calls `taskkill /F /T /PID` on the
 * job host then. `spawnSync`'s timeout would have killed `cmd.exe` first, and the tree
 * would stay (#614). When the shell exits, programs still in its group or its session are
 * stopped the same way. On Windows the job host has already closed the job, which stops
 * programs `cmd.exe` left behind (#735). A program that started its own session is not
 * stopped, and it cannot hold the check open. The check ends on the shell's own result.
 * A short wait collects the last output, then the pipes are dropped. The result is given once.
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
      // A new session on POSIX, so a timeout or a normal exit can stop what the shell started.
      // On Windows the host puts cmd.exe in a job, so the tree still exists after cmd.exe exits.
      child = spawnDoneWhen(command, cwd, childEnv);
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
      // The shell has exited. Stop programs still in its group or its session.
      // A program that called setsid is in another session, so this does not reach it (#735).
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
  // Every command the call carries is judged: `commands` and `command` both, so an empty list never hides one.
  const commands = [...(action.commands ?? []), ...(action.command !== undefined && !action.commands?.includes(action.command) ? [action.command] : [])];
  if (commands.length > 0) {
    // Titles follow a project's own rules: only its hook checks them, never the user-level one (#391).
    const titles = !commandsOnly && root !== null && existsSync(join(root, 'yokoten.json'));
    const ruledRepos = ruled.map((repo) => ({ root: repo.root, leadOnly: repo.config.leadOnly }));
    for (const command of commands) {
      const reason = checkCommand(command, { env, config, cwd: action.cwd ?? root ?? cwd, titles, repos: ruledRepos });
      if (reason) return reason;
    }
  }
  // A worker's edit inside a git folder may change the worker mark (#555), in any repo;
  // one inside a team folder may speak for another agent (#674);
  // one inside yokoten's config folder may change the worker list (#591).
  if (env.YOKOTEN_ROLE === 'worker') {
    const folder = resolve(action.cwd ?? root ?? cwd);
    for (const p of action.paths) {
      const reason = checkWorkerMarkEdit(resolve(folder, p), folder, env) ?? checkTeamEdit(resolve(folder, p));
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
