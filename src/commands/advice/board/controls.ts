// The board's agent controls (#603): starting and stopping agents from the page.
//
// From the page the owner starts an agent on an open issue and stops it again. The
// board makes the worktree at `.worktrees/<issue>` and starts the vendor's own
// headless command with `YOKOTEN_ROLE=worker`, like the dispatch skill. The guard then
// checks the agent as a worker, and pushes and merges still go only through the bot.
// Each agent's latest output shows on the page. Stopping keeps the worktree and its
// commits.
//
// `yokoten board --text` and /data still list what needs the owner: tier A pull
// requests with green checks and no Approve on the head commit, guard stops, and
// agent questions. The page lists Needs you under the header bell (#737). The list is read
// only: no request an agent can make clears an item. There are no Approve or Merge
// buttons anywhere; those stay on the host, with the owner. Safety: 127.0.0.1 only.
// The page is at <repo>.localhost on a stable port. The first visit sets an HttpOnly
// cookie and leaves the token out of the address. A change needs the page's Origin.
// Stop only for processes this board started, and every start and stop in a log file.

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as codex from '../../../agents/runtimes/codex.ts';
import * as deepseekHarness from '../../../agents/runtimes/small/deepseek-harness.ts';
import * as grok from '../../../agents/runtimes/grok.ts';
import * as muse from '../../../agents/runtimes/muse.ts';
import { type Env } from '../../../rules/config.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { hookCliPath } from '../../../setup/init.ts';
import { markWorktree } from '../../guard/hook.ts';
import { BOARD_READ_TIMEOUT_MS, type BoardRole } from './agents.ts';

/**
 * How the board starts one agent of each vendor, before the brief. Each command is the
 * vendor's own headless form, as the guide names it. A vendor missing here cannot be
 * started from the page: start it by hand, and it still shows on the board.
 * Grok's `-p` takes the prompt as its value, so the brief follows it at once; the
 * other vendors take the brief last. Grok keeps the guide's `--trust --always-approve`:
 * `--sandbox yokoten` names a profile that does not exist, so grok refuses to start
 * with it. Muse's `--trust-workspace` and grok's `--trust` trust the fresh worktree at
 * the start, so their hooks run there.
 */
const BOARD_START_COMMANDS: Record<string, string[]> = {
  'claude-code': ['claude', '-p'],
  codex: ['codex', 'exec'],
  muse: ['muse', 'exec', '--trust-workspace'],
  grok: ['grok', '-p', '--trust', '--always-approve'],
  antigravity: ['agy', '-p'],
  'deepseek-harness': ['dsh', 'headless', '--patch', '.dsh/yokoten.patch.yml'],
};

/**
 * Each vendor's model flag, as its `--help` names it. DeepSeek Harness has none on
 * record (and `dsh` is not installed here to check): its model stays a label only, in
 * the brief and `YOKOTEN_MODEL`, and the guide says so.
 */
const BOARD_MODEL_FLAGS: Record<string, string> = {
  'claude-code': '--model',
  codex: '--model',
  muse: '--model',
  grok: '--model',
  antigravity: '--model',
};

/** The board's limits: how many agents run at once, and how many of one model. */
export interface BoardLimits {
  maxAgents: number;
  byModel: Record<string, number>;
}

/** The board's limits at start: three agents at once, and no per-model cap. */
export const BOARD_DEFAULT_LIMITS: BoardLimits = { maxAgents: 3, byModel: {} };

/** One agent the board started. Its output stays while it runs and after it stops. */
export interface BoardRun {
  name: string;
  issue: string;
  vendor: string;
  model: string;
  worktree: string;
  pid: number | null;
  /** Running, or stopped by the owner. A start that fails never joins the list. */
  status: 'running' | 'stopped';
  startedAt: string;
  stoppedAt: string;
  exitCode: number | null;
  /** The latest output lines, oldest first, at most BOARD_OUTPUT_LINES. */
  output: string[];
}

/** One open issue to start an agent on: its number, title, link, and what it waits for. */
export interface BoardIssue {
  number: number;
  title: string;
  url: string;
  /** When it was opened, or ''. */
  createdAt: string;
  /** When it last changed, or ''. */
  updatedAt: string;
  /** Issue numbers on a "Depends on" line. The timeline shows them on the row. */
  dependsOn: number[];
}

