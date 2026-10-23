// Tests for src/host/merge-skill.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { missingUtcMergePhrases } from '../../src/host/merge-skill.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('merge skill: the record and the skill keep a UTC merge, and a dropped phrase is caught (#488)', () => {
  const record = readFileSync(join(repoRoot, 'docs/records/0027-utc-merges.md'), 'utf8');
  const skill = readFileSync(join(repoRoot, 'kit/user/skills/merge/SKILL.md'), 'utf8');
  const both = `${record}\n${skill}`;
  assert.ok(both.includes('Time-Zone'));
  assert.ok(both.includes('not UTC'));
  assert.ok(both.includes('yokoten bot -- gh pr merge --squash'));
  assert.ok(skill.includes('Do not paste that line'));
  assert.deepEqual(missingUtcMergePhrases(record, skill), []);
  // A known-bad pair: none of the phrases, so the check still catches a merge rule that was cut.
  assert.deepEqual(missingUtcMergePhrases('no header here', 'merge any way'), [
    'Time-Zone',
    'not UTC',
    'yokoten bot -- gh pr merge --squash',
    'Do not paste that line',
  ]);
  assert.deepEqual(missingUtcMergePhrases(record.replace('Time-Zone', 'header'), skill), ['Time-Zone']);
  assert.deepEqual(
    missingUtcMergePhrases(record.replaceAll('not UTC', 'on time'), skill.replaceAll('not UTC', 'on time')),
    ['not UTC'],
  );
  assert.deepEqual(missingUtcMergePhrases(record, skill.replace('yokoten bot -- gh pr merge --squash', 'gh pr merge')), [
    'yokoten bot -- gh pr merge --squash',
  ]);
  assert.deepEqual(missingUtcMergePhrases(record, skill.replace('Do not paste that line', 'paste it')), ['Do not paste that line']);
});
