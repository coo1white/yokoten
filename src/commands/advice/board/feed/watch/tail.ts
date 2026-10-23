// An agent's session log, read a little more on each /feed request (#694). The board keeps
// where it stopped in each log, so a read takes only the new lines, and at most READ_BYTES of
// them: a huge log never stalls the board. A log first seen starts near its end. Every item
// is masked before it is kept, so nothing unmasked ever leaves the server.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { type Env } from '../../../../../rules/config.ts';
import { findAgentLog, type FoundLog, type LogCache } from '../read/logs.ts';
import { LINE_READERS, type StreamItem, type StreamSource } from '../items.ts';

/** The most of a log one read takes. */
export const READ_BYTES = 256 * 1024;
/** How far from the end a log first seen starts. */
export const START_BYTES = 1024 * 1024;
/** A line longer than this is skipped: no message the board shows is that long. */
export const LINE_BYTES = 4 * 1024 * 1024;
/** The most items the board keeps for one agent; older ones drop off the top. */
export const KEEP_ITEMS = 400;
/** The most items one answer carries. */
export const SEND_ITEMS = 200;
/** How long a found log stands before the board looks again for a newer one. */
export const FIND_AGAIN_MS = 10000;
/** The most agents whose logs the board follows at once; the one asked about longest ago goes first. */
const TAIL_LIMIT = 16;

/** One log the board follows: where it stopped, the part line it holds, and the items so far. */
export interface LogTail {
  /** Tells this log apart from the agent's last one, so the page knows to start over. */
  session: string;
  source: StreamSource;
  file: string;
  tree: string;
  offset: number;
  rest: Buffer;
  /** True while the rest of an over-long line is skipped. */
  isSkipping: boolean;
  items: StreamItem[];
  /** How many items dropped off the top. An item's number is `base` plus its place. */
  base: number;
  /** Each call's id as the runtime wrote it, and the plain number the page sees. */
  calls: Map<string, string>;
}

/** What the board follows: a tail per agent, the found logs, and the mask every item passes. */
export interface StreamStore {
  tails: Map<string, LogTail>;
  found: Map<string, { log: FoundLog | null; at: number }>;
  used: Map<string, number>;
  cache: LogCache;
  count: number;
  mask: (text: string) => string;
  find: (tree: string, vendor: string) => FoundLog | null;
}

export function makeStreamStore(env: Env, mask: (text: string) => string, find?: (tree: string, vendor: string) => FoundLog | null): StreamStore {
  const cache: LogCache = new Map();
  return { tails: new Map(), found: new Map(), used: new Map(), cache, count: 0, mask, find: find ?? ((tree, vendor) => findAgentLog(tree, vendor, env, cache)) };
}

/** One answer of /feed: the log's runtime (`doing` with no log), its session, the cursor to send next, and the new items. */
export interface StreamAnswer {
  source: StreamSource | 'doing';
  session: string;
  /** The cursor for the next request: `<session>:<number>`. */
  next: string;
  /** True when the page must drop what it has: a new log, or a cursor the board no longer holds. */
  reset: boolean;
  /** True when the log has more than one read took: the page asks again soon. */
  more: boolean;
  items: StreamItem[];
}

