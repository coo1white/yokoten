import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POSITIVE_CONTROL, scanText } from '../../../src/rules/privacy/index.ts';
test('positive control: the known-bad sample is caught', () => {
  assert.equal(scanText(POSITIVE_CONTROL, { file: 'x' }).length, 2);
});

