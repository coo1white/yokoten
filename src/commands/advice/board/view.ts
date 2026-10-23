// What the board shows (#603): the agents, what needs the owner, and each pull request's
// steps. Plain data built on the server, so the page, `--text` and the tests read the same.

import { realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type BoardPull, type Gh, readBoardPulls, repoOf, repoPageOf } from '../../../host/github/index.ts';
import { type Env } from '../../../rules/config.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { readOriginUrl } from '../../../setup/plan.ts';
import type { BoardIssue } from './controls.ts';
import { ageText, BOARD_AGENT_FILE, type BoardAgent, type BoardRole, type BoardWorktree, type FoundAgent, readBoardAgents, readBoardSeats, readBoardWorktrees } from './agents.ts';
import { buildNeeds } from './feed/needs.ts';
import { makeBoardMask, makeFeedMask } from './feed/route.ts';
import { EMPTY_DESK, type LeadDesk, readLeadDesk, readLeadReply } from './feed/read/desk.ts';
import { findAgentLog, lastAssistantLine, type LogCache } from './feed/read/logs.ts';

/** Characters that fit on the lead row. The side column is 312px and the line is 12px. */
export const LEAD_ROW_CHARS = 40;

/** An agent that wrote within this time is working. The same window as a live seat (#698). */
const LIVE_WINDOW_MS = 15 * 60 * 1000;
/** Merged pull requests older than this are not sent; the page keeps only today's. */
const MERGED_WINDOW_MS = 36 * 60 * 60 * 1000;

/** The dot next to an agent: what the owner needs to know at a glance. */
export type AgentDot = 'working' | 'waiting' | 'failing' | 'idle' | 'done';

/** The dot for one agent. Done and waiting come from the agent; failing from its checks; otherwise how recently it wrote. */
export function dotOf(agent: BoardAgent, now: number): AgentDot {
  if (agent.state === 'done') return 'done';
  if (agent.state === 'waiting') return 'waiting';
  if (agent.checks === 'failing') return 'failing';
  const then = Date.parse(agent.updated);
  return !Number.isNaN(then) && now - then < LIVE_WINDOW_MS ? 'working' : 'idle';
}

/** The issue or pull request a task names. */
export interface WorkRef {
  kind: 'issue' | 'pr';
  number: number;
}

