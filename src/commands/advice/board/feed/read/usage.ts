// What the board's usage view reads (#611): token counts from the session logs the agents
// already write, priced with the table in prices.ts. Nothing is sent anywhere and no
// message text is kept: a turn becomes four numbers, a model name and a day.
//
// Claude Code writes one JSON line per turn, with `message.usage`. Muse Code writes frames
// whose records carry a `usage` object. A log without an amount, or a model without a
// price, is "partial": the view says so rather than guessing.

import { statSync } from 'node:fs';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { type Env } from '../../../../../rules/config.ts';
import { roleGroup } from '../../page/groups.ts';
import { findAgentLogs, type LogCache } from './logs.ts';
import { costOf, modelPrice, PRICES_CHECKED, priceSources } from './prices.ts';

/** How far back a usage read looks, in days. A log older than this is left alone. */
export const USAGE_DAYS = 7;
/** The most of a log's end that one read opens. A turn is a short line, so this is many turns. */
const SCAN_BYTES = 2 * 1024 * 1024;
/** The most turns kept from one log. A log longer than this is out of the view's scope. */
const TURN_LIMIT = 20000;
/** How many logs' turns are kept between reads. The board reads /data every 15 seconds. */
const TURN_CACHE_LIMIT = 200;

/** One priced moment of an agent's log: what it used, and on which model. No words. */
export interface UsageTurn {
  /** When the vendor wrote it, as ISO, or '' when the log has no time. */
  at: string;
  /** The model the log names, or '' when it names none. */
  model: string;
  input: number;
  cached: number;
  output: number;
}

/** One agent's log to read. The board fills this from a worktree's status file. */
export interface UsageSource {
  /** The agent's shown name, already masked. */
  agent: string;
  tree: string;
  /** The vendor as the status file names it. */
  vendor: string;
  /** The vendor's shown name, such as Claude, or '' to show the filed name. */
  vendorName?: string;
  /** The model the status file names, used when a log names none. */
  model: string;
  role: string;
  /** The plain text log the status file names, or ''. */
  log: string;
}

/** One agent, model and day: the tokens used, and what they would cost on the API. */
export interface UsageCell {
  agent: string;
  /** The vendor's shown name, such as Claude. */
  vendor: string;
  model: string;
  role: string;
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  input: number;
  cached: number;
  output: number;
  /** USD at list prices, or null when the table has no price for the model. */
  usd: number | null;
  /** True when a price is missing, so this row and any total holding it are partial. */
  isPartial: boolean;
  /** True for a model that runs on this machine: no API bill. */
  isLocal: boolean;
}

/** What the usage view shows, from the local logs. */
export interface BoardUsage {
  cells: UsageCell[];
  /** The days the cells cover, newest first. */
  days: string[];
  /** What is partial, in plain words: a model with no price, or a log with no amounts. */
  partial: string[];
  /** The day the price table was checked. */
  checked: string;
  /** Each vendor's price page. */
  sources: { vendor: string; url: string }[];
  /** The role and vendor a filter kept, in plain words, or '' when it kept everything. */
  filter?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberAt = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** The last `bytes` of a file as text, with the first cut line dropped. */
function readTail(file: string, bytes = SCAN_BYTES): string {
  let opened: number | null = null;
  try {
    opened = openSync(file, 'r');
    const size = fstatSync(opened).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(opened, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    if (start === 0) return text;
    const first = text.indexOf('\n');
    return first === -1 ? '' : text.slice(first + 1);
  } catch {
    return '';
  } finally {
    if (opened !== null) closeSync(opened);
  }
}

/** Object lines of a JSON-lines file. A broken line is skipped, as a log's last line may be half-written. */
function jsonLines(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('{')) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A half-written line at the end of a live log: it comes back on the next read.
    }
  }
  return records;
}

/** Claude Code's cache-creation amount: the count, else the parts of its `cache_creation` object. */
function claudeCacheWrite(usage: Record<string, unknown>): number {
  const count = numberAt(usage.cache_creation_input_tokens);
  if (count) return count;
  const parts = isObject(usage.cache_creation) ? usage.cache_creation : null;
  if (!parts) return 0;
  return Object.entries(parts).reduce((sum, [, value]) => sum + numberAt(value), 0);
}

/**
 * The turns in a Claude Code session log: one per assistant message that reports its
 * usage. A message repeated under the same id is counted once.
 */
