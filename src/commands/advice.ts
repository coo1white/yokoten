// `yokoten doctor`, `explain`, `adopt` and `board`: they read and show; none writes to
// the project. A Claude Code session start keeps what it said in ~/.config/yokoten/sessions/ (#405).

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import * as claudeCode from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as deepseekHarness from '../agents/runtimes/deepseek-harness.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as grok from '../agents/runtimes/grok.ts';
import * as muse from '../agents/runtimes/muse.ts';
import { type BoardPull, type Gh, ghIn, readBoardPulls, repoOf } from '../host/github.ts';
import { DEFAULTS, type Env, loadConfig } from '../rules/config.ts';
import { workerRole } from '../rules/guards.ts';
import { formatFinding } from '../rules/message.ts';
import { hideHome } from '../rules/privacy.ts';
import { draft, facts, table } from '../setup/advice/adopt.ts';
import { explain, explainLines, ids } from '../setup/advice/explain.ts';
import { blocksToSay, doctor, OUTPUT_STOP, SERVER_TIMEOUT_MS, type SessionStart, UNFILTERED } from '../setup/doctor.ts';
import { hookCliPath } from '../setup/init.ts';
import { readOriginUrl } from '../setup/plan.ts';
import { markWorktree, READERS } from './hook.ts';
import { type Invocation, noRootFinding, parse, print, printJson, requireRoot, rootOf, say, usage } from './shared.ts';

/** What full doctor says while the slow reads run: the server read and (in WSL) the drive read. */
const SLOW_READ_LINE = 'reading GitHub settings...';