/** One hold-up an agent reports in its status file: a guard stop or a question. */
export interface BoardAttention {
  name: string;
  vendor: string;
  role: BoardRole;
  worktree: string;
  updated: string;
  /** A guard stop that needs a decision, or a question for the owner. */
  kind: 'guard' | 'question';
  why: string;
  /** Where the owner acts, http(s) only. */
  link: string;
}

/** One row of the waiting list: what waits, who waits, how long, why, and where to act. */
export interface BoardWaiting {
  /** An Approve on the host, a guard stop, or an agent's question. */
  kind: 'approve' | 'guard' | 'question';
  agent: string;
  role: BoardRole;
  /** How long the row has shown, counted from `latchedAt`, never from a rewrite. */
  wait: string;
  why: string;
  link: string;
  /**
   * When the row first showed, as ISO time. Kept on latched agent rows only, so the
   * wait counts from the first sight; never served over /data or shown as text.
   */
  latchedAt?: string;
}

/** How many output lines a run keeps. The page shows the last 30. */
const BOARD_OUTPUT_LINES = 100;

/** A model name: letters and numbers first, then letters, numbers, dots and dashes. */
const BOARD_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

/** What the board hears from a started agent: one output line, then its exit code. */
export interface BoardEvents {
  line: (text: string) => void;
  exit: (code: number | null) => void;
}

/** One started agent process. Kill stops it; the board only ever holds its own. */
export interface BoardChild {
  pid: number | null;
  kill: () => void;
}

/**
 * Starts one agent process. Tests pass a fake, so they never start a real agent. The
 * default starts the vendor's command with pipes, and reports each output line.
 */
export type BoardSpawner = (command: string, args: string[], options: { cwd: string; env: Env }, events: BoardEvents) => BoardChild;

