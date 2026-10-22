// The outboxes (#674): one JSON line per message, append-only, in the sender's own file.
//
// A line borrows the field names of the A2A protocol's Message (a2aproject/A2A, Apache-2.0;
// names only, no code): `messageId`, `role` and `parts` with one text part. yokoten adds
// `from`, `to`, `time`, `seq` and `prev`. `prev` is the start of the sha256 of the line
// before, so a line changed or taken out of the middle shows. Each reader also keeps how
// far it read and the hash of that line, so an outbox cut short or rewritten after it was
// read shows too. The sender is the file's name; `from` must match it.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD, MAX_MESSAGE_CHARS, MAX_OUTBOX_BYTES, MAX_PER_WINDOW, type Me, NAME, outboxOf, RATE_WINDOW_MS, readRoster } from './team.ts';

/** One message as a reader takes it. `from` is the outbox's name. */
export interface Message {
  messageId: string;
  from: string;
  to: string;
  time: string;
  text: string;
  /** Its line in the sender's outbox, from 0. */
  index: number;
}

/** What one outbox holds, read and checked. */
export interface Outbox {
  name: string;
  /** The raw lines that passed the check, in order. */
  lines: string[];
  messages: Message[];
  /** Plain lines about what is wrong with it: a broken chain, a size past the cap. */
  problems: string[];
  size: number;
}

/** How far a reader has read each outbox. */
export type ReadState = Record<string, { lines: number; last: string; size: number }>;

export const hashLine = (line: string): string => createHash('sha256').update(line).digest('hex').slice(0, 16);

/** The text of an outbox, at most MAX_OUTBOX_BYTES, never through a link. */
function readCapped(path: string): { text: string; size: number } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { text: '', size: 0 };
    const buffer = Buffer.alloc(Math.min(stats.size, MAX_OUTBOX_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8', 0, read), size: stats.size };
  } finally {
    closeSync(fd);
  }
}

/** Read and check one agent's outbox. A missing one is empty. */
export function readOutbox(team: string, name: string): Outbox {
  const outbox: Outbox = { name, lines: [], messages: [], problems: [], size: 0 };
  let text: string;
  try {
    ({ text, size: outbox.size } = readCapped(outboxOf(team, name)));
  } catch {
    return outbox;
  }
  if (outbox.size > MAX_OUTBOX_BYTES) outbox.problems.push(`${name}'s outbox is over the cap of ${MAX_OUTBOX_BYTES} bytes; only the start is read`);
  const raw = text.split('\n');
  // A last line with no line break is still being written, or cut at the cap.
  raw.pop();
  let prev = '';
  for (const [index, line] of raw.entries()) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = {};
    }
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const part = parts[0] as { kind?: unknown; text?: unknown } | undefined;
    const ok =
      entry.seq === index + 1 &&
      entry.prev === prev &&
      entry.from === name &&
      entry.role === 'agent' &&
      typeof entry.to === 'string' &&
      typeof entry.time === 'string' &&
      typeof entry.messageId === 'string' &&
      parts.length === 1 &&
      part?.kind === 'text' &&
      typeof part.text === 'string';
    if (!ok) {
      outbox.problems.push(`${name}'s outbox was changed by hand at line ${index + 1}: that line and the ones after it are not shown`);
      break;
    }
    outbox.lines.push(line);
    outbox.messages.push({ messageId: entry.messageId as string, from: name, to: entry.to as string, time: entry.time as string, text: part.text as string, index });
    prev = hashLine(line);
  }
  return outbox;
}

/** The names of the team's outboxes. */
export function outboxNames(team: string): string[] {
  try {
    return readdirSync(join(team, 'outbox'))
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => file.slice(0, -'.jsonl'.length))
      .filter((name) => NAME.test(name))
      .sort();
  } catch {
    return [];
  }
}

