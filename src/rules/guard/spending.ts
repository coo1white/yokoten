// A spending limit for agents that pay on their own (#640), after record 0033. The owner
// sets an amount a day, an amount a payment, and the services that may be paid. The limit
// and the payments live in yokoten's config folder, outside every repo, so a worker cannot
// change them with the repo. Amounts are micro-dollars, an integer, so 0.10 + 0.20 is
// exactly 0.30. A missing or broken limit pays nothing: the agent stops and asks.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../config.ts';
import { configFolder } from './guards.ts';

/** The limit's file, in yokoten's config folder. */
export const LIMIT_FILE = 'spending.json';
/** The payments, one JSON object per line, in the order they happened. */
export const PAYMENTS_FILE = 'payments.jsonl';
/** Micro-dollars in one dollar. The most a payment may name. */
export const MICROS = 1_000_000;
/** The limit in words a message can use without reading a home folder. */
export const LIMIT_PLACE = '~/.config/yokoten/spending.json';

/** The owner's limit. Amounts are micro-dollars; `setAt` is when the owner last changed it. */
export interface SpendingLimit {
  dayUsd: number;
  paymentUsd: number;
  services: string[];
  setAt: string;
}

/** One payment, or one attempt that failed. Amounts are micro-dollars. */
export interface SpendingPayment {
  at: string;
  amountUsd: number;
  service: string;
  isPaid: boolean;
}

/** What an agent must do: pay as it is inside the limit, or stop and ask the owner. */
export type SpendAction = 'pay' | 'ask';

/** The answer for one request, with the day's numbers so the message can show them. */
export interface SpendingDecision {
  action: SpendAction;
  reason: string;
  spentToday: number;
  remainingToday: number;
}

/** A payment an agent wants to make. */
export interface SpendingRequest {
  amountUsd: number;
  service: string;
}

/** What a file read found: the limit, why it cannot be trusted, and its path for a message. */
export interface SpendingRead {
  limit: SpendingLimit | null;
  problem: string | null;
  path: string | null;
}

/** An amount of dollars as micro-dollars: `2`, `2.00`, `$0.10`. Null when it is not money. */
export function parseUsd(text: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim().replace(/^\$/, ''));
  if (!match) return null;
  const micros = Number(match[1]) * MICROS + Number((match[2] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? micros : null;
}

/** Micro-dollars as text without a sign: `2.00`, `0.10`, `0.001`. */
export function formatUsd(micros: number): string {
  const whole = Math.floor(micros / MICROS);
  const rest = micros - whole * MICROS;
  const fraction = rest % 10_000 === 0 ? String(rest / 10_000).padStart(2, '0') : String(rest).padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fraction}`;
}

/** The start of the UTC day that holds `now`, in milliseconds. */
export function dayStartUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** A payment whose time falls on the UTC day of `now`. */
export function isToday(payment: SpendingPayment, now: Date): boolean {
  const then = Date.parse(payment.at);
  return !Number.isNaN(then) && then >= dayStartUtc(now) && then < dayStartUtc(now) + 86_400_000;
}

/** What the day has cost so far: paid attempts only, never a failed one. */
export function spentToday(payments: readonly SpendingPayment[], now: Date): number {
  return payments.reduce((total, payment) => (payment.isPaid && isToday(payment, now) ? total + payment.amountUsd : total), 0);
}

/** The host as compared: no case, no trailing dot. */
export function plainService(service: string): string {
  return service.trim().toLowerCase().replace(/\.$/, '');
}

/** True when `service` is on the list: an exact host, or a `*.` rule for its subdomains. */
export function isServiceAllowed(service: string, services: readonly string[]): boolean {
  const host = plainService(service);
  if (!host) return false;
  return services.some((rule) => {
    const allowed = plainService(rule);
    if (allowed.startsWith('*.')) {
      const base = allowed.slice(2);
      return base !== '' && host.endsWith(`.${base}`);
    }
    return host === allowed;
  });
}

/** Micro-dollars as a message shows them: `$0.10`. */
const usd = (micros: number): string => `$${formatUsd(micros)}`;

/**
 * What to do with one request: pay when every cap holds, else stop and ask the owner. The
 * cap is "at most", so a payment that lands exactly on it is inside.
 */
export function decideSpending(limit: SpendingLimit, payments: readonly SpendingPayment[], request: SpendingRequest, now: Date = new Date()): SpendingDecision {
  const spent = spentToday(payments, now);
  const remaining = Math.max(0, limit.dayUsd - spent);
  if (!isServiceAllowed(request.service, limit.services)) {
    return { action: 'ask', reason: `${request.service} is not on the spending limit's list of services`, spentToday: spent, remainingToday: remaining };
  }
  if (request.amountUsd > limit.paymentUsd) {
    return { action: 'ask', reason: `${usd(request.amountUsd)} is over the ${usd(limit.paymentUsd)} a payment limit`, spentToday: spent, remainingToday: remaining };
  }
  if (spent + request.amountUsd > limit.dayUsd) {
    return { action: 'ask', reason: `${usd(request.amountUsd)} would pass the ${usd(limit.dayUsd)} a day limit`, spentToday: spent, remainingToday: remaining };
  }
  return { action: 'pay', reason: `inside the limit: ${usd(request.amountUsd)} to ${plainService(request.service)}`, spentToday: spent, remainingToday: remaining - request.amountUsd };
}

