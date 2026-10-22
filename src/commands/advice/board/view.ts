// What the board shows (#603): the agents, what needs the owner, and each pull request's
// steps. Plain data built on the server, so the page, `--text` and the tests read the same.

import { type BoardPull, type Gh, readBoardPulls, repoOf, repoPageOf } from '../../../host/github.ts';
import { type Env } from '../../../rules/config.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { readOriginUrl } from '../../../setup/plan.ts';
import { ageText, type BoardAgent, type BoardRole, type BoardWorktree, type FoundAgent, readBoardAgents, readBoardWorktrees } from './agents.ts';

/** An agent that wrote within this time, and says nothing else, is working. */
const WORKING_WINDOW_MS = 30 * 60 * 1000;
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
  return !Number.isNaN(then) && now - then < WORKING_WINDOW_MS ? 'working' : 'idle';
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

/** The task without the issue or pull request it starts with, since the board shows that as a chip. */
export function taskTitle(task: string): string {
  return task.replace(/^\s*(?:PR|pull request|issue)?\s*#?\d+\s*[:\-–—]?\s*/i, '').trim() || task;
}

/** A vendor's shown name and colour. */
export interface VendorLook {
  name: string;
  color: string;
}

const VENDOR_LOOKS: Record<string, VendorLook> = {
  claude: { name: 'Claude', color: '#d97757' },
  'claude-code': { name: 'Claude', color: '#d97757' },
  codex: { name: 'Codex', color: '#10a37f' },
  gemini: { name: 'Gemini', color: '#4285f4' },
  antigravity: { name: 'Antigravity', color: '#4285f4' },
  grok: { name: 'Grok', color: '#9ca3af' },
  muse: { name: 'Muse', color: '#0866ff' },
  deepseek: { name: 'DeepSeek', color: '#4d6bfe' },
};
const OTHER_VENDOR_COLOR = '#8b8b8b';

/** How a vendor shows: a known one by its own name and colour, any other by its filed name in grey. */
export function vendorOf(vendor: string): VendorLook {
  const known = VENDOR_LOOKS[vendor.trim().toLowerCase()];
  return known ?? { name: vendor.trim() || 'Unknown', color: OTHER_VENDOR_COLOR };
}

/** One agent as the page shows it. `key` tells agents apart: its worktree, with `~` for home. */
export interface AgentView {
  key: string;
  name: string;
  vendor: VendorLook;
  model: string;
  effort: string;
  role: BoardRole;
  dot: AgentDot;
  task: string;
  /** The task without its leading issue or pull request. */
  title: string;
  ref: WorkRef | null;
  doing: string;
  checks: BoardAgent['checks'];
  age: string;
  updated: string;
  branch: string;
}

/** Something only the owner can do: approve a pull request, or answer an agent. */
export interface NeedView {
  kind: 'approve' | 'answer';
  title: string;
  why: string;
  /** The waiting agent's key, or the pull request's number. */
  agentKey: string;
  pull: number;
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
  if (pull.tier === 'A' && pull.review !== 'approved') return at(['done', 'done', 'now', ''], 'approve', 'Needs your approval', 'now');
  return at(['done', 'done', pull.tier === 'A' ? 'done' : 'skip', 'now'], 'ready', 'Ready to merge', 'ok');
}

/** What needs the owner: each tier A pull request ready for an Approve, then each agent waiting for an answer. */
export function needsOf(agents: AgentView[], pulls: BoardPull[]): NeedView[] {
  const approve = pulls
    .filter((pull) => pull.stage === 'open' && pull.tier === 'A' && pull.checks === 'pass' && pull.review !== 'approved' && pull.review !== 'changes')
    .map((pull): NeedView => ({ kind: 'approve', title: `Approve PR #${pull.number}`, why: `${pull.title}. All checks pass. Tier A needs your approval.`, agentKey: '', pull: pull.number }));
  const answer = agents
    .filter((agent) => agent.dot === 'waiting')
    .map((agent): NeedView => ({ kind: 'answer', title: `${agent.name} is waiting for you`, why: agent.doing || agent.task || 'It did not say why.', agentKey: agent.key, pull: 0 }));
  return [...approve, ...answer];
}

/** One found agent as the page shows it. */
function agentView({ agent, tree }: FoundAgent, env: Env, now: number): AgentView {
  return {
    key: hideHome(tree.path, env),
    name: agent.name,
    vendor: vendorOf(agent.vendor),
    model: agent.model,
    effort: agent.effort,
    role: agent.role,
    dot: dotOf(agent, now),
    task: agent.task,
    title: taskTitle(agent.task),
    ref: refOf(agent.task),
    doing: agent.doing,
    checks: agent.checks,
    age: ageText(agent.updated, now),
    updated: agent.updated,
    branch: tree.branch,
  };
}

/** Everything the board shows. The pulls and the worktrees are their rows, or why they can't be read. */
export interface BoardData {
  /** The repo root the board runs in, with `~` for home. */
  repo: string;
  /** The repo's web page when it has a GitHub remote, else ''. */
  repoUrl: string;
  agents: AgentView[];
  needs: NeedView[];
  pulls: PullView[] | string;
  merged: MergedView[];
  worktrees: BoardWorktree[] | string;
  /** When the data was read. */
  updated: string;
}

/** The board's data from the status files, `gh pr list` and `git worktree list`. Every shown path shows `~` for home. */
export function collectBoard(root: string, env: Env, gh: Gh, now: number = Date.now()): BoardData {
  const worktrees = readBoardWorktrees(root, env);
  const remote = repoOf(readOriginUrl(root, env));
  const agents = typeof worktrees === 'string' ? [] : readBoardAgents(worktrees).map((found) => agentView(found, env, now));
  const pulls = remote ? readBoardPulls(gh, remote) : 'this repo has no GitHub remote, so the board shows no pull requests';
  const rows = typeof pulls === 'string' ? [] : pulls;
  return {
    repo: hideHome(root, env),
    repoUrl: remote ? repoPageOf(remote) : '',
    agents,
    needs: needsOf(agents, rows),
    pulls: typeof pulls === 'string' ? pulls : rows.filter((pull) => pull.stage === 'open' || pull.stage === 'draft').map(pullView),
    merged: rows
      .filter((pull) => pull.stage === 'merged' && now - Date.parse(pull.mergedAt) < MERGED_WINDOW_MS)
      .map((pull) => ({ number: pull.number, title: pull.title, url: webUrl(pull.url), mergedAt: pull.mergedAt })),
    worktrees: typeof worktrees === 'string' ? worktrees : worktrees.map((tree) => ({ path: hideHome(tree.path, env), branch: tree.branch })),
    updated: new Date(now).toISOString(),
  };
}
