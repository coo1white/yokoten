// Machine notes (record 0012): machine state that stops every agent session, where the
// agent can't see it. Read only and cheap. A session reads one filesystem and one small
// file, and never runs a child process. Each note is a note, never a failure, and a fix
// that needs sudo or Windows is printed for the owner to run, never run.

import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { type Env } from '../../rules/config.ts';
import { type Finding, finding } from '../../rules/message.ts';
import { tempDir as claudeTempDir } from '../../agents/runtimes/claude-code.ts';
import { findTempDirs } from '../advice/unsaved.ts';
import { compareVersions } from '../init.ts';
import { machineStateFile, readMachineState, saveMachineState, writeFileAtomic } from '../install.ts';
import { type Practice } from './checks.ts';
import { type DiskSpace, formatSpace, HOST_DISK_FIX, HOST_DRIVE, hostDiskCache, type HostDiskCache, isFreshReading, isLowOnSpace } from './host-disk.ts';

// The disk limit, the kept host reading and the fix live in host-disk.ts, which the guard
// reads too (#401). They keep their names here, where doctor and its tests found them.
export { type DiskSpace, WSL_DISK_GUIDE, HOST_DISK_FIX, type HostDiskCache, isLowOnSpace, formatSpace } from './host-disk.ts';

/** What the machine notes read, so a test (and the self-test) can hand in a fake machine. */
export interface MachineProbe {
  /** The free and total bytes of the filesystem that holds `path`. Throws when it can't read them. */
  readDiskSpace(path: string): DiskSpace;
  /** The uid that owns `path`, or null when nothing is there. */
  readOwner(path: string): number | null;
  /** A program's stdout. Throws when it fails, or runs longer than `timeoutMs`. */
  runProgram(file: string, args: string[], timeoutMs: number): string;
  /** A file's text, or null when it can't be read. */
  readText(path: string): string | null;
  /** Write a file, making its folder. Throws when it can't. */
  writeText(path: string, text: string): void;
  /** This process's uid, or null where there is none (Windows). */
  uid: number | null;
  now(): Date;
  /** The running Node's version, as in `process.versions.node`. */
  nodeVersion: string;
}

/** The real machine. */
export const REAL_MACHINE: MachineProbe = {
  readDiskSpace(path) {
    const stats = statfsSync(path);
    return { free: Number(stats.bavail) * Number(stats.bsize), size: Number(stats.blocks) * Number(stats.bsize) };
  },
  readOwner(path) {
    try {
      return lstatSync(path).uid;
    } catch {
      return null;
    }
  },
  runProgram: (file, args, timeoutMs) => execFileSync(file, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }),
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: writeFileAtomic,
  uid: process.getuid?.() ?? null,
  now: () => new Date(),
  nodeVersion: process.versions.node,
};

const GB = 1024 ** 3;

/** How long full doctor waits for reg.exe. */
const REGISTRY_TIMEOUT_MS = 3000;

/** The file that tells a Linux process it runs in WSL. */
const WSL_INTEROP_FILE = '/proc/sys/fs/binfmt_misc/WSLInterop';

/** Where WSL keeps each distro's settings, its disk file's folder among them. */
const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

/** Whether this Linux runs in WSL: WSL sets WSL_DISTRO_NAME, and the interop file is there. */
export const isWsl = (env: Env, probe: MachineProbe): boolean => Boolean(env.WSL_DISTRO_NAME) || probe.readText(WSL_INTEROP_FILE) !== null;

/** One WSL distro, as the registry lists it. */
export interface WslDistro {
  name: string;
  basePath: string;
  /** 1 or 2; WSL 2 when the registry does not say. */
  version: number;
}

/** The distros in the output of `reg.exe query <Lxss key> /s`. */
export function parseLxss(text: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const block of text.split(/\r?\n(?=HKEY_)/)) {
    const value = (name: string) => block.match(new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'm'))?.[1];
    const name = value('DistributionName');
    const basePath = value('BasePath');
    if (!name || !basePath) continue;
    distros.push({ name, basePath, version: Number.parseInt(value('Version') ?? '0x2', 16) === 1 ? 1 : 2 });
  }
  return distros;
}