export function claudeUsage(text: string): UsageTurn[] {
  const turns: UsageTurn[] = [];
  const seen = new Set<string>();
  for (const record of jsonLines(text)) {
    if (!isObject(record) || record.type !== 'assistant' || !isObject(record.message)) continue;
    const message = record.message;
    const usage = isObject(message.usage) ? message.usage : null;
    if (!usage) continue;
    const id = textOf(message.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const model = textOf(message.model);
    turns.push({
      at: textOf(record.timestamp),
      model: model.startsWith('<') ? '' : model,
      input: numberAt(usage.input_tokens),
      cached: numberAt(usage.cache_read_input_tokens) + claudeCacheWrite(usage),
      output: numberAt(usage.output_tokens),
    });
    if (turns.length >= TURN_LIMIT) break;
  }
  return turns;
}

/** Muse Code's records from one line: the line itself, or the records a frame carries. */
function museRecords(line: unknown): Record<string, unknown>[] {
  if (!isObject(line)) return [];
  if (!Array.isArray(line.children)) return [line];
  const records: Record<string, unknown>[] = [];
  for (const child of line.children) {
    if (!isObject(child)) continue;
    try {
      const parsed: unknown = JSON.parse(textOf(child.record_json));
      if (isObject(parsed)) records.push(parsed);
    } catch {
      // A frame without a whole record: skip it.
    }
  }
  return records;
}

/** The objects of a Muse record that may hold a usage or a model, innermost first. */
function musePlaces(record: Record<string, unknown>): Record<string, unknown>[] {
  const payload = isObject(record.payload) ? record.payload : {};
  const event = isObject(payload.event) ? payload.event : payload;
  return [event, payload, isObject(payload.record) ? payload.record : {}, record];
}

/** The first place in a Muse record that has a usage object. */
function museUsageAt(record: Record<string, unknown>): Record<string, unknown> | null {
  for (const place of musePlaces(record)) if (isObject(place.usage)) return place.usage;
  return null;
}

/** A total from the aliases vendors use, or 0 when none is a number. */
function amountOf(usage: Record<string, unknown>, names: readonly string[]): number {
  for (const name of names) {
    const value = numberAt(usage[name]);
    if (value) return value;
  }
  return 0;
}

/** A Muse time, kept in microseconds, as ISO. */
function museTime(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(Math.floor(value / 1000)).toISOString() : '';
}

/**
 * The turns in a Muse Code session log: one per record that reports its usage. The model
 * may sit on the first record only, so a record without one uses the session's.
 */
export function museUsage(text: string): UsageTurn[] {
  const records = jsonLines(text).flatMap(museRecords);
  let sessionModel = '';
  for (const record of records) {
    for (const place of musePlaces(record)) {
      const model = textOf(place.model) || textOf(place.model_name);
      if (model) {
        sessionModel = model;
        break;
      }
    }
    if (sessionModel) break;
  }
  const turns: UsageTurn[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const usage = museUsageAt(record);
    if (!usage) continue;
    const input = amountOf(usage, ['input_tokens', 'prompt_tokens']);
    const output = amountOf(usage, ['output_tokens', 'completion_tokens']);
    const cached = amountOf(usage, ['cache_read_input_tokens', 'cache_read_tokens', 'cached_input_tokens', 'cached_tokens']);
    const at = museTime(record.recorded_at);
    const model = musePlaces(record).map((place) => textOf(place.model) || textOf(place.model_name)).find(Boolean) ?? sessionModel;
    const key = `${at}|${model}|${input}|${cached}|${output}`;
    if (seen.has(key)) continue;
    seen.add(key);
    turns.push({ at, model, input, cached, output });
    if (turns.length >= TURN_LIMIT) break;
  }
  return turns;
}

/** Turns kept between reads, by file and its size and time. A live log changes, so its key does. */
const TURN_CACHE = new Map<string, UsageTurn[]>();

/** The turns in one log, parsed once until the file changes. */
export function turnsOf(file: string, source: 'claude' | 'muse'): UsageTurn[] {
  let stamp = '';
  try {
    const stat = statSync(file);
    stamp = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return [];
  }
  const key = `${file}|${stamp}`;
  const kept = TURN_CACHE.get(key);
  if (kept) return kept;
  const turns = source === 'claude' ? claudeUsage(readTail(file)) : museUsage(readTail(file));
  if (TURN_CACHE.size >= TURN_CACHE_LIMIT) TURN_CACHE.clear();
  TURN_CACHE.set(key, turns);
  return turns;
}

/** The UTC day of a time, or '' when it is not a time. */
export function dayOf(at: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(at)?.[0] ?? '';
  return day && !Number.isNaN(Date.parse(at)) ? day : '';
}

/** The board's usage from the logs of `sources`: one cell per agent, model and day. */
export function collectUsage(sources: readonly UsageSource[], env: Env, now: number = Date.now(), mask: (text: string) => string = (text) => text): BoardUsage {
  const logs: LogCache = new Map();
  const cells = new Map<string, UsageCell>();
  const partial = new Set<string>();
  const oldest = now - USAGE_DAYS * 24 * 60 * 60 * 1000;
  for (const source of sources) {
    const agent = mask(source.agent);
    const filed = mask(source.model);
    const vendorName = mask(source.vendorName || source.vendor);
    const treeLogs = findAgentLogs(source.tree, source.vendor, env, logs, source.log, now).filter((log) => log.mtime >= oldest);
    let counted = 0;
    for (const log of treeLogs) {
      if (log.source !== 'claude' && log.source !== 'muse') continue;
      const fallbackDay = dayOf(new Date(log.mtime).toISOString());
      for (const turn of turnsOf(log.file, log.source)) {
        if (!turn.input && !turn.cached && !turn.output) continue;
        counted += 1;
        const model = mask(turn.model || filed || 'unknown model');
        const day = dayOf(turn.at) || fallbackDay;
        const key = `${agent}|${source.vendor}|${model}|${day}`;
        const cell = cells.get(key) ?? {
          agent,
          vendor: vendorName,
          model,
          role: source.role,
          day,
          input: 0,
          cached: 0,
          output: 0,
          usd: 0,
          isPartial: false,
          isLocal: modelPrice(model)?.isLocal === true,
        };
        cell.input += turn.input;
        cell.cached += turn.cached;
        cell.output += turn.output;
        const usd = costOf(model, turn.input, turn.cached, turn.output);
        if (usd === null) {
          cell.usd = null;
          cell.isPartial = true;
          partial.add(`${model}: no price in the table`);
        } else if (cell.usd !== null) {
          cell.usd += usd;
        }
        cells.set(key, cell);
      }
    }
    if (!counted && treeLogs.length) partial.add(`${agent}: its log has no token counts`);
  }
  const rows = [...cells.values()].sort((a, b) => (a.day === b.day ? a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model) : a.day < b.day ? 1 : -1));
  return {
    cells: rows,
    days: [...new Set(rows.map((cell) => cell.day))].sort().reverse(),
    partial: [...partial].sort(),
    checked: PRICES_CHECKED,
    sources: priceSources(),
  };
}

