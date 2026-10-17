// The road's logic, apart from the checks: where a project is, from what each check found.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Found, ROAD, STAGES, type Step, walk } from '../src/setup/road.ts';

const step = (stage: number, key: string): Step => ({ stage, key, check: () => false, what: () => key, why: key });
const steps = [step(1, 'a'), step(1, 'b'), step(2, 'c'), step(3, 'd')];
const at = (found: Found[], notNow: Record<string, string> = {}) => walk(steps.map((s, i) => ({ step: s, found: found[i] })), notNow);
const marks = (found: Found[], notNow: Record<string, string> = {}) => at(found, notNow).steps.map((w) => w.mark);

test('road: the stage is the first one with a step neither done nor not now', () => {
  assert.equal(at([false, false, false, false]).stage, 1);
  assert.equal(at([true, true, false, false]).stage, 2);
  assert.equal(at([true, true, true, false]).stage, 3);
  assert.deepEqual(marks([true, false, false, false]), ['done', 'next', 'to do', 'to do']);
  assert.equal(at([true, false, false, false]).next?.key, 'b');
});

test('road: a later step done early counts as done', () => {
  assert.deepEqual(marks([false, true, true, true]), ['next', 'done', 'done', 'done']);
  assert.equal(at([false, true, true, true]).stage, 1);
});

test('road: not now skips a step, and done wins over not now', () => {
  assert.equal(at([true, false, false, false], { b: 'later' }).stage, 2);
  assert.deepEqual(marks([true, false, false, false], { a: 'x', b: 'later' }), ['done', 'not now', 'next', 'to do']);
});

test("road: a step yokoten can't check shows so, and never holds the stage", () => {
  assert.deepEqual(marks([true, null, false, true]), ['done', "can't check", 'next', 'done']);
  assert.equal(at([true, null, false, true]).stage, 2);
});

test('road: nothing left means no stage and no next step', () => {
  const end = at([true, null, true, false], { d: 'not public yet' });
  assert.equal(end.stage, null);
  assert.equal(end.next, null);
});

test('road: five stages, each step in one of them, each key once, each why a sentence', () => {
  assert.equal(STAGES.length, 5);
  assert.deepEqual(ROAD.map((s) => s.stage), [...ROAD.map((s) => s.stage)].sort(), 'the table is in stage order');
  assert.ok(ROAD.every((s) => s.stage >= 1 && s.stage <= STAGES.length));
  assert.equal(new Set(ROAD.map((s) => s.key)).size, ROAD.length);
  // The keys a project may already have in yokoten.json "notNow" keep working.
  for (const key of ['rules', 'commit-check', 'tool-hook', 'ci', 'runtime', 'issues']) assert.ok(ROAD.some((s) => s.key === key), key);
  for (const s of ROAD) assert.ok(!/[.]$/.test(s.why) && s.why.split(' ').length <= 25, `${s.key}: a why has no full stop and at most 25 words`);
});

test('road: every outside standard has the form "<standard>: <item>" or an item id, joined by " · " (#58)', () => {
  const named = ROAD.filter((s) => s.standard);
  assert.ok(named.length >= 10, 'most steps name a standard');
  for (const { key, standard } of named) {
    for (const part of (standard ?? '').split(' · ')) {
      assert.match(part, /^[A-Za-z][\w .-]*(?:: \S(?:.*\S)?)?$/, `${key}: "${part}"`);
      if (part.startsWith('OSPS')) assert.match(part, /^OSPS-[A-Z]{2}-\d{2}\.\d{2}$/, `${key}: an OSPS Baseline id`);
    }
  }
});
