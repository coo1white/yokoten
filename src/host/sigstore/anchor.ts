// One check of the event log against its daily anchors (#768).
//
// Each past UTC day of the log has one number: the SHA-256 of its last line. The nightly
// workflow logs that number in Rekor. This check fails a day whose chain does not hold,
// and a day whose number has no entry this repo's workflow signed. A day that changed
// after it was anchored can no longer be found, so the message names that day. Today is
// left out: the day is still growing, and it is anchored the next day.

import { finding, type Finding } from '../../rules/message.ts';
import { dailyHashes, type DailyHash, type EventLog } from './record.ts';
import type { RekorFind } from './rekor.ts';

/** How one day's hash is looked up; Rekor in a real run, a plain function in a test. */
export type AnchorLookup = (hash: string) => Promise<RekorFind>;

/** What the check found: each day, how many anchors verified, and the lines to show. */
export interface AnchorReport {
  days: DailyHash[];
  anchored: number;
  /** Failing lines: a broken chain, or a day that does not match its anchor. */
  problems: Finding[];
  /** The days that did match, so a person sees the whole run. */
  notes: Finding[];
}

const CHAIN_FIX = 'restore the line the chain names, or keep this log and start a new one; a day after a broken line no longer matches Rekor';
const ANCHOR_FIX = 'the log changed after that day was anchored, or the day was never anchored; restore it from a copy, or keep this log and start a new one';

/** The UTC day a problem belongs to: the line's own day, or the day before it when it has none. */
function dayOfProblem(log: EventLog, index: number): string | undefined {
  for (let at = index; at >= 0; at--) if (log.lines[at]?.day) return log.lines[at].day ?? undefined;
  return undefined;
}

/**
 * Check each past day of `log` against `lookup`. `today` is the UTC day, as
 * `YYYY-MM-DD`; a test passes a fixed one.
 */
export async function checkAnchors(log: EventLog, { today, lookup }: { today: string; lookup: AnchorLookup }): Promise<AnchorReport> {
  const problems: Finding[] = [];
  const notes: Finding[] = [];
  const days = dailyHashes(log);
  // The first break is the line after the one that changed: line N names the hash line N-1
  // had before. So the day to name is the changed line's, and every later day depends on it.
  const firstBreak = log.problems[0];
  const breakIndex = firstBreak ? Math.max(0, firstBreak.index - 1) : undefined;
  const breakDay = breakIndex === undefined ? undefined : dayOfProblem(log, breakIndex);
  if (firstBreak) {
    problems.push(
      finding(
        'anchor',
        breakDay
          ? `${breakDay} no longer matches its anchor: the chain breaks at line ${firstBreak.index + 1} (${firstBreak.what})`
          : `the event log's chain does not hold: ${firstBreak.what}`,
        CHAIN_FIX,
      ),
    );
  }
  let anchored = 0;
  for (const day of days) {
    if (day.day >= today) continue;
    if (breakIndex !== undefined && day.index >= breakIndex) continue;
    const read = await lookup(day.hash);
    if ('found' in read) {
      anchored += 1;
      notes.push(finding('anchor', `${day.day}: the day's last line is anchored at Rekor log index ${read.found.logIndex}`, 'nothing to do'));
      continue;
    }
    problems.push(finding('anchor', `${day.day} no longer matches its anchor: ${read.problem} (last line ${day.index + 1}, hash ${day.hash.slice(0, 12)}…)`, ANCHOR_FIX));
  }
  return { days, anchored, problems, notes };
}