/** What a filter keeps: a role word (engineer, reviewer, checker) and a vendor word. */
export interface UsageFilter {
  role: string;
  vendor: string;
}

/** The role groups a filter word names, or '' for all roles. An unknown word keeps nothing. */
function roleGroupOf(word: string): string {
  const name = word.trim().toLowerCase();
  if (name === 'checker' || name === 'checkers') return 'group.verifier';
  if (!name) return '';
  return roleGroup(name);
}

/** A role or vendor the filter word names, in plain words, or '' when it names none. */
export function isKnownRole(word: string): boolean {
  return ['', 'engineer', 'reviewer', 'checker', 'verifier', 'manager', 'helper'].includes(word.trim().toLowerCase());
}

/** The usage rows a filter keeps. An empty word keeps every row of that kind. */
export function filterUsage(usage: BoardUsage, filter: UsageFilter): BoardUsage {
  const group = roleGroupOf(filter.role);
  const vendor = filter.vendor.trim().toLowerCase();
  const cells = usage.cells.filter((cell) => (!group || roleGroup(cell.role) === group) && (!vendor || cell.vendor.toLowerCase().includes(vendor)));
  const agents = new Set(cells.map((cell) => cell.agent));
  return {
    ...usage,
    cells,
    days: [...new Set(cells.map((cell) => cell.day))].sort().reverse(),
    partial: usage.partial.filter((note) => [...agents].some((agent) => note.startsWith(`${agent}:`))),
    filter: [filter.role.trim(), filter.vendor.trim()].filter(Boolean).join(', '),
  };
}

/** Tokens in a cell, and what they would cost, added up. */
export interface UsageTotal {
  input: number;
  cached: number;
  output: number;
  /** USD, or null when any cell has no price: the total is then partial, not a guess. */
  usd: number | null;
  isPartial: boolean;
}

/** The sum of some cells. */
export function totalOf(cells: readonly UsageCell[]): UsageTotal {
  let usd = 0;
  let isPartial = false;
  for (const cell of cells) {
    if (cell.usd === null) isPartial = true;
    else usd += cell.usd;
  }
  return {
    input: cells.reduce((sum, cell) => sum + cell.input, 0),
    cached: cells.reduce((sum, cell) => sum + cell.cached, 0),
    output: cells.reduce((sum, cell) => sum + cell.output, 0),
    usd: isPartial ? null : usd,
    isPartial,
  };
}

/** A token count in plain words: 12450 is "12,450". */
export function tokenText(count: number): string {
  return count.toLocaleString('en-US');
}

/** A dollar amount, or '' when it is unknown. A tiny amount says so instead of "$0.00". */
export function usdText(usd: number): string {
  if (usd <= 0) return '$0.00';
  return usd < 0.01 ? 'less than $0.01' : `$${usd.toFixed(2)}`;
}

/** What a total's price is, in plain words: "about $1.20 if paid by API", or that it is partial. */
export function costWords(total: UsageTotal, isLocal: boolean): string {
  if (total.usd === null) return 'partial: a model here has no price or no amounts in its log';
  if (isLocal && total.usd === 0) return 'no API bill: a local model';
  return `about ${usdText(total.usd)} if paid by API`;
}
