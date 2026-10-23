// Tests for src/commands/advice/board/page/groups.ts.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCheckoutLead, roleGroup } from '../../../../../src/commands/advice/board/page/groups.ts';

test('board groups: a role lands with the work its name contains', () => {
  assert.equal(roleGroup('reviewer'), 'group.reviewer');
  assert.equal(roleGroup('Verifier'), 'group.verifier');
  assert.equal(roleGroup('worker'), 'group.engineer');
  assert.equal(roleGroup('development'), 'group.engineer', 'develop is checked before pm');
  assert.equal(roleGroup('lead'), 'group.manager');
  assert.equal(roleGroup('PM'), 'group.manager');
  assert.equal(roleGroup('helper'), 'group.helper');
  assert.equal(roleGroup('scribe'), 'group.helper');
});

test('board groups: only the main checkout lead stands apart', () => {
  assert.equal(isCheckoutLead({ isMain: true, role: 'Lead' }), true);
  assert.equal(isCheckoutLead({ isMain: false, role: 'lead' }), false);
  assert.equal(isCheckoutLead({ isMain: true, role: 'engineer' }), false);
});
