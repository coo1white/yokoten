// Tests for src/setup/doctor/host-disk.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import { formatSpace, isLowOnSpace, readKeptHostDisk } from '../../../src/setup/doctor/host-disk.ts';

const gb = 1024 ** 3;

/** A home folder with the kept reading `text` in machine.json, or none. */
const keptHome = (text?: string): string => {
  const home = makeTempDir('yokoten-host-disk-');
  if (text === undefined) return home;
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(home, '.config', 'yokoten', 'machine.json'), text);
  return home;
};

const cache = (over: Record<string, unknown> = {}) => ({ free: gb, size: 250 * gb, readAt: new Date().toISOString(), distro: 'Ubuntu', version: 2, ...over });

test('host-disk: the limit is 20 GB under 10%, or YOKOTEN_MIN_FREE_GB when set (#401)', () => {
  assert.ok(isLowOnSpace({ free: 0, size: 250 * gb }, {}));
  assert.ok(!isLowOnSpace({ free: 150 * gb, size: 2048 * gb }, {}), 'a big drive with room');
  assert.ok(isLowOnSpace({ free: 40 * gb, size: 2048 * gb }, { YOKOTEN_MIN_FREE_GB: '50' }));
  assert.ok(!isLowOnSpace({ free: 0, size: 250 * gb }, { YOKOTEN_MIN_FREE_GB: '0' }), '0 turns it off');
  assert.equal(formatSpace({ free: 8 * gb, size: 250 * gb }), '8.0 GB free of 250 GB');
});

test('host-disk: the kept reading is repeated only when it is fresh, whole and from WSL 2 (#401)', () => {
  assert.equal(readKeptHostDisk({ HOME: keptHome() }), null, 'no file');
  assert.equal(readKeptHostDisk({ HOME: keptHome('{ broken') }), null, 'broken JSON');
  assert.equal(readKeptHostDisk({ HOME: keptHome(JSON.stringify({ hostDisk: { free: 1 } })) }), null, 'not a reading');
  const now = new Date();
  const fresh = cache({ readAt: now.toISOString() });
  assert.deepEqual(readKeptHostDisk({ HOME: keptHome(JSON.stringify({ hostDisk: fresh })) }, now), fresh);
  assert.equal(readKeptHostDisk({ HOME: keptHome(JSON.stringify({ hostDisk: cache({ version: 1 }) })) }, now), null, 'WSL 1 has no disk file');
  assert.equal(readKeptHostDisk({ HOME: keptHome(JSON.stringify({ hostDisk: cache({ readAt: '2020-01-01T00:00:00Z' }) })) }, now), null, 'too old');
  assert.equal(readKeptHostDisk({ HOME: keptHome(JSON.stringify({ hostDisk: cache({ readAt: '2999-01-01T00:00:00Z' }) })) }, now), null, 'in the future');
  assert.equal(readKeptHostDisk({}), null, 'no home folder');
});
