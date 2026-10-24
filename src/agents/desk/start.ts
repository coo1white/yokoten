// Start a desk (#637): pick the backend for this system, start the proxy outside, start
// the agent inside the fence, and clean up when it ends. The plan comes from desk.ts.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { BWRAP } from './bwrap.ts';
import type { DeskBackend, DeskPlan } from './desk.ts';
import { type ProxyEvent, startProxy } from './network/proxy.ts';
import { SEATBELT } from './seatbelt.ts';

/** The backend for a system, or the plain reason there is none. */
export function chooseBackend(platform: NodeJS.Platform, env: Env): DeskBackend | string {
  if (platform === 'win32') return 'a desk on native Windows is experimental and not ready yet (#669): it needs a restricted-token helper, ACLs and a firewall rule that pass the #637 contract test on real Windows. Until then run yokoten in WSL2, where the Linux desk works. On native Windows, the guard alone holds the rules.';
  const backend = platform === 'linux' ? BWRAP : platform === 'darwin' ? SEATBELT : null;
  if (!backend) return `a desk runs on Linux, WSL2 and macOS; not on ${platform} yet.`;
  return backend.problem(env) ?? backend;
}

/**
 * The plain reason a plan cannot start on `backend`, or null when it can. A fence that
 * shares this machine's network (Seatbelt) cannot open one loopback port for an agent whose
 * private server picks its own: it would open every loopback port. Nothing is started until
 * the lead accepts that with `--allow-loopback`. A fence with its own network (bwrap) has
 * nothing to ask: its loopback reaches only the desk.
 */
export function deskProblem(plan: DeskPlan, backend: DeskBackend): string | null {
  if (!plan.loopback || plan.allowLoopback || backend.ownNetwork) return null;
  return `${backend.name} cannot fence one loopback port, and this agent's private server picks the port itself, so the desk would open every loopback port: the agent could reach a local service, and a local process could reach a port it binds. Nothing was started. Add --allow-loopback if you accept that, or run the desk on Linux or WSL2, where its network is its own.`;
}

/**
 * The exit code and the lines for a fenced program that a signal ended: 128 plus the
 * signal's number, as a shell gives. When the program may have said nothing on stderr (`quiet`),
 * the system sandbox may have stopped it, and on macOS its log says why.
 */
export function signalEnd(signal: NodeJS.Signals, platform: NodeJS.Platform, quiet: boolean): { code: number; lines: string[] } {
  const code = 128 + (constants.signals[signal] ?? 15);
  const lines = [`yokoten desk: the agent was ended by ${signal} (exit ${code}).`];
  if (quiet) lines.push('yokoten desk: if it printed no error, the system sandbox may have stopped it.');
  if (quiet && platform === 'darwin') lines.push(`yokoten desk: to see why, run: log show --last 1m --predicate 'eventMessage CONTAINS "deny"'`);
  return { code, lines };
}

/** How the agent's own streams are wired: the lead's terminal, or pipes a test reads. */
export interface DeskStreams {
  stdio: 'inherit' | 'pipe';
  /** Each proxy request, for the desk's log line. */
  onEvent?: (event: ProxyEvent) => void;
  /** The system, for the hint when a signal ends the agent. */
  platform?: NodeJS.Platform;
}

/** What a finished desk run gives back. With pipes, the agent's output too. */
export interface DeskResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the plan with `backend`: the proxy outside, the agent inside, both gone at the end.
 * A signal that ends the desk command is passed on to the agent first.
 */
export async function startDesk(plan: DeskPlan, backend: DeskBackend, { stdio, onEvent, platform = process.platform }: DeskStreams): Promise<DeskResult> {
  const problem = deskProblem(plan, backend);
  if (problem) throw new Error(problem);
  // The real path: on macOS the temp folder is a link, and Seatbelt matches real paths.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'yokoten-desk-')));
  mkdirSync(join(scratch, 'tmp'));
  const proxy = await startProxy(backend.proxyAddress(scratch), plan.hosts, onEvent);
  try {
    const address = proxy.server.address();
    const listened = typeof address === 'string' ? address : (address?.port ?? 0);
    const fenced = backend.fence(plan, listened, scratch);
    const child = spawn(fenced.file, fenced.args, { cwd: plan.desk, env: fenced.env, stdio: ['inherit', stdio, stdio] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => [signal, forward(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const code = await new Promise<number>((resolve) => {
      child.on('error', (error: NodeJS.ErrnoException) => {
        err.push(Buffer.from(`yokoten desk: can't start ${fenced.file}: ${error.code ?? error.message}\n`));
        resolve(127);
      });
      child.on('close', (status, signal) => {
        if (status !== null || !signal) return resolve(status ?? 1);
        // With the lead's terminal, the agent's stderr is not seen here, so the hint is shown.
        const ended = signalEnd(signal, platform, stdio === 'inherit' || err.length === 0);
        err.push(Buffer.from(`${ended.lines.join('\n')}\n`));
        resolve(ended.code);
      });
    });
    for (const [signal, handler] of handlers) process.off(signal, handler);
    return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  } finally {
    await proxy.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