/** Read the log from where the tail stopped, at most READ_BYTES. True when more is left. */
export function readTail(tail: LogTail, mask: (text: string) => string): boolean {
  let fd: number | null = null;
  let chunk: Buffer;
  let size: number;
  try {
    fd = openSync(tail.file, 'r');
    size = fstatSync(fd).size;
    // A log cut shorter was written anew: start it again.
    if (size < tail.offset) Object.assign(tail, { offset: 0, rest: Buffer.alloc(0), isSkipping: false });
    // Lines still held from the last read come first: nothing new is read until they are taken.
    const length = tail.rest.includes(10) ? 0 : Math.min(READ_BYTES, size - tail.offset);
    chunk = Buffer.alloc(Math.max(0, length));
    if (length > 0) readSync(fd, chunk, 0, length, tail.offset);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  tail.offset += chunk.length;
  let data = tail.rest.length ? Buffer.concat([tail.rest, chunk]) : chunk;
  let start = 0;
  let added = 0;
  // At most SEND_ITEMS new items a read, so none drops off the top before the page has it.
  for (let end = data.indexOf(10); end !== -1 && added < SEND_ITEMS; end = data.indexOf(10, start)) {
    if (!tail.isSkipping) added += takeLine(tail, data.subarray(start, end).toString('utf8'), mask);
    tail.isSkipping = false;
    start = end + 1;
  }
  data = data.subarray(start);
  const isHeld = data.includes(10);
  if (!isHeld && data.length > LINE_BYTES) {
    tail.isSkipping = true;
    data = Buffer.alloc(0);
  }
  tail.rest = Buffer.from(data);
  return isHeld || tail.offset < size;
}

/** One line of the log as masked items, and how many it made. A line that is not JSON is skipped. */
function takeLine(tail: LogTail, line: string, mask: (text: string) => string): number {
  if (!line.trim()) return 0;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return 0;
  }
  const items = LINE_READERS[tail.source](record, tail.tree);
  for (const item of items) {
    const kept: StreamItem = { kind: item.kind, text: mask(item.text), time: item.time };
    if (item.tool) kept.tool = item.tool;
    if (item.isCommand) kept.isCommand = true;
    if (item.isFailed) kept.isFailed = true;
    if (item.full !== undefined) kept.full = mask(item.full);
    if (item.call) {
      if (!tail.calls.has(item.call)) tail.calls.set(item.call, `c${tail.calls.size + 1}`);
      kept.call = tail.calls.get(item.call);
    }
    tail.items.push(kept);
  }
  if (tail.items.length > KEEP_ITEMS) {
    const drop = tail.items.length - KEEP_ITEMS;
    tail.items.splice(0, drop);
    tail.base += drop;
  }
  return items.length;
}

/** A new tail for a found log. A long log starts START_BYTES from its end, at the next whole line. */
function openTail(store: StreamStore, log: FoundLog, tree: string): LogTail {
  store.count += 1;
  const tail: LogTail = { session: `s${store.count}`, source: log.source, file: log.file, tree, offset: 0, rest: Buffer.alloc(0), isSkipping: false, items: [], base: 0, calls: new Map() };
  let size = 0;
  let fd: number | null = null;
  try {
    fd = openSync(log.file, 'r');
    size = fstatSync(fd).size;
  } catch {
    size = 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (size > START_BYTES) {
    tail.offset = size - START_BYTES;
    // The first line is cut: skip to its end.
    tail.isSkipping = true;
  }
  return tail;
}

/** The log of an agent, found again when the last look is older than FIND_AGAIN_MS. */
function logOf(store: StreamStore, key: string, tree: string, vendor: string, now: number): FoundLog | null {
  const last = store.found.get(key);
  if (last && now - last.at < FIND_AGAIN_MS) return last.log;
  const log = store.find(tree, vendor);
  store.found.set(key, { log, at: now });
  return log;
}

/** `<session>:<number>` as its parts, or null. */
function parseCursor(cursor: string): { session: string; at: number } | null {
  const hit = /^(s\d+):(\d+)$/.exec(cursor);
  return hit ? { session: hit[1], at: Number(hit[2]) } : null;
}

/**
 * The new items of one agent's log after `cursor`. `key` names the agent, `tree` is its
 * worktree and `vendor` its runtime as its status file says. No log: source `doing`, and the
 * page shows the agent's `doing` steps.
 */
export function readStream(store: StreamStore, key: string, tree: string, vendor: string, cursor: string, now: number = Date.now()): StreamAnswer {
  store.used.set(key, now);
  const log = logOf(store, key, tree, vendor, now);
  if (!log) {
    store.tails.delete(key);
    return { source: 'doing', session: '', next: '', reset: true, more: false, items: [] };
  }
  let tail = store.tails.get(key);
  if (!tail || tail.file !== log.file) {
    tail = openTail(store, log, tree);
    store.tails.set(key, tail);
  }
  for (const [other] of [...store.used].sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, store.used.size - TAIL_LIMIT))) {
    store.used.delete(other);
    store.tails.delete(other);
    store.found.delete(other);
  }
  const asked = parseCursor(cursor);
  const held = tail.base + tail.items.length;
  const isFresh = !asked || asked.session !== tail.session || asked.at < tail.base || asked.at > held;
  // The log is read again only once the page has all the board holds, so nothing drops off the top unsent.
  const more = isFresh || asked.at === held ? readTail(tail, store.mask) : true;
  const end = tail.base + tail.items.length;
  const from = isFresh ? Math.max(tail.base, end - SEND_ITEMS) : asked.at;
  const upto = Math.min(end, from + SEND_ITEMS);
  return {
    source: tail.source,
    session: tail.session,
    next: `${tail.session}:${upto}`,
    reset: isFresh,
    more: more || upto < end,
    items: tail.items.slice(from - tail.base, upto - tail.base),
  };
}
