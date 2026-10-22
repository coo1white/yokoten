// Tests for src/agents/desk/seatbelt.ts: the profile sandbox-exec gets. This machine may
// not be a Mac, so the profile is checked as text here; start.test.ts checks the contract
// for real when it runs on macOS.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DeskPlan } from '../../../src/agents/desk/desk.ts';
import { SEATBELT, sbplString, seatbeltProfile } from '../../../src/agents/desk/seatbelt.ts';
import { makeTempDir } from '../../repo/helpers.ts';

const PLAN: DeskPlan = {
  desk: '/Users/someone/projects/desk',
  state: ['/Users/someone/.codex'],
  readable: ['/opt/homebrew'],
  hidden: ['/Users', '/Volumes', '/Users/someone/projects'],
  locked: ['/Users/someone/projects/desk/.git/yokoten-worker'],
  hosts: ['api.example.com'],
  env: { YOKOTEN_ROLE: 'worker', TZ: 'UTC' },
  command: ['codex', 'exec', 'hello'],
};

/** The index of the first line that holds `text`, so a test can check which rule comes last. */
const lineOf = (profile: string, text: string) => profile.split('\n').findIndex((line) => line.includes(text));

test('sbplString: quotes and backslashes escaped; a line break refused', () => {
  assert.equal(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => sbplString('/a\n(allow default)'), /line break/);
});

test('seatbeltProfile: each allow comes after its deny, so the contract holds', () => {
  const profile = seatbeltProfile(PLAN, 49152, '/private/var/folders/x/scratch');
  // 3. Hidden folders can't be read; what is needed is shown again after.
  assert.ok(lineOf(profile, '(deny file-read* (subpath "/Users")') < lineOf(profile, '(allow file-read* (subpath "/opt/homebrew")'));
  assert.ok(profile.includes('(allow file-read* (subpath "/opt/homebrew") (subpath "/Users/someone/projects/desk") (subpath "/Users/someone/.codex") (subpath "/private/var/folders/x/scratch"))'));
  // 1 and 2. No writes but the desk, the state and the scratch folder; the lock last.
  assert.ok(lineOf(profile, '(deny file-write*)') < lineOf(profile, '(allow file-write* (subpath "/Users/someone/projects/desk")'));
  assert.ok(lineOf(profile, '(allow file-write* (subpath') < lineOf(profile, '(deny file-write* (literal "/Users/someone/projects/desk/.git/yokoten-worker"))'));
  // 5. No network but the proxy's port.
  assert.ok(lineOf(profile, '(deny network*)') < lineOf(profile, '(allow network-outbound (remote ip "localhost:49152"))'));
  assert.ok(!/allow network\*/.test(profile));
  // 4. Child processes.
  assert.ok(profile.includes('(allow process-fork)') && profile.includes('(allow process-exec)'));
});

test('seatbeltProfile: a port that is not a port is refused', () => {
  assert.throws(() => seatbeltProfile(PLAN, 0, '/tmp/x'), /not a port/);
});

test('SEATBELT.fence: sandbox-exec with the written profile, the proxy names and a private TMPDIR', () => {
  const scratch = makeTempDir('seatbelt-');
  const fenced = SEATBELT.fence(PLAN, 49152, scratch);
  assert.equal(fenced.file, '/usr/bin/sandbox-exec');
  assert.deepEqual(fenced.args, ['-f', join(scratch, 'desk.sb'), ...PLAN.command]);
  assert.equal(readFileSync(join(scratch, 'desk.sb'), 'utf8'), seatbeltProfile(PLAN, 49152, scratch));
  assert.equal(fenced.env.HTTPS_PROXY, 'http://127.0.0.1:49152');
  assert.equal(fenced.env.TMPDIR, join(scratch, 'tmp'));
  assert.equal(SEATBELT.proxyAddress(scratch), 0);
});
