// The pull requests for `yokoten board` (#601), read through `gh pr list`, so it uses
// the owner's own sign-in and holds no token. The open ones, then the last few merged,
// newest first. Read only.

import { readLabelTier } from '../../rules/pr.ts';
import { terminalText } from '../../run/learn.ts';
import { asText, type Gh, type GhLater, isObject, labelNames } from './planning.ts';

/** The most open pull requests the board reads: enough for one team's open work. */
const BOARD_PULL_LIMIT = 30;
/** The most merged pull requests the board reads, for "Merged today". */
const BOARD_MERGED_LIMIT = 10;

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

/** One row of `gh pr list --json` as a board pull, or null when it has no number. */
function parseBoardPull(row: unknown): BoardPull | null {
  if (!isObject(row) || typeof row.number !== 'number' || !Number.isSafeInteger(row.number) || row.number <= 0) return null;
  const review = asText(row.reviewDecision);
  return {
    number: row.number,
    title: asText(row.title),
    branch: asText(row.headRefName),
    url: asText(row.url),
    stage: asText(row.state) === 'MERGED' ? 'merged' : asText(row.state) === 'CLOSED' ? 'closed' : row.isDraft === true ? 'draft' : 'open',
    checks: rollupState(row.statusCheckRollup),
    tier: pullTier(labelNames(row.labels)),
    mergedAt: asText(row.mergedAt),
    review: review === 'APPROVED' ? 'approved' : review === 'CHANGES_REQUESTED' ? 'changes' : review === 'REVIEW_REQUIRED' ? 'waiting' : 'none',
  };
}

/**
 * The two gh queries of the board (#688): the open pull requests with their checks, and
 * the last few merged ones without. Merged checks never show, and the checks are the
 * slow part of gh's answer.
 */
function boardPullQueries(repo: string): string[][] {
  return [
    ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(BOARD_PULL_LIMIT), '--json', 'number,title,headRefName,state,reviewDecision,isDraft,statusCheckRollup,labels,url,mergedAt'],
    ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(BOARD_MERGED_LIMIT), '--json', 'number,title,headRefName,state,url,mergedAt'],
  ];
}

/** Why gh could not list the pull requests, in words a beginner can act on. */
function boardPullsFailed(err: unknown): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
  const reason = terminalText(String((err as { stderr?: string }).stderr || '').split('\n')[0].trim());
  return `gh can't list the pull requests${reason ? ` (${reason})` : ''}: run \`gh auth login\`, and check the repo`;
}

/**
 * The pull requests from gh's two answers: open and draft ones from the first, merged
 * ones from the second, each number once. Or why the answers are no list.
 */
function boardPullsOf(answers: string[]): BoardPull[] | string {
  const wanted: BoardPull['stage'][][] = [['open', 'draft'], ['merged']];
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
