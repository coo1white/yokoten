// Tests for src/commands/advice/board/feed/read/prices.ts (#611): the price table.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf, MODEL_PRICES, modelPrice, priceKey, priceSources, PRICES_CHECKED } from '../../../../../../src/commands/advice/board/feed/read/prices.ts';

test('board prices: a family name matches its row, with a version or any case', () => {
  assert.equal(modelPrice('claude-opus-5-5-20261001')?.match, 'opus');
  assert.equal(modelPrice('CLAUDE-SONNET-5-5')?.match, 'sonnet');
  assert.equal(modelPrice('deepseek-v4.1-flash')?.match, 'deepseek');
  assert.equal(priceKey('DeepSeek V4.1 Flash'), 'deepseekv41flash');
});

// A positive control: a model the table does not know must stay unknown, never a guess.
test('board prices: a stranger has no price, and a cost of it is null', () => {
  assert.equal(modelPrice('mystery-model-9'), null);
  assert.equal(modelPrice(''), null);
  assert.equal(costOf('mystery-model-9', 1000, 0, 10), null);
  assert.equal(costOf('claude-opus-5-5', 1_000_000, 1_000_000, 1_000_000), 91.5);
});

test('board prices: the table says when it was checked, and links each vendor', () => {
  assert.match(PRICES_CHECKED, /^\d{4}-\d{2}-\d{2}$/);
  const sources = priceSources();
  assert.deepEqual(sources.map((source) => source.vendor).sort(), ['Claude', 'DeepSeek', 'Grok', 'Muse', 'Qwen']);
  assert.ok(sources.every((source) => source.url.startsWith('https://')));
  assert.ok(MODEL_PRICES.every((row) => row.input >= 0 && row.cached >= 0 && row.output >= 0));
});
