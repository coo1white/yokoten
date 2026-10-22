// Tests for src/run/check/scan.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, type Value } from '../../../src/run/check/scan.ts';

function read(source: string): Value {
  return evaluate(source, 0, new Map()).value;
}

test('the reader joins a list, spreads one, and reads an env object (#697)', () => {
  assert.deepEqual(read("['git', 'push', '--force'].join(' ')"), { kind: 'text', text: 'git push --force' });
  assert.deepEqual(read("['git status', ...['git push']]"), { kind: 'list', items: ['git status', 'git push'] });
  assert.deepEqual(read("{ YOKOTEN_ROLE: 'worker' }"), { kind: 'env', env: { YOKOTEN_ROLE: 'worker' } });
  assert.deepEqual(read('{}'), { kind: 'env', env: {} });
  assert.deepEqual(read("{ cwd: process.cwd() }"), { kind: 'unknown' });
  assert.deepEqual(read('`git ${name}`'), { kind: 'unknown' });
});
