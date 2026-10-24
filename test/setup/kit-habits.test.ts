// The four kit skills carry habits that used to live only in memory (#531).

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../repo/helpers.ts';

const MANAGED = '<!-- managed by yokoten; `yokoten install` updates this file, and keeps your edits -->';

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

test('kit habits: the lead names outside pull requests in the session summary (#88)', () => {
  const dispatch = readSkill('dispatch');
  assert.ok(dispatch.includes('## The summary you give the owner'));
  assert.ok(dispatch.includes('pull requests\nfrom outside accounts this week'), 'the summary names outside pull requests, with the line break the skill uses');
  assert.ok(dispatch.includes('even when it is zero'), 'a quiet week is said, so the owner knows the watch ran');
});

const NPM_SETTING = 'Require two-factor authentication and disallow bypass 2fa tokens';

/** Reasons the release skill misses the first publish (#538). */
function findFirstReleaseGaps(skill: string): string[] {
  const gaps: string[] = [];
  if (!skill.includes("project's release docs")) gaps.push('does not read the release docs');
  if (!skill.includes('npm view')) gaps.push('does not ask the registry');
  if (!skill.includes('publish by hand')) gaps.push('does not name the hand publish');
  if (!skill.includes('just before the next release')) gaps.push('does not time the trusted publisher');
  if (!skill.includes(NPM_SETTING)) gaps.push('does not name the npm setting');
  if (!skill.includes('git push origin --delete')) gaps.push('does not give the tag delete form');
  const commands = skill.split('\n').filter((line) => /^\s*git (tag|push)/.test(line));
  if (commands.some((line) => line.includes(':refs/tags/'))) gaps.push('uses the colon ref form');
  return gaps;
}

test('release skill: a package not yet on npm is published by hand (#538)', () => {
  const skill = readSkill('release');
  assert.deepEqual(findFirstReleaseGaps(skill), []);
  // Positive control: the v0.1.0 skill named a token setting and no hand publish.
  const old = skill.replace('publish by hand', 'publish').replace(NPM_SETTING, 'disallow tokens');
  assert.equal(findFirstReleaseGaps(old).includes('does not name the hand publish'), true);
  assert.equal(findFirstReleaseGaps(old).includes('does not name the npm setting'), true);
  assert.equal(
    findFirstReleaseGaps(`${skill}\ngit push origin :refs/tags/vX.Y.Z`).includes('uses the colon ref form'),
    true,
  );
});

test('release docs: record 0009 and server.md use npm\'s current settings wording (#538)', () => {
  for (const path of ['docs/records/0009-release-environment.md', 'docs/server.md']) {
    assert.ok(readFileSync(join(ROOT, path), 'utf8').includes(NPM_SETTING), path);
  }
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
