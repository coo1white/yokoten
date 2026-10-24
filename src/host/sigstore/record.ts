// The event log's hash chain, read as the daily number an outside witness keeps (#768).
//
// The log is the append-only file docs/standard.md specifies: one OTLP/JSON line per
// event, each line naming the SHA-256 of the line before. A whole rewritten log can carry
// a chain that holds, because the writer makes every hash. An outside witness closes that
// gap: one number a day, the hash of the day's last line, is enough to show that the day
// did not change after it was anchored.
//
// This module reads bytes and checks the chain. It writes nothing and talks to no network.

import { createHash } from 'node:crypto';

/** The first line of a chain names 64 zeros, not the hash of an earlier line. */
export const ZERO_HASH = '0'.repeat(64);

const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** One line of the log: its place, its bytes, its hash, and the UTC day it names. */
export interface LogLine {
  /** From 0. */
  index: number;
  /** The raw line, without the newline. */
  text: string;
  /** The SHA-256 of `text`, lowercase hex. This is what an anchor records. */
  hash: string;
  /** The UTC day of `timeUnixNano`, as `YYYY-MM-DD`; null when the line has no readable time. */
  day: string | null;
}

/** One place where the chain does not hold. */
export interface ChainProblem {
  /** The line at 0-based `index`. */
  index: number;
  /** One plain sentence about it. */
  what: string;
}

/** The log as it was read: every line, and what is wrong with the chain. */
export interface EventLog {
  lines: LogLine[];
  /** In line order. Empty when the chain holds. */
  problems: ChainProblem[];
}

/** The hash of one day: the last line of that day, and where it sits. */
export interface DailyHash {
  day: string;
  hash: string;
  index: number;
}

/** The SHA-256 of one raw line, lowercase hex, without its newline. */
export const lineHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The `previous_hash` attribute of one log record, when it has a readable one. */
function previousHash(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const attributes = (record as { attributes?: unknown }).attributes;
  if (!Array.isArray(attributes)) return undefined;
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== 'object') continue;
    const { key, value } = attribute as { key?: unknown; value?: unknown };
    if (key !== 'yokoten.event.previous_hash' || !value || typeof value !== 'object') continue;
    const text = (value as { stringValue?: unknown }).stringValue;
    if (typeof text === 'string') return text;
  }
  return undefined;
}

/** The one log record a line holds, or undefined when the line is not that shape. */
function logRecord(line: unknown): unknown {
  if (!line || typeof line !== 'object') return undefined;
  const resourceLogs = (line as { resourceLogs?: unknown }).resourceLogs;
  if (!Array.isArray(resourceLogs) || resourceLogs.length !== 1) return undefined;
  const scopeLogs = (resourceLogs[0] as { scopeLogs?: unknown } | undefined)?.scopeLogs;
  if (!Array.isArray(scopeLogs) || scopeLogs.length !== 1) return undefined;
  const records = (scopeLogs[0] as { logRecords?: unknown } | undefined)?.logRecords;
  if (!Array.isArray(records) || records.length !== 1) return undefined;
  return records[0];
}

/** The UTC day of `timeUnixNano` (digits, nanoseconds), or null when it is not readable. */
export function dayOf(timeUnixNano: unknown): string | null {
  if (typeof timeUnixNano !== 'string' || !/^\d+$/.test(timeUnixNano)) return null;
  const milliseconds = Number(BigInt(timeUnixNano) / 1000000n);
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return null;
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/**
 * Read `text` as the event log: hash every line, compare each `previous_hash` with the
 * line before, and note the UTC day. A line that is not the shape, a missing hash, or a
 * hash that does not match is a problem; the later lines are still read, so one changed
 * line does not hide the rest of the day.
 */
export function readEventLog(text: string): EventLog {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const rawLines = body === '' ? [] : body.split('\n');
  const lines: LogLine[] = [];
  const problems: ChainProblem[] = [];
  const note = (index: number, what: string) => problems.push({ index, what });
  let previous = ZERO_HASH;
  rawLines.forEach((raw, index) => {
    const place = `line ${index + 1}`;
    const hash = lineHash(raw);
    if (raw.includes('\r')) note(index, `${place} has a carriage return; the log is UTF-8 without \\r`);
    let record: unknown;
    try {
      record = logRecord(JSON.parse(raw));
    } catch {
      record = undefined;
    }
    if (record === undefined) {
      note(index, `${place} is not one OTLP/JSON log record on one line`);
      lines.push({ index, text: raw, hash, day: null });
      previous = hash;
      return;
    }
    const named = previousHash(record);
    if (!isHash(named)) note(index, `${place} has no yokoten.event.previous_hash of 64 lowercase hex characters`);
    else if (named !== previous) {
      note(
        index,
        index === 0 ? `${place} names ${named.slice(0, 8)}…, not 64 zeros` : `${place} names a previous hash that is not the hash of line ${index}: the chain breaks here`,
      );
    }
    lines.push({ index, text: raw, hash, day: dayOf((record as { timeUnixNano?: unknown }).timeUnixNano) });
    previous = hash;
  });
  return { lines, problems };
}

/**
 * The last line of each UTC day, in log order. An anchor records one of these hashes. A
 * day whose lines carry no readable time is left out; `readEventLog` does not report it,
 * because the standard makes the time a required field and a check for it is the writer's
 * job (#755).
 */
export function dailyHashes(log: EventLog): DailyHash[] {
  const last = new Map<string, DailyHash>();
  for (const line of log.lines) {
    if (line.day !== null) last.set(line.day, { day: line.day, hash: line.hash, index: line.index });
  }
  return [...last.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The line with this hash, or -1. */
export const findLine = (log: EventLog, hash: string): number => log.lines.findIndex((line) => line.hash === hash);
