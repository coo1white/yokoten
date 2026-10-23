// Machines the owner added (#682): the board reaches them over ssh or Tailscale,
// starts a worker there, and fetches its commits. Never prints an address or a user name.
//
// The first step is two machines: WSL and a MacBook. `yokoten machine add <name>`
// writes one entry under ~/.config/yokoten/machines.json, with mode 0600. The entry's
// target stays in that file and is never shown by `machine list` or the board.
//
// A machine has its own folder for temp clones, `nice`, a memory cap where the shell
// supports it, and a cap on how many agents run there at once. The board's engineer
// limit counts every started run, whichever machine it is on.
//
// A task starts in a clone of the public repo. The clone is the desk the agent works
// in, so `yokoten desk` fences it as usual. The machine commits; the lead fetches the
// commits and pushes them as the bot.
//
// Tests use a fake ssh stand-in or a second folder: `--folder` names a local stand-in,
// as the issue allows. No test starts a real agent.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeOf, NO_HOME } from '../../rules/privacy.ts';
import { readOriginUrl } from '../../setup/plan.ts';
import { type Invocation, parse, print, printJson, requireRoot, usage } from '../shared.ts';

/** How a machine is reached: an ssh target (an alias in ~/.ssh/config, or Tailscale). */
export type MachineTransport = 'ssh' | 'folder';

/** One machine the owner added. `target` never leaves this module or its file. */
export interface Machine {
  name: string;
  transport: MachineTransport;
  /** An ssh alias or the folder of a local stand-in. Private. */
  target: string;
  /** The folder that holds temp clones: absolute, or starting with `~`. */
  root: string;
  /** The `nice` value the agent runs at, from 0 to 19. */
  nice: number;
  /** The most agents the board starts on this machine at once. */
  maxAgents: number;
  /** A memory cap in MB; 0 leaves it off. Linux's `ulimit -v` applies it. */
  memoryMb: number;
}

/** The settings `machine add` takes. Missing ones get a safe default. */
export interface MachineOptions {
  folder?: string;
  ssh?: string;
  root?: string;
  nice?: number;
  maxAgents?: number;
  memoryMb?: number;
}

/** What a machine answers: its name, whether it is reachable, and its load. Never a target. */
export interface MachineStatus {
  name: string;
  isReachable: boolean;
  /** The 1, 5 and 15 minute load, as text, or ''. */
  load: string;
}

/** The result of one command sent to a machine. */
export interface MachineResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one shell script on a machine. Tests pass a fake, so they start no agent. */
export type MachineRunner = (machine: Machine, script: string) => MachineResult;

/** One start request on a machine. */
export interface MachineAsk {
  issue: string;
  vendor: string;
  model: string;
  /** The public repo to clone there. */
  repoUrl: string;
}

/** What a started machine task wrote back. It holds no target. */
export interface MachineStarted {
  name: string;
  issue: string;
  branch: string;
  pid: number | null;
}

/** The vendors the board can start: those with a headless form. */
export const AGENT_START_COMMANDS: Record<string, string[]> = {
  'claude-code': ['claude', '-p'],
  codex: ['codex', 'exec'],
  muse: ['muse', 'exec', '--trust-workspace'],
  grok: ['grok', '-p', '--trust', '--always-approve'],
  antigravity: ['agy', '-p'],
  'deepseek-harness': ['dsh', 'headless', '--patch', '.dsh/yokoten.patch.yml'],
};

/** Each vendor's model flag, as its `--help` names it. DeepSeek Harness has none on record. */
export const AGENT_MODEL_FLAGS: Record<string, string> = {
  'claude-code': '--model',
  codex: '--model',
  muse: '--model',
  grok: '--model',
  antigravity: '--model',
};

/** The vendors a desk starts. A machine runs the agent in a desk, so these only. */
export const DESK_VENDORS = ['claude-code', 'codex', 'grok', 'muse'];

/** The state folder each desk vendor needs before it can sign in on a machine. */
const SIGN_IN_FOLDERS: Record<string, string> = {
  'claude-code': '.claude',
  codex: '.codex',
  grok: '.grok',
  muse: '.config/muse',
};

/** The file the owner's machines live in, under the home folder. */
export function machinesFile(env: Env): string | null {
  const home = homeOf(env);
  return home === null ? null : join(home, '.config', 'yokoten', 'machines.json');
}

/** A name a machine may take: lowercase words, letters, digits and one dash between. */
const MACHINE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** True when `name` can be a machine's name. */
export function isMachineName(name: string): boolean {
  return MACHINE_NAME.test(name);
}

