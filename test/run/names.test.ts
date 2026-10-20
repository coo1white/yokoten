// Tests for src/run/names.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NAMED } from '../repo/helpers.ts';
import {
  DOCS_URL,
  formatFinding,
} from '../../src/rules/message.ts';
import { addedLinesByFile } from '../../src/rules/pr.ts';
import {
  isCodeFile,
  nameNotes,
} from '../../src/run/names.ts';

test('names: a note for a long-lived one-letter name and a 5-word name on added lines (#111)', () => {
  const notes = nameNotes('src/cart.ts', NAMED, new Set([1, 2, 3]));
  assert.deepEqual(notes.map(formatFinding), [
    `src/cart.ts:1: "t" is used for 14 lines. A reader must scroll back to learn what it holds. Name what it is, e.g. "text".\n  docs: ${DOCS_URL}#naming`,
    `src/cart.ts:2: "loadTheWholeUserList" has 5 words, over 4. A long name is slow to read, and the words that matter get lost. Keep the words a reader needs; the file and the type say the rest, e.g. "processTheUserInputDataNow" becomes "parseInput".\n  docs: ${DOCS_URL}#naming`,
  ]);
  assert.deepEqual(notes.map((note) => note.id), ['name-short', 'name-long']);
  assert.deepEqual(nameNotes('src/cart.ts', NAMED, new Set([3])), [], '`i` in a short loop is fine');
  assert.deepEqual(nameNotes('src/cart.ts', NAMED, new Set([4, 15])), [], 'names on unchanged lines are left alone');
  assert.deepEqual(nameNotes('src/a.ts', 'export const x = 1;\nconst ignore = (_: unknown) => 1;\nconst _count = 2;\n', new Set([1, 2, 3])).map((note) => note.what), ['"x" is one letter, and exported'], 'only the two name notes; `_` for an unused parameter passes');
});

test('names: TypeScript and JavaScript files are read, others are not (#111)', () => {
  for (const file of ['a.ts', 'b/c.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts']) assert.ok(isCodeFile(file), file);
  for (const file of ['a.md', 'a.json', 'a.d', 'ts', 'a.tsv', 'a.py']) assert.ok(!isCodeFile(file), file);
});

test('names: the added lines of each file, from git diff (#111)', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +2,2 @@',
    '+const one = 1;',
    '++++ not a header',
    '@@ -9 +11 @@ function f() {',
    '-old',
    '+new',
    'diff --git a/old.ts b/new name.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to new name.ts',
    '--- a/old.ts',
    '+++ b/new name.ts\t',
    '@@ -5,2 +5,3 @@',
    ' kept',
    '-gone',
    '+added',
    '+more',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
    'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
    '--- /dev/null',
    '+++ "b/tab\\there.ts"',
    '@@ -0,0 +1 @@',
    '+y',
    '',
  ].join('\n');
  const added = addedLinesByFile(diff);
  assert.deepEqual([...added.keys()], ['src/a.ts', 'new name.ts', 'tab\there.ts']);
  assert.deepEqual([...(added.get('src/a.ts') ?? [])], [2, 3, 11]);
  assert.deepEqual([...(added.get('new name.ts') ?? [])], [6, 7], 'a renamed file counts only its new lines');
  assert.deepEqual([...(added.get('tab\there.ts') ?? [])], [1]);
  assert.equal(addedLinesByFile('').size, 0);
});
