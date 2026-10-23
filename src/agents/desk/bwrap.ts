// The desk on Linux and WSL2 (#637): bubblewrap (`bwrap`). yokoten only runs it as a
// program; it ships none of its code. How the plan becomes bwrap's words:
//
// - The whole system is mounted read-only, with fresh /dev, /proc and an empty /tmp.
// - Each hidden folder gets an empty file system, made read-only at the end.
// - The readable paths are mounted read-only again inside them; the desk and the
//   state paths are mounted writable; locked files go read-only on top.
// - New namespaces for everything (`--unshare-all`), so the desk has its own empty
//   network. the bridge (network/bridge.ts), the desk's first program, listens on 127.0.0.1:3128 inside and
//   passes each connection to the proxy's socket, which is mounted in.
// - `--new-session` and `--die-with-parent`: no typing into the lead's terminal, and
//   nothing left running when the desk command ends.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../../rules/config.ts';
import { type DeskBackend, type DeskPlan, type FencedCommand, proxyEnv } from './desk.ts';

/** Where the proxy's socket is inside the desk. */
export const INSIDE_SOCKET = '/tmp/.yokoten-desk-proxy.sock';

/** The port the bridge listens on inside the desk. The desk has its own network, so any port is free. */
export const INSIDE_PORT = 3128;

/** yokoten's entry, which starts the bridge: bin/ here, and dist/bin/ in the built package. */
const ENTRY = fileURLToPath(new URL('../../../bin/yokoten.mjs', import.meta.url));

/** How a mount kind sorts at the same depth: a folder is hidden before things are shown in it. */
const KIND_ORDER = { hide: 0, read: 1, write: 2, lock: 3 } as const;

type MountKind = keyof typeof KIND_ORDER;

/**
 * System settings folders that a program reads from /etc. One is mounted read-only when
 * this machine has it, so a program sees what is there (#771).
 */
export const SYSTEM_SETTINGS = ['/etc/grok'];

/** The mounts of a plan, in the order bwrap must make them: outer folders first. */
export function orderMounts(plan: DeskPlan): { kind: MountKind; path: string }[] {
  const mounts: { kind: MountKind; path: string }[] = [
    ...plan.hidden.map((path) => ({ kind: 'hide' as const, path })),
    ...plan.readable.map((path) => ({ kind: 'read' as const, path })),
    ...[plan.desk, ...plan.state].map((path) => ({ kind: 'write' as const, path })),
    ...plan.locked.map((path) => ({ kind: 'lock' as const, path })),
  ];
  const depth = (path: string) => path.split('/').filter(Boolean).length;
  return mounts.sort((a, b) => depth(a.path) - depth(b.path) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** bwrap's words for a plan, up to and including the `--` before the bridge. */
export function bwrapArgs(plan: DeskPlan, socket: string, settings: readonly string[] = SYSTEM_SETTINGS): string[] {
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  for (const path of settings) if (existsSync(path)) args.push('--ro-bind', path, path);
  for (const { kind, path } of orderMounts(plan)) {
    if (kind === 'hide') args.push('--tmpfs', path);
    else if (kind === 'write') args.push('--bind', path, path);
    else args.push('--ro-bind', path, path);
  }
  // The proxy socket; connecting to a socket needs it writable.
  args.push('--bind', socket, INSIDE_SOCKET);
  // A hidden folder's empty file system is read-only too. Only /tmp, the desk's own scratch, stays writable.
  for (const path of plan.hidden) args.push('--remount-ro', path);
  args.push('--chdir', plan.desk, '--');
  return args;
}

export const BWRAP: DeskBackend = {
  name: 'bwrap',
  problem: (env: Env) => {
    const found = spawnSync('bwrap', ['--version'], { env, encoding: 'utf8' });
    if (found.error || found.status !== 0) return 'bwrap is not installed. Install bubblewrap (Debian and Ubuntu: `sudo apt install bubblewrap`), then run it again.';
    const tried = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--', 'true'], { env, encoding: 'utf8' });
    if (tried.status !== 0) return `bwrap can't make a sandbox here (${(tried.stderr || '').trim().split('\n')[0] || 'no reason given'}). Allow unprivileged user namespaces, then run it again.`;
    return null;
  },
  proxyAddress: (scratch: string) => join(scratch, 'proxy.sock'),
  fence: (plan: DeskPlan, address: string | number, _: string): FencedCommand => ({
    file: 'bwrap',
    args: [...bwrapArgs(plan, String(address)), process.execPath, ENTRY, 'desk', '--bridge', INSIDE_SOCKET, String(INSIDE_PORT), '--', ...plan.command],
    env: { ...plan.env, ...proxyEnv(`http://127.0.0.1:${INSIDE_PORT}`) },
  }),
};
