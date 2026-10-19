// Tests for src/setup/advice/explain.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';
import { RULES } from '../../../src/rules/message.ts';
import {
  explain,
  ids,
} from '../../../src/setup/advice/explain.ts';

test('explain with no id lists the ids on stdout and exits 0; --json gives { ids } (#247)', () => {
  const sandbox = makeSandbox();
  let result = sandbox.run(['explain']);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  assert.match(result.stdout, /^Ids: release, .*\bsecret\b.*\n$/);
  result = sandbox.run(['explain', '--json']);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(listed), ['ids']);
  assert.ok(listed.ids.includes('release') && listed.ids.includes('secret'));
  // An unknown id is still an error.
  result = sandbox.run(['explain', 'nope']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no rule or step is called nope\.\nIds: release, /);
});

test('explain: each rule and step, its reason and its check; ids are unique (#42)', () => {
  const all = ids();
  assert.equal(new Set(all).size, all.length, 'a rule and a step share an id');
  assert.ok(Object.keys(RULES).length >= 20);
  for (const id of all) {
    const e = explain(id);
    assert.ok(e && e.what && e.why && e.check, id);
    assert.ok(![e.what, e.why, e.check].some((t) => /[.]$/.test(t)), `${id}: no full stop at the end`);
  }
  assert.equal(explain('nope'), null);
  assert.equal(explain('toString'), null, 'only own keys');
});
