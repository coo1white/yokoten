// Tests for src/commands/advice/board/page/words.ts.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANG_NAMES, WORDS } from '../../../../../src/commands/advice/board/page/words.ts';

/** The `{name}` marks in one text, sorted. */
function marksOf(text: string): string[] {
  return (text.match(/\{\w+\}/g) ?? []).sort();
}

/** Where a language's words differ from English in keys or marks. */
function findGaps(english: Record<string, string>, other: Record<string, string>): string[] {
  const keys = Object.keys(english).filter((key) => !key.endsWith('.one'));
  const gaps = keys.filter((key) => !(key in other)).map((key) => `missing ${key}`);
  gaps.push(...Object.keys(other).filter((key) => !(key in english)).map((key) => `extra ${key}`));
  gaps.push(...keys.filter((key) => key in other && marksOf(english[key]).join() !== marksOf(other[key]).join()).map((key) => `marks ${key}`));
  return gaps;
}

// #603: a missing or misspelled word would show the key on the page.
test('board words: every language has every key, with the same {marks} as English', () => {
  assert.deepEqual(Object.keys(WORDS), Object.keys(LANG_NAMES));
  for (const [lang, words] of Object.entries(WORDS)) {
    assert.deepEqual(findGaps(WORDS.en, words), [], lang);
    assert.ok(Object.values(words).every((text) => text.trim() === text && text.length > 0), `${lang}: no empty or padded words`);
  }
  for (const key of Object.keys(WORDS.en).filter((each) => each.endsWith('.one'))) assert.ok(key.slice(0, -4) in WORDS.en, `${key} has its plural`);
});

// A positive control: the gap check catches a missing key, an extra key and a lost mark.
test('board words: the gap check catches each kind of gap', () => {
  assert.deepEqual(findGaps({ a: 'x {n}', b: 'y', 'b.one': 'z' }, { a: 'x', c: 'w' }), ['missing b', 'extra c', 'marks a']);
});