/** Why a limit file cannot be read, in words the owner can act on. Null when it is good. */
function limitProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'it is not an object';
  const fields = value as Record<string, unknown>;
  if (typeof fields.day !== 'string' || parseUsd(fields.day) === null) return '"day" is not an amount, such as "2.00"';
  if (typeof fields.payment !== 'string' || parseUsd(fields.payment) === null) return '"payment" is not an amount, such as "0.10"';
  if (!Array.isArray(fields.services) || !fields.services.length || !fields.services.every((service) => typeof service === 'string' && service.trim() !== '')) return '"services" is not a list of service names';
  return null;
}

/**
 * The owner's limit from yokoten's config folder. No file means none is set: `limit` is
 * null and `problem` is null. A file that cannot be read, or has the wrong shape, gives a
 * problem, and the caller pays nothing.
 */
export function readLimit(env: Env): SpendingRead {
  const folder = configFolder(env);
  if (!folder) return { limit: null, problem: 'there is no home folder, so the spending limit cannot be read', path: null };
  const path = join(folder, LIMIT_FILE);
  if (!existsSync(path)) return { limit: null, problem: null, path };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { limit: null, problem: `${LIMIT_PLACE} is not valid JSON`, path };
  }
  const problem = limitProblem(value);
  if (problem) return { limit: null, problem: `${LIMIT_PLACE} has a shape yokoten does not know: ${problem}`, path };
  const fields = value as { day: string; payment: string; services: string[]; setAt?: unknown };
  return {
    limit: {
      dayUsd: parseUsd(fields.day) ?? 0,
      paymentUsd: parseUsd(fields.payment) ?? 0,
      services: fields.services.map(plainService),
      setAt: typeof fields.setAt === 'string' ? fields.setAt : '',
    },
    problem: null,
    path,
  };
}

/** Write the limit, owner only by convention and by mode. Null when it was written, else why not. */
export function writeLimit(env: Env, limit: SpendingLimit): string | null {
  const folder = configFolder(env);
  if (!folder) return 'there is no home folder, so the spending limit cannot be written';
  const path = join(folder, LIMIT_FILE);
  const temp = `${path}.tmp`;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify({ day: formatUsd(limit.dayUsd), payment: formatUsd(limit.paymentUsd), services: limit.services.map(plainService), setAt: limit.setAt }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return null;
  } catch (error) {
    return `the spending limit could not be written: ${(error as Error).message}`;
  }
}

/** Remove the limit. With no limit, nothing is paid; the payments log stays. */
export function removeLimit(env: Env): string | null {
  const folder = configFolder(env);
  if (!folder) return 'there is no home folder, so there is no limit to remove';
  try {
    unlinkSync(join(folder, LIMIT_FILE));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `the spending limit could not be removed: ${(error as Error).message}`;
  }
}

/** Why one payments line cannot be read, or the payment it holds. */
function paymentOf(line: string): SpendingPayment | 'bad' {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return 'bad';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'bad';
  const fields = value as Record<string, unknown>;
  const amountUsd = typeof fields.amountUsd === 'string' ? parseUsd(fields.amountUsd) : null;
  if (typeof fields.at !== 'string' || Number.isNaN(Date.parse(fields.at)) || amountUsd === null || typeof fields.service !== 'string' || typeof fields.isPaid !== 'boolean') return 'bad';
  return { at: fields.at, amountUsd, service: fields.service, isPaid: fields.isPaid };
}

/** Every payment, in the order they happened, and how many lines could not be read. */
export function readPayments(env: Env): { payments: SpendingPayment[]; problem: string | null } {
  const folder = configFolder(env);
  if (!folder) return { payments: [], problem: 'there is no home folder, so the payments cannot be read' };
  const path = join(folder, PAYMENTS_FILE);
  if (!existsSync(path)) return { payments: [], problem: null };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { payments: [], problem: `the payments could not be read: ${(error as Error).message}` };
  }
  const payments: SpendingPayment[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const payment = paymentOf(line);
    if (payment === 'bad') bad++;
    else payments.push(payment);
  }
  return { payments, problem: bad ? `${bad} payment line(s) could not be read` : null };
}

/** Add one payment, or failed attempt. Null when it was added, else why not. */
export function appendPayment(env: Env, payment: SpendingPayment): string | null {
  const folder = configFolder(env);
  if (!folder) return 'there is no home folder, so the payment cannot be recorded';
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ at: payment.at, amountUsd: formatUsd(payment.amountUsd), service: plainService(payment.service), isPaid: payment.isPaid });
    appendFileSync(join(folder, PAYMENTS_FILE), `${line}\n`, { mode: 0o600 });
    return null;
  } catch (error) {
    return `the payment could not be recorded: ${(error as Error).message}`;
  }
}
