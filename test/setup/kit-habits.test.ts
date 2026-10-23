// The four kit skills carry habits that used to live only in memory (#531).

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

test('kit habits: every skill warns when it came from a skills-only copy (#540)', () => {
  for (const folder of ['user', 'plugin']) {
    for (const name of readdirSync(join(ROOT, 'kit', folder, 'skills'))) {
      const text = readFileSync(join(ROOT, 'kit', folder, 'skills', name, 'SKILL.md'), 'utf8');
      assert.match(text, /npx skills add/, `${folder}/${name}: names the command that copies skills alone`);
      assert.match(text, /not on PATH and the Claude Code plugin is not enabled/, `${folder}/${name}: says when the guard is missing`);
      assert.match(text, /This copy has the skills only; run `npx yokoten install` to add the guard/, `${folder}/${name}: gives the one line and the fix`);
      assert.match(text, /say one\s+>\s*line\. Then carry on:/, `${folder}/${name}: the instruction is two short sentences`);
    }
  }
});