/**
 * Where Linux mounts a Windows drive, from /proc/mounts: `C:\` on /mnt/c, for example.
 * Null when it is not mounted. Never a guess: a path that is not the drive would give
 * this Linux disk's numbers instead.
 */
export function findDriveMount(letter: string, mounts: string): string | null {
  const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
  for (const line of mounts.split('\n')) {
    const [source, target, type] = line.split(' ');
    if (!source || !target || !['9p', 'drvfs', 'virtiofs'].includes(type ?? '')) continue;
    if (unescape(source).toUpperCase().startsWith(`${letter.toUpperCase()}:`)) return unescape(target);
  }
  return null;
}

/** The Windows drive that holds this distro's disk file, as read now; or why it can't be read. */
export type HostDiskRead = { space: DiskSpace; distro: string; version: number } | { unread: string };

/**
 * In WSL, the Windows drive that holds this distro's disk file. Linux sees only the disk
 * file's own size, which can be far more than the drive has. Full doctor only: it runs
 * reg.exe, with a time cap.
 */
export function readHostDisk(env: Env, probe: MachineProbe): HostDiskRead {
  const distro = env.WSL_DISTRO_NAME;
  if (!distro) return { unread: 'WSL_DISTRO_NAME is not set' };
  const mounts = probe.readText('/proc/mounts') ?? '';
  const systemDrive = findDriveMount('C', mounts);
  const programs = ['reg.exe', ...(systemDrive ? [join(systemDrive, 'Windows', 'System32', 'reg.exe')] : [])];
  let text: string | null = null;
  for (const program of programs) {
    try {
      text = probe.runProgram(program, ['query', LXSS_KEY, '/s'], REGISTRY_TIMEOUT_MS);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { unread: 'reg.exe failed or took too long' };
    }
  }
  if (text === null) return { unread: 'reg.exe is not on the PATH' };
  const found = parseLxss(text).find((d) => d.name.toLowerCase() === distro.toLowerCase());
  if (!found) return { unread: 'the registry does not list this distro' };
  const letter = found.basePath.replace(/^\\\\\?\\/, '').match(/^([A-Za-z]):/)?.[1];
  if (!letter) return { unread: 'its disk file is not on a drive letter' };
  const mount = findDriveMount(letter, mounts);
  if (!mount) return { unread: `drive ${letter.toUpperCase()}: is not mounted in Linux` };
  try {
    return { space: probe.readDiskSpace(mount), distro: found.name, version: found.version };
  } catch {
    return { unread: `can't read drive ${letter.toUpperCase()}:` };
  }
}

/** The last reading, or null when there is none or the file is broken. */
export function readHostCache(env: Env, probe: MachineProbe): HostDiskCache | null {
  try {
    return hostDiskCache(readMachineState(machineStateFile(env), probe).hostDisk);
  } catch {
    return null;
  }
}

/** The last reading when it is from the last 7 days, or null. */
export function readFreshHostCache(env: Env, probe: MachineProbe): HostDiskCache | null {
  const cache = readHostCache(env, probe);
  return cache && isFreshReading(cache, probe.now()) ? cache : null;
}

/** Keep the last reading. A file that can't be written is left: a session then says nothing about the host. */
export function saveHostCache(env: Env, probe: MachineProbe, cache: HostDiskCache): void {
  try {
    saveMachineState(machineStateFile(env), probe, 'hostDisk', cache);
  } catch {
    // no home, or a read-only one: the next full doctor reads the host again
  }
}

const SPACE_FIX = 'free some space: delete caches and build outputs you do not need, or move data to another disk';

