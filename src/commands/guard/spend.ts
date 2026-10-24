// `yokoten spend` (#640, record 0033): the owner's spending limit for agents that pay on
// their own, and the log of what they paid. `check` says pay or ask; `pay` checks, runs the
// command only inside the limit, and records the result. `limit` and `off` change the limit,
// which lives outside every repo. A worker cannot change it, and a raise asks first.

import { spawnSync } from 'node:child_process';
import { checkCommand, workerRole } from '../../rules/guard/guards.ts';
import {
  appendPayment,
  decideSpending,
  formatUsd,
  isToday,
  type SpendingDecision,
  type SpendingLimit,
  type SpendingPayment,
  LIMIT_PLACE,
  parseUsd,
  plainService,
  readLimit,
  readPayments,
  removeLimit,
  spentToday,
  writeLimit,
} from '../../rules/guard/spending.ts';
import { type Invocation, type Parsed, parse, print, printJson, usage } from '../shared.ts';

/** The words that name an action. The first word of `yokoten spend` is one, or `status`. */
const ACTIONS = ['status', 'check', 'pay', 'limit', 'off'];
/** The options each action takes. The parser knows them all, so this keeps one action's flags out of another. */
const OPTIONS: Record<string, string[]> = {
  status: ['--json'],
  check: ['--amount', '--service', '--json'],
  pay: ['--amount', '--service'],
  limit: ['--day', '--payment', '--service', '--yes'],
  off: [],
};
/** A service rule: a host name, or `*.` and a host name. No scheme, no path, no port. */
const SERVICE_RULE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
/** How long a paid command's output may be, before it is kept in memory. */
const MAX_OUTPUT = 1 << 26;

/** `$2.00`, for a message. */
const usd = (micros: number): string => `$${formatUsd(micros)}`;

/** The reason to stop, said once, and the exit code 1. A payment is either pay or ask. */
function ask(invocation: Invocation, decision: SpendingDecision, json: boolean): number {
  const line = `yokoten spend: ${decision.action === 'pay' ? 'pay' : 'stop and ask the owner'}: ${decision.reason}. ${usd(decision.spentToday)} is paid today, ${usd(decision.remainingToday)} is left.`;
  if (json) printJson(invocation, { action: decision.action, reason: decision.reason, spentToday: decision.spentToday, remainingToday: decision.remainingToday });
  print(invocation, [line], json || decision.action !== 'pay' ? invocation.stderr : invocation.stdout);
  return decision.action === 'pay' ? 0 : 1;
}

