// The pull requests for `yokoten board` (#601), read through `gh pr list`, so it uses
// the owner's own sign-in and holds no token. The open ones, then the last few merged,
// then the last few closed. Read only. Closed rows let Needs you drop a finished item.

import { readLabelTier } from '../../rules/pr.ts';
import { terminalText } from '../../run/learn.ts';
import { asText, type Gh, type GhLater, isObject, labelNames } from './planning.ts';

/** The most open pull requests the board reads: enough for one team's open work. */
const BOARD_PULL_LIMIT = 30;
/** The most merged pull requests the board reads, for "Merged today". */
const BOARD_MERGED_LIMIT = 10;
/** The most closed pull requests the board reads, so a closed one can leave Needs you. */
const BOARD_CLOSED_LIMIT = 10;

/** One pull request on the board: its number, title, branch, and each stage. */
export interface BoardPull {
  number: number;
  title: string;
  branch: string;
  url: string;
  /** Merged, closed, a draft, or open. */
  stage: 'merged' | 'closed' | 'draft' | 'open';
  /** The checks: pass, fail, still running, or none. A fail wins over running. */
  checks: 'pass' | 'fail' | 'running' | 'none';
  /** The tier from its labels (A, B or C), or '' when it has none. */
  tier: '' | 'A' | 'B' | 'C';
  /** The review: approved, changes asked, waiting for the owner, or none asked. */
  review: 'approved' | 'changes' | 'waiting' | 'none';
  /** True when an Approve is on the head commit. An Approve on an older commit stays false. */
  isApprovedOnHead: boolean;
  /** When it merged, as gh gives it, or '' when it has not. */
  mergedAt: string;
}

/** A check conclusion that keeps the pull request green. Any other conclusion on a completed run turns it red, so an unknown one never shows green. */
const PASSED_CHECK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'CANCELLED']);

/** The checks of one pull request, from gh's statusCheckRollup. Each check counts by its latest run, so a green rerun clears an old failure. A fail wins over running. */
function rollupState(rollup: unknown): BoardPull['checks'] {
  const entries = Array.isArray(rollup) ? rollup.filter(isObject) : [];
  if (!entries.length) return 'none';
  const latest = keepLatestRuns(entries);
  if (latest.some((entry) => entry.status === 'COMPLETED' && !(typeof entry.conclusion === 'string' && PASSED_CHECK.has(entry.conclusion)))) return 'fail';
  if (latest.some((entry) => typeof entry.status === 'string' && entry.status !== 'COMPLETED')) return 'running';
  return 'pass';
}

/** One run's time: completedAt, else startedAt, else NaN when neither parses. */
function readRunTime(entry: Record<string, unknown>): number {
  for (const key of ['completedAt', 'startedAt']) {
    const value = entry[key];
    if (typeof value !== 'string' || !value) continue;
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return time;
  }
  return NaN;
}

/**
 * One run per check name: the latest by run time. An entry with no name is its own
 * check, since nothing says it reruns another. A dateless run never beats a dated one;
 * ties keep file order.
 */
function keepLatestRuns(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byName = new Map<string, Record<string, unknown>>();
  const nameless: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (typeof name !== 'string' || !name) {
      nameless.push(entry);
      continue;
    }
    const seen = byName.get(name);
    if (seen === undefined) {
      byName.set(name, entry);
      continue;
    }
    const seenTime = readRunTime(seen);
    const entryTime = readRunTime(entry);
    if (Number.isNaN(entryTime)) continue;
    if (Number.isNaN(seenTime) || entryTime > seenTime) byName.set(name, entry);
  }
  return [...byName.values(), ...nameless];
}

/** The tier from the label names, by the same rule as CI, or '' when there is none. */
function pullTier(labels: string[]): BoardPull['tier'] {
  const tier = labels.map(readLabelTier).find((found) => found !== null);
  return tier === 'A' || tier === 'B' || tier === 'C' ? tier : '';
}

/** The review word from gh's reviewDecision. */
function reviewOf(decision: string): BoardPull['review'] {
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'CHANGES_REQUESTED') return 'changes';
  if (decision === 'REVIEW_REQUIRED') return 'waiting';
  return 'none';
}

/**
 * The verdict on one review comment, or ''. Only a short line counts, such as
 * "PR #7: request changes". A mention inside a paragraph does not.
 */
