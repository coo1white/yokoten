// `yokoten board` (#601, #603): the team board. See the notes below.

import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { type BoardPull, type Gh, ghIn, readBoardPulls, repoOf } from '../../host/github.ts';
import { type Env } from '../../rules/config.ts';
import { hideHome } from '../../rules/privacy.ts';
import { readOriginUrl } from '../../setup/plan.ts';
import { type Invocation, parse, print, requireRoot, usage } from '../shared.ts';

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

/** The board as plain text: the same data the page shows. */
export function renderBoardText(board: BoardData, now: number = Date.now()): string[] {
  const pulls = typeof board.pulls === 'string' ? [] : board.pulls;
  const worktrees = typeof board.worktrees === 'string' ? [] : board.worktrees;
  return [
    `yokoten board: ${board.repo}`,
    `${countText(board.agents.length, 'agent')}, ${countText(pulls.length, 'pull request')}, ${countText(worktrees.length, 'worktree')}.`,
    '',
    'Agents:',
    ...(board.agents.length ? board.agents.map((agent) => `- ${formatBoardAgent(agent, now)}`) : [`- none. An agent joins by writing ${BOARD_AGENT_FILE} in its worktree.`]),
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
</section>
</div>
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
 * Start the board on 127.0.0.1 and a free port: the page at /, the data as JSON at
 * /data. Resolves with the server and its link, which holds a random token; rejects
 * when the server cannot listen. The caller stops it with server.close. A request
 * whose Host is not this server, or whose token is missing or wrong, gets a 403.
 */
export function startBoardServer(root: string, env: Env, gh: Gh): Promise<{ server: Server; url: string }> {
  const token = randomBytes(BOARD_TOKEN_BYTES).toString('hex');
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (!isBoardHost(req.headers.host, port)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    const [path, query] = (req.url ?? '').split('?');
    if (!isBoardToken(new URLSearchParams(query ?? '').get('t'), token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (req.method !== 'GET') return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (path === '/') return serveText(res, 200, 'text/html; charset=utf-8', boardPage());
    if (path === '/data') {
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
  return new Promise((done, failed) => {
    server.on('error', failed);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done({ server, url: `http://127.0.0.1:${port}/?t=${token}` });
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
  return startBoardServer(root, invocation.env, gh).then(
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
