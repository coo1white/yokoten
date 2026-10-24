// Tests for src/commands/spend.ts: the limit, check, pay, off, and the board's payments.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EMPTY_DESK } from '../../../src/commands/advice/board/feed/read/desk.ts';
import { renderBoardText } from '../../../src/commands/advice/board/page/text.ts';
import type { BoardData } from '../../../src/commands/advice/board/view.ts';
import { makeSandbox } from '../../repo/helpers.ts';

const limitPath = (sandbox: ReturnType<typeof makeSandbox>) => join(sandbox.home, '.config', 'yokoten', 'spending.json');
const paymentsPath = (sandbox: ReturnType<typeof makeSandbox>) => join(sandbox.home, '.config', 'yokoten', 'payments.jsonl');

const setLimit = (sandbox: ReturnType<typeof makeSandbox>, args: string[] = ['--day', '2.00', '--payment', '0.10', '--service', 'api.example.com', '--yes']) =>
  sandbox.call(['spend', 'limit', ...args]);

test('spend status and check: with no limit, an agent pays nothing and the owner is asked', async () => {
  const sandbox = makeSandbox();
  let result = await sandbox.call(['spend']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no spending limit is set/);
  result = await sandbox.call(['spend', 'check', '--amount', '0.10', '--service', 'api.example.com']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stop and ask the owner: no spending limit is set/);
  // A broken file is unsure, so it pays nothing and says why.
  mkdirSync(join(sandbox.home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(limitPath(sandbox), '{}\n');
  result = await sandbox.call(['spend', 'check', '--amount', '0.10', '--service', 'api.example.com', '--json']);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).action, 'ask');
  assert.match(result.stderr, /cannot be read/);
});

test('spend limit: a raise asks first, --yes writes it, and the file is outside the repo', async () => {
  const sandbox = makeSandbox();
  let result = await setLimit(sandbox, ['--day', '2.00', '--payment', '0.10', '--service', 'api.example.com']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /would allow more.*Run it again with --yes/);
  assert.equal(existsSync(limitPath(sandbox)), false, 'nothing was written');

  result = await setLimit(sandbox);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /limit set: \$2\.00 a day, \$0\.10 a payment, 1 service/);
  assert.equal(readFileSync(limitPath(sandbox), 'utf8').includes(sandbox.repo), false, 'the limit is not in the repo');

  // Lowering a cap is safe, so it needs no flag.
  result = await setLimit(sandbox, ['--day', '0.05', '--payment', '0.02', '--service', 'api.example.com']);
  assert.equal(result.status, 0, result.stderr);

  // A service that is not a host is a usage error.
  result = await setLimit(sandbox, ['--day', '2.00', '--payment', '0.10', '--service', 'https://api.example.com/a?b', '--yes']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--service .* is not a host name/);
});

