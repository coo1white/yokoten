// `yokoten doctor`, `explain`, `adopt` and `board`: they read and show; none writes to
// the project. A Claude Code session start keeps what it said in ~/.config/yokoten/sessions/ (#405).

import { execFileSync } from 'node:child_process';
import { readFileSync, readSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import * as claudeCode from '../agents/runtimes/claude-code.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import { type BoardPull, type Gh, ghIn, readBoardPulls, repoOf } from '../host/github.ts';
import { DEFAULTS, type Env, loadConfig } from '../rules/config.ts';
import { workerRole } from '../rules/guards.ts';
import { formatFinding } from '../rules/message.ts';
import { hideHome } from '../rules/privacy.ts';
import { draft, facts, table } from '../setup/advice/adopt.ts';
import { explain, explainLines, ids } from '../setup/advice/explain.ts';
import { blocksToSay, doctor, OUTPUT_STOP, SERVER_TIMEOUT_MS, type SessionStart, UNFILTERED } from '../setup/doctor.ts';
import { readOriginUrl } from '../setup/plan.ts';
import { READERS } from './hook.ts';
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
}

/** Plain text of a status field, or '' when it is missing or not text. */
function fieldText(fields: Record<string, unknown>, name: string): string {
  const value: unknown = fields[name];
  return typeof value === 'string' ? value : '';
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

/** One agent as plain words: its name, vendor, task, worktree, and what it does now. */
function formatBoardAgent(agent: BoardAgent, now: number): string {
  const head = `${agent.name}${agent.vendor ? ` (${agent.vendor})` : ''}`;
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

/** The board as plain text: the same data the page shows. */
export function renderBoardText(board: BoardData, now: number = Date.now()): string[] {
  const pulls = typeof board.pulls === 'string' ? [] : board.pulls;
  const worktrees = typeof board.worktrees === 'string' ? [] : board.worktrees;
  return [
    `yokoten board: ${board.repo}`,
    `${countText(board.agents.length, 'agent')}, ${countText(pulls.length, 'pull request')}, ${countText(worktrees.length, 'worktree')}.`,
    '',
    'Agents:',
    ...(board.agents.length ? board.agents.map((agent) => `- ${formatBoardAgent(agent, now)}`) : ['- none. An agent joins by writing .yokoten-agent.json in its worktree.']),
    '',
    'Pull requests:',
    ...(typeof board.pulls === 'string' ? [`- ${board.pulls}`] : pulls.length ? pulls.map((pull) => `- ${formatBoardPull(pull)}`) : ['- none.']),
    '',
    'Worktrees:',
    ...(typeof board.worktrees === 'string' ? [`- ${board.worktrees}`] : worktrees.length ? worktrees.map((tree) => `- ${tree.path}${tree.branch ? ` (${tree.branch})` : ''}`) : ['- none.']),
  ];
}

/** The board as JSON for /data: the data, each agent with its age, and the time. */
function boardJson(board: BoardData): unknown {
  const now = Date.now();
  return { ...board, agents: board.agents.map((agent) => ({ ...agent, age: ageText(agent.updated, now) })), updated: new Date(now).toISOString() };
}

/** One answer of the board server: the status, the kind, and the text. */
function serveText(res: ServerResponse, status: number, kind: string, text: string): void {
  res.writeHead(status, { 'content-type': kind });
  res.end(text);
}

/** The board page: plain HTML, CSS and JavaScript. It reads /data every 15 seconds. */
export function boardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yokoten board</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2em auto; max-width: 60em; padding: 0 1em; color: #222; }
h1 { font-size: 1.4em; }
table { border-collapse: collapse; width: 100%; margin-bottom: 2em; }
th, td { border: 1px solid #ccc; padding: 0.4em 0.6em; text-align: left; vertical-align: top; }
th { background: #f4f4f4; }
.pass { color: #080; }
.fail { color: #c00; }
.note { color: #666; }
</style>
</head>
<body>
<h1>yokoten board</h1>
<p class="note" id="meta">Loading.</p>
<h2>Agents</h2>
<table id="agents"></table>
<h2>Pull requests</h2>
<table id="pulls"></table>
<h2>Worktrees</h2>
<table id="worktrees"></table>
<script>
function cell(text) {
  var box = document.createElement('td');
  box.textContent = text;
  return box;
}
function head(table, names) {
  var row = document.createElement('tr');
  names.forEach(function (name) {
    var box = document.createElement('th');
    box.textContent = name;
    row.appendChild(box);
  });
  table.appendChild(row);
}
function oneRow(table, text) {
  var row = document.createElement('tr');
  var box = document.createElement('td');
  box.textContent = text;
  row.appendChild(box);
  table.appendChild(row);
}
function showAgents(table, agents) {
  head(table, ['Name', 'Vendor', 'Task', 'Worktree', 'Doing now', 'Updated']);
  if (!agents.length) oneRow(table, 'No agents. One joins by writing .yokoten-agent.json in its worktree.');
  agents.forEach(function (agent) {
    var row = document.createElement('tr');
    row.appendChild(cell(agent.name));
    row.appendChild(cell(agent.vendor || '-'));
    row.appendChild(cell(agent.task || '-'));
    row.appendChild(cell(agent.worktree || '-'));
    row.appendChild(cell(agent.doing || '-'));
    row.appendChild(cell(agent.age || '-'));
    table.appendChild(row);
  });
}
function reviewWord(pull) {
  if (pull.stage !== 'open') return pull.stage;
  if (pull.review === 'approved') return 'approved';
  if (pull.review === 'changes') return 'changes asked';
  if (pull.review === 'waiting') return 'waiting for the owner';
  return 'no review asked';
}
function showPulls(table, pulls) {
  head(table, ['Number', 'Title', 'Branch', 'Checks', 'Tier', 'Stage']);
  if (typeof pulls === 'string') {
    oneRow(table, pulls);
    return;
  }
  if (!pulls.length) oneRow(table, 'No pull requests.');
  pulls.forEach(function (pull) {
    var row = document.createElement('tr');
    var number = document.createElement('td');
    if (pull.url) {
      var link = document.createElement('a');
      link.href = pull.url;
      link.textContent = '#' + pull.number;
      number.appendChild(link);
    } else {
      number.textContent = '#' + pull.number;
    }
    row.appendChild(number);
    row.appendChild(cell(pull.title));
    row.appendChild(cell(pull.branch || '-'));
    var checks = cell(pull.checks);
    if (pull.checks === 'pass') checks.className = 'pass';
    if (pull.checks === 'fail') checks.className = 'fail';
    row.appendChild(checks);
    row.appendChild(cell(pull.tier ? 'tier ' + pull.tier : 'no tier'));
    row.appendChild(cell(reviewWord(pull)));
    table.appendChild(row);
  });
}
function showWorktrees(table, worktrees) {
  head(table, ['Path', 'Branch']);
  if (typeof worktrees === 'string') {
    oneRow(table, worktrees);
    return;
  }
  if (!worktrees.length) oneRow(table, 'No worktrees.');
  worktrees.forEach(function (tree) {
    var row = document.createElement('tr');
    row.appendChild(cell(tree.path));
    row.appendChild(cell(tree.branch || '-'));
    table.appendChild(row);
  });
}
function show(data) {
  ['agents', 'pulls', 'worktrees'].forEach(function (id) {
    document.getElementById(id).replaceChildren();
  });
  showAgents(document.getElementById('agents'), data.agents);
  showPulls(document.getElementById('pulls'), data.pulls);
  showWorktrees(document.getElementById('worktrees'), data.worktrees);
  var meta = document.getElementById('meta');
  meta.textContent = 'Shows ' + data.repo + '. Refreshes every ${BOARD_REFRESH_SECONDS} seconds. Last update ' + new Date().toLocaleTimeString() + '.';
}
function load() {
  fetch('data').then(function (res) {
    return res.json();
  }).then(show).catch(function () {
    document.getElementById('meta').textContent = 'Waiting for data.';
  });
}
setInterval(load, ${BOARD_REFRESH_SECONDS * 1000});
load();
</script>
</body>
</html>
`;
}

/**
 * Start the board on 127.0.0.1 and a free port: the page at /, the data as JSON at
 * /data. Resolves with the server and its link. The caller stops it with server.close.
 */
export function startBoardServer(root: string, env: Env, gh: Gh): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (req.url === '/') return serveText(res, 200, 'text/html; charset=utf-8', boardPage());
    if (req.url === '/data') {
      let board: BoardData;
      try {
        board = collectBoard(root, env, gh);
      } catch {
        return serveText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'the board could not be read: run it again' }));
      }
      return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify(boardJson(board)));
    }
    return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

export function runBoard(invocation: Invocation): number | Promise<number> {
  const options = parse('board', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const gh = ghIn(root, invocation.env, BOARD_READ_TIMEOUT_MS);
  if (options.flags.has('--text')) {
    print(invocation, renderBoardText(collectBoard(root, invocation.env, gh)));
    return 0;
  }
  return startBoardServer(root, invocation.env, gh).then(({ url }) => {
    print(invocation, [`yokoten board: the team is live at ${url}`, 'The page refreshes every 15 seconds. Stop it with Ctrl-C.']);
    return new Promise<number>(() => {});
  });
}
