// The pull requests for `yokoten board` (#601), read through `gh pr list`, so it uses
// the owner's own sign-in and holds no token. Open, merged and closed, newest first.
// Read only.

import { readLabelTier } from '../../rules/pr.ts';
import { terminalText } from '../../run/learn.ts';
import { asText, type Gh, isObject, labelNames } from './planning.ts';

/** The most pull requests the board reads: enough for one team's open and recent work. */
const BOARD_PULL_LIMIT = 30;

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

/** The pull requests of `repo` ("owner/name"), or the reason gh can't read them. */
export function readBoardPulls(gh: Gh, repo: string): BoardPull[] | string {
  let text: string;
  try {
    text = gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(BOARD_PULL_LIMIT), '--json', 'number,title,headRefName,state,reviewDecision,isDraft,statusCheckRollup,labels,url,mergedAt']);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
    const reason = terminalText(String((err as { stderr?: string }).stderr || '').split('\n')[0].trim());
    return `gh can't list the pull requests${reason ? ` (${reason})` : ''}: run \`gh auth login\`, and check the repo`;
  }
  let pulls: unknown;
  try {
    pulls = JSON.parse(text);
  } catch {
    return 'gh gave no pull request list: run it again';
  }
  if (!Array.isArray(pulls)) return 'gh gave no pull request list: run it again';
  return pulls.map(parseBoardPull).filter((pull): pull is BoardPull => pull !== null);
}
