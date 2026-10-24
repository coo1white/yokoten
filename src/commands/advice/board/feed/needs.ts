// What needs the owner, as the header bell lists it (#737). One pull request or
// issue is one row. A row leaves when that work is done, on the next read, so the
// open page drops it without a reload. A review that is still running is not the
// owner's turn, so it is not a row and the page does not call it "all checks pass".

import type { BoardPull } from '../../../../host/github/index.ts';

/** An agent, with only the fields this list reads. */
export interface NeedAgent {
  key: string;
  name: string;
  nickname: string;
  role: string;
  dot: string;
  doing: string;
  task: string;
  updated: string;
  ref: { kind: 'issue' | 'pr'; number: number } | null;
}

/** One row: what it is, which pull request or issue, and when it started. */
export interface BuiltNeed {
  kind: 'approve' | 'answer';
  title: string;
  why: string;
  /** The waiting agent's key, or '' for an approval. */
  agentKey: string;
  /** The pull request, or 0 when the row is not one. */
  pull: number;
  /** The issue, or 0 when the row is not one. */
  issue: number;
  /** When it started, as ISO, or '' when nothing names a time. */
  at: string;
}

/** A day, in milliseconds. The page says so once a row is this old. */
export const NEED_DAY_MS = 24 * 60 * 60 * 1000;

/** True when `at` is a day old or more. A missing or odd time is not. */
export function isOlderThanDay(at: string, now: number): boolean {
  const then = Date.parse(at);
  return at !== '' && !Number.isNaN(then) && now - then >= NEED_DAY_MS;
}

/** True when a tier A pull request is open, green, and not approved on its head commit. */
function isNeedingApproval(pull: BoardPull): boolean {
  return pull.stage === 'open' && pull.tier === 'A' && pull.checks === 'pass' && pull.review !== 'changes' && !pull.isApprovedOnHead;
}

/**
 * True when a reviewer is still on this pull request. The cross-vendor review has
 * not finished, so the owner is not asked, and the row cannot say the checks are done.
 */
function isReviewOpen(agents: readonly NeedAgent[], number: number): boolean {
  return agents.some((agent) => agent.ref?.kind === 'pr' && agent.ref.number === number && agent.role.toLowerCase().includes('review') && agent.dot !== 'done');
}

/**
 * True when the pull request or issue is finished. A pull request is finished when
 * it is merged, closed, or approved on its head commit. An issue is finished only
 * when the open-issue list is known and does not name it. A missing pull request
 * stays, because the board cannot prove it is closed.
 */
function isSettledRef(ref: { kind: 'issue' | 'pr'; number: number }, pulls: readonly BoardPull[], openIssues: ReadonlySet<number> | null): boolean {
  if (ref.kind === 'issue') return openIssues !== null && !openIssues.has(ref.number);
  const pull = pulls.find((row) => row.number === ref.number);
  if (!pull) return false;
  return pull.stage === 'merged' || pull.stage === 'closed' || pull.isApprovedOnHead;
}

/** The earliest time an agent named this pull request or issue, or ''. */
function startedAt(agents: readonly NeedAgent[], kind: 'pr' | 'issue', number: number): string {
  const times = agents.filter((agent) => agent.ref?.kind === kind && agent.ref.number === number).map((agent) => Date.parse(agent.updated)).filter((time) => !Number.isNaN(time));
  return times.length ? new Date(Math.min(...times)).toISOString() : '';
}

/**
 * What needs the owner: one row per pull request or issue. Approve rows come first.
 * A row leaves once that pull request is approved on its head commit, or the pull
 * request or issue is merged or closed. A reviewer still on a pull request keeps
 * that approval off the list. An agent with no number keeps its own row.
 */
export function buildNeeds(agents: readonly NeedAgent[], pulls: readonly BoardPull[], openIssues: number[] | null = null): BuiltNeed[] {
  const open = openIssues === null ? null : new Set(openIssues);
  const seen = new Set<string>();
  const needs: BuiltNeed[] = [];
  for (const pull of pulls) {
    if (!isNeedingApproval(pull) || isReviewOpen(agents, pull.number)) continue;
    const key = `pr:${pull.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    needs.push({
      kind: 'approve',
      title: `Approve PR #${pull.number}`,
      why: `${pull.title}. All checks pass. Tier A needs your approval.`,
      agentKey: '',
      pull: pull.number,
      issue: 0,
      at: startedAt(agents, 'pr', pull.number),
    });
  }
  for (const agent of agents) {
    if (agent.dot !== 'waiting') continue;
    let pull = 0;
    let issue = 0;
    if (agent.ref) {
      const key = `${agent.ref.kind}:${agent.ref.number}`;
      if (seen.has(key) || isSettledRef(agent.ref, pulls, open)) continue;
      seen.add(key);
      if (agent.ref.kind === 'pr') pull = agent.ref.number;
      else issue = agent.ref.number;
    }
    needs.push({
      kind: 'answer',
      title: `${agent.nickname || agent.name} is waiting for you`,
      why: agent.doing || agent.task || 'It did not say why.',
      agentKey: agent.key,
      pull,
      issue,
      at: agent.updated,
    });
  }
  return needs;
}