export function runDoctor(invocation: Invocation): number {
  const { env, cwd } = invocation;
  const options = parse('doctor', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const agent = options.values['--agent'] ?? 'claude-code';
  if (!Object.hasOwn(READERS, agent)) return usage(invocation, `unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`);
  const session = options.flags.has('--session');
  const root = rootOf(cwd, invocation.env);
  const config = root ? loadConfig(root) : DEFAULTS;
  // One line while the slow reads run. A session never reads the server, and --json
  // keeps stdout to the report, so the line shows on a terminal only, in full doctor.
  if (root && !session && !options.flags.has('--json') && invocation.stdout.isTTY === true) say(invocation, `${SLOW_READ_LINE}\n`, invocation.stdout);
  const { ok, lines: allLines, blocks, report } = doctor(root, { env, config, session, gh: root ? ghIn(root, env, SERVER_TIMEOUT_MS) : undefined, fillMarks: !session });
  // Full doctor outside a repo says so (#205). A session there stays quiet: no noise in a non-repo folder.
  if (!root && !session) {
    const missing = noRootFinding(cwd, invocation.env);
    if (options.flags.has('--json')) printJson(invocation, { ...report, ok: false, findings: [...report.findings, missing] });
    else print(invocation, [...allLines, `yokoten doctor: ${formatFinding(missing)}`], invocation.stderr);
    return 1;
  }
  // A compaction start repeats only what changed (#405); any other start says all.
  const lines = root && session && blocks && !options.flags.has('--json') ? blocksToSay(env, agent === 'claude-code' ? readSessionStart(invocation) : null, blocks).flat() : allLines;
  // A worker, by YOKOTEN_ROLE or by the mark on its worktree (#555), hears that the guard sees
  // it as one (#402), on every start, a compaction too: its role is safety, never news to
  // drop. The lead hears nothing.
  const role = root && session && blocks && !options.flags.has('--json') ? workerRole(env, [cwd]) : null;
  if (role) lines.push(`yokoten: ${role === 'mark' ? WORKER_MARKED : WORKER_SESSION}.`);
  // An agent that can't filter command output hears it at session start, with the opt-in (#390).
  if (root && session && agent !== 'claude-code' && config.privacy.output !== 'stop') lines.push(`yokoten: ${UNFILTERED}. ${OUTPUT_STOP[0].toUpperCase()}${OUTPUT_STOP.slice(1)}.`);
  if (options.flags.has('--json')) printJson(invocation, report);
  // Gemini CLI reads a SessionStart hook's context from JSON only (#211).
  else if (session && agent === 'gemini') {
    if (lines.length) say(invocation, `${gemini.formatSessionContext(hideHome(lines.join('\n'), env))}\n`, invocation.stdout);
  } else print(invocation, lines);
  // A session must start even when doctor found a problem.
  return session || ok ? 0 : 1;
}

const WORKER_SESSION = 'this session is a worker: lead-only files are guarded';
const WORKER_MARKED = 'this session is a worker, because its worktree carries the worker mark: lead-only files are guarded, and the lead pushes after review';

/** How long a session start waits for the hook's event on stdin, at most. */
const STDIN_WAIT_MS = 300;
/** The most of stdin read: an event is a few hundred bytes. */
const STDIN_LIMIT = 1 << 20;

/**
 * The SessionStart event Claude Code writes to stdin, or null when it gives none. It never
 * waits on a terminal, and never longer than STDIN_WAIT_MS on a pipe that stays open.
 */
function readSessionStart({ env, stdin }: Invocation): SessionStart | null {
  // Reading the process's stdin stream opens it first. For a pipe, libuv then puts the fd
  // in non-blocking mode, so readSync below throws EAGAIN in place of waiting for a writer
  // that never closes. A file, such as /dev/null, reads to its end at once.
  if (!claudeCode.hasSessionInput(env, stdin.stream.isTTY === true)) return null;
  const { fd } = stdin;
  const toEvent = (text: string) => {
    try {
      return claudeCode.readSessionStart(JSON.parse(text));
    } catch {
      return null;
    }
  };
  // A test's stdin is its text, all there at once.
  if (fd === null) return toEvent(stdin.text ?? '');
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + STDIN_WAIT_MS;
  const parsed = () => toEvent(Buffer.concat(chunks).toString('utf8'));
  for (let size = 0; size < STDIN_LIMIT; ) {
    let count = 0;
    try {
      count = readSync(fd, buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') break;
      // Nothing to read yet: a whole event read so far is enough; else wait a little.
      if (parsed() || Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    size += count;
  }
  return parsed();
}

export function runExplain(invocation: Invocation): number {
  const options = parse('explain', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [id] = options.positional;
  if (id === undefined) {
    if (options.flags.has('--json')) printJson(invocation, { ids: ids() });
    else print(invocation, [`Ids: ${ids().join(', ')}`]);
    return 0;
  }
  const found = explain(id);
  if (options.flags.has('--json')) printJson(invocation, found ? { found: true, ...found } : { id, found: false, ids: ids() });
  else if (found) print(invocation, explainLines(found));
  else print(invocation, [`yokoten explain: no rule or step is called ${id}.`, `Ids: ${ids().join(', ')}`], invocation.stderr);
  return found ? 0 : 1;
}

export function runAdopt(invocation: Invocation): number | Promise<number> {
  const { env } = invocation;
  // Reads files and asks the model; never writes a file or changes config.
  const options = parse('adopt', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  return draft(facts(root, env), { env }).then((drafted) => {
    if (options.flags.has('--json')) {
      printJson(invocation, drafted.rows.map(({ key, status, evidence, decision, reason }) => ({ key, status, evidence, decision, reason })));
      print(invocation, [`yokoten adopt: drafted by ${drafted.by}${drafted.note ? `, because ${drafted.note}` : ''}. You decide every row.`], invocation.stderr);
    } else print(invocation, table(drafted));
    return 0;
  });
}

// ---- The team board (#601) ----
//
// `yokoten board` serves a live page on this machine only; `board --text` prints the same
// data as plain text. The data comes from three places: one status file per worktree, `gh
// pr list`, and `git worktree list`. An agent joins by writing the file at its worktree's
// root, and leaves by removing it. The page is only one view: it reads the same data over
// /data as JSON.

/** How long the board waits for `gh pr list` or `git worktree list`, at most. */
const BOARD_READ_TIMEOUT_MS = 15000;
/** How often the page asks for new data, in seconds. */
const BOARD_REFRESH_SECONDS = 15;
/** An agent's status file, at its worktree's root. One file per worktree. */
const BOARD_AGENT_FILE = '.yokoten-agent.json';

/** One agent on the board, from its status file. The guide shows the open format. */
export interface BoardAgent {
  name: string;
  vendor: string;
  task: string;
  worktree: string;
  doing: string;
  /** When the agent last wrote, as filed, or '' when unknown. */
  updated: string;
  /** The agent's part in its issue: who builds, who reviews, or who verifies. */
  role: '' | 'engineer' | 'reviewer' | 'verifier';
}

/** Plain text of a status field, or '' when it is missing or not text. */
function fieldText(fields: Record<string, unknown>, name: string): string {
  const value: unknown = fields[name];
  return typeof value === 'string' ? value : '';
}

/** An agent's role, or '' when it is missing or not one of the three words. */
function readBoardRole(fields: Record<string, unknown>): BoardAgent['role'] {
  const role = fieldText(fields, 'role');
  return role === 'engineer' || role === 'reviewer' || role === 'verifier' ? role : '';
}

/** One status file as an agent, or null when it is not a JSON object. The worktree's own folder name fills a missing name. */
function parseBoardAgent(text: string, worktree: string): BoardAgent | null {
  let status: unknown;
  try {
    status = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof status !== 'object' || status === null || Array.isArray(status)) return null;
  const fields = status as Record<string, unknown>;
  return {
    name: fieldText(fields, 'name') || basename(worktree),
    vendor: fieldText(fields, 'vendor'),
    task: fieldText(fields, 'task'),
    worktree: fieldText(fields, 'worktree'),
    doing: fieldText(fields, 'doing'),
    updated: fieldText(fields, 'updated'),
    role: readBoardRole(fields),
  };
}

/** Every agent with a status file at its worktree's root, in worktree order. A missing, broken or unreadable file is skipped. */
export function readBoardAgents(trees: BoardWorktree[]): BoardAgent[] {
  const agents: BoardAgent[] = [];
  for (const tree of trees) {
    let text: string;
    try {
      text = readFileSync(join(tree.path, BOARD_AGENT_FILE), 'utf8');
    } catch {
      continue;
    }
    const agent = parseBoardAgent(text, tree.path);
    if (agent) agents.push(agent);
  }
  return agents;
}

/** How long ago `when` was, in plain words, or '' when it is missing or not a time. */
export function ageText(when: string, now: number = Date.now()): string {
  if (!when) return '';
  const then = Date.parse(when);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** One worktree of the repo: its path and its branch. */
export interface BoardWorktree {
  path: string;
  /** The branch, or '' when bare or detached. */
  branch: string;
}

/** `git worktree list --porcelain -z` as worktrees, or why git can't read them. */
export function readBoardWorktrees(root: string, env: Env): BoardWorktree[] | string {
  let text: string;
  try {
    text = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: BOARD_READ_TIMEOUT_MS });
  } catch {
    return 'git could not list the worktrees: run it again';
  }
  return text
    .split('\0\0')
    .filter((record) => record.startsWith('worktree '))
    .map((record) => {
      const fields = record.split('\0');
      const value = (key: string) => fields.find((field) => field === key || field.startsWith(`${key} `))?.slice(key.length + 1) ?? '';
      return { path: value('worktree'), branch: value('branch').replace(/^refs\/heads\//, '') };
    })
    .filter((worktree) => worktree.path !== '');
}

/** Everything the board shows. The pulls and the worktrees are their rows, or why they can't be read. */
export interface BoardData {
  /** The repo root the board runs in. */
  repo: string;
  agents: BoardAgent[];
  pulls: BoardPull[] | string;
  worktrees: BoardWorktree[] | string;
}

/**
 * The board's data: the agents' files, the pull requests, and the worktrees. Every shown
 * path (the repo, the worktrees, each agent's worktree) shows `~` for the home folder.
 */
export function collectBoard(root: string, env: Env, gh: Gh): BoardData {
  const worktrees = readBoardWorktrees(root, env);
  const remote = repoOf(readOriginUrl(root, env));
  const agents = typeof worktrees === 'string' ? [] : readBoardAgents(worktrees).map((agent) => ({ ...agent, worktree: hideHome(agent.worktree, env) }));
  return {
    repo: hideHome(root, env),
    agents,
    pulls: remote ? readBoardPulls(gh, remote) : 'this repo has no GitHub remote, so the board shows no pull requests',
    worktrees: typeof worktrees === 'string' ? worktrees : worktrees.map((tree) => ({ path: hideHome(tree.path, env), branch: tree.branch })),
  };
}

/** One agent as plain words: its name, vendor, role, task, worktree, and what it does now. */
function formatBoardAgent(agent: BoardAgent, now: number): string {
  const head = `${agent.name}${agent.vendor ? ` (${agent.vendor})` : ''}${agent.role ? ` [${agent.role}]` : ''}`;
  const parts = [agent.task, agent.worktree ? `in ${agent.worktree}` : '', agent.doing, ageText(agent.updated, now)].filter(Boolean);
  return parts.length ? `${head}: ${parts.join(', ')}` : head;
}

/** One pull request as plain words: its number, title, branch, and each stage. */
function formatBoardPull(pull: BoardPull): string {
  const checks = pull.checks === 'pass' ? 'checks pass' : pull.checks === 'fail' ? 'checks fail' : pull.checks === 'running' ? 'checks running' : 'no checks';
  const stage = pull.stage === 'open' ? (pull.review === 'approved' ? 'approved' : pull.review === 'changes' ? 'changes asked' : pull.review === 'waiting' ? 'waiting for the owner' : 'no review asked') : pull.stage;
  return `#${pull.number} ${pull.title} [${pull.branch}]: ${checks}, ${pull.tier ? `tier ${pull.tier}` : 'no tier'}, ${stage}`;
}

/** `1 agent`, `2 agents`: the count with the word. */
function countText(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** What `--text` adds past the agents, pulls and worktrees: the waiting list and the runs the board started. */
export interface BoardTextExtra {
  waiting: BoardWaiting[];
  runs: BoardRun[];
}

/** One waiting row as plain words, the same data the page shows. */
function formatBoardWaiting(row: BoardWaiting): string {
  const kind = row.kind === 'approve' ? 'Needs the owner go-ahead' : row.kind === 'guard' ? 'Guard stop' : 'Question';
  const head = [kind, row.agent, row.role ? `[${row.role}]` : '', row.wait].filter(Boolean).join(' ');
  return `${head}: ${row.why}${row.link ? ` (${row.link})` : ''}`;
}

/** One started run as plain words, the same data the page shows. */
function formatBoardRun(run: BoardRun): string {
  return `${run.name} ${run.vendor} ${run.model} issue ${run.issue} ${run.status}${run.worktree ? ` in ${run.worktree}` : ''}`;
}

/**
 * The board as plain text: the same data the page shows. With `extra` it also shows the
 * waiting list and the runs the board started; without it the text stays the agents,
 * pulls and worktrees alone, so an idle `--text` reads as before.
 */
export function renderBoardText(board: BoardData, now: number = Date.now(), extra?: BoardTextExtra): string[] {
  const pulls = typeof board.pulls === 'string' ? [] : board.pulls;
  const worktrees = typeof board.worktrees === 'string' ? [] : board.worktrees;
  return [
    `yokoten board: ${board.repo}`,
    `${countText(board.agents.length, 'agent')}, ${countText(pulls.length, 'pull request')}, ${countText(worktrees.length, 'worktree')}.`,
    '',
    'Agents:',
    ...(board.agents.length ? board.agents.map((agent) => `- ${formatBoardAgent(agent, now)}`) : [`- none. An agent joins by writing ${BOARD_AGENT_FILE} in its worktree.`]),
    '',
    ...(extra === undefined
      ? []
      : [
          'Waiting for you:',
          ...(extra.waiting.length ? extra.waiting.map((row) => `- ${formatBoardWaiting(row)}`) : ['- Nothing waits for you.']),
          '',
          'Started here:',
          ...(extra.runs.length ? extra.runs.map((run) => `- ${formatBoardRun(run)}`) : ['- No agents started here yet.']),
          '',
        ]),
    'Pull requests:',
    ...(typeof board.pulls === 'string' ? [`- ${board.pulls}`] : pulls.length ? pulls.map((pull) => `- ${formatBoardPull(pull)}`) : ['- none.']),
    '',
    'Worktrees:',
    ...(typeof board.worktrees === 'string' ? [`- ${board.worktrees}`] : worktrees.length ? worktrees.map((tree) => `- ${tree.path}${tree.branch ? ` (${tree.branch})` : ''}`) : ['- none.']),
  ];
}

/** The board as JSON for /data: the data, each agent with its age, and the time. */
function boardJson(board: BoardData): Record<string, unknown> {
  const now = Date.now();
  return { ...board, agents: board.agents.map((agent) => ({ ...agent, age: ageText(agent.updated, now) })), updated: new Date(now).toISOString() };
}

/** One answer of the board server: the status, the kind, and the text. Nothing is stored, and the page sends no referrer. */
function serveText(res: ServerResponse, status: number, kind: string, text: string): void {
  res.writeHead(status, { 'content-type': kind, 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(text);
}

/** The board page: plain HTML, CSS and JavaScript. The agents on the left, the picked one in the middle, the pull requests on the right. It reads /data every BOARD_REFRESH_SECONDS seconds. */
export function boardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yokoten board</title>
<style>
body { font-family: system-ui, sans-serif; margin: 1em auto; max-width: 90em; padding: 0 1em; color: #222; }
h1 { font-size: 1.4em; }
.columns { display: flex; gap: 1em; align-items: flex-start; }
.left { flex: 1 1 0; min-width: 12em; }
.middle { flex: 2 1 0; min-width: 16em; }
.right { flex: 1.4 1 0; min-width: 14em; }
section h2 { font-size: 1.1em; border-bottom: 1px solid #ccc; padding-bottom: 0.2em; }
.group h3 { font-size: 1em; color: #555; margin: 0.8em 0 0.3em; }
.agent { display: block; width: 100%; text-align: left; font: inherit; cursor: pointer; background: #f8f8f8; border: 1px solid #ccc; border-radius: 0.4em; padding: 0.4em 0.6em; margin: 0 0 0.3em; }
.agent.current { background: #e8f0fe; border-color: #888; }
.tag { display: inline-block; background: #e0e0e0; border-radius: 0.6em; padding: 0 0.5em; font-size: 0.85em; margin-left: 0.4em; }
.card { border: 1px solid #ccc; border-radius: 0.4em; padding: 0.4em 0.6em; margin: 0 0 0.5em; }
.card p { margin: 0.2em 0; }
form p { margin: 0.3em 0; }
label { display: block; margin: 0.3em 0; }
input, select, button { font: inherit; max-width: 100%; }
pre { white-space: pre-wrap; word-break: break-word; background: #f8f8f8; border: 1px solid #ccc; border-radius: 0.4em; padding: 0.4em 0.6em; }
dl { margin: 0.5em 0; }
dt { color: #555; font-size: 0.9em; }
dd { margin: 0 0 0.5em; }
.pass { color: #080; }
.fail { color: #c00; }
.note { color: #666; }
@media (max-width: 60em) { .columns { flex-direction: column; } .left, .middle, .right { width: 100%; } }
</style>
</head>
<body>
<h1>yokoten board</h1>
<p class="note" id="meta">Loading.</p>
<section>
<h2>Waiting for you</h2>
<div id="waiting"></div>
</section>
<div class="columns">
<section class="left">
<h2>Agents</h2>
<div id="groups"></div>
</section>
<section class="middle">
<h2>Agent</h2>
<div id="detail"></div>
<h2>Conversation</h2>
<p class="note">The agent's conversation will show here in a later version.</p>
</section>
<section class="right">
<h2>Pull requests</h2>
<div id="pulls"></div>
<h2>Start an agent</h2>
<form id="start">
<p><label>Issue number <input name="issue" id="issue" inputmode="numeric" list="issues"></label></p>
<datalist id="issues"></datalist>
<p><label>Vendor <select name="vendor" id="vendor"><option>claude-code</option><option>codex</option><option>muse</option><option>grok</option><option>antigravity</option><option>deepseek-harness</option></select></label></p>
<p><label>Model <input name="model" id="model"></label></p>
<p><button type="submit">Start</button></p>
</form>
<p class="note" id="startNote"></p>
<h2>Limits</h2>
<form id="limits">
<p><label>Agents at once <input name="maxAgents" id="maxAgents" inputmode="numeric"></label></p>
<p><label>Per model, as name:count pairs <input name="models" id="models"></label></p>
<p><button type="submit">Save</button></p>
</form>
<p class="note" id="limitsNote"></p>
<h2>Started here</h2>
<div id="started"></div>
<p class="note" id="startedNote"></p>
</section>
</div>
<section>
<h2>Latest output</h2>
<div id="output"></div>
</section>
<script>
var selectedName = null;
var lastAgents = [];
function text(tag, words) {
  var box = document.createElement(tag);
  box.textContent = words;
  return box;
}
function roleTag(role) {
  var tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = role;
  return tag;
}
function issueOf(task) {
  var found = /issue\\s*#?\\s*(\\d+)/i.exec(task || '');
  return found ? found[1] : '';
}
function groupAgents(agents) {
  var groups = [];
  agents.forEach(function (agent) {
    var key = issueOf(agent.task);
    var group = null;
    groups.forEach(function (known) {
      if (known.key === key) group = known;
    });
    if (!group) {
      group = { key: key, agents: [] };
      groups.push(group);
    }
    group.agents.push(agent);
  });
  return groups;
}
function showGroups(box, agents) {
  if (!agents.length) {
    box.appendChild(text('p', 'No agents. One joins by writing ${BOARD_AGENT_FILE} in its worktree.'));
    return;
  }
  groupAgents(agents).forEach(function (group) {
    var part = document.createElement('div');
    part.className = 'group';
    part.appendChild(text('h3', group.key ? 'Issue ' + group.key : 'Other work'));
    group.agents.forEach(function (agent) {
      var pick = document.createElement('button');
      pick.className = 'agent' + (agent.name === selectedName ? ' current' : '');
      pick.setAttribute('data-name', agent.name);
      pick.appendChild(text('span', agent.name));
      if (agent.role) pick.appendChild(roleTag(agent.role));
      pick.addEventListener('click', function () { select(agent.name); });
      part.appendChild(pick);
    });
    box.appendChild(part);
  });
}
function showDetail(box, agents) {
  box.replaceChildren();
  var found = null;
  agents.forEach(function (agent) {
    if (agent.name === selectedName) found = agent;
  });
  if (!found) {
    box.appendChild(text('p', agents.length ? 'Pick an agent on the left.' : 'No agents yet.'));
    return;
  }
  var head = text('h3', found.name);
  if (found.role) head.appendChild(roleTag(found.role));
  box.appendChild(head);
  var list = document.createElement('dl');
  var rows = [
    ['Task', found.task || 'no task yet'],
    ['Doing now', found.doing || 'nothing yet']
  ];
  if (found.vendor) rows.push(['Vendor', found.vendor]);
  if (found.worktree) rows.push(['Worktree', found.worktree]);
  if (found.age) rows.push(['Updated', found.age]);
  rows.forEach(function (row) {
    list.appendChild(text('dt', row[0]));
    list.appendChild(text('dd', row[1]));
  });
  box.appendChild(list);
}
function select(name) {
  selectedName = name;
  showDetail(document.getElementById('detail'), lastAgents);
  document.getElementById('groups').querySelectorAll('.agent').forEach(function (button) {
    if (button.getAttribute('data-name') === name) button.classList.add('current');
    else button.classList.remove('current');
  });
}
function checksWord(checks) {
  if (checks === 'pass') return 'checks pass';
  if (checks === 'fail') return 'checks fail';
  if (checks === 'running') return 'checks running';
  return 'no checks';
}
function reviewWord(pull) {
  if (pull.stage !== 'open') return pull.stage;
  if (pull.review === 'approved') return 'approved';
  if (pull.review === 'changes') return 'changes asked';
  if (pull.review === 'waiting') return 'waiting for the owner';
  return 'no review asked';
}
function isHttpUrl(url) {
  var clean = String(url || '').trim().toLowerCase();
  return clean.indexOf('http://') === 0 || clean.indexOf('https://') === 0;
}
function showPulls(box, pulls) {
  if (typeof pulls === 'string') {
    box.appendChild(text('p', pulls));
    return;
  }
  if (!pulls.length) {
    box.appendChild(text('p', 'No pull requests.'));
    return;
  }
  pulls.forEach(function (pull) {
    var card = document.createElement('div');
    card.className = 'card';
    var head = document.createElement('p');
    var number = document.createElement('strong');
    if (isHttpUrl(pull.url)) {
      var link = document.createElement('a');
      link.href = pull.url;
      link.textContent = '#' + pull.number;
      number.appendChild(link);
    } else {
      number.textContent = '#' + pull.number;
    }
    head.appendChild(number);
    head.appendChild(text('span', ' ' + pull.title));
    card.appendChild(head);
    var checks = text('p', checksWord(pull.checks) + ', ' + (pull.tier ? 'tier ' + pull.tier : 'no tier') + ', ' + reviewWord(pull));
    if (pull.checks === 'pass') checks.className = 'pass';
    if (pull.checks === 'fail') checks.className = 'fail';
    card.appendChild(checks);
    if (pull.branch) card.appendChild(text('p', 'Branch ' + pull.branch));
    box.appendChild(card);
  });
}
function kindWord(kind) {
  if (kind === 'approve') return 'Needs the owner go-ahead';
  if (kind === 'guard') return 'Guard stop';
  return 'Question';
}
function showWaiting(box, waiting) {
  var rows = waiting || [];
  if (!rows.length) {
    box.appendChild(text('p', 'Nothing waits for you.'));
    return;
  }
  rows.forEach(function (item) {
    var card = document.createElement('div');
    card.className = 'card';
    var head = kindWord(item.kind);
    if (item.agent) head += ' · ' + item.agent;
    if (item.role) head += ' [' + item.role + ']';
    if (item.wait) head += ', ' + item.wait;
    card.appendChild(text('p', head));
    card.appendChild(text('p', item.why));
    if (isHttpUrl(item.link)) {
      var act = document.createElement('a');
      act.href = item.link;
      act.textContent = 'Act here';
      card.appendChild(act);
    }
    box.appendChild(card);
  });
}
function showStarted(box, runs) {
  var rows = runs || [];
  if (!rows.length) {
    box.appendChild(text('p', 'No agents started here yet.'));
    return;
  }
  rows.forEach(function (run) {
    var card = document.createElement('div');
    card.className = 'card';
    card.appendChild(text('p', run.name + ' · ' + run.vendor + ' · ' + run.model + ' · issue ' + run.issue + ' · ' + run.status));
    if (run.worktree) card.appendChild(text('p', run.worktree));
    if (run.status === 'running') {
      var stop = document.createElement('button');
      stop.textContent = 'Stop';
      stop.setAttribute('data-name', run.name);
      stop.addEventListener('click', function () { stopRun(run.name); });
      card.appendChild(stop);
    }
    box.appendChild(card);
  });
}
function showOutput(box, runs) {
  var rows = runs || [];
  if (!rows.length) {
    box.appendChild(text('p', 'No output yet.'));
    return;
  }
  rows.forEach(function (run) {
    var card = document.createElement('div');
    card.className = 'card';
    card.appendChild(text('p', run.name));
    var out = document.createElement('pre');
    out.textContent = run.output.length ? run.output.join('\\n') : '(no output yet)';
    card.appendChild(out);
    box.appendChild(card);
  });
}
function showIssues(box, issues) {
  box.replaceChildren();
  if (!Array.isArray(issues)) return;
  issues.forEach(function (issue) {
    var pick = document.createElement('option');
    pick.value = String(issue.number);
    pick.textContent = '#' + issue.number + ' ' + issue.title;
    box.appendChild(pick);
  });
}
function showLimits(box, limits) {
  var caps = Object.keys((limits || {}).byModel || {}).map(function (model) { return model + ': ' + limits.byModel[model]; });
  box.textContent = 'Now: ' + (limits ? limits.maxAgents : '?') + ' at once' + (caps.length ? ' · ' + caps.join(', ') : '');
}
function enc(text) {
  return encodeURIComponent(text);
}
function doneWord(path) {
  if (path === 'agents/start') return 'Started.';
  if (path === 'agents/stop') return 'Stopped.';
  return 'Saved.';
}
function post(path, fields, noteId) {
  var body = fields.map(function (pair) { return enc(pair[0]) + '=' + enc(pair[1]); }).join('&');
  fetch(path + '?t=' + enc(pageToken()), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body }).then(function (res) {
    return res.text().then(function (note) { return { ok: res.ok, note: note }; });
  }).then(function (answer) {
    document.getElementById(noteId).textContent = answer.ok ? doneWord(path) : answer.note;
    if (answer.ok) load();
  }).catch(function () {
    document.getElementById(noteId).textContent = 'The board could not be reached.';
  });
}
function stopRun(name) {
  post('agents/stop', [['name', name]], 'startedNote');
}
function wireForms() {
  var start = document.getElementById('start');
  if (!start || !start.addEventListener) return;
  start.addEventListener('submit', function (event) {
    event.preventDefault();
    post('agents/start', [['issue', document.getElementById('issue').value], ['vendor', document.getElementById('vendor').value], ['model', document.getElementById('model').value]], 'startNote');
  });
  var limits = document.getElementById('limits');
  if (!limits || !limits.addEventListener) return;
  limits.addEventListener('submit', function (event) {
    event.preventDefault();
    post('agents/limits', [['maxAgents', document.getElementById('maxAgents').value], ['models', document.getElementById('models').value]], 'limitsNote');
  });
}
function show(data) {
  lastAgents = data.agents;
  if (!data.agents.some(function (agent) { return agent.name === selectedName; })) {
    selectedName = data.agents.length ? data.agents[0].name : null;
  }
  var groups = document.getElementById('groups');
  groups.replaceChildren();
  showGroups(groups, data.agents);
  showDetail(document.getElementById('detail'), data.agents);
  var pulls = document.getElementById('pulls');
  pulls.replaceChildren();
  showPulls(pulls, data.pulls);
  var waiting = document.getElementById('waiting');
  waiting.replaceChildren();
  showWaiting(waiting, data.waiting);
  var started = document.getElementById('started');
  started.replaceChildren();
  showStarted(started, data.runs);
  var output = document.getElementById('output');
  output.replaceChildren();
  showOutput(output, data.runs);
  showIssues(document.getElementById('issues'), data.issues);
  showLimits(document.getElementById('limitsNote'), data.limits);
  var meta = document.getElementById('meta');
  meta.textContent = 'Shows ' + data.repo + '. Refreshes every ${BOARD_REFRESH_SECONDS} seconds. Last update ' + new Date().toLocaleTimeString() + '.';
}
function pageToken() {
  return new URLSearchParams(location.search).get('t') || '';
}
function load() {
  fetch('data?t=' + encodeURIComponent(pageToken())).then(function (res) {
    return res.json();
  }).then(show).catch(function () {
    document.getElementById('meta').textContent = 'Waiting for data.';
  });
}
wireForms();
setInterval(load, ${BOARD_REFRESH_SECONDS * 1000});
load();
</script>
</body>
</html>
`;
}

/** How many random bytes the board link's token holds. */
const BOARD_TOKEN_BYTES = 16;

/**
 * True when the Host header names this server: 127.0.0.1:<port> or localhost:<port>.
 * Any other host is a rebound name, and gets a 403, so a page open in the same
 * browser cannot read the board through another name for this machine.
 */
function isBoardHost(host: string | undefined, port: number): boolean {
  const clean = (host ?? '').trim().toLowerCase();
  return clean === `127.0.0.1:${port}` || clean === `localhost:${port}`;
}

/** True when the given token matches, compared in constant time. A missing token, or one of another length, never reaches the compare. */
function isBoardToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const guess = Buffer.from(given, 'utf8');
  const want = Buffer.from(token, 'utf8');
  return guess.length === want.length && timingSafeEqual(guess, want);
}

/**
 * True when the Origin names this page: 127.0.0.1:<port> or localhost:<port>. A change
 * without the page's Origin gets a 403, so a page elsewhere cannot start or stop agents
 * through this board.
 */
function isBoardOrigin(origin: string | undefined, port: number): boolean {
  const clean = (origin ?? '').trim().toLowerCase();
  return clean === `http://127.0.0.1:${port}` || clean === `http://localhost:${port}`;
}

/** One request body, or null when it is too large to read. */
function readBoardBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((done) => {
    const parts: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stop = (body: string | null) => {
      if (settled) return;
      settled = true;
      done(body);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BOARD_BODY_LIMIT) {
        req.destroy();
        stop(null);
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => stop(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => stop(null));
  });
}

/**
 * One change request as fields: JSON, or a form. Null when the kind is JSON but the
 * text is not. The page sends a form, so it never builds raw JSON.
 */
function boardFields(text: string, kind: string | undefined): Record<string, string> | null {
  if ((kind ?? '').split(';')[0].trim().toLowerCase() === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(text || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) fields[key] = typeof value === 'string' ? value : '';
      return fields;
    } catch {
      return null;
    }
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) fields[key] = value;
  return fields;
}

/** The status for a refused start: over the limit is a conflict, a failed spawn is the server, the rest is the request. */
function startRefuseStatus(reason: string): number {
  if (reason.startsWith('the board already runs')) return 409;
  if (reason.startsWith('the board could not')) return 500;
  return 400;
}

/** The status for a refused stop: unknown is missing, done is a conflict, the rest is the request. */
function stopRefuseStatus(reason: string): number {
  if (reason.startsWith('no agent called') || reason === 'name the agent to stop') return 404;
  if (reason.endsWith('already stopped')) return 409;
  return 400;
}

/** What the options carry: the board's controls. Tests pass their own, with a fake spawner. */
export interface BoardServerOptions {
  controls?: BoardControls;
}

/**
 * Start the board on 127.0.0.1 and a free port: the page at /, the data as JSON at
 * /data, and the owner's changes at /agents/start, /agents/stop and /agents/limits.
 * Resolves with the server and its link, which holds a random token; rejects when the
 * server cannot listen. The caller stops it with server.close. A request whose Host is
 * not this server, or whose token is missing or wrong, gets a 403. A change whose
 * Origin is not the page gets a 403 too.
 */
export function startBoardServer(root: string, env: Env, gh: Gh, options: BoardServerOptions = {}): Promise<{ server: Server; url: string }> {
  const token = randomBytes(BOARD_TOKEN_BYTES).toString('hex');
  const controls = options.controls ?? createBoardControls(join(root, '.yokoten-board.log'));
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (!isBoardHost(req.headers.host, port)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    const [path, query] = (req.url ?? '').split('?');
    if (!isBoardToken(new URLSearchParams(query ?? '').get('t'), token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (req.method === 'GET') {
      if (path === '/') return serveText(res, 200, 'text/html; charset=utf-8', boardPage());
      if (path === '/data') {
        try {
          const board = collectBoard(root, env, gh);
          const trees = readBoardWorktrees(root, env);
          const snapshot = readBoardSnapshot(root, env, gh, controls, board, trees);
          return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...boardJson(board), ...snapshot }));
        } catch {
          return serveText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'the board could not be read: run it again' }));
        }
      }
      return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    }
    if (req.method !== 'POST') return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (path !== '/agents/start' && path !== '/agents/stop' && path !== '/agents/limits') {
      return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    }
    if (!isBoardOrigin(req.headers.origin, port)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    readBoardBody(req).then((body) => {
      if (res.writableEnded) return;
      if (body === null) return serveText(res, 400, 'text/plain; charset=utf-8', 'the board could not read that: send it again');
      try {
        if (path === '/agents/start') {
          const fields = boardFields(body, req.headers['content-type']);
          if (!fields) return serveText(res, 400, 'text/plain; charset=utf-8', 'send JSON or form fields');
          const ask = readBoardStartAsk(fields);
          if (typeof ask === 'string') return serveText(res, 400, 'text/plain; charset=utf-8', ask);
          const started = startBoardAgent(root, env, controls, ask);
          if (typeof started === 'string') return serveText(res, startRefuseStatus(started), 'text/plain; charset=utf-8', started);
          return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ name: started.name, worktree: hideHome(started.worktree, env), pid: started.pid }));
        }
        if (path === '/agents/stop') {
          const fields = boardFields(body, req.headers['content-type']);
          if (!fields) return serveText(res, 400, 'text/plain; charset=utf-8', 'send JSON or form fields');
          const stopped = stopBoardAgent(controls, fields.name ?? '');
          if (typeof stopped === 'string') return serveText(res, stopRefuseStatus(stopped), 'text/plain; charset=utf-8', stopped);
          return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ name: stopped.name, status: stopped.status }));
        }
        const fields = boardFields(body, req.headers['content-type']);
        if (!fields) return serveText(res, 400, 'text/plain; charset=utf-8', 'send JSON or form fields');
        const limits = setBoardLimits(controls, fields);
        if (typeof limits === 'string') return serveText(res, 400, 'text/plain; charset=utf-8', limits);
        return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ limits }));
      } catch {
        return serveText(res, 500, 'text/plain; charset=utf-8', 'the board could not do that: run it again');
      }
    });
  });
  return new Promise((done, failed) => {
    server.on('error', failed);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done({ server, url: `http://127.0.0.1:${port}/?t=${token}` });
    });
  });
}

export function runBoard(invocation: Invocation, options: BoardServerOptions = {}): number | Promise<number> {
  const parsed = parse('board', invocation.args);
  if (typeof parsed === 'string') return usage(invocation, parsed);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const gh = ghIn(root, invocation.env, BOARD_READ_TIMEOUT_MS);
  const controls = options.controls ?? createBoardControls(join(root, '.yokoten-board.log'));
  if (parsed.flags.has('--text')) {
    const board = collectBoard(root, invocation.env, gh);
    const trees = readBoardWorktrees(root, invocation.env);
    const waiting = collectBoardWaiting(board, typeof trees === 'string' ? [] : readBoardAttention(trees), controls.runs, controls.seen);
    print(invocation, renderBoardText(board, Date.now(), waiting.length || controls.runs.length ? { waiting, runs: controls.runs } : undefined));
    return 0;
  }
  return startBoardServer(root, invocation.env, gh, { controls }).then(
    ({ url }) => {
      print(invocation, [`yokoten board: the team is live at ${url}`, `The page refreshes every ${BOARD_REFRESH_SECONDS} seconds. Stop it with Ctrl-C.`]);
      return new Promise<number>(() => {});
    },
    () => {
      print(invocation, ['yokoten board: the page could not start: run it again.'], invocation.stderr);
      return 1;
    },
  );
}

// ---- The board's agent controls (#603) ----
//
// From the page the owner starts an agent on an open issue and stops it again. The
// board makes the worktree at `.worktrees/<issue>` and starts the vendor's own
// headless command with `YOKOTEN_ROLE=worker`, like the dispatch skill. The guard then
// checks the agent as a worker, and pushes and merges still go only through the bot.
// Each agent's latest output shows on the page. Stopping keeps the worktree and its
// commits.
//
// The waiting list at the top shows what needs the owner: tier A pull requests with
// green checks and no Approve, guard stops, and agent questions. The list is read
// only: no request an agent can make clears an item. There are no Approve or Merge
// buttons anywhere; those stay on the host, with the owner. Safety: 127.0.0.1 only, a
// random link token, the page's Origin on every change, stop only for processes this
// board started, and every start and stop in a log file.

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

/** One open issue to start an agent on: its number, title, and link. */
export interface BoardIssue {
  number: number;
  title: string;
  url: string;
}

/** One hold-up an agent reports in its status file: a guard stop or a question. */
export interface BoardAttention {
  name: string;
  vendor: string;
  role: BoardAgent['role'];
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
  role: BoardAgent['role'];
  wait: string;
  why: string;
  link: string;
}

/** How many output lines a run keeps; the page shows the last BOARD_OUTPUT_SHOWN. */
const BOARD_OUTPUT_LINES = 100;

/** How many of a run's output lines /data serves. */
const BOARD_OUTPUT_SHOWN = 30;

/** The most of a change request the board reads. */
const BOARD_BODY_LIMIT = 64 * 1024;

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
 * Start one agent from the ask: make the worktree, check the guard hooks will run
 * there, then mark it as a worker's right before starting the vendor's command, and
 * keep the run. A refused start leaves the worktree unmarked. The child gets
 * `YOKOTEN_ROLE=worker`, and the worker mark covers runtimes that drop it.
 */
export function startBoardAgent(root: string, env: Env, controls: BoardControls, ask: BoardStartAsk): BoardRun | string {
  const made = boardWorktree(root, env, ask.issue);
  if ('fail' in made) return made.fail;
  const ready = boardGuardReady(ask.vendor, made.dir, env);
  if (ready) return ready;
  const parts = boardStartParts(ask.vendor, boardBrief(ask.issue, made.dir, ask.model), ask.model);
  if (!parts) return `the board starts ${Object.keys(BOARD_START_COMMANDS).join(', ')}: start ${ask.vendor} by hand`;
  const over = checkBoardLimits(controls, ask.model);
  if (over) return over;
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

/** The open issues, gh's order, or why gh cannot read them. */
export function readBoardIssues(gh: Gh, repo: string): BoardIssue[] | string {
  let text: string;
  try {
    text = gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '30', '--json', 'number,title,url']);
  } catch {
    return 'gh could not list the open issues: run it again';
  }
  let rows: unknown;
  try {
    rows = JSON.parse(text || '[]');
  } catch {
    return 'gh gave no open issue list: run it again';
  }
  if (!Array.isArray(rows)) return 'gh gave no open issue list: run it again';
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const fields = row as Record<string, unknown>;
    const number = fields.number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return [];
    return [{ number, title: typeof fields.title === 'string' ? fields.title : '', url: typeof fields.url === 'string' ? fields.url : '' }];
  });
}

/** The link when it is http(s), else ''. Anything else stays plain text, never a link. */
function boardLink(url: string): string {
  const clean = url.trim().toLowerCase();
  return clean.startsWith('http://') || clean.startsWith('https://') ? url.trim() : '';
}

/**
 * The hold-ups the status files name: `blocked` (a guard stop that needs a decision) or
 * `question` (one line the agent asks the owner), with `link` for where to act. A file
 * that is missing, broken, or names neither is skipped.
 */
export function readBoardAttention(trees: BoardWorktree[]): BoardAttention[] {
  const found: BoardAttention[] = [];
  for (const tree of trees) {
    let text: string;
    try {
      text = readFileSync(join(tree.path, BOARD_AGENT_FILE), 'utf8');
    } catch {
      continue;
    }
    const agent = parseBoardAgent(text, tree.path);
    if (!agent) continue;
    let status: unknown;
    try {
      status = JSON.parse(text);
    } catch {
      continue;
    }
    const fields = status as Record<string, unknown>;
    const link = boardLink(fieldText(fields, 'link'));
    for (const kind of ['guard', 'question'] as const) {
      const why = fieldText(fields, kind === 'guard' ? 'blocked' : 'question').split('\n')[0].trim().slice(0, 140);
      if (!why) continue;
      found.push({ name: agent.name, vendor: agent.vendor, role: agent.role, worktree: agent.worktree, updated: agent.updated, kind, why, link });
    }
  }
  return found;
}

/** True when the pull request waits for the owner: tier A, open, green, and no Approve. */
function isWaitingPull(pull: BoardPull): boolean {
  return pull.tier === 'A' && pull.stage === 'open' && pull.checks === 'pass' && pull.review !== 'approved';
}

/** The agent in the worktree on the pull's branch, or null when no agent is there. */
function pullAgent(board: BoardData, branch: string): BoardAgent | null {
  if (typeof board.worktrees === 'string' || !branch) return null;
  const path = board.worktrees.find((tree) => tree.branch === branch)?.path;
  if (!path) return null;
  return board.agents.find((agent) => agent.worktree === path) ?? null;
}

/**
 * The waiting list: tier A pull requests that need the Approve, and the agents' guard
 * stops and questions. Tier A rows are live from the pull requests. Agent rows latch:
 * once a hold-up shows, it stays while the agent is here, even when its file stops
 * naming it. Only leaving (removing the file) clears a file row, and only stopping
 * clears a run's own row. `seen` keeps the latched rows; the answer copies them, so
 * callers never move the latch.
 */
export function collectBoardWaiting(board: BoardData, attention: BoardAttention[], runs: BoardRun[], seen: BoardWaiting[], now: number = Date.now()): BoardWaiting[] {
  const live: BoardWaiting[] = [];
  if (typeof board.pulls !== 'string') {
    for (const pull of board.pulls.filter(isWaitingPull)) {
      const agent = pullAgent(board, pull.branch);
      live.push({
        kind: 'approve',
        agent: agent?.name ?? '',
        role: agent?.role ?? '',
        wait: agent ? ageText(agent.updated, now) : '',
        why: `tier A, checks pass, needs the owner go-ahead: #${pull.number} ${pull.title}`.slice(0, 140),
        link: pull.url,
      });
    }
  }
  const fresh: BoardWaiting[] = attention.map((held) => ({ kind: held.kind, agent: held.name, role: held.role, wait: ageText(held.updated, now), why: held.why, link: held.link }));
  for (const run of runs.filter((one) => one.status === 'running')) {
    const stop = run.output.filter((line) => /guard stopped/i.test(line)).at(-1);
    if (!stop) continue;
    if (fresh.some((row) => row.agent === run.name && row.kind === 'guard')) continue;
    if (seen.some((row) => row.agent === run.name && row.kind === 'guard')) continue;
    fresh.push({ kind: 'guard', agent: run.name, role: '', wait: ageText(run.startedAt, now), why: stop.slice(0, 140), link: '' });
  }
  for (const row of fresh) {
    const old = seen.find((kept) => kept.agent === row.agent && kept.kind === row.kind);
    if (old) {
      old.role = row.role;
      old.wait = row.wait;
      old.why = row.why;
      old.link = row.link;
    } else seen.push({ ...row });
  }
  const here = new Set([...board.agents.map((agent) => agent.name), ...runs.filter((run) => run.status === 'running').map((run) => run.name)]);
  for (let at = seen.length - 1; at >= 0; at -= 1) {
    if (!here.has(seen[at].agent)) seen.splice(at, 1);
  }
  return [...live, ...seen.map((row) => ({ ...row }))];
}

/** The board's data with the controls: the waiting list, the open issues, the runs, and the limits. */
export interface BoardSnapshot {
  waiting: BoardWaiting[];
  issues: BoardIssue[] | string;
  runs: BoardRun[];
  limits: BoardLimits;
}

/** The runs as /data serves them: worktrees hide the home folder, and only the tail of the output. */
function snapshotRuns(runs: BoardRun[], env: Env): BoardRun[] {
  return runs.map((run) => ({ ...run, worktree: hideHome(run.worktree, env), output: run.output.slice(-BOARD_OUTPUT_SHOWN) }));
}

/** The snapshot for /data: the waiting list, the open issues, the runs, and the limits. */
export function readBoardSnapshot(root: string, env: Env, gh: Gh, controls: BoardControls, board: BoardData, trees: BoardWorktree[] | string): BoardSnapshot {
  const remote = repoOf(readOriginUrl(root, env));
  return {
    waiting: collectBoardWaiting(board, typeof trees === 'string' ? [] : readBoardAttention(trees), controls.runs, controls.seen),
    issues: remote ? readBoardIssues(gh, remote) : 'this repo has no GitHub remote, so the board shows no open issues',
    runs: snapshotRuns(controls.runs, env),
    limits: { ...controls.limits, byModel: { ...controls.limits.byModel } },
  };
}