test('spend check: inside the limit pays; each cap and the service list stop it', async () => {
  const sandbox = makeSandbox();
  assert.equal((await setLimit(sandbox)).status, 0);
  let result = await sandbox.call(['spend', 'check', '--amount', '0.10', '--service', 'api.example.com']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pay: inside the limit/);
  result = await sandbox.call(['spend', 'check', '--amount', '0.11', '--service', 'api.example.com']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\$0\.11 is over the \$0\.10 a payment limit/);
  result = await sandbox.call(['spend', 'check', '--amount', '0.01', '--service', 'other.example.com']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not on the spending limit's list/);
  // --json keeps stdout pure, and the words for a person go to stderr.
  result = await sandbox.call(['spend', 'check', '--amount', '0.05', '--service', 'api.example.com', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'pay');
  assert.match(result.stderr, /pay: inside the limit/);
});

test('spend pay: runs inside the limit, records paid and failed calls, and counts only paid ones', async () => {
  const sandbox = makeSandbox();
  assert.equal((await setLimit(sandbox)).status, 0);
  let result = await sandbox.call(['spend', 'pay', '--amount', '0.05', '--service', 'api.example.com', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\$0\.05 to api\.example\.com paid/);
  result = await sandbox.call(['spend', 'pay', '--amount', '0.05', '--service', 'api.example.com', '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(result.status, 3, result.stderr);
  const lines = readFileSync(paymentsPath(sandbox), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.isPaid), [true, false]);
  result = await sandbox.call(['spend']);
  assert.match(result.stdout, /\$0\.05 paid, \$1\.95 left/);
  assert.match(result.stdout, /0\.05 to api\.example\.com, paid/);
  assert.match(result.stdout, /0\.05 to api\.example\.com, failed/);
});

test('spend pay: over the day cap it runs nothing and records nothing', async () => {
  const sandbox = makeSandbox();
  assert.equal((await setLimit(sandbox, ['--day', '0.05', '--payment', '0.05', '--service', 'api.example.com', '--yes'])).status, 0);
  let result = await sandbox.call(['spend', 'pay', '--amount', '0.05', '--service', 'api.example.com', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(result.status, 0, result.stderr);
  result = await sandbox.call(['spend', 'pay', '--amount', '0.01', '--service', 'api.example.com', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /would pass the \$0\.05 a day limit/);
  assert.equal(readFileSync(paymentsPath(sandbox), 'utf8').trim().split('\n').length, 1, 'nothing was added');
});

test('spend: a worker cannot change the limit, and off is the way back', async () => {
  const sandbox = makeSandbox();
  assert.equal((await setLimit(sandbox)).status, 0);
  let result = await sandbox.call(['spend', 'limit', '--day', '3.00', '--payment', '0.10', '--service', 'api.example.com', '--yes'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a worker cannot change the spending limit/);
  assert.match(readFileSync(limitPath(sandbox), 'utf8'), /"day": "2\.00"/);
  result = await sandbox.call(['spend', 'off'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.equal(existsSync(limitPath(sandbox)), true, 'the worker did not remove it');
  // pay is not a tunnel: the command after -- still meets the guard.
  result = await sandbox.call(['spend', 'pay', '--amount', '0.01', '--service', 'api.example.com', '--', 'git', 'push'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the guard refuses the command after --/);
  assert.equal(existsSync(paymentsPath(sandbox)), false, 'a refused command records nothing');
  result = await sandbox.call(['spend', 'off']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(limitPath(sandbox)), false);
  result = await sandbox.call(['spend', 'check', '--amount', '0.01', '--service', 'api.example.com']);
  assert.equal(result.status, 1);
});

test('board text: today\'s payments, the limit, and what is left', () => {
  const board: BoardData = {
    repo: '/repo',
    repoName: 'repo',
    repoUrl: '',
    agents: [],
    needs: [],
    pulls: [],
    merged: [],
    worktrees: [],
    desk: EMPTY_DESK,
    updated: '',
    spending: {
      isSet: true,
      day: '2.00',
      payment: '0.10',
      services: ['api.example.com'],
      spentToday: '0.10',
      setAt: '2026-10-23T00:00:00.000Z',
      problem: '',
      payments: [
        { at: '2026-10-23T10:05:00.000Z', amount: '0.10', service: 'api.example.com', isPaid: true },
        { at: '2026-10-23T10:06:00.000Z', amount: '0.10', service: 'api.example.com', isPaid: false },
      ],
    },
  };
  const text = renderBoardText(board).join('\n');
  assert.match(text, /Payments:\n- limit \$2\.00 a day, \$0\.10 a payment, 1 service \(api\.example\.com\); \$0\.10 paid today\./);
  assert.match(text, /10:05 UTC, \$0\.10 to api\.example\.com, paid/);
  assert.match(text, /10:06 UTC, \$0\.10 to api\.example\.com, failed/);
  // A board with no spending field keeps the old text: an older server does not break the page.
  assert.equal(renderBoardText({ ...board, spending: undefined }).join('\n').includes('Payments:'), false);
});