/** The note for a disk low on space, or null when it has room. */
export function diskSpaceNote(where: string, space: DiskSpace, env: Env, fix: string = SPACE_FIX): Finding | null {
  return isLowOnSpace(space, env) ? finding('disk-space', `${where} has ${formatSpace(space)}`, fix) : null;
}



/**
 * The disk notes: the disk that holds the repo, and in WSL the Windows drive under it.
 * Full doctor reads the Windows drive with reg.exe and keeps the reading. A session only
 * repeats the kept reading, and only when it was low.
 */
export function diskSpaceChecks(root: string, env: Env, probe: MachineProbe, session: boolean): Practice[] {
  const checks: Practice[] = [];
  const note = (name: string, found: Finding): Practice => ({ name, ok: false, finding: found });
  const fine = (name: string, detail: string): Practice => ({ name, ok: true, finding: finding('disk-space', '', ''), detail });
  try {
    const space = probe.readDiskSpace(root);
    const low = diskSpaceNote('the disk that holds this repo', space, env);
    checks.push(low ? note('disk-space', low) : fine('disk-space', formatSpace(space)));
  } catch {
    checks.push(note('disk-space', finding('disk-space', "can't read the free space of the disk that holds this repo", 'check it with `df -h .`, or in your file manager')));
  }
  // Without WSL_DISTRO_NAME (under sudo, or from systemd) there is no way to find the
  // drive, and a note every run would only nag: say nothing about it.
  if (!isWsl(env, probe) || !env.WSL_DISTRO_NAME) return checks;
  if (session) {
    const cache = readFreshHostCache(env, probe);
    const when = cache ? new Date(cache.readAt).toISOString().slice(0, 16).replace('T', ' ') : '';
    const low = cache && cache.version !== 1 && diskSpaceNote(`${HOST_DRIVE} (read ${when} UTC)`, cache, env, `${HOST_DISK_FIX}. Then run \`yokoten doctor\` to read the drive again`);
    if (low) checks.push(note('host-disk', low));
    return checks;
  }
  const host = readHostDisk(env, probe);
  // WSL 1 has no disk file: the repo's disk is that drive, and its note is above.
  if ('space' in host && host.version === 1) return checks;
  if ('unread' in host) {
    checks.push(note('host-disk', finding('disk-space', `can't read ${HOST_DRIVE}: ${host.unread}`, 'check its free space in Windows; when it fills, every session here stops')));
    return checks;
  }
  saveHostCache(env, probe, { free: host.space.free, size: host.space.size, readAt: probe.now().toISOString(), distro: host.distro, version: host.version });
  const low = diskSpaceNote(HOST_DRIVE, host.space, env, HOST_DISK_FIX);
  checks.push(low ? note('host-disk', low) : fine('host-disk', `${formatSpace(host.space)} on ${HOST_DRIVE}`));
  return checks;
}

/**
 * The note when another user owns Claude Code's temp folder, often root after a restart.
 * Claude Code then refuses to start, so the user runs full doctor in a terminal. The fix
 * needs sudo, so doctor prints it and never runs it. Null when there is no uid (Windows)
 * or no folder; ok when the folder is the user's.
 */
export function agentTempDirCheck(env: Env, probe: MachineProbe): Practice | null {
  if (probe.uid === null) return null;
  const dir = claudeTempDir(env, probe.uid);
  const owner = probe.readOwner(dir);
  if (owner === null) return null;
  if (owner === probe.uid) return { name: 'agent-temp-dir', ok: true, finding: finding('agent-temp-dir', '', '') };
  // A control character or a newline can't be pasted safely: name the folder, print no command.
  const isPastable = !/[\u0000-\u001f\u007f]/.test(dir);
  const shown = isPastable ? dir : JSON.stringify(dir);
  const fix = isPastable ? `run \`sudo rm -rf ${quoteForShell(dir)}\` yourself` : `remove the folder ${shown} yourself, with sudo`;
  return { name: 'agent-temp-dir', ok: false, finding: finding('agent-temp-dir', `${shown} belongs to uid ${owner}, not to you (uid ${probe.uid}), so Claude Code won't start`, `${fix}; Claude Code makes a new one when it starts`) };
}

