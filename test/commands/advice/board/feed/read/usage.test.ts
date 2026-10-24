// Tests for src/commands/advice/board/feed/read/usage.ts (#611): known logs give known
// totals, an unknown model is partial, and no message text reaches the view.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../../../../repo/helpers.ts';
import { claudeFolder } from '../../../../../../src/commands/advice/board/feed/read/logs.ts';
import { PRICES_CHECKED } from '../../../../../../src/commands/advice/board/feed/read/prices.ts';
import { claudeUsage, collectUsage, costWords, dayOf, filterUsage, museUsage, totalOf } from '../../../../../../src/commands/advice/board/feed/read/usage.ts';

/** A file with its folders, last changed `age` ms ago. */
function put(file: string, text: string, age = 0): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  const when = new Date(Date.now() - age);
  utimesSync(file, when, when);
}

/** One Claude Code turn, with a message the view must never repeat. */
function claudeTurn(id: string, usage: Record<string, number>, model = 'claude-opus-5-5', text = 'secret words from the session'): string {
  return `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-22T10:00:00.000Z', message: { id, model, usage, content: [{ type: 'text', text }] } })}\n`;
}

/** One Muse Code record with a usage, as its session log writes it. */
function museTurn(usage: Record<string, number>, model = 'muse-spark', at = Date.UTC(2026, 9, 22, 11) * 1000): string {
  return `${JSON.stringify({ recorded_at: at, payload: { event: { kind: 'assistant_message_committed', text: 'secret words from the session', model, usage } } })}\n`;
}

const NOW = Date.now();

test('board usage: Claude Code turns count once, with their cache reads and writes', () => {
  const turns = claudeUsage([
    claudeTurn('msg-1', { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 }),
    claudeTurn('msg-1', { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 }),
    claudeTurn('msg-2', { input_tokens: 50, cache_creation_input_tokens: 300, output_tokens: 10 }),
    JSON.stringify({ type: 'user', message: { content: 'a prompt is not a turn' } }),
  ].join(''));
  assert.deepEqual(turns.map((turn) => [turn.input, turn.cached, turn.output]), [[100, 1000, 20], [50, 300, 10]]);
  assert.ok(turns.every((turn) => turn.model === 'claude-opus-5-5'));
  assert.equal(dayOf(turns[0].at), '2026-10-22');
});

test('board usage: Muse Code turns read the usage the record carries, and the model once', () => {
  const text = [
    museTurn({ input_tokens: 400, cached_tokens: 100, output_tokens: 40 }),
    museTurn({ input_tokens: 200, output_tokens: 10 }),
  ].join('');
  const turns = museUsage(text);
  assert.deepEqual(turns.map((turn) => [turn.input, turn.cached, turn.output]), [[400, 100, 40], [200, 0, 10]]);
  assert.ok(turns.every((turn) => turn.model === 'muse-spark'));
});

test('board usage: a known Claude log gives known totals, in dollars at the list price', () => {
  const home = makeTempDir('yokoten-usage-');
  const tree = join(home, 'dev', 'repo-611');
  const log = join(home, '.claude', 'projects', claudeFolder(tree), 'session.jsonl');
  // 2,000,000 input at $15, 1,000,000 cached at $1.50, 100,000 output at $75 per million.
  put(log, claudeTurn('msg-1', { input_tokens: 2_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 100_000 }));
  const usage = collectUsage([{ agent: 'Ada', tree, vendor: 'claude', vendorName: 'Claude', model: '', role: 'engineer', log: '' }], { HOME: home }, NOW);
  assert.equal(usage.checked, PRICES_CHECKED);
  assert.equal(usage.cells.length, 1);
  const cell = usage.cells[0];
  assert.deepEqual([cell.input, cell.cached, cell.output], [2_000_000, 1_000_000, 100_000]);
  assert.equal(cell.usd, 39);
  assert.equal(cell.isPartial, false);
  assert.equal(cell.day, '2026-10-22');
  assert.equal(costWords(totalOf([cell]), false), 'about $39.00 if paid by API');
  assert.equal(totalOf([cell]).usd, 39);
});

