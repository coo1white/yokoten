// Tests for src/rules/spending.ts: amounts, the day, services, and the files outside the repo.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import {
  appendPayment,
  decideSpending,
  formatUsd,
  isServiceAllowed,
  parseUsd,
  readLimit,
  readPayments,
  removeLimit,
  spentToday,
  type SpendingLimit,
  type SpendingPayment,
  writeLimit,
} from '../../../src/rules/guard/spending.ts';

const home = (): string => makeTempDir('spending-');

const limitOf = (fields: Partial<SpendingLimit> = {}): SpendingLimit => ({ dayUsd: 2_000_000, paymentUsd: 100_000, services: ['api.example.com'], setAt: '2026-10-23T00:00:00.000Z', ...fields });

const paymentOf = (fields: Partial<SpendingPayment> = {}): SpendingPayment => ({ at: '2026-10-23T10:00:00.000Z', amountUsd: 50_000, service: 'api.example.com', isPaid: true, ...fields });

test('amounts: a dollar amount is whole micro-dollars, and a bad one is refused', () => {
  assert.equal(parseUsd('2'), 2_000_000);
  assert.equal(parseUsd('$0.10'), 100_000);
  assert.equal(parseUsd('0.000001'), 1);
  assert.equal(parseUsd('0'), 0);
  for (const bad of ['', 'one', '-1', '1e3', '0.0000001', '1,00', '1.2.3', ' 1 2 ']) assert.equal(parseUsd(bad), null, bad);
  for (const micros of [1, 100_000, 2_000_000, 2_500_000]) assert.equal(parseUsd(formatUsd(micros)), micros, formatUsd(micros));
  assert.equal(formatUsd(100_000), '0.10');
  assert.equal(formatUsd(1_000), '0.001');
});

test('services: exact host, no case, and a wildcard covers a subdomain only', () => {
  assert.equal(isServiceAllowed('API.Example.com', ['api.example.com']), true);
  assert.equal(isServiceAllowed('api.example.com.', ['api.example.com']), true);
  assert.equal(isServiceAllowed('cdn.example.com', ['*.example.com']), true);
  assert.equal(isServiceAllowed('example.com', ['*.example.com']), false);
  assert.equal(isServiceAllowed('evil-example.com', ['*.example.com']), false);
  assert.equal(isServiceAllowed('', ['*.example.com']), false);
});

test('decide: inside pays; each cap and the service list stop it; a failed payment costs nothing', () => {
  const now = new Date('2026-10-23T12:00:00.000Z');
  const paid = [paymentOf({ amountUsd: 100_000 })];
  assert.equal(decideSpending(limitOf(), paid, { amountUsd: 100_000, service: 'api.example.com' }, now).action, 'pay', 'exactly on the day cap is inside');
  assert.equal(decideSpending(limitOf(), paid, { amountUsd: 100_001, service: 'api.example.com' }, now).action, 'ask', 'a cent over the day cap');
  const nearlyFull = [paymentOf({ amountUsd: 1_990_000 })];
  assert.equal(decideSpending(limitOf({ paymentUsd: 10_000_000 }), nearlyFull, { amountUsd: 10_001, service: 'api.example.com' }, now).action, 'ask', 'a cent over the day cap');
  assert.match(decideSpending(limitOf({ paymentUsd: 10_000_000 }), nearlyFull, { amountUsd: 10_001, service: 'api.example.com' }, now).reason, /would pass the \$2\.00 a day limit/);
  assert.equal(decideSpending(limitOf({ dayUsd: 10_000_000 }), [], { amountUsd: 100_001, service: 'api.example.com' }, now).action, 'ask', 'over the payment cap');
  assert.equal(decideSpending(limitOf(), [], { amountUsd: 10_000, service: 'other.example.com' }, now).action, 'ask', 'an unknown service');
  assert.equal(decideSpending(limitOf(), [paymentOf({ isPaid: false, amountUsd: 100_000 })], { amountUsd: 100_000, service: 'api.example.com' }, now).action, 'pay', 'a failed attempt costs nothing');
});

test('the day: a payment after UTC midnight counts that day, and the one before does not', () => {
  const before = paymentOf({ at: '2026-10-22T23:59:59.999Z', amountUsd: 200_000 });
  const after = paymentOf({ at: '2026-10-23T00:00:00.000Z', amountUsd: 300_000 });
  assert.equal(spentToday([before, after], new Date('2026-10-23T08:00:00.000Z')), 300_000);
  assert.equal(spentToday([before], new Date('2026-10-22T23:00:00.000Z')), 200_000);
  assert.equal(spentToday([after], new Date('2026-10-24T00:00:00.000Z')), 0);
});

test('the files: a limit and payments live under the home folder, and a broken file says why', () => {
  const env = { HOME: home() };
  assert.deepEqual(readLimit(env), { limit: null, problem: null, path: join(env.HOME, '.config', 'yokoten', 'spending.json') });
  assert.equal(writeLimit(env, limitOf()), null);
  const found = readLimit(env);
  assert.deepEqual(found.limit, limitOf());
  assert.deepEqual(readPayments(env), { payments: [], problem: null });
  assert.equal(appendPayment(env, paymentOf()), null);
  assert.equal(appendPayment(env, paymentOf({ isPaid: false })), null);
  const payments = readPayments(env);
  assert.equal(payments.problem, null);
  assert.deepEqual(payments.payments, [paymentOf(), paymentOf({ isPaid: false })]);
  // The file is text a person can read, and mode 0600.
  const text = readFileSync(join(env.HOME, '.config', 'yokoten', 'spending.json'), 'utf8');
  assert.match(text, /"day": "2\.00"/);
  assert.equal(removeLimit(env), null);
  assert.equal(removeLimit(env), null, 'removing twice is not a problem');
  assert.equal(readLimit(env).limit, null);
  writeFileSync(join(env.HOME, '.config', 'yokoten', 'spending.json'), '{ "day": "two" }\n');
  const broken = readLimit(env);
  assert.equal(broken.limit, null);
  assert.match(broken.problem ?? '', /yokoten does not know: "day" is not an amount/);
});
