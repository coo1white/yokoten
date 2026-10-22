// Tests for src/setup/doctor/index.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';

test('doctor: a marks file it can not read is named as unreadable, not missing (#656)', async () => {
  const sandbox = makeSandbox();
  const config = join(sandbox.home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'private-marks'), 'quietharbor\n');
  const folder = join(sandbox.home, 'marks-folder');
  mkdirSync(folder);
  const result = await sandbox.call(['doctor'], { extra: { YOKOTEN_PRIVATE_MARKS: folder } });
  const out = result.stdout;
  assert.match(out, /private-marks: a private-marks file can't be read, so the privacy check stops every commit; make ~\/\.config\/yokoten\/private-marks readable/);
  assert.doesNotMatch(out, /is missing or has no marks/);
  assert.doesNotMatch(out, /quietharbor/i);
});