/** `--amount` and `--service`, or why they are missing or wrong. */
function requestOf(options: Parsed): { amountUsd: number; service: string } | string {
  const amount = options.values['--amount'];
  const name = options.values['--service'];
  if (amount === undefined) return '--amount is missing';
  if (name === undefined) return '--service is missing';
  const amountUsd = parseUsd(amount);
  if (amountUsd === null || amountUsd === 0) return `--amount ${amount} is not an amount over 0, such as 0.10`;
  const service = plainService(name.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  if (!SERVICE_RULE.test(service)) return '--service must be a host name, such as api.example.com';
  return { amountUsd, service };
}

/** The services from `--service`, separated by commas; or why one does not look like a host. */
function servicesOf(value: string | undefined): string[] | string {
  if (value === undefined) return '--service is missing';
  const services = value.split(',').map(plainService).filter(Boolean);
  if (!services.length) return '--service is missing';
  const bad = services.find((service) => !SERVICE_RULE.test(service));
  return bad ? `--service ${bad} is not a host name, such as api.example.com` : services;
}

/** The limit a `limit` request would set, or why it cannot be read. */
function limitOf(options: Parsed): SpendingLimit | string {
  const day = options.values['--day'];
  const payment = options.values['--payment'];
  if (day === undefined) return '--day is missing';
  if (payment === undefined) return '--payment is missing';
  const dayUsd = parseUsd(day);
  const paymentUsd = parseUsd(payment);
  if (dayUsd === null) return `--day ${day} is not an amount, such as 2.00`;
  if (paymentUsd === null) return `--payment ${payment} is not an amount, such as 0.10`;
  const services = servicesOf(options.values['--service']);
  if (typeof services === 'string') return services;
  return { dayUsd, paymentUsd, services, setAt: new Date().toISOString() };
}

/** True when `next` allows something `current` did not: a higher cap, or a new service. */
function isRaise(current: SpendingLimit | null, next: SpendingLimit): boolean {
  if (!current) return true;
  return next.dayUsd > current.dayUsd || next.paymentUsd > current.paymentUsd || next.services.some((service) => !current.services.includes(service));
}

/** Why a worker may not change the limit, or what its change would do. */
function workerRefusal(invocation: Invocation, action: string): number | null {
  if (!workerRole(invocation.env, [invocation.cwd])) return null;
  print(invocation, [`yokoten spend: a worker cannot ${action} the spending limit. Ask the owner to run it from the lead's clone.`], invocation.stderr);
  return 1;
}

/** A limit as words: the two caps and the services. */
function limitWords(limit: SpendingLimit): string {
  return `${usd(limit.dayUsd)} a day, ${usd(limit.paymentUsd)} a payment, ${limit.services.length} service${limit.services.length === 1 ? '' : 's'} (${limit.services.join(', ')})`;
}

/** `yokoten spend status`: the limit, what is paid today, and today's payments. */
function runSpendStatus(invocation: Invocation, options: Parsed): number {
  const json = options.flags.has('--json');
  const found = readLimit(invocation.env);
  const { payments, problem } = readPayments(invocation.env);
  const now = new Date();
  const spent = spentToday(payments, now);
  const today = payments.filter((payment) => isToday(payment, now));
  const isProblem = Boolean(found.problem || problem);
  const lines = found.limit ? [`yokoten spend: ${limitWords(found.limit)}${found.limit.setAt ? `, set ${found.limit.setAt}` : ''}.`, `Today: ${usd(spent)} paid, ${usd(Math.max(0, found.limit.dayUsd - spent))} left.`] : ['yokoten spend: no spending limit is set, so an agent pays nothing. The owner sets one with `yokoten spend limit`.', `Today: ${usd(spent)} paid.`];
  if (today.length) lines.push('', 'Payments today:', ...today.map((payment) => `- ${payment.at.slice(11, 16)} UTC, ${usd(payment.amountUsd)} to ${payment.service}, ${payment.isPaid ? 'paid' : 'failed'}`));
  else lines.push('', 'Payments today: none.');
  if (found.problem) lines.push('', `Problem: ${found.problem}. Nothing is paid until it is fixed.`);
  if (problem) lines.push('', `Problem: ${problem}.`);
  if (json) {
    printJson(invocation, { isSet: found.limit !== null, isBad: isProblem, problem: [found.problem, problem].filter(Boolean).join('; '), limit: found.limit ? { day: formatUsd(found.limit.dayUsd), payment: formatUsd(found.limit.paymentUsd), services: found.limit.services, setAt: found.limit.setAt } : null, spentToday: spent, remainingToday: found.limit ? Math.max(0, found.limit.dayUsd - spent) : 0, payments: today });
    return isProblem ? 1 : 0;
  }
  print(invocation, lines, isProblem ? invocation.stderr : invocation.stdout);
  return isProblem ? 1 : 0;
}

/** `yokoten spend check`: pay, or stop and ask the owner. Nothing runs and nothing is written. */
function runSpendCheck(invocation: Invocation, options: Parsed): number {
  const json = options.flags.has('--json');
  const request = requestOf(options);
  if (typeof request === 'string') return usage(invocation, request);
  const found = readLimit(invocation.env);
  if (found.problem) {
    const decision: SpendingDecision = { action: 'ask', reason: `the spending limit cannot be read: ${found.problem}`, spentToday: 0, remainingToday: 0 };
    if (json) printJson(invocation, decision);
    print(invocation, [`yokoten spend: stop and ask the owner: ${decision.reason}. Nothing is paid.`], invocation.stderr);
    return 1;
  }
  if (!found.limit) {
    const decision: SpendingDecision = { action: 'ask', reason: `no spending limit is set in ${LIMIT_PLACE}`, spentToday: 0, remainingToday: 0 };
    if (json) printJson(invocation, decision);
    print(invocation, [`yokoten spend: stop and ask the owner: ${decision.reason}. Nothing is paid.`], invocation.stderr);
    return 1;
  }
  const { payments } = readPayments(invocation.env);
  return ask(invocation, decideSpending(found.limit, payments, request), json);
}

/** `yokoten spend pay --amount <usd> --service <host> -- <command>`: check, run, record. */
function runSpendPay(invocation: Invocation, options: Parsed, tail: string[]): number {
  const request = requestOf(options);
  if (typeof request === 'string') return usage(invocation, request);
  if (!tail.length) return usage(invocation, 'the command to pay for is missing; put it after --');
  const found = readLimit(invocation.env);
  if (found.problem) {
    print(invocation, [`yokoten spend: stop and ask the owner: the spending limit cannot be read: ${found.problem}. Nothing ran.`], invocation.stderr);
    return 1;
  }
  if (!found.limit) {
    print(invocation, [`yokoten spend: stop and ask the owner: no spending limit is set in ${LIMIT_PLACE}. Nothing ran.`], invocation.stderr);
    return 1;
  }
  const { payments } = readPayments(invocation.env);
  const decision = decideSpending(found.limit, payments, request);
  if (decision.action !== 'pay') {
    print(invocation, [`yokoten spend: stop and ask the owner: ${decision.reason}. ${usd(decision.spentToday)} is paid today, ${usd(decision.remainingToday)} is left. Nothing ran.`], invocation.stderr);
    return 1;
  }
  // The command after `--` is judged by the same guard as any other tool call: `pay` must
  // not become a tunnel around the rules for a worker.
  const refused = checkCommand(tail.join(' '), { env: invocation.env, cwd: invocation.cwd });
  if (refused) {
    print(invocation, [`yokoten spend: the guard refuses the command after --: ${refused.what}. ${refused.fix}`], invocation.stderr);
    return 1;
  }
  const [program, ...args] = tail;
  const result = spawnSync(program, args, { cwd: invocation.cwd, env: invocation.env, encoding: 'utf8', maxBuffer: MAX_OUTPUT });
  if (result.stdout) invocation.stdout.write(result.stdout);
  if (result.stderr) invocation.stderr.write(result.stderr);
  const status = result.error ? 127 : (result.status ?? 1);
  const payment: SpendingPayment = { at: new Date().toISOString(), amountUsd: request.amountUsd, service: request.service, isPaid: status === 0 };
  const recorded = appendPayment(invocation.env, payment);
  const outcome = status === 0 ? 'paid' : 'failed';
  const line = `yokoten spend: ${usd(request.amountUsd)} to ${request.service} ${outcome}; ${usd(spentToday(payments, new Date()) + (status === 0 ? request.amountUsd : 0))} is paid today.`;
  print(invocation, [recorded ? `${line} The payment could not be recorded: ${recorded}.` : line], invocation.stderr);
  return status;
}

/** `yokoten spend limit`: set or raise with --yes; lowering and off are safe by default. */
function runSpendLimit(invocation: Invocation, options: Parsed): number {
  const refusal = workerRefusal(invocation, 'change');
  if (refusal !== null) return refusal;
  const next = limitOf(options);
  if (typeof next === 'string') return usage(invocation, next);
  const current = readLimit(invocation.env);
  if (current.problem) return usage(invocation, `the current limit cannot be read: ${current.problem}. Fix ${LIMIT_PLACE}, or set a new limit with --yes`);
  if (isRaise(current.limit, next) && !options.flags.has('--yes')) {
    print(invocation, [`yokoten spend: this would allow more: ${limitWords(next)}. Nothing was written. Run it again with --yes to allow it.`], invocation.stderr);
    return 1;
  }
  const problem = writeLimit(invocation.env, next);
  if (problem) {
    print(invocation, [`yokoten spend: ${problem}. Nothing was written.`], invocation.stderr);
    return 1;
  }
  print(invocation, [`yokoten spend: limit set: ${limitWords(next)}.`]);
  return 0;
}

/** `yokoten spend off`: remove the limit. With no limit, an agent pays nothing. */
function runSpendOff(invocation: Invocation): number {
  const refusal = workerRefusal(invocation, 'remove');
  if (refusal !== null) return refusal;
  const problem = removeLimit(invocation.env);
  if (problem) {
    print(invocation, [`yokoten spend: ${problem}. Nothing was changed.`], invocation.stderr);
    return 1;
  }
  print(invocation, ['yokoten spend: the limit is off. An agent pays nothing until the owner sets one with `yokoten spend limit`.', 'The payments log is kept.']);
  return 0;
}

export function runSpend(invocation: Invocation): number {
  const first = invocation.args[0];
  const action = first !== undefined && ACTIONS.includes(first) ? first : 'status';
  const rest = first !== undefined && ACTIONS.includes(first) ? invocation.args.slice(1) : invocation.args;
  // `pay` takes the command to run after `--`; every word there belongs to that command.
  let words = rest;
  let tail: string[] = [];
  if (action === 'pay') {
    const at = rest.indexOf('--');
    if (at !== -1) {
      words = rest.slice(0, at);
      tail = rest.slice(at + 1);
    }
  }
  const options = parse('spend', words);
  if (typeof options === 'string') return usage(invocation, options);
  if (options.positional.length) return usage(invocation, `unexpected argument ${options.positional[0]}`);
  const allowed = new Set(OPTIONS[action]);
  const unexpected = [...options.flags, ...Object.keys(options.values)].find((name) => !allowed.has(name));
  if (unexpected) return usage(invocation, `${unexpected} does not go with ${action}`);
  if (action === 'status') return runSpendStatus(invocation, options);
  if (action === 'check') return runSpendCheck(invocation, options);
  if (action === 'pay') return runSpendPay(invocation, options, tail);
  if (action === 'limit') return runSpendLimit(invocation, options);
  return runSpendOff(invocation);
}
