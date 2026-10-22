// The desk on macOS (#637): Seatbelt, through `sandbox-exec` with a profile yokoten
// writes for each desk. Both are built into macOS. The profile is written here from the
// plan; no code is copied from another project.
//
// macOS has no empty network or empty folder to mount, so the same contract is held by
// rules instead:
// - Reads: allowed, but not in the hidden folders; the readable paths, the desk, the
//   state paths and a private scratch folder are allowed again inside them.
// - Writes: denied, but in the desk, the state paths, the scratch folder and a few
//   devices. Locked files are denied again.
// - Network: only to the proxy's port on 127.0.0.1; the proxy runs outside.
// - Processes may fork and exec, and pipes work: they are not network.
// In SBPL the last rule that matches wins, so each allow comes after its deny.
//
// Untested on a Mac in this change: run test/agents/desk/desk.test.ts there once.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type DeskBackend, type DeskPlan, type FencedCommand, proxyEnv } from './desk.ts';

/** A path as an SBPL string: backslash and quote escaped. A path with a line break is refused. */
export function sbplString(path: string): string {
  if (/[\n\r\0]/.test(path)) throw new Error('a desk path has a line break');
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const subpaths = (paths: readonly string[]) => paths.map((path) => `(subpath ${sbplString(path)})`).join(' ');
const literals = (paths: readonly string[]) => paths.map((path) => `(literal ${sbplString(path)})`).join(' ');

/** The SBPL profile for a plan, with the proxy on `port` and a private scratch folder. */
export function seatbeltProfile(plan: DeskPlan, port: number, scratch: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`the proxy port ${port} is not a port`);
  const writable = [plan.desk, ...plan.state, scratch];
  const lines = [
    '(version 1)',
    '; A yokoten desk (#637). Written for one run; the last rule that matches wins.',
    '(allow default)',
    '; 3. The hidden folders: no reads, then what the agent needs, shown again.',
    `(deny file-read* ${subpaths(plan.hidden)})`,
    // A parent folder must be readable as a folder, or a program can't walk down to its file.
    `(allow file-read-metadata ${subpaths(plan.hidden)})`,
    `(allow file-read* ${subpaths([...plan.readable, ...writable])})`,
    '; 1 and 2. No writes but in the desk, the state and the scratch folder.',
    '(deny file-write*)',
    `(allow file-write* ${subpaths(writable)})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...(plan.locked.length ? [`(deny file-write* ${literals(plan.locked)})`] : []),
    '; 5. No network but the proxy on this machine.',
    '(deny network*)',
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    '; 4. Child processes, and the pipes between them.',
    '(allow process-fork)',
    '(allow process-exec)',
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
