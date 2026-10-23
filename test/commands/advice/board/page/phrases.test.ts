// Tests for src/commands/advice/board/page/phrases.ts.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JA, ZH_TW } from '../../../../../src/commands/advice/board/page/phrases.ts';

test('board phrases: Traditional Chinese and Japanese each say the desk', () => {
  assert.equal(ZH_TW.deskNow, '正在做');
  assert.equal(ZH_TW.deskWaiting, '等你決定');
  assert.equal(ZH_TW.afterIssue, '在 {refs} 之後');
  assert.equal(JA.deskNow, '今していること');
  assert.equal(JA.deskWaiting, 'あなたの判断待ち');
  assert.equal(JA.afterIssue, '{refs} のあと');
  assert.equal(JA.timelineTitle, '直近 24 時間');
  assert.notEqual(ZH_TW.deskQuiet, JA.deskQuiet);
});
