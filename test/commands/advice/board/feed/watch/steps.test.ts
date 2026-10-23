// Tests for src/commands/advice/board/feed/watch/steps.ts.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEED_LIMIT, feedsJson, makeFeedStore, recordFeed } from '../../../../../../src/commands/advice/board/feed/watch/steps.ts';
import type { AgentView } from '../../../../../../src/commands/advice/board/view.ts';

const agent = (fields: Partial<AgentView>) => ({ key: '~/w', name: 'w', doing: '', checks: '', dot: 'working', ...fields }) as AgentView;
const steps = (store: ReturnType<typeof makeFeedStore>) => Object.fromEntries(Object.entries(feedsJson(store)).map(([key, feed]) => [key, feed.map((event) => `${event.kind}:${event.text}`)]));

// #603: each read compares an agent with the last one; a change becomes a step.
test('board feed: a new doing, a check result and a waiting or done state each become a step', () => {
  const store = makeFeedStore();
  recordFeed(store, [agent({ doing: 'reading the issue' })], 't1');
  recordFeed(store, [agent({ doing: 'reading the issue' })], 't2');
  recordFeed(store, [agent({ doing: 'ran the tests', checks: 'passing' })], 't3');
  recordFeed(store, [agent({ doing: 'ran the tests', checks: 'failing', dot: 'failing' })], 't4');
  recordFeed(store, [agent({ doing: 'asks to add a package', checks: 'failing', dot: 'waiting' })], 't5');
  recordFeed(store, [agent({ doing: 'asks to add a package', checks: 'failing', dot: 'done' })], 't6');
  assert.deepEqual(steps(store), {
    '~/w': ['step:reading the issue', 'step:ran the tests', 'pass:Checks passed', 'fail:Checks failed', 'step:asks to add a package', 'wait:Waiting for you', 'done:Finished'],
  });
  assert.equal(feedsJson(store)['~/w'][0].time, 't1', 'each step keeps when the board saw it');
});

test('board feed: an agent first seen waiting has no "waiting" step; an agent that leaves loses its feed', () => {
  const store = makeFeedStore();
  recordFeed(store, [agent({ dot: 'waiting' }), agent({ key: '~/x', doing: 'x' })], 't1');
  assert.deepEqual(steps(store), { '~/x': ['step:x'] });
  recordFeed(store, [agent({ dot: 'waiting' })], 't2');
  assert.deepEqual(steps(store), {}, 'the agent at ~/x left');
  recordFeed(store, [agent({ dot: 'waiting' }), agent({ key: '~/x', doing: 'x' })], 't3');
  assert.deepEqual(steps(store), { '~/x': ['step:x'] }, 'back again, it starts over');
});

test('board feed: one agent keeps at most FEED_LIMIT steps, the newest', () => {
  const store = makeFeedStore();
  for (let index = 0; index < FEED_LIMIT + 5; index += 1) recordFeed(store, [agent({ doing: `step ${index}` })], `t${index}`);
  const feed = feedsJson(store)['~/w'];
  assert.equal(feed.length, FEED_LIMIT);
  assert.equal(feed[0].text, 'step 5');
  assert.equal(feed[FEED_LIMIT - 1].text, `step ${FEED_LIMIT + 4}`);
});
