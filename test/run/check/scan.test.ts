// Tests for src/run/check/scan.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, skipExpr, type Value } from '../../../src/run/check/scan.ts';

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

test('a regex with a backtick or a class does not hide the code after it (#697)', () => {
  const source = "const fence = (line: string) => /^\\s*(```|~~~)/.test(line);\nconst next = halfway(donations);\n";
  const end = skipExpr(source, source.indexOf('fence'));
  assert.equal(source.slice(end), ';\nconst next = halfway(donations);\n');
});

test('a division is not read as a regex (#697)', () => {
  const source = 'const half = total / 2;\nconst next = 1;\n';
  const end = skipExpr(source, source.indexOf('half'));
  assert.equal(source.slice(end), ';\nconst next = 1;\n');
});