/** The first issue or pull request a task names: "PR #615", "pull request 615", "issue #614" or "#614". */
export function refOf(task: string): WorkRef | null {
  const pull = /\b(?:PR|pull request)\s*#?\s*(\d+)/i.exec(task);
  if (pull) return { kind: 'pr', number: Number(pull[1]) };
  const issue = /(?:\bissue\s*#?\s*|#)(\d+)/i.exec(task);
  return issue ? { kind: 'issue', number: Number(issue[1]) } : null;
}

/** A leading issue or pull request: "PR #615", "pull requests 1", "issues #668", or "#7". */
const LEADING_REF = /^(?:(?:PRs?|pull requests?|issues?)\s*#?\s*|#)\d+\b/i;
/** What joins or follows refs: commas, colons, dashes, "and", brackets. */
const LEADING_GLUE = /^(?:[,;:.\-–—&+/|()[\]]|and\b|or\b)/i;

/**
 * The task as a clean title (#685): without the issues, pull requests and links it starts
 * with, since the board shows the first as a chip, and without any web address. "PR #683
 * (https://…), issues #668 and #664: Board fixes" is "Board fixes". A task that is only
 * refs keeps its text.
 */
export function taskTitle(task: string): string {
  let rest = task.replace(/\([^()]*https?:\/\/[^()]*\)/gi, ' ').replace(/https?:\/\/\S+/gi, ' ').trim();
  for (let before = ''; before !== rest; ) {
    before = rest;
    rest = rest.replace(LEADING_REF, '').trim().replace(LEADING_GLUE, '').trim();
  }
  rest = rest.replace(/\s+/g, ' ');
  return rest || task.trim();
}

/** A vendor's shown name and colour. */
export interface VendorLook {
  name: string;
  color: string;
}

/**
 * How a vendor shows (#693). Claude, Grok, Muse and DeepSeek each have one name.
 * Codex on a DeepSeek model shows as DeepSeek. Claude on that model stays Claude.
 * Any other vendor keeps its filed name, in grey. The tables are inside the function
 * so the page can run it as one script, with no module constants.
 */
export function vendorOf(vendor: string, model = ''): VendorLook {
  /** Filed names that share one shown name (#693). The hooks file each agent by its --agent name. */
  const keys: Record<string, string> = {
    anthropic: 'claude',
    claude: 'claude',
    'claude-code': 'claude',
    xai: 'grok',
    grok: 'grok',
    muse: 'muse',
    deepseek: 'deepseek',
    'deepseek-harness': 'deepseek',
    'codex-deepseek': 'deepseek',
    'codex on deepseek': 'deepseek',
  };
  const looks: Record<string, VendorLook> = {
    claude: { name: 'Claude', color: '#d97757' },
    codex: { name: 'Codex', color: '#10a37f' },
    gemini: { name: 'Gemini', color: '#4285f4' },
    antigravity: { name: 'Antigravity', color: '#4285f4' },
    grok: { name: 'Grok', color: '#9ca3af' },
    muse: { name: 'Muse', color: '#0866ff' },
    deepseek: { name: 'DeepSeek', color: '#4d6bfe' },
  };
  const filed = vendor.trim().toLowerCase();
  let key = keys[filed] ?? filed;
  if (key === 'codex' && model.toLowerCase().includes('deepseek')) key = 'deepseek';
  const known = looks[key];
  return known ?? { name: vendor.trim() || 'Unknown', color: '#8b8b8b' };
}

/** Adjectives for a friendly name. The same list the old viewer used, so a name can stay. */
const NICKNAME_ADJECTIVES = ['Swift', 'Calm', 'Bright', 'Brave', 'Keen', 'Steady', 'Clever', 'Gentle', 'Bold', 'Quiet', 'Eager', 'Patient', 'Lucky', 'Sunny', 'Witty', 'Nimble'];
/** Pioneers for a friendly name, paired with one adjective. A clash in one run takes the next. */
const NICKNAME_PIONEERS = ['Lovelace', 'Turing', 'Hopper', 'Knuth', 'Hamilton', 'Dijkstra', 'Liskov', 'Ritchie', 'Goldberg', 'Thompson', 'Allen', 'Lamport', 'Johnson', 'Hoare', 'Wing', 'Kay', 'Clarke', 'Backus', 'Sammet', 'Wirth'];

/**
 * A friendly name for `id`: an adjective and a pioneer. The same id keeps its name.
 * A name already in `taken` moves to the next pioneer. When every pioneer is taken, the
 * adjective stands with "agent".
 */
export function nicknameOf(id: string, taken: readonly string[]): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const adjective = NICKNAME_ADJECTIVES[hash % NICKNAME_ADJECTIVES.length];
  const start = Math.floor(hash / NICKNAME_ADJECTIVES.length);
  for (let index = 0; index < NICKNAME_PIONEERS.length; index++) {
    const name = `${adjective} ${NICKNAME_PIONEERS[(start + index) % NICKNAME_PIONEERS.length]}`;
    if (!taken.includes(name)) return name;
  }
  return `${adjective} agent`;
}

/** The id a nickname comes from: the worktree path, or the status name when there is no path. */
export function nicknameId(path: string, name: string): string {
  return path || name;
}

/** One folder's real path, or the path as given when it cannot be resolved. */
function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

/** One agent as the page shows it. `key` tells agents apart: its worktree, with `~` for home. */
export interface AgentView {
  key: string;
  name: string;
  /** A friendly name, stable for this worktree, so a restart keeps it. */
  nickname: string;
  vendor: VendorLook;
  model: string;
  effort: string;
  role: BoardRole;
  /** True when this agent works in the main checkout, not a linked worktree or a desk. */
  isMain: boolean;
  dot: AgentDot;
  task: string;
  /** The task without its leading issue or pull request. */
  title: string;
  ref: WorkRef | null;
  doing: string;
  checks: BoardAgent['checks'];
  age: string;
  updated: string;
  /** When this work started. The file's `started`, else the file's birth, else `updated`. */
  started: string;
  branch: string;
  /** True when it says working and its status file or session log changed within 15 minutes. */
  isLive?: boolean;
}

/** Something only the owner can do: approve a pull request, or answer an agent. */
export interface NeedView {
  kind: 'approve' | 'answer';
  title: string;
  why: string;
  /** The waiting agent's key, or '' for an approval. */
  agentKey: string;
  /** The pull request, or 0 when the row is not one. */
  pull: number;
  /** The issue, or 0 when the row is not one. */
  issue?: number;
  /** When it started, as ISO, or '' when nothing names a time. The page says how old. */
  at?: string;
}

/** The four steps of a pull request; "You" only for tier A. */
export const PULL_STEPS = ['Built', 'Checked', 'You', 'Merged'] as const;
export type StepMark = 'done' | 'now' | 'fail' | 'skip' | '';

/** Where a pull request is, as a word the page can say in each language. */
export type PullStatus = 'building' | 'failed' | 'running' | 'unchecked' | 'changes' | 'approve' | 'ready';

/** One open pull request as the page shows it. */
export interface PullView {
  number: number;
  title: string;
  /** The address, only when it is http(s); else ''. */
  url: string;
  branch: string;
  tier: BoardPull['tier'];
  steps: StepMark[];
  /** The current step, as a word and in English, and whether it is moving, failed, or ready. */
  status: PullStatus;
  label: string;
  tone: 'now' | 'fail' | 'ok';
}

/** A merged pull request, for "Merged today". */
export interface MergedView {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

/** The address when it is http(s), else '': a status file or gh can't hand the page a script link. */
function webUrl(url: string): string {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : '';
}

/** The steps of one open or draft pull request, and the current step in words. */
export function pullView(pull: BoardPull): PullView {
  const you: StepMark = pull.tier === 'A' ? '' : 'skip';
  const base = { number: pull.number, title: pull.title, url: webUrl(pull.url), branch: pull.branch, tier: pull.tier };
  const at = (steps: StepMark[], status: PullStatus, label: string, tone: PullView['tone']): PullView => ({ ...base, steps, status, label, tone });
  if (pull.stage === 'draft') return at(['now', '', you, ''], 'building', 'Being built', 'now');
  if (pull.checks === 'fail') return at(['done', 'fail', you, ''], 'failed', 'Checks failed', 'fail');
  if (pull.checks === 'running') return at(['done', 'now', you, ''], 'running', 'Checks running', 'now');
  if (pull.checks === 'none') return at(['done', 'now', you, ''], 'unchecked', 'No checks yet', 'now');
  if (pull.tier === 'A' && pull.review === 'changes') return at(['done', 'done', 'fail', ''], 'changes', 'Changes requested', 'fail');
  // An Approve on an older commit still needs the owner (#693).
  if (pull.tier === 'A' && !pull.isApprovedOnHead) return at(['done', 'done', 'now', ''], 'approve', 'Needs your approval', 'now');
  return at(['done', 'done', pull.tier === 'A' ? 'done' : 'skip', 'now'], 'ready', 'Ready to merge', 'ok');
}

/**
 * What needs the owner (#693, #737): one row per pull request or issue. The rows are
 * built in the feed, so a finished one leaves on the next read. The page shows them
 * under the header bell.
 */
export function needsOf(agents: AgentView[], pulls: BoardPull[], openIssues: number[] | null = null): NeedView[] {
  return buildNeeds(agents, pulls, openIssues);
}

/** When a file last changed, or null when it is not a file. */
function fileChangedAt(file: string): number | null {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * True when the agent says it is working and its status file or its own log changed
 * within 15 minutes. A stale "working" holds no seat. The log is read only when the file is stale.
 */
function isAgentLive(tree: string, vendor: string, state: BoardAgent['state'], env: Env, cache: LogCache, now: number, logPath = ''): boolean {
  if (state !== 'working') return false;
  const statusAt = fileChangedAt(join(tree, BOARD_AGENT_FILE));
  if (statusAt !== null && now - statusAt < LIVE_WINDOW_MS) return true;
  const log = findAgentLog(tree, vendor, env, cache, logPath);
  return log !== null && now - log.mtime < LIVE_WINDOW_MS;
}

/**
 * The lead row's one line (#700): the first line of what the lead last said, masked as
 * the stream masks it, then cut to the row. No log, or no mask: the status file's line.
 */
function leadLine(tree: string, vendor: string, env: Env, root: string, cache: LogCache, fallback: string, logPath = ''): string {
  const log = findAgentLog(tree, vendor, env, cache, logPath);
  if (!log) return fallback;
  const text = lastAssistantLine(log.file, log.source, tree);
  if (!text) return fallback;
  try {
    const masked = makeFeedMask(env, root)(text).split('\n')[0]?.trim() ?? '';
    if (!masked) return fallback;
    return masked.length <= LEAD_ROW_CHARS ? masked : masked.slice(0, LEAD_ROW_CHARS);
  } catch {
    return fallback;
  }
}

/** When the work started: the filed time, else the status file's birth, else the last write. */
function workStarted(agent: BoardAgent, tree: string): string {
  if (!Number.isNaN(Date.parse(agent.started))) return agent.started;
  try {
    const born = statSync(join(tree, BOARD_AGENT_FILE)).birthtimeMs;
    if (born > 0) return new Date(born).toISOString();
  } catch {
    // No file time: the last write stands in.
  }
  return agent.updated;
}

/** One found agent as the page shows it. Agent text is masked before it can reach /data. */
function agentView(found: FoundAgent, env: Env, now: number, nickname: string, isMain: boolean, cache: LogCache, root: string, mask: (text: string) => string): AgentView {
  const { agent, tree } = found;
  const look = vendorOf(agent.vendor, agent.model);
  const filed = agent.role === 'lead' ? leadLine(tree.path, agent.vendor, env, root, cache, agent.doing, agent.log) : agent.doing;
  return {
    key: hideHome(tree.path, env),
    name: mask(agent.name),
    nickname,
    vendor: { name: mask(look.name), color: look.color },
    model: mask(agent.model),
    effort: mask(agent.effort),
    role: mask(agent.role),
    isMain,
    dot: dotOf(agent, now),
    task: mask(agent.task),
    title: mask(taskTitle(agent.task)),
    ref: refOf(agent.task),
    doing: mask(filed),
    checks: agent.checks,
    age: ageText(agent.updated, now),
    updated: agent.updated,
    started: workStarted(agent, tree.path),
    branch: tree.branch,
    isLive: isAgentLive(tree.path, agent.vendor, agent.state, env, cache, now, agent.log),
  };
}

/** Everything the board shows. The pulls and the worktrees are their rows, or why they can't be read. */
export interface BoardData {
  /** The repo root the board runs in, with `~` for home. */
  repo: string;
  /** The main checkout's folder name. The top bar shows this, not the worktree folder. */
  repoName: string;
  /** The repo's web page when it has a GitHub remote, else ''. */
  repoUrl: string;
  agents: AgentView[];
  needs: NeedView[];
  pulls: PullView[] | string;
  merged: MergedView[];
  worktrees: BoardWorktree[] | string;
  /** The lead's desk: what it is doing, the decisions, and its last reply (#701). */
  desk: LeadDesk;
  /** When the data was read. */
  updated: string;
  /** Seats per vendor, or null when `.git/yokoten-seats.json` is missing or bad. */
  seats?: Record<string, number> | null;
}

/** Why there are no pull requests without a GitHub remote. */
export const BOARD_NO_REMOTE_PULLS = 'this repo has no GitHub remote, so the board shows no pull requests';
/** Why there are no issues without a GitHub remote. */
export const BOARD_NO_REMOTE_ISSUES = 'this repo has no GitHub remote, so the board shows no open issues';
/** What the lists say before the first read from GitHub finishes (#688). */
export const BOARD_READING_GITHUB = 'reading GitHub…';
/**
 * The most open issues the board reads. A list this long may be cut off, so it
 * cannot prove that an issue is closed (#693).
 */
export const BOARD_ISSUE_LIMIT = 30;

/** The open issue numbers, or null when the list is missing or may be cut off. */
export function issueNumbersOf(issues: { number: number }[] | string): number[] | null {
  if (!Array.isArray(issues) || issues.length >= BOARD_ISSUE_LIMIT) return null;
  return issues.map((issue) => issue.number);
}

/** The board's data from the status files, `gh pr list` and `git worktree list`. Every shown path shows `~` for home. */
export function collectBoard(root: string, env: Env, gh: Gh, now: number = Date.now(), openIssues: number[] | null = null): BoardData {
  const remote = repoOf(readOriginUrl(root, env));
  return collectBoardWith(root, env, remote, remote ? readBoardPulls(gh, remote) : BOARD_NO_REMOTE_PULLS, now, openIssues);
}

/** The lead's desk for this read: the file when it is good, and the reply from its session. */
function leadDesk(root: string, env: Env, found: FoundAgent[]): LeadDesk {
  const filed = readLeadDesk(root, env);
  const lead = found.find((one) => one.agent.role === 'lead');
  const reply = lead ? readLeadReply(lead.tree.path, lead.agent.vendor, env, root) : { reply: '', rest: '' };
  return { ...(filed ?? EMPTY_DESK), reply: reply.reply, rest: reply.rest };
}

/**
 * The board's data with pull requests already read, or why there are none (#688). Only
 * the local parts are read here: the status files and `git worktree list`. `openIssues`
 * is the open issue numbers, or null when that list cannot prove an issue is closed.
 */
export function collectBoardWith(root: string, env: Env, remote: string | null, pulls: BoardPull[] | string, now: number = Date.now(), openIssues: number[] | null = null): BoardData {
  const worktrees = readBoardWorktrees(root, env);
  // git lists the main checkout first. Desks are clones added after that list.
  const mainPath = typeof worktrees === 'string' ? root : worktrees[0]?.path || root;
  const mainReal = realFolder(mainPath);
  const found = typeof worktrees === 'string' ? [] : readBoardAgents(worktrees);
  const taken: string[] = [];
  const cache: LogCache = new Map();
  const mask = makeBoardMask(env, root);
  const agents = found.map((item) => {
    const nickname = nicknameOf(nicknameId(item.tree.path, item.agent.name), taken);
    taken.push(nickname);
    return agentView(item, env, now, nickname, realFolder(item.tree.path) === mainReal, cache, root, mask);
  });
  const rows = typeof pulls === 'string' ? [] : pulls;
  return {
    repo: hideHome(root, env),
    repoName: basename(mainPath),
    repoUrl: remote ? repoPageOf(remote) : '',
    agents,
    needs: needsOf(agents, rows, openIssues),
    pulls: typeof pulls === 'string' ? pulls : rows.filter((pull) => pull.stage === 'open' || pull.stage === 'draft').map(pullView),
    merged: rows
      .filter((pull) => pull.stage === 'merged' && now - Date.parse(pull.mergedAt) < MERGED_WINDOW_MS)
      .map((pull) => ({ number: pull.number, title: pull.title, url: webUrl(pull.url), mergedAt: pull.mergedAt })),
    worktrees: typeof worktrees === 'string' ? worktrees : worktrees.map((tree) => ({ path: hideHome(tree.path, env), branch: tree.branch })),
    desk: leadDesk(root, env, found),
    updated: new Date(now).toISOString(),
    seats: readBoardSeats(root),
  };
}

/** The two lists the board reads from GitHub: each its rows, or why gh can't read them. */
export interface BoardGitHubLists {
  pulls: BoardPull[] | string;
  issues: BoardIssue[] | string;
}

/**
 * What the board last read from GitHub (#688). /data serves it at once and never waits
 * for gh. A read runs in the background, one at a time.
 */
export interface BoardGitHub extends BoardGitHubLists {
  /** The repo ("owner/name") the lists are from, or '' before the first read. */
  repo: string;
  /** When the last read with no failure finished, or '' before one. */
  readAt: string;
  /** When the last read finished, good or not. The next read waits for the refresh time after it. */
  triedAt: number;
  /** Why the last read failed, or '' when it worked. A failed list keeps its last good rows. */
  failed: string;
  /** The read that runs now, or null. Tests wait for it; /data never does. */
  reading: Promise<void> | null;
}

/** The cache before any read: both lists say GitHub is being read. */
export function createBoardGitHub(): BoardGitHub {
  return { repo: '', pulls: BOARD_READING_GITHUB, issues: BOARD_READING_GITHUB, readAt: '', triedAt: 0, failed: '', reading: null };
}

/** One list after a read: new rows win; a failed read keeps the old rows, else says why. */
function keptList<Row>(old: Row[] | string, fresh: Row[] | string): Row[] | string {
  return typeof fresh === 'string' && typeof old !== 'string' ? old : fresh;
}

/**
 * Starts one background read of `repo` when none runs and the last one finished at least
 * `maxAgeMs` ago. Returns at once. A new repo clears the lists of the old one.
 */
export function refreshBoardGitHub(cache: BoardGitHub, repo: string, read: () => Promise<BoardGitHubLists>, maxAgeMs: number, now: number = Date.now()): void {
  if (cache.repo !== repo) Object.assign(cache, { ...createBoardGitHub(), repo, reading: cache.reading });
  if (cache.reading || (cache.triedAt && now - cache.triedAt < maxAgeMs)) return;
  const failedRead = 'gh could not read GitHub: run it again';
  const reading = read()
    .catch((): BoardGitHubLists => ({ pulls: failedRead, issues: failedRead }))
    .then((fresh) => {
      if (cache.repo !== repo) return;
      const failed = [fresh.pulls, fresh.issues].filter((list): list is string => typeof list === 'string');
      cache.pulls = keptList(cache.pulls, fresh.pulls);
      cache.issues = keptList(cache.issues, fresh.issues);
      cache.failed = failed.join('; ');
      cache.triedAt = Date.now();
      if (!failed.length) cache.readAt = new Date(cache.triedAt).toISOString();
    })
    .finally(() => {
      if (cache.reading === reading) cache.reading = null;
    });
  cache.reading = reading;
}