/** The default spawner: the vendor's command with `YOKOTEN_ROLE=worker` in its env. */
function spawnBoardChild(command: string, args: string[], options: { cwd: string; env: Env }, events: BoardEvents): BoardChild {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let rest = '';
  const onText = (text: string) => {
    const lines = (rest + text).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) events.line(line);
  };
  child.stdout?.on('data', (chunk: Buffer) => onText(String(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => onText(String(chunk)));
  child.on('exit', (code) => {
    if (rest) events.line(rest);
    events.exit(code);
  });
  child.on('error', () => events.exit(null));
  return {
    pid: child.pid ?? null,
    kill: () => {
      try {
        child.kill();
      } catch {
        // Already gone: the exit event reports it.
      }
    },
  };
}

/** What one board server owns: its limits, its runs, its latched waiting rows, and how it starts agents. */
export interface BoardControls {
  limits: BoardLimits;
  runs: BoardRun[];
  /** The agent hold-ups the board keeps showing, keyed by agent and kind. */
  seen: BoardWaiting[];
  /** The started processes by run name. The board stops only these. */
  handles: Map<string, BoardChild>;
  logPath: string;
  spawner: BoardSpawner;
}

/** Fresh controls for a board: default limits, no runs, the log at the given path. */
export function createBoardControls(logPath: string, spawner: BoardSpawner = spawnBoardChild): BoardControls {
  return { limits: { ...BOARD_DEFAULT_LIMITS, byModel: {} }, runs: [], seen: [], handles: new Map(), logPath, spawner };
}

/** One line in the board's log: when, and what started, stopped, or changed. Never throws. */
export function appendBoardLog(controls: BoardControls, line: string): void {
  try {
    appendFileSync(controls.logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The board runs on without the log.
  }
}

/** One start request: the issue, the vendor, and the model, as plain text. */
export interface BoardStartAsk {
  issue: string;
  vendor: string;
  model: string;
}

/** The brief the board hands the agent: the issue, its worktree, and the model. */
export function boardBrief(issue: string, worktree: string, model: string): string {
  return [
    `Issue: #${issue}`,
    `Worktree: ${worktree}`,
    `Model: ${model}`,
    'Goal: do the issue in this worktree as a yokoten worker. Follow AGENTS.md. Commit the work. Never push.',
  ].join('\n');
}

/**
 * The vendor's start command with the brief and the model, or null when the board
 * cannot start it. The model goes through the vendor's own flag; a vendor with none
 * keeps it as a label only, in the brief.
 */
export function boardStartParts(vendor: string, brief: string, model = ''): string[] | null {
  const head = BOARD_START_COMMANDS[vendor];
  if (!head) return null;
  const flag = BOARD_MODEL_FLAGS[vendor];
  const withModel = model && flag ? [flag, model] : [];
  // Grok's `-p` takes the prompt as its value: `grok -p --trust ...` fails with
  // "a value is required for '--single <PROMPT>'", so the brief follows `-p` at once.
  if (vendor === 'grok') return [...head.slice(0, 2), brief, ...head.slice(2), ...withModel];
  return [...head, ...withModel, brief];
}

/**
 * Whether the vendor's guard hooks are in place in the worktree at `dir` and will run
 * there: the plain reason the start is refused, or null when it may start. A vendor
 * whose hooks need no trust (Claude Code, Antigravity) always passes: whether its hooks
 * file is there is the lead's repo setup, which `doctor` reports. The rest refuse when
 * the board can tell the hooks will not run, and pass when it cannot tell (no trust
 * store on this machine): a bare test folder is not proof of a missing guard.
 * Codex names its trust step, since nothing the board passes trusts it. Muse and grok
 * are trusted at the start (`--trust-workspace`, `--trust`), so only missing hooks
 * refuse them. DeepSeek Harness fails open without a word, so a missing guard, patch
 * or bridge refuses it.
 */
export function boardGuardReady(vendor: string, dir: string, env: Env): string | null {
  if (vendor === 'codex') {
    if (!codex.hasProjectHook(dir) || !codex.hasProjectStopHook(dir)) {
      if (!codex.hasUserDir(env)) return null;
      return `codex would run with no guard in ${hideHome(dir, env)}: no tool-call guard or stop check there. Run \`yokoten init\` in the repo, commit the hooks, and start again`;
    }
    const trust = codex.readTrust(dir, env);
    if (trust.state === 'trusted' || trust.state === 'no home' || trust.state === 'no store' || trust.state === 'unreadable') return null;
    return `codex would skip the guard hooks in ${hideHome(dir, env)}: ${trust.state === 'untrusted' ? 'that folder is not trusted' : 'the hooks there are not trusted'}. ${codex.TRUST_STEP}`;
  }
  if (vendor === 'muse') {
    const guard = muse.projectHooksState(dir, hookCliPath(dir)).guard;
    if (guard === 'same' || guard === 'updated') return null;
    if (!muse.hasUserDir(env)) return null;
    return `muse would run with no guard in ${hideHome(dir, env)}: no tool-call guard there. Run \`yokoten init\` in the repo, commit the hooks, and start again`;
  }
  if (vendor === 'grok') {
    const guard = grok.projectHooksState(dir, hookCliPath(dir)).guard;
    if (guard === 'same' || guard === 'updated') return null;
    if (!grok.hasUserDir(env)) return null;
    return `grok would run with no guard in ${hideHome(dir, env)}: no tool-call guard there. Run \`yokoten init\` in the repo, commit the hooks, and start again`;
  }
  if (vendor === 'deepseek-harness') {
    const states = deepseekHarness.projectHooksState(dir, hookCliPath(dir));
    if (states.guard !== 'same') return `deepseek-harness would run with no guard in ${hideHome(dir, env)}: no tool-call guard in ${deepseekHarness.HOOKS_FILE}. Run \`yokoten init\` in the repo, commit the hooks, and start again`;
    if (states.patch !== 'same') return `deepseek-harness would run with no guard in ${hideHome(dir, env)}: ${deepseekHarness.PATCH_FILE} is missing or out of date. Run \`yokoten init\` in the repo, commit the patch, and start again`;
    const profiles = deepseekHarness.profilesWithBridge(env);
    if (profiles && profiles.found.length) return null;
    return `deepseek-harness would run with no guard: no profile has the bridge and its peer. Add both to each profile you use (needs pnpm): ${deepseekHarness.pluginAddCommands('<profile>').join(' && ')}`;
  }
  return null;
}

/** The ask as given, or the plain reason it is refused. */
export function readBoardStartAsk(fields: Record<string, string>): BoardStartAsk | string {
  const issue = (fields.issue ?? '').trim();
  if (!/^[1-9]\d*$/.test(issue)) return 'give the issue by its number, such as 603';
  const vendor = (fields.vendor ?? '').trim();
  if (!Object.hasOwn(BOARD_START_COMMANDS, vendor)) {
    return `the board starts ${Object.keys(BOARD_START_COMMANDS).join(', ')}: start ${vendor || 'that vendor'} by hand`;
  }
  const model = (fields.model ?? '').trim();
  if (!BOARD_MODEL_PATTERN.test(model)) return 'name the model in letters, numbers, dots and dashes, such as muse-spark-1.3';
  return { issue, vendor, model };
}

/** The worktree for the issue, made when missing, or the plain reason git cannot make it. */
function boardWorktree(root: string, env: Env, issue: string): { dir: string } | { fail: string } {
  const dir = join(root, '.worktrees', issue);
  try {
    if (statSync(dir).isDirectory()) return { dir };
  } catch {
    // Missing: made below.
  }
  if (existsSync(dir)) return { fail: `the board needs ${hideHome(dir, env)} as a folder, but a file is there: move it away and run it again` };
  const branch = `${issue}-board`;
  try {
    execFileSync('git', ['worktree', 'add', dir, branch], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: BOARD_READ_TIMEOUT_MS });
  } catch {
    try {
      execFileSync('git', ['worktree', 'add', dir, '-b', branch], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: BOARD_READ_TIMEOUT_MS });
    } catch {
      return { fail: `the board could not make the worktree at ${hideHome(dir, env)}: make it by hand and run it again` };
    }
  }
  return { dir };
}