function verdictOf(body: string): '' | 'changes' | 'approve' {
  const lines = body.split('\n').map((line) => line.replace(/[*_`]/g, '').trim()).filter(Boolean).slice(0, 8);
  for (const line of lines) {
    if (line.length > 80) continue;
    const text = line.replace(/^pr\s*#\d+\s*:\s*/i, '').trim();
    if (/^request changes\b/i.test(text)) return 'changes';
    if (/^approv(?:e|ed)\b/i.test(text)) return 'approve';
  }
  return '';
}

/** The objects in a gh list. A connection with `nodes` counts too. */
function noteList(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.nodes) ? value.nodes : [];
  return list.filter(isObject);
}

/** The newest review verdict, from comments and reviews. Empty when none names one. */
function latestVerdict(row: Record<string, unknown>): '' | 'changes' | 'approve' {
  const notes: { at: number; order: number; verdict: 'changes' | 'approve' }[] = [];
  const take = (value: unknown) => {
    for (const item of noteList(value)) {
      const verdict = verdictOf(asText(item.body));
      if (!verdict) continue;
      const at = Date.parse(asText(item.createdAt) || asText(item.submittedAt));
      notes.push({ at: Number.isNaN(at) ? 0 : at, order: notes.length, verdict });
    }
  };
  take(row.comments);
  take(row.reviews);
  take(row.latestReviews);
  notes.sort((left, right) => left.at - right.at || left.order - right.order);
  return notes.at(-1)?.verdict ?? '';
}

/**
 * True when an Approve sits on the head commit. GitHub can still say APPROVED after
 * new commits. Without a matching commit, the Approve does not count.
 */
function approvedOnHead(row: Record<string, unknown>, review: BoardPull['review']): boolean {
  if (review !== 'approved') return false;
  const head = asText(row.headRefOid);
  if (!head) return false;
  const reviews = Array.isArray(row.latestReviews) ? row.latestReviews : [];
  return reviews.some((item) => {
    if (!isObject(item) || asText(item.state) !== 'APPROVED') return false;
    const commit = item.commit;
    return isObject(commit) && asText(commit.oid) === head;
  });
}

/** One row of `gh pr list --json` as a board pull, or null when it has no number. */
function parseBoardPull(row: unknown): BoardPull | null {
  if (!isObject(row) || typeof row.number !== 'number' || !Number.isSafeInteger(row.number) || row.number <= 0) return null;
  let review = reviewOf(asText(row.reviewDecision));
  // A comment can ask for changes while GitHub still says the review is waiting.
  if (review !== 'changes' && latestVerdict(row) === 'changes') review = 'changes';
  return {
    number: row.number,
    title: asText(row.title),
    branch: asText(row.headRefName),
    url: asText(row.url),
    stage: asText(row.state) === 'MERGED' ? 'merged' : asText(row.state) === 'CLOSED' ? 'closed' : row.isDraft === true ? 'draft' : 'open',
    checks: rollupState(row.statusCheckRollup),
    tier: pullTier(labelNames(row.labels)),
    mergedAt: asText(row.mergedAt),
    review,
    isApprovedOnHead: approvedOnHead(row, review),
  };
}

/**
 * The gh queries of the board (#688): the open pull requests with their checks, then the
 * last few merged and the last few closed, without checks. Checks are the slow part.
 * The head commit and the latest reviews say whether an Approve is still current.
 */
function boardPullQueries(repo: string): string[][] {
  const openJson = 'number,title,headRefName,headRefOid,state,reviewDecision,latestReviews,reviews,comments,isDraft,statusCheckRollup,labels,url,mergedAt';
  const quietJson = 'number,title,headRefName,state,url,mergedAt';
  return [
    ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(BOARD_PULL_LIMIT), '--json', openJson],
    ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(BOARD_MERGED_LIMIT), '--json', quietJson],
    ['pr', 'list', '--repo', repo, '--state', 'closed', '--limit', String(BOARD_CLOSED_LIMIT), '--json', quietJson],
  ];
}

/** Why gh could not list the pull requests, in words a beginner can act on. */
function boardPullsFailed(err: unknown): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
  const reason = terminalText(String((err as { stderr?: string }).stderr || '').split('\n')[0].trim());
  return `gh can't list the pull requests${reason ? ` (${reason})` : ''}: run \`gh auth login\`, and check the repo`;
}

/**
 * The pull requests from gh's answers: open and draft from the first, merged from the
 * second, closed from the third, each number once. Or why the answers are no list.
 */
function boardPullsOf(answers: string[]): BoardPull[] | string {
  const wanted: BoardPull['stage'][][] = [['open', 'draft'], ['merged'], ['closed']];
  const found: BoardPull[] = [];
  for (const [at, text] of answers.entries()) {
    let rows: unknown;
    try {
      rows = JSON.parse(text);
    } catch {
      return 'gh gave no pull request list: run it again';
    }
    if (!Array.isArray(rows)) return 'gh gave no pull request list: run it again';
    for (const pull of rows.map(parseBoardPull)) {
      if (pull && wanted[at].includes(pull.stage) && !found.some((seen) => seen.number === pull.number)) found.push(pull);
    }
  }
  return found;
}

/** The open and recently merged pull requests of `repo` ("owner/name"), or the reason gh can't read them. */
export function readBoardPulls(gh: Gh, repo: string): BoardPull[] | string {
  let answers: string[];
  try {
    answers = boardPullQueries(repo).map((args) => gh(args));
  } catch (err) {
    return boardPullsFailed(err);
  }
  return boardPullsOf(answers);
}

/** readBoardPulls without blocking (#688): both queries run at once, and `signal` stops them. */
export async function readBoardPullsLater(gh: GhLater, repo: string, signal?: AbortSignal): Promise<BoardPull[] | string> {
  let answers: string[];
  try {
    answers = await Promise.all(boardPullQueries(repo).map(async (args) => gh(args, signal)));
  } catch (err) {
    return boardPullsFailed(err);
  }
  return boardPullsOf(answers);
}
