// The desk on macOS (#637): Seatbelt, through `sandbox-exec` with a profile yokoten
// writes for each desk. Both are built into macOS. The profile is written here from the
// plan; no code is copied from another project.
//
// The profile starts from `(deny default)`: nothing is allowed that is not named here.
// - Reads: the system's own folders, the readable paths, the desk, its state folder and a
//   private scratch folder. The parent folders of those get their own metadata only, so a
//   program can walk down to them but can't list them. /private/tmp, /private/var/folders
//   and every home stay closed, but for the scratch folder.
// - Writes: only the desk, its state folder, the scratch folder and a few devices. The
//   locked paths (`.git/config`, `.git/hooks`, the worker mark) are denied again.
// - Network: only to the proxy's port on 127.0.0.1; the proxy runs outside.
// - Processes may fork and exec, but never `open` or `osascript`, and nothing may ask
//   Launch Services or send Apple events: those start programs outside the fence.
// - Mach services: a short list that programs need to look up users, log, check TLS
//   certificates and read preferences.
// In SBPL a later rule wins over an earlier one, so each deny for a lock comes last.
//
// Untested on a Mac in this change: run test/agents/desk/start.test.ts there once.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type DeskBackend, type DeskPlan, type FencedCommand, proxyEnv } from './desk.ts';

/** The system folders every program reads: its libraries, tools, settings and time zones. */
const SYSTEM_READS = ['/usr', '/bin', '/sbin', '/System', '/Library', '/opt', '/private/etc', '/private/var/db/timezone', '/private/var/select', '/dev'];

/** The Mach services a command-line program needs. Launch Services and Apple events are not here. */
const MACH_SERVICES = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.trustd',
  'com.apple.trustd.agent',
  'com.apple.SecurityServer',
  'com.apple.ocspd',
  'com.apple.cfprefsd.daemon',
  'com.apple.cfprefsd.agent',
  'com.apple.diagnosticd',
];

/** Programs that start other programs outside the fence. */
const BLOCKED_PROGRAMS = ['/usr/bin/open', '/usr/bin/osascript'];

/** A path as an SBPL string: backslash and quote escaped. A path with a line break is refused. */
export function sbplString(path: string): string {
  if (/[\n\r\0]/.test(path)) throw new Error('a desk path has a line break');
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const subpaths = (paths: readonly string[]) => paths.map((path) => `(subpath ${sbplString(path)})`).join(' ');
const literals = (paths: readonly string[]) => paths.map((path) => `(literal ${sbplString(path)})`).join(' ');

/** Every parent folder of the paths, `/` included, once. */
export function parentFolders(paths: readonly string[]): string[] {
  const parents = new Set<string>();
  for (const path of paths) for (let at = dirname(path); ; at = dirname(at)) {
    parents.add(at);
    if (at === dirname(at)) break;
  }
  return [...parents].sort();
}

/** The SBPL profile for a plan, with the proxy on `port` and a private scratch folder. */
export function seatbeltProfile(plan: DeskPlan, port: number, scratch: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`the proxy port ${port} is not a port`);
  const writable = [plan.desk, ...plan.state, scratch];
  const readable = [...SYSTEM_READS, ...plan.readable, ...writable];
  const lines = [
    '(version 1)',
    '; A yokoten desk (#637). Written for one run. Nothing is allowed that is not named here.',
    '(deny default)',
    '; 4. Child processes, and the pipes between them; never a program that opens others outside.',
    '(allow process-fork)',
    '(allow process-exec)',
    `(deny process-exec ${literals(BLOCKED_PROGRAMS)})`,
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${sbplString(name)})`).join(' ')})`,
    '(deny lsopen)',
    '(deny appleevent-send)',
    '; 2 and 3. Reads: the system, what the agent needs, and the parent folders by their own metadata only.',
    `(allow file-read* ${subpaths(readable)})`,
    `(allow file-read-metadata ${literals(parentFolders(readable))})`,
    '; dyld lists the root folder when a program starts; without it every program aborts.',
    '; That shows only the top-level names, like /Users; nothing inside a hidden folder.',
    '(allow file-read-data (literal "/"))',
    '; 1. Writes: the desk, its state folder, the scratch folder and a few devices.',
    `(allow file-write* ${subpaths(writable)})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    '; dyld also talks to /dev/dtracehelper at start.',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))',
    ...(plan.locked.length ? [`(deny file-write* ${subpaths(plan.locked)})`] : []),
    '; 5. No network but the proxy on this machine.',
    `(allow network-outbound (remote ip "localhost:${port}"))`,
  ];
  return `${lines.join('\n')}\n`;
}

export const SEATBELT: DeskBackend = {
  name: 'sandbox-exec',
  problem: (env: Env) => {
    const tried = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { env, encoding: 'utf8' });
    return tried.status === 0 ? null : "sandbox-exec can't run here. It ships with macOS; check that /usr/bin/sandbox-exec is there.";
  },
  // Seatbelt can't show a socket under a different name, so the proxy takes any free port.
  proxyAddress: () => 0,
  fence: (plan: DeskPlan, address: string | number, scratch: string): FencedCommand => {
    const port = Number(address);
    const profile = join(scratch, 'desk.sb');
    const work = join(scratch, 'tmp');
    writeFileSync(profile, seatbeltProfile(plan, port, scratch));
    return {
      file: '/usr/bin/sandbox-exec',
      args: ['-f', profile, ...plan.command],
      env: { ...plan.env, ...proxyEnv(`http://127.0.0.1:${port}`), TMPDIR: work },
    };
  },
};
