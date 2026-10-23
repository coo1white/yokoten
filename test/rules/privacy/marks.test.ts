// Tests for src/rules/privacy/marks.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { useRealHome } from '../../../src/rules/privacy/home.ts';
import { loadMarks, marksFile, marksFiles, writtenMarksOnly } from '../../../src/rules/privacy/marks.ts';
import { makeTempDir } from '../../repo/helpers.ts';

test('marks: the default file sits under the home folder', () => {
  const home = makeTempDir();
  assert.equal(marksFile({ HOME: home }), join(home, '.config', 'yokoten', 'private-marks'));
  assert.deepEqual(marksFiles({ HOME: home }), [join(home, '.config', 'yokoten', 'private-marks')]);
});

test('marks: every line that is not blank or a comment is a mark, lowercased once', () => {
  const home = makeTempDir();
  const file = marksFile({ HOME: home });
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(file, '# your own marks\n\nAlice\nALICE\nexample.test\n');
  const restore = useRealHome(() => '');
  try {
    assert.deepEqual(loadMarks({ HOME: home }), ['alice', 'example.test']);
  } finally {
    restore();
  }
});

test('marks: a missing file has no marks, and the real home cannot hide that', () => {
  const home = makeTempDir();
  const restore = useRealHome(() => '');
  try {
    assert.deepEqual(loadMarks({ HOME: home }), []);
    // The positive control: the same read finds a mark once the file has one.
    mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
    writeFileSync(marksFile({ HOME: home }), 'a-mark\n');
    assert.deepEqual(loadMarks({ HOME: home }), ['a-mark']);
  } finally {
    restore();
  }
});

test('marks: YOKOTEN_PRIVATE_MARKS adds a file; writtenMarksOnly drops it (#656)', () => {
  const home = makeTempDir();
  const extra = join(home, 'extra-marks');
  const env = { HOME: home, YOKOTEN_PRIVATE_MARKS: extra };
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(marksFile({ HOME: home }), 'default-mark\n');
  writeFileSync(extra, 'extra-mark\n');
  const restore = useRealHome(() => '');
  try {
    assert.deepEqual(loadMarks(env), ['default-mark', 'extra-mark']);
    assert.deepEqual(marksFiles(env), [marksFile({ HOME: home }), extra]);
    assert.deepEqual(marksFiles(writtenMarksOnly(env)), [marksFile({ HOME: home })]);
  } finally {
    restore();
  }
});