export function loadReadState(path: string): ReadState {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

export function saveReadState(path: string, state: ReadState): void {
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

/** A problem when the outbox no longer holds what the reader read before. */
export function changedSinceRead(outbox: Outbox, seen: ReadState[string] | undefined): string | null {
  if (!seen || seen.lines === 0) return null;
  const line = outbox.lines[seen.lines - 1];
  if (line === undefined || hashLine(line) !== seen.last) return `${outbox.name}'s outbox was changed after you read it: messages were changed or taken out`;
  return null;
}

/** What `unread` gives: the messages for me, the problems, and the read state to save once they are shown. */
export interface Unread {
  messages: Message[];
  problems: string[];
  /** Messages for me past the ones given, left for next time. */
  waiting: number;
  state: ReadState;
  changed: boolean;
}

/**
 * The messages for `me` that it has not read, oldest first, at most `max`. A sender whose
 * outbox has not grown since the last read is not opened: a hook runs on every tool call.
 */
export function unread(me: Me, max: number): Unread {
  const state = loadReadState(me.readState);
  const next: ReadState = { ...state };
  const problems: string[] = [];
  const found: Message[] = [];
  const boxes = new Map<string, Outbox>();
  for (const name of outboxNames(me.team)) {
    if (name === me.name) continue;
    let size: number;
    try {
      size = statSync(outboxOf(me.team, name)).size;
    } catch {
      continue;
    }
    if (state[name]?.size === size) continue;
    const outbox = readOutbox(me.team, name);
    boxes.set(name, outbox);
    problems.push(...outbox.problems);
    const changed = changedSinceRead(outbox, state[name]);
    if (changed) problems.push(changed);
    const from = changed ? 0 : (state[name]?.lines ?? 0);
    found.push(...outbox.messages.filter((message) => message.index >= from && message.to === me.name));
  }
  found.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const given = found.slice(0, max);
  const left = found.slice(max);
  for (const [name, outbox] of boxes) {
    const first = left.find((message) => message.from === name);
    const lines = first ? first.index : outbox.lines.length;
    next[name] = { lines, last: lines ? hashLine(outbox.lines[lines - 1]) : '', size: first ? -1 : outbox.size };
  }
  return { messages: given, problems, waiting: left.length, state: next, changed: boxes.size > 0 };
}

/** Why a message can't be sent, by the caps and the names; null when it may. `text` is already checked for privacy. */
export function sendProblem(me: Me, to: string, text: string, now: Date): string | null {
  if (!text.trim()) return 'the message is empty. Fix: give the text after the name, or on stdin';
  if (text.length > MAX_MESSAGE_CHARS) return `the message is ${text.length} characters, over the cap of ${MAX_MESSAGE_CHARS}. Fix: say it shorter, or point at a file in your desk`;
  if (to === me.name) return 'that is your own name. Fix: name another agent; `yokoten msg who` lists them';
  if (to !== LEAD && !readRoster(me.team).has(to)) return `the team has no agent named "${to}". Fix: \`yokoten msg who\` lists the names`;
  const own = readOutbox(me.team, me.name);
  if (own.problems.length) return `${own.problems[0]}. Fix: ask the lead to look at the outbox`;
  const since = now.getTime() - RATE_WINDOW_MS;
  const recent = own.messages.filter((message) => Date.parse(message.time) > since).length;
  if (recent >= MAX_PER_WINDOW) return `you sent ${recent} messages in the last ${RATE_WINDOW_MS / 60000} minutes, the cap. Fix: wait, or put more in one message`;
  if (own.size + text.length * 3 + 512 > MAX_OUTBOX_BYTES) return `your outbox is full (cap ${MAX_OUTBOX_BYTES} bytes). Fix: report to the lead; the lead starts a new desk`;
  return null;
}

/** Append one message to `me`'s outbox. The caller checked it with `sendProblem` and the privacy scan. */
export function appendMessage(me: Me, to: string, text: string, now: Date): Message {
  const own = readOutbox(me.team, me.name);
  const seq = own.lines.length + 1;
  const messageId = `${me.name}-${seq}`;
  const time = now.toISOString();
  const line = JSON.stringify({ messageId, role: 'agent', parts: [{ kind: 'text', text }], from: me.name, to, time, seq, prev: own.lines.length ? hashLine(own.lines.at(-1) as string) : '' });
  appendFileSync(outboxOf(me.team, me.name), `${line}\n`);
  return { messageId, from: me.name, to, time, text, index: seq - 1 };
}

/** Save `state` where `me` keeps it: its desk state folder, or the lead's folder in the team. */
export function keepReadState(me: Me, state: ReadState): void {
  try {
    saveReadState(me.readState, state);
  } catch (error) {
    throw new Error(`can't save what ${me.name} has read (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}