test('board usage: an unknown model is partial, and no message text reaches the view', () => {
  const home = makeTempDir('yokoten-usage-');
  const tree = join(home, 'dev', 'repo-611');
  const secret = 'PRIVATE-MESSAGE-TEXT-MUST-NOT-LEAVE';
  const log = join(home, '.claude', 'projects', claudeFolder(tree), 'session.jsonl');
  put(log, claudeTurn('msg-1', { input_tokens: 1000, output_tokens: 10 }, 'mystery-model-9', secret));
  const usage = collectUsage([{ agent: 'Ada', tree, vendor: 'claude', model: '', role: 'engineer', log: '' }], { HOME: home }, NOW);
  assert.equal(usage.cells.length, 1);
  assert.equal(usage.cells[0].usd, null);
  assert.equal(usage.cells[0].isPartial, true);
  assert.deepEqual(usage.partial, ['mystery-model-9: no price in the table']);
  assert.equal(totalOf(usage.cells).usd, null, 'a total holding a partial row is partial');
  assert.equal(costWords(totalOf(usage.cells), false), 'partial: a model here has no price or no amounts in its log');
  assert.ok(!JSON.stringify(usage).includes(secret), 'no message text in the view');
  assert.ok(!JSON.stringify(usage).includes('secret words'), 'not even a word of it');
});

test('board usage: a Muse log and a Claude log add up per agent, model and day', () => {
  const home = makeTempDir('yokoten-usage-');
  const claudeTree = join(home, 'dev', 'repo-611');
  const museTree = join(home, 'dev', 'repo-612');
  put(join(home, '.claude', 'projects', claudeFolder(claudeTree), 'session.jsonl'), claudeTurn('msg-1', { input_tokens: 1000, output_tokens: 100 }));
  put(join(home, '.local', 'share', 'muse', 'sessions', '2026', '10', '22', 'm1', 'session.jsonl'),
    `${JSON.stringify({ payload: { kind: 'metadata', record: { workspace_root: museTree } } })}\n${museTurn({ input_tokens: 1_000_000, cached_tokens: 1_000_000, output_tokens: 1_000_000 })}`);
  const usage = collectUsage([
    { agent: 'Ada', tree: claudeTree, vendor: 'claude', vendorName: 'Claude', model: '', role: 'engineer', log: '' },
    { agent: 'Bea', tree: museTree, vendor: 'muse', vendorName: 'Muse', model: '', role: 'reviewer', log: '' },
  ], { HOME: home }, NOW);
  assert.deepEqual(usage.cells.map((cell) => [cell.agent, cell.vendor, cell.model, cell.day]).sort(), [
    ['Ada', 'Claude', 'claude-opus-5-5', '2026-10-22'],
    ['Bea', 'Muse', 'muse-spark', '2026-10-22'],
  ]);
  assert.deepEqual(usage.days, ['2026-10-22']);
  const muse = usage.cells.find((cell) => cell.agent === 'Bea');
  assert.equal(muse?.usd, 2.05);
  assert.equal(totalOf(usage.cells).usd, (1000 * 15 + 100 * 75) / 1_000_000 + 2.05);
});

test('board usage: a log with no token counts says so rather than showing zero', () => {
  const home = makeTempDir('yokoten-usage-');
  const tree = join(home, 'dev', 'repo-611');
  put(join(home, '.claude', 'projects', claudeFolder(tree), 'session.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
  const usage = collectUsage([{ agent: 'Ada', tree, vendor: 'claude', vendorName: 'Claude', model: 'Claude Opus 5.5', role: 'engineer', log: '' }], { HOME: home }, NOW);
  assert.deepEqual(usage.cells, []);
  assert.deepEqual(usage.partial, ['Ada: its log has no token counts']);
});

test('board usage: a role and a vendor filter keep their rows, and say what they kept', () => {
  const usage = {
    cells: [
      { agent: 'Ada', vendor: 'Claude', model: 'claude-opus-5-5', role: 'engineer', day: '2026-10-22', input: 1, cached: 0, output: 0, usd: 0, isPartial: false, isLocal: false },
      { agent: 'Bea', vendor: 'Muse', model: 'muse-spark', role: 'reviewer', day: '2026-10-22', input: 2, cached: 0, output: 0, usd: 0, isPartial: false, isLocal: false },
    ],
    days: ['2026-10-22'],
    partial: [],
    checked: PRICES_CHECKED,
    sources: [],
  };
  assert.deepEqual(filterUsage(usage, { role: 'reviewer', vendor: '' }).cells.map((cell) => cell.agent), ['Bea']);
  assert.deepEqual(filterUsage(usage, { role: 'checker', vendor: '' }).cells, []);
  assert.deepEqual(filterUsage(usage, { role: '', vendor: 'claude' }).cells.map((cell) => cell.agent), ['Ada']);
  assert.equal(filterUsage(usage, { role: 'reviewer', vendor: 'muse' }).filter, 'reviewer, muse');
});
