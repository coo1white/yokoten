// The merge skill and record (#488). They are kit text, not a src module.
// A log with no ref reads the feature head after `gh pr merge`. The count stays open.

import './home.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Phrases the record and the skill share. The command lives in the skill. */
const MERGE_PHRASES = ['Time-Zone', 'not UTC', 'yokoten bot -- gh pr merge --squash'] as const;

/** The skill line that keeps a zone value out of a report. */
const SKILL_PHRASE = 'Do not paste that line';

/** The log that names the default branch. A log with no ref reads the feature head. */
const MERGE_LOG = 'git log -1 --format=%ci origin/main';

const REMAINS_ISSUE = /remains issue #(\d+)/g;
const CLOSING_LINK = /\b(?:closes|fixes|resolves) #(\d+)/gi;

/**
 * Phrases missing from the record and the skill.
 * Empty when both still say how a merge stays on UTC.
 */
function findMissingUtcPhrases(record: string, skill: string): string[] {
  const both = `${record}\n${skill}`;
  const missing: string[] = MERGE_PHRASES.filter((phrase) => !both.includes(phrase));
  if (!skill.includes(SKILL_PHRASE)) missing.push(SKILL_PHRASE);
  return missing;
}

/**
 * What the skill lacks so the lead reads the merge on the default branch.
 * A log with no ref can pass on the feature head.
 */
function findMergeReadGaps(skill: string): string[] {
  const gaps: string[] = [];
  if (!skill.includes('git fetch')) gaps.push('git fetch');
  if (!skill.includes(MERGE_LOG)) gaps.push(MERGE_LOG);
  if (/git log -1 --format=%ci(?! origin\/main)/.test(skill)) gaps.push('log with no ref');
  return gaps;
}

/**
 * Closing links for an issue the record says remains open.
 * `Refs` and `Part of` leave the issue open.
 */
function findOpenIssueCloses(record: string, text: string): string[] {
  const open = new Set([...record.matchAll(REMAINS_ISSUE)].map((match) => match[1]));
  const found: string[] = [];
  for (const match of text.matchAll(CLOSING_LINK)) {
    if (open.has(match[1])) found.push(match[0]);
  }
  return found;
}

/** Skill names missing from the guide row that points at `kit/user/skills/`. */
function findGuideSkillGaps(guide: string, skillNames: string[]): string[] {
  const row = guide.split('\n').find((line) => line.includes('kit/user/skills/'));
  if (row === undefined) return ['no skill table row'];
  return skillNames.filter((name) => !row.includes(`/yokoten:${name}`));
}

test('merge skill: the record and the skill keep a UTC merge, and a dropped phrase is caught (#488)', () => {
  const record = readFileSync(join(repoRoot, 'docs/records/0027-utc-merges.md'), 'utf8');
  const skill = readFileSync(join(repoRoot, 'kit/user/skills/merge/SKILL.md'), 'utf8');
  assert.deepEqual(findMissingUtcPhrases(record, skill), []);
  // A known-bad pair: none of the phrases, so a merge rule that was cut is still caught.
  assert.deepEqual(findMissingUtcPhrases('no header here', 'merge any way'), [
    'Time-Zone',
    'not UTC',
    'yokoten bot -- gh pr merge --squash',
    'Do not paste that line',
  ]);
  assert.deepEqual(findMissingUtcPhrases(record.replace('Time-Zone', 'header'), skill), ['Time-Zone']);
  assert.deepEqual(
    findMissingUtcPhrases(record.replaceAll('not UTC', 'on time'), skill.replaceAll('not UTC', 'on time')),
    ['not UTC'],
  );
  assert.deepEqual(findMissingUtcPhrases(record, skill.replace('yokoten bot -- gh pr merge --squash', 'gh pr merge')), [
    'yokoten bot -- gh pr merge --squash',
  ]);
  assert.deepEqual(findMissingUtcPhrases(record, skill.replace('Do not paste that line', 'paste it')), ['Do not paste that line']);
});

test('merge skill: fetch, then read origin/main, so the feature head cannot pass (#488)', () => {
  const skill = readFileSync(join(repoRoot, 'kit/user/skills/merge/SKILL.md'), 'utf8');
  assert.deepEqual(findMergeReadGaps(skill), []);
  // The line this pull request had: no fetch, and no ref, so it reads the feature head.
  const featureHead = 'Read the new commit on the default branch with `git log -1 --format=%ci`.';
  assert.deepEqual(findMergeReadGaps(featureHead), ['git fetch', MERGE_LOG, 'log with no ref']);
  assert.deepEqual(findMergeReadGaps(`git fetch\n${featureHead}`), [MERGE_LOG, 'log with no ref']);
  assert.deepEqual(findMergeReadGaps(MERGE_LOG), ['git fetch']);
  assert.deepEqual(findMergeReadGaps(`git fetch\n${MERGE_LOG}`), []);
});

test('merge record: an issue it leaves open is linked with Refs, not Closes (#488)', () => {
  const record = readFileSync(join(repoRoot, 'docs/records/0027-utc-merges.md'), 'utf8');
  const skill = readFileSync(join(repoRoot, 'kit/user/skills/merge/SKILL.md'), 'utf8');
  const change = readFileSync(join(repoRoot, 'changes/488-merge-utc.md'), 'utf8');
  const open = 'That count remains issue #488.';
  assert.match(record, /remains issue #488/);
  assert.match(record, /Refs #488/);
  assert.deepEqual(findOpenIssueCloses(record, `${record}\n${skill}\n${change}`), []);
  // A known-bad message: the closing word would finish an issue the record leaves open.
  assert.deepEqual(findOpenIssueCloses(open, 'Closes #488'), ['Closes #488']);
  assert.deepEqual(findOpenIssueCloses(open, 'Fixes #488'), ['Fixes #488']);
  assert.deepEqual(findOpenIssueCloses(open, 'Resolves #488'), ['Resolves #488']);
  assert.deepEqual(findOpenIssueCloses(open, 'Refs #488'), []);
  assert.deepEqual(findOpenIssueCloses(open, 'Part of #488'), []);
  assert.deepEqual(findOpenIssueCloses(open, 'Closes #12'), []);
  assert.deepEqual(findOpenIssueCloses('the work is done', 'Closes #488'), []);
});

test('guide: the skill table lists every skill in the kit, including merge (#488)', () => {
  const names = readdirSync(join(repoRoot, 'kit/user/skills'));
  assert.ok(names.includes('merge'), 'kit/user/skills/merge is missing; the scan is broken');
  const row = '| The skills: `/yokoten:dispatch` | `kit/user/skills/` |';
  assert.deepEqual(findGuideSkillGaps(row, ['dispatch', 'merge']), ['merge']);
  assert.deepEqual(findGuideSkillGaps('no table here', ['merge']), ['no skill table row']);
  for (const file of ['docs/guide.md', 'docs/i18n/zh-CN/guide.md']) {
    const guide = readFileSync(join(repoRoot, file), 'utf8');
    assert.deepEqual(findGuideSkillGaps(guide, names), [], file);
    assert.match(guide, /`merge`/, file);
  }
});