/**
 * The first release of each supported Node line with the security fixes of 2026-10-21
 * (#572). Among them are TLS hostname checks, which yokoten's HTTPS calls to GitHub rely on:
 * https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
 * package.json "engines" and the docs name the same versions. A line not in this table and
 * older than the newest line in it (an odd line, or one past its end of life) gets no fixes.
 */
export const NODE_ADVISORY = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';
export const NODE_FIXED: Readonly<Record<number, string>> = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };

/**
 * The note when the running Node lacks the security fixes of October 2026 (#572): a
 * release older than its line's fix, or a line that gets no fixes at all. A Node line
 * newer than the table is fine: it came out after the fixes.
 */
export function nodeSecurityCheck(probe: Pick<MachineProbe, 'nodeVersion'>): Practice {
  const version = probe.nodeVersion.replace(/^v/, '');
  const line = Number.parseInt(version, 10);
  const fixed = NODE_FIXED[line];
  const lines = Object.keys(NODE_FIXED).map(Number);
  const newestLine = Math.max(...lines);
  const advisoryLink = `the advisory: ${NODE_ADVISORY}`;
  if (fixed && (compareVersions(version, fixed) ?? -1) < 0) {
    return { name: 'node-security', ok: false, finding: finding('node-security', `Node ${version} has known security holes that Node fixed in October 2026`, `upgrade Node to ${fixed} or later; ${advisoryLink}`) };
  }
  if (!fixed && line < newestLine) {
    const others = lines.filter((other) => other !== newestLine).map((other) => NODE_FIXED[other]).join(' or ');
    return { name: 'node-security', ok: false, finding: finding('node-security', `Node ${version} is not supported, because Node ${line} gets no more security fixes`, `install Node ${NODE_FIXED[newestLine]} or later (or ${others}); ${advisoryLink}`) };
  }
  return { name: 'node-security', ok: true, finding: finding('node-security', '', ''), detail: `Node ${version}` };
}

/** A leftover folder is one older than this: a test run that is still going is newer. */
const LEFTOVER_AGE_MS = 24 * 60 * 60 * 1000;

/** One `yokoten-*` folder in a temp folder, and when it last changed. */
export interface TempFolderEntry {
  name: string;
  mtimeMs: number;
}

/**
 * The `yokoten-*` folders in one temp folder: one read of the folder and one lstat per
 * match. Throws when the folder can't be read.
 */
export function readYokotenFolders(dir: string): TempFolderEntry[] {
  const entries: TempFolderEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.startsWith('yokoten-') || !entry.isDirectory()) continue;
    try {
      entries.push({ name: entry.name, mtimeMs: lstatSync(join(dir, entry.name)).mtimeMs });
    } catch {
      // removed while we read: it no longer counts
    }
  }
  return entries;
}

/**
 * The `yokoten-*` folders older than a day in the temp folders (#400): test runs left
 * them, and thousands of them fill a disk. Full doctor only. A count, no size: adding up
 * the size of thousands of folders takes a minute. Doctor prints the command, never runs it.
 * Null when there are none, or nothing can be read. `read` is a parameter so the self-test
 * can hand in folders that are not on the disk.
 */
