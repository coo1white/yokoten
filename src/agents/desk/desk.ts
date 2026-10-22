// One desk for every worker, whatever the vendor (#637). A desk is a folder (the worker's
// own clone) and a fence around the agent that works in it. The fence is one contract,
// the same for Claude Code, Codex (and DeepSeek through it), Grok and Muse:
//
// 1. The desk folder, `.git` included, and the agent's own state folder are writable.
// 2. Everything else the agent can see is read-only.
// 3. The owner's other projects and home are not visible: only what the agent needs to
//    run (Node, its own program, yokoten's runtime) is shown again, read-only.
// 4. Child processes work, with pipes (tests start programs).
// 5. Commands have no network. The agent reaches only its model's API hosts, through
//    the proxy in proxy.ts, which runs outside.
// 6. YOKOTEN_ROLE=worker and TZ=UTC are set, and no token or key is passed in (agent-env.ts).
//
// This file turns a request into a `DeskPlan`: plain lists of paths, hosts and names. A
// backend per system turns the plan into a command: bwrap.ts on Linux and WSL2,
// seatbelt.ts on macOS. Native Windows has no backend; WSL2 is the way there (#669).

import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../../rules/config.ts';
import { homeIn } from '../../rules/privacy.ts';
import { DESK as CLAUDE_CODE } from '../runtimes/claude-code.ts';
import { DESK as CODEX } from '../runtimes/codex.ts';
import { DESK as GROK } from '../runtimes/grok.ts';
import { DESK as MUSE } from '../runtimes/muse.ts';
import { buildAgentEnv } from './agent-env.ts';

/** What a runtime's own file tells the desk: where it keeps its state, and which hosts its API is on. */
export interface RuntimeDesk {
  /** The agent's own state folders and files, writable in the desk. A file is used only when it is there. */
  state: (env: Env) => { path: string; isFile?: boolean }[];
  /** The API hosts the agent program may reach, on port 443. */
  hosts: readonly string[];
}

/** The runtimes a desk can start, by the name `--agent` takes elsewhere. DeepSeek runs through Codex. */
export const DESK_RUNTIMES: Readonly<Record<string, RuntimeDesk>> = {
  'claude-code': CLAUDE_CODE,
  codex: CODEX,
  grok: GROK,
  muse: MUSE,
};

/** The contract for one desk, as plain data. Every path is absolute. */
export interface DeskPlan {
  /** The desk folder: the worker's own clone. Writable. */
  desk: string;
  /** The agent's state folders and files. Writable. */
  state: string[];
  /** Folders and files shown again, read-only, inside the hidden ones. */
  readable: string[];
  /** Folders that are not visible at all: home folders, other drives, the desk's parent folder. */
  hidden: string[];
  /** Files inside a writable folder that stay read-only, such as the worker mark. */
  locked: string[];
  /** The hosts the proxy lets the agent reach. */
  hosts: string[];
  /** The agent's environment. The backend adds the proxy names. */
  env: Record<string, string>;
  /** The agent command and its words. */
  command: string[];
}

/** What a desk request gives: the folder, the agent, its command, and the lead's few choices. */
export interface DeskRequest {
  runtime: string;
  desk: string;
  command: string[];
  env: Env;
  /** Extra paths to show read-only (`--read`). */
  extraReadable?: string[];
  /** Extra API hosts (`--host`), for example a DeepSeek host for Codex. */
  extraHosts?: string[];
  /** yokoten runtime folders to show read-only: this copy and the installed one. */
  runtimes?: string[];
  /** The private-marks file, shown read-only only when the lead asks (`--marks`). Off by default until #665. */
  marks?: string;
  /** The system the plan is for: its hidden folders differ. */
  platform?: NodeJS.Platform;
}

/** The parts of this yokoten that run in a desk: the guard, the commit check and the bridge. */
const OWN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const OWN_RUNTIME = ['bin', 'src', 'kit', 'dist', 'package.json'].map((part) => join(OWN_ROOT, part));