/** `1 agent`, `2 agents`: the count with the word. */
function countText(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** Why the ask breaks the limits, or null when it passes. */
function checkBoardLimits(controls: BoardControls, model: string): string | null {
  const running = controls.runs.filter((run) => run.status === 'running');
  if (running.length >= controls.limits.maxAgents) {
    return `the board already runs ${countText(running.length, 'agent')} of ${controls.limits.maxAgents}: stop one before starting another`;
  }
  const cap = controls.limits.byModel[model] ?? 0;
  const same = running.filter((run) => run.model === model).length;
  if (cap > 0 && same >= cap) return `the board already runs ${countText(same, 'agent')} on ${model} of ${cap}: stop one before starting another`;
  return null;
}

/** One board log line as one line: the brief in a start line holds newlines. */
function boardLogLine(line: string): string {
  return line.replace(/\s*\n\s*/g, ' ');
}

/**
 * Start one agent from the ask: check the limits (they need no dir), make the
 * worktree, check the guard hooks will run there and the vendor can start, then mark
 * it as a worker's right before starting the vendor's command, and keep the run. A
 * refused start leaves nothing behind: no dir, no branch, no mark, no process. The
 * child gets `YOKOTEN_ROLE=worker`, and the worker mark covers runtimes that drop it.
 */
export function startBoardAgent(root: string, env: Env, controls: BoardControls, ask: BoardStartAsk): BoardRun | string {
  const over = checkBoardLimits(controls, ask.model);
  if (over) return over;
  const made = boardWorktree(root, env, ask.issue);
  if ('fail' in made) return made.fail;
  const ready = boardGuardReady(ask.vendor, made.dir, env);
  if (ready) return ready;
  const parts = boardStartParts(ask.vendor, boardBrief(ask.issue, made.dir, ask.model), ask.model);
  if (!parts) return `the board starts ${Object.keys(BOARD_START_COMMANDS).join(', ')}: start ${ask.vendor} by hand`;
  const marked = markWorktree(root, made.dir, env);
  if ('fail' in marked) return `the board could not mark the worktree at ${hideHome(made.dir, env)} as a worker's: ${marked.fail}`;
  const [command, ...args] = parts;
  let name = `issue-${ask.issue}-${ask.vendor}`;
  for (let salt = 2; controls.runs.some((run) => run.name === name); salt += 1) name = `issue-${ask.issue}-${ask.vendor}-${salt}`;
  const run: BoardRun = {
    name,
    issue: ask.issue,
    vendor: ask.vendor,
    model: ask.model,
    worktree: made.dir,
    pid: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    stoppedAt: '',
    exitCode: null,
    output: [],
  };
  const push = (text: string) => {
    run.output.push(text.slice(0, 500));
    if (run.output.length > BOARD_OUTPUT_LINES) run.output.splice(0, run.output.length - BOARD_OUTPUT_LINES);
  };
  let child: BoardChild;
  try {
    child = controls.spawner(command, args, { cwd: made.dir, env: { ...env, YOKOTEN_ROLE: 'worker', YOKOTEN_MODEL: ask.model } }, {
      line: push,
      // An exit by itself stops the run: its limits slot and waiting rows free, and
      // a later stop answers already-stopped instead of signalling a dead child.
      exit: (code) => {
        run.exitCode = code;
        run.status = 'stopped';
        run.stoppedAt = new Date().toISOString();
        controls.handles.delete(name);
        appendBoardLog(controls, boardLogLine(`exit ${name} code ${code ?? 'unknown'}`));
      },
    });
  } catch {
    return `the board could not start ${command}: check that it is installed and run it again`;
  }
  run.pid = child.pid;
  controls.handles.set(name, child);
  controls.runs.push(run);
  appendBoardLog(controls, boardLogLine(`start ${name} pid ${child.pid ?? '?'} issue #${ask.issue} ${ask.vendor} ${ask.model} ${made.dir} ${command} ${args.join(' ')}`));
  return run;
}

/**
 * Stop one agent the board started. Anything else is refused: an unknown name, or one
 * that already stopped. Stopping keeps the worktree and its commits.
 */
export function stopBoardAgent(controls: BoardControls, name: string): BoardRun | string {
  const clean = name.trim();
  if (!clean) return 'name the agent to stop';
  const run = controls.runs.find((one) => one.name === clean);
  if (!run) return `no agent called ${clean} was started by this board`;
  if (run.status !== 'running') return `${clean} already stopped`;
  const child = controls.handles.get(clean);
  if (!child) return `the board could not stop ${clean}: its process is gone`;
  try {
    child.kill();
  } catch {
    return `the board could not stop ${clean}: run it again`;
  }
  run.status = 'stopped';
  run.stoppedAt = new Date().toISOString();
  appendBoardLog(controls, `stop ${run.name} pid ${run.pid ?? '?'} issue #${run.issue} ${run.vendor} ${run.model}`);
  return run;
}

/** One limits change: a new cap, a new per-model map, or both. Missing stays as it is. */
export interface BoardLimitChange {
  maxAgents?: number;
  byModel?: Record<string, number>;
}

/** The limits change as given, or the plain reason it is refused. */
export function readBoardLimitChange(fields: Record<string, string>): BoardLimitChange | string {
  const change: BoardLimitChange = {};
  const maxText = (fields.maxAgents ?? '').trim();
  if (maxText !== '') {
    const maxAgents = Number(maxText);
    if (!/^[1-9]\d*$/.test(maxText) || maxAgents > 32) return 'set maxAgents to a whole number from 1 to 32';
    change.maxAgents = maxAgents;
  }
  const modelsText = (fields.models ?? '').trim();
  if (modelsText !== '') {
    const byModel: Record<string, number> = {};
    for (const pair of modelsText.split(',')) {
      const [name, count] = pair.split(':').map((part) => part.trim());
      if (!name || !BOARD_MODEL_PATTERN.test(name) || !/^[1-9]\d*$/.test(count ?? '') || Number(count) > 32) {
        return 'set models as name:count pairs, such as model-a:2, model-b:1';
      }
      byModel[name] = Number(count);
    }
    change.byModel = byModel;
  }
  if (change.maxAgents === undefined && change.byModel === undefined) return 'set maxAgents, models, or both';
  return change;
}

/** The new limits, or the plain reason they are refused. Setting one keeps the other. */
export function setBoardLimits(controls: BoardControls, fields: Record<string, string>): BoardLimits | string {
  const change = readBoardLimitChange(fields);
  if (typeof change === 'string') return change;
  if (change.maxAgents !== undefined) controls.limits.maxAgents = change.maxAgents;
  if (change.byModel !== undefined) controls.limits.byModel = change.byModel;
  appendBoardLog(controls, `limits maxAgents ${controls.limits.maxAgents} models ${JSON.stringify(controls.limits.byModel)}`);
  return { ...controls.limits, byModel: { ...controls.limits.byModel } };
}

/** The board's data with the controls: the waiting list, the open issues, the runs, and the limits. */
export interface BoardSnapshot {
  waiting: BoardWaiting[];
  issues: BoardIssue[] | string;
  runs: BoardRun[];
  limits: BoardLimits;
}

export {
  collectBoardWaiting,
  readBoardAttention,
  readBoardIssues,
  readBoardIssuesLater,
  readBoardSnapshot,
} from './waiting.ts';
