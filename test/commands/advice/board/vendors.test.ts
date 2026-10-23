// Tests for src/commands/advice/board/vendors.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vendorKeyOf, vendorOf } from '../../../../src/commands/advice/board/vendors.ts';

test('board vendors: a filed name maps to one key and one look (#693, #779)', () => {
  assert.equal(vendorKeyOf(' DeepSeek-Harness '), 'deepseek', 'a filed name maps to its vendor');
  assert.equal(vendorKeyOf('codex', 'deepseek-v4.1-flash'), 'deepseek', 'the model names the vendor');
  assert.equal(vendorKeyOf('claude-code'), 'claude');
  assert.equal(vendorKeyOf('nobody'), 'nobody', 'an unknown vendor keeps its name');
  assert.deepEqual(vendorOf('deepseek-harness'), { name: 'DeepSeek', color: '#4d6bfe' });
  assert.deepEqual(vendorOf('nobody'), { name: 'nobody', color: '#8b8b8b' });
  assert.equal(vendorOf('').name, 'Unknown');
  assert.deepEqual(vendorOf('constructor'), { name: 'constructor', color: '#8b8b8b' }, 'an object key is not a vendor');
  assert.equal(vendorKeyOf('__proto__'), '__proto__');
});