/** True when a repo URL is public enough to clone on a machine: no name or token in it. */
export function isPublicRepoUrl(url: string): boolean {
  const clean = url.trim();
  if (/^https:\/\/[^/@\s]+(?:\/[^/\s]+)+\/?$/.test(clean)) return true;
  return /^(?:ssh:\/\/)?git@[^/\s:]+[:/][^/\s]+(?:\/[^/\s]+)*\/?$/.test(clean);
}

/** One machine from a raw settings object, or null when it is not a machine. */
function readMachineValue(name: string, value: unknown): Machine | null {
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  const target = typeof fields.target === 'string' ? fields.target.trim() : '';
  if (!target) return null;
  const transport = fields.transport === 'folder' ? 'folder' : 'ssh';
  const root = typeof fields.root === 'string' && fields.root.trim() ? fields.root.trim() : transport === 'folder' ? target : '.yokoten-machines';
  const nice = typeof fields.nice === 'number' && Number.isInteger(fields.nice) && fields.nice >= 0 && fields.nice <= 19 ? fields.nice : 10;
  const maxAgents = typeof fields.maxAgents === 'number' && Number.isInteger(fields.maxAgents) && fields.maxAgents >= 1 && fields.maxAgents <= 32 ? fields.maxAgents : 1;
  const memoryMb = typeof fields.memoryMb === 'number' && Number.isInteger(fields.memoryMb) && fields.memoryMb >= 0 ? fields.memoryMb : 0;
  return { name, transport, target, root, nice, maxAgents, memoryMb };
}

/** The machines in `env`'s file, sorted by name. A missing or bad file is no machines. */
export function readMachines(env: Env): Machine[] {
  const file = machinesFile(env);
  if (file === null) return [];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null) return [];
  const entries = (raw as Record<string, unknown>).machines;
  if (typeof entries !== 'object' || entries === null) return [];
  const found: Machine[] = [];
  for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!isMachineName(name)) continue;
    const machine = readMachineValue(name, value);
    if (machine) found.push(machine);
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/** One machine by name, or the plain reason it was not added. */
export function findMachine(env: Env, name: string): Machine | string {
  const clean = name.trim();
  if (!isMachineName(clean)) return `${clean || 'that'} is not a machine name: use lowercase letters, digits and dashes`;
  const machine = readMachines(env).find((one) => one.name === clean);
  return machine ?? `no machine called ${clean} was added: run \`yokoten machine add ${clean}\` first`;
}

/** Write the machines file with mode 0600. Throws NO_HOME when there is no home. */
function writeMachines(env: Env, machines: Machine[]): void {
  const file = machinesFile(env);
  const home = homeOf(env);
  if (file === null || home === null) throw new Error(NO_HOME);
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true, mode: 0o700 });
  const entries: Record<string, unknown> = {};
  for (const machine of machines) {
    entries[machine.name] = { transport: machine.transport, target: machine.target, root: machine.root, nice: machine.nice, maxAgents: machine.maxAgents, memoryMb: machine.memoryMb };
  }
  writeFileSync(file, `${JSON.stringify({ machines: entries }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Add one machine. `--folder` names a local stand-in for a test; without it the machine
 * is reached by ssh at `--ssh`, or at its own name (an ssh alias or a Tailscale name).
 */
export function addMachine(env: Env, name: string, options: MachineOptions = {}): Machine | string {
  const clean = name.trim();
  if (!isMachineName(clean)) return `${clean || 'that'} is not a machine name: use lowercase letters, digits and dashes`;
  if (options.folder !== undefined && options.ssh !== undefined) return 'give --folder or --ssh, not both';
  const machines = readMachines(env);
  if (machines.some((one) => one.name === clean)) return `${clean} is already added: remove it first to change it`;
  const transport: MachineTransport = options.folder !== undefined ? 'folder' : 'ssh';
  const target = options.folder ?? options.ssh ?? clean;
  if (transport === 'folder' && !isAbsolute(target)) return '--folder takes an absolute folder';
  if (/\s/.test(target)) return 'the machine target cannot hold a space';
  const root = options.root ?? (transport === 'folder' ? target : '.yokoten-machines');
  if (/\s/.test(root)) return '--root cannot hold a space';
  if (root.startsWith('~')) return 'give --root as an absolute path or one from the home folder, such as .yokoten-machines';
  const nice = options.nice ?? 10;
  if (!Number.isInteger(nice) || nice < 0 || nice > 19) return '--nice goes from 0 to 19';
  const maxAgents = options.maxAgents ?? 1;
  if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 32) return '--max-agents goes from 1 to 32';
  const memoryMb = options.memoryMb ?? 0;
  if (!Number.isInteger(memoryMb) || memoryMb < 0) return '--memory-mb is a whole number, 0 for off';
  const machine: Machine = { name: clean, transport, target, root, nice, maxAgents, memoryMb };
  try {
    writeMachines(env, [...machines, machine]);
  } catch (error) {
    return (error as Error).message === NO_HOME ? NO_HOME : 'the machine could not be written: run it again';
  }
  return machine;
}

/** Remove one machine. Unknown names are refused, as every machine action is. */
export function removeMachine(env: Env, name: string): string {
  const found = findMachine(env, name);
  if (typeof found === 'string') return found;
  const rest = readMachines(env).filter((one) => one.name !== found.name);
  try {
    writeMachines(env, rest);
  } catch {
    return 'the machine could not be removed: run it again';
  }
  return `removed ${found.name}`;
}

/** The shell word for `text`: single quotes, so no value is run as code. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The folder a machine keeps one issue's clone in. `posix` keeps a remote path remote. */
export function machineCloneDir(machine: Machine, issue: string): string {
  return machine.transport === 'folder' ? join(machine.target, `issue-${issue}`) : posix.join(machine.root, `issue-${issue}`);
}

/** The branch a machine commits on. The lead fetches it and pushes as the bot. */
export function machineBranch(issue: string): string {
  return `${issue}-machine`;
}

/** The brief the machine hands the agent: the issue, its clone, and the model. */
export function machineBrief(issue: string, clone: string, model: string): string {
  return [
    `Issue: #${issue}`,
    `Worktree: ${clone}`,
    `Model: ${model}`,
    'Goal: do the issue in this worktree as a yokoten worker. Follow AGENTS.md. Commit the work. Never push.',
  ].join('\n');
}

