// Tests for src/agents/folder-trust.ts.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { folderKeys } from '../../src/agents/folder-trust.ts';

test('folderKeys: the folder as given, without a trailing slash, and its real path behind a symlink (#341)', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'yokoten-')));
  const real = join(base, 'repo');
  mkdirSync(real);
  symlinkSync(real, join(base, 'link'));
  assert.deepEqual(folderKeys(real), [real]);
  assert.deepEqual(folderKeys(`${real}/`), [real]);
  assert.deepEqual(folderKeys(join(base, 'link')), [join(base, 'link'), real]);
  assert.deepEqual(folderKeys(join(base, 'gone')), [join(base, 'gone')], 'a folder that is gone keeps the path as given');
});