/** Whether `path` is `folder` or inside it. */
export const isInside = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** The real path, or the path itself when it is not there. */
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The file a command name runs, found on PATH like a shell would, or null. */
export function findProgram(name: string, path: string | undefined): string | null {
  if (name.includes('/')) return existsSync(name) ? resolve(name) : null;
  for (const folder of (path ?? '').split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const file = join(folder, name);
    try {
      if (statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

/**
 * The folders a program needs to run: the folder it is named from, and the package or
 * folder its real file sits in. A Node program's real file is deep in its package, so
 * the nearest folder with a package.json is taken; a binary's own folder otherwise.
 */
export function programFolders(file: string): string[] {
  const real = realOr(file);
  let folder = dirname(real);
  for (let at = folder; at !== dirname(at); at = dirname(at)) {
    if (existsSync(join(at, 'package.json'))) {
      folder = at;
      break;
    }
  }
  return [dirname(file), folder];
}

/**
 * The folders that are never shown: every home, other drives and mounts, and the desk's
 * parent folder. On Linux also /run, which holds sockets to the host: on WSL2 the one that
 * starts Windows programs outside any fence, the session bus, and Docker's.
 */
export function hiddenFolders(platform: NodeJS.Platform, home: string, desk: string): string[] {
  const roots = platform === 'darwin' ? ['/Users', '/Volumes'] : ['/home', '/root', '/mnt', '/media', '/run'];
  return [...new Set([...roots, home, dirname(desk)])].filter((folder) => existsSync(folder));
}

/**
 * Turn a request into the desk's plan. It throws, with a reason the lead can act on, when
 * the runtime is unknown, the folder is not a clone, or a path would open a hidden folder.
 */
export function planDesk(request: DeskRequest): DeskPlan {
  const runtime = Object.hasOwn(DESK_RUNTIMES, request.runtime) ? DESK_RUNTIMES[request.runtime] : undefined;
  if (!runtime) throw new Error(`a desk starts ${Object.keys(DESK_RUNTIMES).join(', ')}; not "${request.runtime}". DeepSeek runs through codex.`);
  if (!request.command.length) throw new Error('no agent command after --');
  const { env } = request;
  const home = realOr(homeIn(env));
  const desk = realOr(resolve(request.desk));
  if (!existsSync(join(desk, '.git'))) throw new Error(`${desk} is not a git clone. Make the desk with \`git clone <repo> <folder>\`.`);
  if (statSync(join(desk, '.git')).isFile()) throw new Error(`${desk} is a worktree: its git folder lives in another checkout, which the desk hides. Make the desk with \`git clone\`.`);
  const hidden = hiddenFolders(request.platform ?? process.platform, home, desk);
  // A path the agent may see must not open a whole hidden folder, or the desk itself.
  const isTooWide = (path: string) => hidden.some((folder) => isInside(folder, path)) || isInside(desk, path) || path === '/';
  const state: string[] = [];
  for (const entry of runtime.state(env)) {
    const path = realOr(entry.path);
    if (isTooWide(path)) throw new Error(`the agent's state folder ${path} would open a hidden folder`);
    if (entry.isFile) {
      if (existsSync(path)) state.push(path);
      continue;
    }
    mkdirSync(path, { recursive: true });
    state.push(path);
  }
  const program = findProgram(request.command[0], env.PATH);
  if (!program) throw new Error(`can't find ${request.command[0]} on PATH`);
  const node = dirname(dirname(realOr(process.execPath)));
  const wanted = [node, ...programFolders(program), ...OWN_RUNTIME, ...(request.runtimes ?? []), join(home, '.gitconfig'), join(home, '.config', 'git')];
  if (request.marks) wanted.push(request.marks);
  const readable: string[] = [];
  for (const path of wanted.map(realOr)) {
    if (!existsSync(path) || isTooWide(path) || readable.includes(path)) continue;
    if (state.some((folder) => isInside(path, folder))) continue;
    readable.push(path);
  }
  for (const path of request.extraReadable ?? []) {
    const real = realOr(resolve(path));
    if (!existsSync(real)) throw new Error(`--read ${path}: not there`);
    if (isTooWide(real)) throw new Error(`--read ${path} would open a hidden folder or the whole system`);
    if (!readable.includes(real)) readable.push(real);
  }
  const marks = join(desk, '.git', 'yokoten-worker');
  return {
    desk,
    state,
    readable,
    hidden,
    locked: existsSync(marks) ? [marks] : [],
    hosts: [...new Set([...runtime.hosts, ...(request.extraHosts ?? [])])],
    env: { ...buildAgentEnv(env, { runtime: request.runtime, set: { YOKOTEN_ROLE: 'worker' } }), TZ: 'UTC' },
    command: request.command,
  };
}

/** The names that point an agent at the proxy. Upper and lower case: programs read either. */
export function proxyEnv(url: string): Record<string, string> {
  const names = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'];
  // NODE_USE_ENV_PROXY: Node's own fetch reads the names above only with it (Node 22.21 and 24).
  return { ...Object.fromEntries(names.flatMap((name) => [[name, url], [name.toLowerCase(), url]])), NODE_USE_ENV_PROXY: '1', NO_PROXY: '', no_proxy: '' };
}

/** A command that starts the agent inside the fence. */
export interface FencedCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** One system's way to build the fence. */
export interface DeskBackend {
  /** The name the desk prints, such as `bwrap`. */
  name: string;
  /** Null when the backend can run here; else the reason, in one line. */
  problem: (env: Env) => string | null;
  /** Where the proxy listens outside: a socket path in `scratch`, or a port (0 for any). */
  proxyAddress: (scratch: string) => string | number;
  /** The command that starts `plan` inside the fence, with the proxy at `address` and a private scratch folder. */
  fence: (plan: DeskPlan, address: string | number, scratch: string) => FencedCommand;
}
