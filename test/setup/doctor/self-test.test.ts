// Tests for src/setup/doctor/self-test.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unsavedNotes } from '../../../src/setup/advice/unsaved.ts';
import { isShellControlCaught, isUnsavedControlCaught, sandboxControl, selfTest } from '../../../src/setup/doctor/index.ts';

test('self-test: the sandbox control passes the real checks and fails broken ones (#589)', () => {
  assert.deepEqual(sandboxControl(), []);
  assert.ok(!selfTest().some((name) => name.toLowerCase().includes('sandbox')));
  const passAll = () => null;
  assert.deepEqual(sandboxControl(passAll, passAll, passAll, passAll), ['Claude Code sandbox check', 'Codex sandbox check', 'Gemini CLI sandbox check', 'Grok sandbox check'], 'checks that pass everything');
  const failAll = () => ({ what: 'broken', fix: 'fix it' });
  assert.deepEqual(sandboxControl(failAll, failAll, failAll, failAll), ['sandbox check (a good set passes)'], 'checks that fail everything');
});

test('doctor self-test: the unsaved-work check must name every kind, and a broken one is caught (#365)', () => {
  assert.equal(isUnsavedControlCaught(), true);
  assert.equal(isUnsavedControlCaught(() => []), false, 'a check that finds nothing');
  const deletesWhenUnsure: Parameters<typeof isUnsavedControlCaught>[0] = (facts, options) =>
    unsavedNotes(facts, options).map((f) => (f.id === 'stale-index-lock' ? { ...f, fix: 'delete it' } : f));
  assert.equal(isUnsavedControlCaught(deletesWhenUnsure), false, "a check that says to delete a lock it can't judge");
  assert.ok(!selfTest().includes('unsaved work check'));
});

test('self-test: a shell write from the plugin agent yokoten:worker is caught, and the lead passes (#402)', () => {
  assert.ok(isShellControlCaught());
  assert.ok(!selfTest().includes('lead-only shell guard'));
});

