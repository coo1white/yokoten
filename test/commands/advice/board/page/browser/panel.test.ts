// Tests for src/commands/advice/board/page/browser/panel.ts. The pure helpers run as they are;
// the drawn panel is tested in script.test.ts, which has the fake document.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextOf } from '../../../../../../src/commands/advice/board/page/browser/panel.ts';
import type { AgentView } from '../../../../../../src/commands/advice/board/view.ts';

const agent = (contextUsed: unknown, contextLimit: unknown): AgentView => ({ contextUsed, contextLimit }) as unknown as AgentView;

test('board panel: context is a rounded percent, a warning from 80, and unknown when odd', () => {
  assert.deepEqual(contextOf(agent(46, 100)), { percent: 46, isSoon: false });
  assert.deepEqual(contextOf(agent(800, 1000)), { percent: 80, isSoon: true });
  assert.deepEqual(contextOf(agent(300, 200)), { percent: 100, isSoon: true });
  for (const [used, limit] of [[null, 100], [10, 0], [-1, 100], [Number.NaN, 100], ['5', 10]]) {
    assert.equal(contextOf(agent(used, limit)), null);
  }
});