/**
 * The vendor's headless start command with the brief and the model, or null when the
 * board cannot start it. Grok's `-p` takes the prompt as its value, so the brief follows it.
 */
export function agentStartParts(vendor: string, brief: string, model = ''): string[] | null {
  const head = AGENT_START_COMMANDS[vendor];
  if (!head) return null;
  const flag = AGENT_MODEL_FLAGS[vendor];
  const withModel = model && flag ? [flag, model] : [];
  if (vendor === 'grok') return [...head.slice(0, 2), brief, ...head.slice(2), ...withModel];
  return [...head, ...withModel, brief];
}

/** The first, 5 and 15 minute load in `uptime`'s text, or ''. */
export function readLoad(text: string): string {
  const match = /load averages?:\s*([^\n]+)/i.exec(text.replace(/\s+/g, ' '));
  if (!match) return '';
  const numbers = match[1].match(/\d+(?:[.,]\d+)?/g);
  return numbers ? numbers.slice(0, 3).join(' ') : '';
}

/** Run one script on a machine. A failure hides the target, which may hold a user name. */
export const defaultMachineRunner: MachineRunner = (machine, script) => {
  const options = { encoding: 'utf8' as const, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  try {
    const text = machine.transport === 'folder'
      ? execFileSync('/bin/sh', ['-c', script], { ...options, cwd: machine.target })
      : execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', machine.target, script], options);
    return { code: 0, stdout: String(text), stderr: '' };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string };
    return { code: failed.status ?? null, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
};

/** The reach and load of every added machine, in name order. */
export function probeMachines(env: Env, runner: MachineRunner = defaultMachineRunner): MachineStatus[] {
  return readMachines(env).map((machine) => {
    const result = runner(machine, 'uptime');
    return { name: machine.name, isReachable: result.code === 0, load: result.code === 0 ? readLoad(result.stdout) : '' };
  });
}

/** The script that starts one task: sign-in first, then clone, then the desk under `nice`. */
export function machineStartScript(machine: Machine, ask: MachineAsk, parts: string[]): string {
  const clone = machineCloneDir(machine, ask.issue);
  const branch = machineBranch(ask.issue);
  const signIn = SIGN_IN_FOLDERS[ask.vendor];
  const memory = machine.memoryMb > 0 ? `ulimit -v ${machine.memoryMb * 1024} 2>/dev/null || true\n` : '';
  const command = ['yokoten', 'desk', ask.vendor, clone, '--', ...parts].map(shellQuote).join(' ');
  return [
    'set -eu',
    // Before any folder or clone is made: a machine without the sign-in copies nothing.
    ...(signIn === undefined ? [] : [`if [ ! -e "$HOME/${signIn}" ]; then echo 'no sign-in' >&2; exit 4; fi`]),
    `root=${shellQuote(machine.root)}`,
    `clone="$root/issue-${ask.issue}"`,
    `branch=${shellQuote(branch)}`,
    'if [ ! -d "$clone/.git" ]; then',
    '  mkdir -p "$(dirname "$clone")"',
    `  git clone --depth 1 ${shellQuote(ask.repoUrl)} "$clone"`,
    'fi',
    'cd "$clone"',
    'git checkout -B "$branch"',
    memory + `nohup nice -n ${machine.nice} ${command} >"$clone.log" 2>&1 &`,
    'pid=$!',
    `echo "$pid" >"$clone.pid"`,
    'echo "started $pid"',
  ].join('\n');
}

/** The parts the machine starts for one ask, or the plain reason it cannot. */
function startParts(machine: Machine, ask: MachineAsk): string[] | string {
  if (!DESK_VENDORS.includes(ask.vendor)) {
    return `a machine starts ${DESK_VENDORS.join(', ')} in a desk: start ${ask.vendor || 'that vendor'} on this machine by hand`;
  }
  const clone = machineCloneDir(machine, ask.issue);
  const parts = agentStartParts(ask.vendor, machineBrief(ask.issue, clone, ask.model), ask.model);
  return parts ?? `the board has no start command for ${ask.vendor}`;
}

/**
 * Start one task on a machine. The check for the vendor's sign-in comes first, so a
 * machine that is not signed in gets no clone and no file. Returns the run, or the
 * plain reason it did not start. A refusal never holds the target.
 */
export function startMachineTask(machine: Machine, ask: MachineAsk, runner: MachineRunner = defaultMachineRunner): MachineStarted | string {
  if (!/^[1-9]\d*$/.test(ask.issue)) return 'give the issue by its number, such as 603';
  const parts = startParts(machine, ask);
  if (typeof parts === 'string') return parts;
  if (!isPublicRepoUrl(ask.repoUrl)) return 'a machine clones a public repo over https or ssh, with no name or token in the URL';
  const result = runner(machine, machineStartScript(machine, ask, parts));
  if (result.code === 4) return `no ${ask.vendor} sign-in on ${machine.name}: sign in there first. Nothing was copied to it`;
  if (result.code !== 0) return `could not start issue #${ask.issue} on ${machine.name}: check that the machine is reachable and yokoten is installed there`;
  const pid = Number(/started\s+(\d+)/.exec(result.stdout)?.[1] ?? '');
  return { name: machine.name, issue: ask.issue, branch: machineBranch(ask.issue), pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

/** Stop a task the board started on a machine. Its clone and commits stay. */
export function stopMachineTask(machine: Machine, issue: string, runner: MachineRunner = defaultMachineRunner): string {
  const clone = machineCloneDir(machine, issue);
  const script = `if [ -f ${shellQuote(`${clone}.pid`)} ]; then kill "$(cat ${shellQuote(`${clone}.pid`)})" 2>/dev/null || true; rm -f ${shellQuote(`${clone}.pid`)}; echo stopped; else echo 'no task'; fi`;
  const result = runner(machine, script);
  if (result.code !== 0) return `could not stop issue #${issue} on ${machine.name}: check that it is reachable`;
  return result.stdout.includes('stopped') ? `stopped issue #${issue} on ${machine.name}` : `no task for issue #${issue} on ${machine.name}`;
}

/**
 * Fetch one issue's commits from a machine into the local repo, as a remote-tracking
 * ref. The lead reviews and pushes them as the bot. The target is never printed.
 */
export function fetchMachineCommits(root: string, machine: Machine, issue: string, env: Env): string {
  if (!/^[1-9]\d*$/.test(issue)) return 'give the issue by its number, such as 603';
  const branch = machineBranch(issue);
  const clone = machineCloneDir(machine, issue);
  const source = machine.transport === 'folder' ? clone : `${machine.target}:${clone}`;
  const ref = `refs/remotes/machine/${machine.name}/${branch}`;
  try {
    execFileSync('git', ['fetch', '--no-tags', source, `${branch}:${ref}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch {
    return `could not fetch issue #${issue} from ${machine.name}: check that the machine is reachable and the task committed`;
  }
  return `fetched ${branch} from ${machine.name} into ${ref}`;
}

/** `2 machines added:`. */
function machineCount(count: number): string {
  return `${count} machine${count === 1 ? '' : 's'} added.`;
}

/** One machine as plain words: never its target, which may hold an address or a user name. */
function formatMachine(status: MachineStatus): string {
  return `${status.name}: ${status.isReachable ? `reachable${status.load ? `, load ${status.load}` : ''}` : 'not reachable'}`;
}

/** Add, list, remove, start, and fetch: the `machine` command. */
export function runMachine(invocation: Invocation): number {
  const options = parse('machine', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [action, name = '', issue = ''] = options.positional;
  const wantsJson = options.flags.has('--json');
  if (action === 'add') {
    if (!name) return usage(invocation, 'name the machine: yokoten machine add <name>');
    const niceText = options.values['--nice'];
    const maxText = options.values['--max-agents'];
    const memoryText = options.values['--memory-mb'];
    const nice = niceText === undefined ? undefined : Number(niceText);
    const maxAgents = maxText === undefined ? undefined : Number(maxText);
    const memoryMb = memoryText === undefined ? undefined : Number(memoryText);
    if (niceText !== undefined && (!/^\d+$/.test(niceText) || nice === undefined)) return usage(invocation, '--nice goes from 0 to 19');
    if (maxText !== undefined && (!/^\d+$/.test(maxText) || maxAgents === undefined)) return usage(invocation, '--max-agents goes from 1 to 32');
    if (memoryText !== undefined && (!/^\d+$/.test(memoryText) || memoryMb === undefined)) return usage(invocation, '--memory-mb is a whole number, 0 for off');
    const added = addMachine(invocation.env, name, { folder: options.values['--folder'], ssh: options.values['--ssh'], root: options.values['--root'], nice, maxAgents, memoryMb });
    if (typeof added === 'string') return usage(invocation, added);
    print(invocation, wantsJson ? [] : [`added ${added.name}. The board shows whether it is reachable; no address is shown.`]);
    if (wantsJson) printJson(invocation, { machine: added.name, transport: added.transport, nice: added.nice, maxAgents: added.maxAgents, memoryMb: added.memoryMb });
    return 0;
  }
  if (action === 'list') {
    const machines = readMachines(invocation.env);
    const statuses = probeMachines(invocation.env);
    if (wantsJson) {
      printJson(invocation, { machines: statuses });
      return 0;
    }
    print(invocation, [machineCount(machines.length), ...(statuses.length ? statuses.map((status) => `- ${formatMachine(status)}`) : ['- none. Run `yokoten machine add <name>`.'])]);
    return 0;
  }
  if (action === 'remove') {
    if (!name) return usage(invocation, 'name the machine: yokoten machine remove <name>');
    const removed = removeMachine(invocation.env, name);
    if (removed.startsWith('removed ')) {
      print(invocation, wantsJson ? [] : [removed]);
      if (wantsJson) printJson(invocation, { removed: name });
      return 0;
    }
    return usage(invocation, removed);
  }
  if (action === 'start') {
    if (!name || !issue) return usage(invocation, 'name the machine and the issue: yokoten machine start <name> <issue> --vendor <name> --model <name>');
    const root = requireRoot(invocation, invocation.cwd);
    if (!root) return 1;
    const vendor = (options.values['--vendor'] ?? '').trim();
    if (!Object.hasOwn(AGENT_START_COMMANDS, vendor)) return usage(invocation, `name the vendor with --vendor: ${Object.keys(AGENT_START_COMMANDS).join(', ')}`);
    const model = (options.values['--model'] ?? '').trim();
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(model)) return usage(invocation, 'name the model in letters, numbers, dots and dashes');
    const machine = findMachine(invocation.env, name);
    if (typeof machine === 'string') return usage(invocation, machine);
    const started = startMachineTask(machine, { issue, vendor, model, repoUrl: readOriginUrl(root, invocation.env) });
    if (typeof started === 'string') return usage(invocation, started);
    print(invocation, wantsJson ? [] : [`started issue #${started.issue} on ${started.name}: branch ${started.branch}${started.pid ? `, pid ${started.pid}` : ''}. It commits; the lead fetches and pushes as the bot.`]);
    if (wantsJson) printJson(invocation, started);
    return 0;
  }
  if (action === 'fetch') {
    if (!name || !issue) return usage(invocation, 'name the machine and the issue: yokoten machine fetch <name> <issue>');
    const root = requireRoot(invocation, invocation.cwd);
    if (!root) return 1;
    const machine = findMachine(invocation.env, name);
    if (typeof machine === 'string') return usage(invocation, machine);
    const fetched = fetchMachineCommits(root, machine, issue, invocation.env);
    if (!fetched.startsWith('fetched ')) return usage(invocation, fetched);
    print(invocation, wantsJson ? [] : [fetched]);
    if (wantsJson) printJson(invocation, { fetched: true, machine: machine.name, issue, ref: `refs/remotes/machine/${machine.name}/${machineBranch(issue)}` });
    return 0;
  }
  return usage(invocation, 'name an action: add, list, remove, start, or fetch');
}