export function leftoverTempCheck(env: Env, probe: MachineProbe, read: typeof readYokotenFolders = readYokotenFolders): Practice | null {
  const oldest = probe.now().getTime() - LEFTOVER_AGE_MS;
  let count = 0;
  const dirs: string[] = [];
  for (const dir of findTempDirs(env)) {
    try {
      const old = read(dir).filter((entry) => entry.mtimeMs < oldest).length;
      if (old) dirs.push(dir);
      count += old;
    } catch {
      // a temp folder that can't be read has nothing to say
    }
  }
  if (!count) return null;
  // A control character or a newline can't be pasted safely: name the folders, print no command.
  const isPastable = dirs.every((dir) => !/[\u0000-\u001f\u007f]/.test(dir));
  const where = dirs.map((dir) => (isPastable ? dir : JSON.stringify(dir))).join(' and ');
  const fix = isPastable
    ? `run \`find ${dirs.map(quoteForShell).join(' ')} -maxdepth 1 -name 'yokoten-*' -mmin +1440 -exec rm -rf {} +\` yourself; it removes only the ones older than a day`
    : 'remove the `yokoten-*` folders older than a day from those folders yourself';
  const folders = count === 1 ? '1 yokoten-* folder' : `${count} yokoten-* folders`;
  return { name: 'leftover-temp-folders', ok: false, finding: finding('leftover-temp-folders', `${folders} older than a day in ${where}`, fix) };
}

/**
 * A temp folder, in memory, with one `yokoten-*` folder two days old and one new: the
 * leftover check must count the old one only. No disk, so the session self-test stays fast.
 * `check` is a parameter so a test can hand in a broken one.
 */
export function leftoverControl(check: typeof leftoverTempCheck = leftoverTempCheck): string[] {
  const now = new Date(0);
  const probe: MachineProbe = { ...REAL_MACHINE, now: () => now };
  const read = () => [{ name: 'yokoten-old', mtimeMs: -2 * LEFTOVER_AGE_MS }, { name: 'yokoten-new', mtimeMs: 0 }];
  const note = check({ YOKOTEN_TEMP_DIRS: '/control' }, probe, read);
  return note?.ok === false && note.finding.what.startsWith('1 yokoten-* folder older') ? [] : ['leftover temp folder check'];
}

/** A word for a POSIX shell: in single quotes, each single quote inside closed, escaped and reopened. */
export const quoteForShell = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * A fake machine with no free space and a temp folder that root owns: both machine checks
 * must catch it, and in a fake WSL, the full Windows drive under it. The checks are
 * parameters so a test can hand in broken ones.
 */
export function machineControl(diskCheck: typeof diskSpaceChecks = diskSpaceChecks, tempCheck: typeof agentTempDirCheck = agentTempDirCheck, nodeCheck: typeof nodeSecurityCheck = nodeSecurityCheck): string[] {
  const fake: MachineProbe = {
    readDiskSpace: () => ({ free: 0, size: 250 * GB }),
    readOwner: () => 0,
    runProgram: () => {
      throw new Error('no programs in the control');
    },
    readText: () => null,
    writeText: () => {},
    uid: 1000,
    now: () => new Date(0),
    nodeVersion: '22.23.3',
  };
  const failed: string[] = [];
  if (diskCheck('/', {}, fake, true).every((c) => c.ok)) failed.push('disk space check');
  // The Windows drive is full while the Linux disk has room, as in the incident of record 0012.
  const registry = `${LXSS_KEY}\\{0}\r\n    DistributionName    REG_SZ    control\r\n    Version    REG_DWORD    0x2\r\n    BasePath    REG_SZ    \\\\?\\D:\\WSL\\control\r\n`;
  const wsl: MachineProbe = {
    ...fake,
    readDiskSpace: (path) => ({ free: path === '/mnt/d' ? 0 : 200 * GB, size: 250 * GB }),
    runProgram: () => registry,
    readText: (path) => (path === '/proc/mounts' ? 'none / ext4 rw 0 0\nD:\\134 /mnt/d 9p rw 0 0\n' : null),
  };
  const host = diskCheck('/', { WSL_DISTRO_NAME: 'control', HOME: '/nonexistent' }, wsl, false).find((c) => c.name === 'host-disk');
  if (host?.ok !== false || !host.finding.what.startsWith(`${HOST_DRIVE} has`)) failed.push('host drive check');
  if (tempCheck({}, fake)?.ok !== false) failed.push('agent temp dir check');
  if (nodeCheck(fake).ok || !nodeCheck({ nodeVersion: '24.22.1' }).ok) failed.push('node security check');
  return failed;
}
