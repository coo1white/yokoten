// The four kit skills carry habits that used to live only in memory (#531).

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../repo/helpers.ts';

const MANAGED = '<!-- managed by yokoten; `yokoten install` replaces this file -->';

/** A kit skill, read from the repo root. */
const readSkill = (name: string): string => readFileSync(join(ROOT, 'kit/user/skills', name, 'SKILL.md'), 'utf8');

test('kit habits: the skills name the merge order, the cause, the road and the issue (#531)', () => {
  const dispatch = readSkill('dispatch');
  const cause = readSkill('rca');
  const release = readSkill('release');
  const inspect = readSkill('inspect');
  for (const text of [dispatch, cause, release, inspect]) assert.ok(text.includes(MANAGED));
  assert.ok(dispatch.includes('When several pull requests wait'));
  assert.ok(cause.includes('fix its cause before you take the next case'));
  assert.ok(release.includes('Try the beginner road'));
  assert.ok(release.includes('weak model'));
  assert.ok(inspect.includes('How you name an issue'));
  assert.ok(inspect.includes('issue #N'));
});
