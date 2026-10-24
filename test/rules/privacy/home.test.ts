// Tests for src/rules/privacy/home.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeIn, homeOf, NO_HOME, realHomeRead, useRealHome, withHome } from '../../../src/rules/privacy/home.ts';

test('home: an absolute HOME is the home folder; a relative one is none (#392)', () => {
  assert.equal(homeOf({ HOME: '/tmp/yokoten-home' }), '/tmp/yokoten-home');
  assert.equal(homeOf({ HOME: 'relative/home' }), null);
  assert.equal(homeOf({}), null);
});

test('home: homeIn throws NO_HOME when there is no full home folder', () => {
  assert.throws(() => homeIn({}), new Error(NO_HOME));
  assert.throws(() => homeIn({ HOME: 'not/full' }), new Error(NO_HOME));
  assert.equal(homeIn({ HOME: '/tmp/yokoten-home' }), '/tmp/yokoten-home');
});

test('home: withHome fills a missing home from the system, and keeps a full one (#356)', () => {
  assert.deepEqual(withHome({}, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-system' });
  assert.deepEqual(withHome({ HOME: 'relative' }, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-system' });
  assert.deepEqual(withHome({ HOME: '/tmp/yokoten-mine' }, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-mine' });
  // The positive control: a system that can tell no home leaves the env as it was.
  assert.deepEqual(withHome({}, () => ''), {});
});

test('home: useRealHome points the real-home read at a stand-in, and puts it back', () => {
  const before = realHomeRead();
  const restore = useRealHome(() => '/tmp/yokoten-real');
  try {
    assert.equal(realHomeRead()(), '/tmp/yokoten-real');
  } finally {
    restore();
  }
  assert.equal(realHomeRead(), before);
});
