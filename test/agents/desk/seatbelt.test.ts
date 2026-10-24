// Tests for src/agents/desk/seatbelt.ts: the profile sandbox-exec gets. This machine may
// not be a Mac, so the profile is checked as text here; start.test.ts checks the contract
// for real when it runs on macOS.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DeskPlan } from '../../../src/agents/desk/desk.ts';
import { parentFolders, SEATBELT, sbplString, seatbeltProfile } from '../../../src/agents/desk/seatbelt.ts';
import { makeTempDir } from '../../repo/helpers.ts';

const PLAN: DeskPlan = {
  desk: '/Users/someone/projects/desk',
  state: ['/Users/someone/projects/desk.state/codex'],
  readable: ['/opt/homebrew'],
  hidden: ['/Users', '/Volumes', '/Users/someone/projects'],
  locked: ['/Users/someone/projects/desk/.git/config', '/Users/someone/projects/desk/.git/hooks'],
  hosts: ['api.example.com'],
  env: { YOKOTEN_ROLE: 'worker', TZ: 'UTC' },
  command: ['codex', 'exec', 'hello'],
};


test('sbplString: quotes and backslashes escaped; a line break refused', () => {
  assert.equal(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => sbplString('/a\n(allow default)'), /line break/);
});

test('seatbeltProfile: starts from deny default and allows only what the contract needs', () => {
  const scratch = '/private/var/folders/x/scratch';
  const profile = seatbeltProfile(PLAN, 49152, scratch);
  const rules = profile.split('\n').filter((line) => line.startsWith('('));
  assert.equal(rules[1], '(deny default)');
  assert.ok(!profile.includes('(allow default)'));
  // 3. Reads: the shown paths, the desk, its state and the scratch folder; no home, no shared temp.
  const reads = rules.find((line) => line.startsWith('(allow file-read* ')) ?? '';
  for (const path of ['/opt/homebrew', PLAN.desk, ...PLAN.state, scratch]) assert.ok(reads.includes(`(subpath "${path}")`), path);
  for (const path of ['/Users"', '/Users/someone"', '/private/tmp"', '/private/var/folders"']) assert.ok(!reads.includes(`(subpath "${path}`), `${path} is not readable`);
  // Parent folders get their own metadata only, never a subpath.
  const metadata = rules.find((line) => line.startsWith('(allow file-read-metadata')) ?? '';
  assert.ok(metadata.includes('(literal "/Users/someone/projects")') && !metadata.includes('subpath'));
  // 1 and 2. Writes only in the desk, its state and the scratch folder; the locks denied last.
  assert.ok(profile.includes(`(allow file-write* (subpath "${PLAN.desk}") (subpath "/Users/someone/projects/desk.state/codex") (subpath "${scratch}"))`));
  assert.ok(rules.indexOf(rules.find((line) => line.startsWith('(deny file-write*')) ?? '') > rules.findIndex((line) => line.startsWith('(allow file-write* (subpath')));
  assert.ok(profile.includes('(deny file-write* (subpath "/Users/someone/projects/desk/.git/config") (subpath "/Users/someone/projects/desk/.git/hooks"))'));
  // 5. No network but the proxy port.
  assert.deepEqual(rules.filter((line) => line.includes('network')), ['(allow network-outbound (remote ip "localhost:49152"))']);
  // No door out: open, osascript, Launch Services, Apple events, and only listed Mach services.
  assert.ok(profile.includes('(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))'));
  assert.ok(profile.includes('(deny lsopen)') && profile.includes('(deny appleevent-send)'));
  assert.ok(!/\(allow mach-lookup\)|global-name "com\.apple\.coreservices/.test(profile), 'no open Mach lookup, no Launch Services');
});

test('seatbeltProfile: dyld may list the root folder and use /dev/dtracehelper, nothing more', () => {
  const profile = seatbeltProfile(PLAN, 3128, '/private/var/folders/xy/scratch');
  assert.match(profile, /^\(allow file-read-data \(literal "\/"\)\)$/m);
  assert.match(profile, /\(allow file-ioctl [^\n]*\(literal "\/dev\/dtracehelper"\)/);
  assert.match(profile, /\(allow file-write\* [^\n]*\(literal "\/dev\/dtracehelper"\)/);
  // The root's entries only: no subpath read of / or of a hidden folder.
  assert.doesNotMatch(profile, /\(subpath "\/"\)/);
  assert.doesNotMatch(profile, /file-read[^\n]*\(subpath "\/Users"\)/);
});

test('seatbeltProfile: /etc/grok is readable, so a missing settings file reads as missing (#771)', () => {
  const profile = seatbeltProfile(PLAN, 3128, '/private/var/folders/xy/scratch');
  const reads = profile.split('\n').find((line) => line.startsWith('(allow file-read* ')) ?? '';
  assert.ok(reads.includes('(subpath "/etc/grok")'), 'the program may look in /etc/grok');
  const writes = profile.split('\n').filter((line) => line.startsWith('(allow file-write*'));
  assert.ok(!writes.some((line) => line.includes('/etc/grok')), 'system settings stay read-only');
});

test('seatbeltProfile: git may look for its config in a hidden home, and finds nothing', () => {
  const profile = seatbeltProfile({ ...PLAN, env: { ...PLAN.env, HOME: '/Users/someone' } }, 3128, '/private/var/folders/xy/scratch');
  const reads = profile.split('\n').find((line) => line.startsWith('(allow file-read* ')) ?? '';
  assert.ok(reads.includes('(subpath "/Users/someone/.gitconfig")') && reads.includes('(subpath "/Users/someone/.config/git")'));
  assert.ok(!reads.includes('(subpath "/Users/someone")') && !reads.includes('(subpath "/Users/someone/.config")'));
});

test('parentFolders: each parent once, up to the root', () => {
  assert.deepEqual(parentFolders(['/a/b/c', '/a/d']), ['/', '/a', '/a/b']);
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
