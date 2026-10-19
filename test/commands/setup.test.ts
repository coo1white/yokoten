// Tests for src/commands/setup.ts.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../repo/helpers.ts';

test('update: a folder that does not exist is said plainly (#208)', () => {
  const sandbox = makeSandbox();
  const result = sandbox.run(['update', 'typo']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', 'yokoten update: typo does not exist; nothing to update.\n']);
  assert.ok(!existsSync(join(sandbox.repo, 'typo')));
});
