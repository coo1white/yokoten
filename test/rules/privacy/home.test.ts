// Tests for src/rules/privacy/home.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import type { Env } from '../../../src/rules/config.ts';
import { homeIn, homeOf, loadMarks, marksFile, marksFiles, NO_HOME, ownMarks, realHomeRead, useRealHome, withHome, writtenMarksOnly } from '../../../src/rules/privacy/home.ts';
import { repoMarkKinds } from '../../../src/rules/privacy/allow.ts';
import { loadMarkKinds } from '../../../src/rules/privacy/marks.ts';
import { formatFinding } from '../../../src/rules/message.ts';
import { scanText } from '../../../src/rules/privacy/scan.ts';
test('withHome: only the CLI entry falls back to the system home, and only when HOME is not a full path (#356)', () => {
  const system = () => '/home/someone';
  assert.deepEqual(withHome({ HOME: '/h', X: '1' }, system), { HOME: '/h', X: '1' });
  assert.deepEqual(withHome({ X: '1' }, system), { HOME: '/home/someone', X: '1' });
  assert.deepEqual(withHome({ HOME: 'relative' }, system), { HOME: '/home/someone' });
  assert.deepEqual(withHome({ HOME: '' }, () => 'also/relative'), { HOME: '' }, 'no full path anywhere: no home');
  const env: Env = { PATH: '/bin' };
  withHome(env, system);
  assert.deepEqual(env, { PATH: '/bin' }, 'the env it is given stays as it was');
  assert.equal(homeIn({ HOME: '/h' }), '/h');
  assert.throws(() => homeIn({}), /no home folder/, 'no fallback outside the CLI entry');
});

test('home: withHome fills a missing home from the system, and keeps a full one (#356)', () => {
  assert.deepEqual(withHome({}, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-system' });
  assert.deepEqual(withHome({ HOME: 'relative' }, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-system' });
  assert.deepEqual(withHome({ HOME: '/tmp/yokoten-mine' }, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-mine' });
  // The positive control: a system that can tell no home leaves the env as it was.
  assert.deepEqual(withHome({}, () => ''), {});
});

test('private marks file: comments and blanks skipped, missing file is empty', () => {
  const dir = makeTempDir();
  const file = join(dir, 'marks');
  writeFileSync(file, '# header\n\nMyCity\n  myserver  \n');
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: file }), ['mycity', 'myserver']);
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: join(dir, 'none') }), []);
});

test('marks: the default file sits under the home folder', () => {
  const home = makeTempDir();
  assert.equal(marksFile({ HOME: home }), join(home, '.config', 'yokoten', 'private-marks'));
  assert.deepEqual(marksFiles({ HOME: home }), [join(home, '.config', 'yokoten', 'private-marks')]);
});

test('marks: every line that is not blank or a comment is a mark, lowercased once', () => {
  const home = makeTempDir();
  const file = marksFile({ HOME: home });
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(file, '# your own marks\n\nAlice\nALICE\nexample.test\n');
  const restore = useRealHome(() => '');
  try {
    assert.deepEqual(loadMarks({ HOME: home }), ['alice', 'example.test']);
  } finally {
    restore();
  }
});

test('marks: YOKOTEN_PRIVATE_MARKS adds a file; writtenMarksOnly drops it (#656)', () => {
  const home = makeTempDir();
  const extra = join(home, 'extra-marks');
  const env = { HOME: home, YOKOTEN_PRIVATE_MARKS: extra };
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(marksFile({ HOME: home }), 'default-mark\n');
  writeFileSync(extra, 'extra-mark\n');
  const restore = useRealHome(() => '');
  try {
    assert.deepEqual(loadMarks(env), ['default-mark', 'extra-mark']);
    assert.deepEqual(marksFiles(env), [marksFile({ HOME: home }), extra]);
    assert.deepEqual(marksFiles(writtenMarksOnly(env)), [marksFile({ HOME: home })]);
  } finally {
    restore();
  }
});

test('private marks file: the setting adds a second list to the default file, never replaces it (#656)', () => {
  const home = makeTempDir();
  const config = join(home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  const own = join(config, 'private-marks');
  writeFileSync(own, '# added by yokoten from this machine: forge login\nOcto-Jdoe\nMyCity');
  const extra = join(home, 'extra');
  writeFileSync(extra, 'myserver\nmycity\n');
  const empty = join(home, 'empty');
  writeFileSync(empty, '');
  assert.deepEqual(loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: empty }), ['octo-jdoe', 'mycity']);
  assert.deepEqual(loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), ['octo-jdoe', 'mycity', 'myserver']);
  assert.deepEqual(loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: join(home, 'none') }), ['octo-jdoe', 'mycity']);
  // A header in one file never names the kind of a line in the next.
  assert.deepEqual(loadMarkKinds({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), [
    { value: 'octo-jdoe', kind: 'forge login' },
    { value: 'mycity', kind: 'forge login' },
    { value: 'myserver', kind: null },
  ]);
  // yokoten writes to the default file, and the setting names the same file only once.
  assert.equal(marksFile({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), own);
  assert.deepEqual(marksFiles({ HOME: home, YOKOTEN_PRIVATE_MARKS: own }), [own]);
});

test('private marks file: a default file that can not be read throws, whatever the setting names (#656)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const home = makeTempDir();
  const config = join(home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  const own = join(config, 'private-marks');
  writeFileSync(own, 'mycity\n');
  chmodSync(own, 0o000);
  const extra = join(home, 'extra');
  writeFileSync(extra, 'myserver\n');
  try {
    assert.throws(() => loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), { code: 'EACCES' });
    assert.throws(() => loadMarkKinds({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), { code: 'EACCES' });
  } finally {
    chmodSync(own, 0o600);
  }
});

test('ownMarks and scanText: a mark the project allows, same string case aside, is not reported (#424)', () => {
  const marks = ['quietvale', 'quietvale labs', 'vale'];
  assert.deepEqual(ownMarks(marks, ['QuietVale']), ['quietvale']);
  const hits = (text: string, allow: string[]) => scanText(text, { file: 'a', marks: ['quietvale'], allow }).length;
  assert.equal(hits('QuietVale ships', ['QUIETVALE']), 0, 'case does not matter');
  assert.equal(hits('QuietVale ships', []), 1, 'with no allow, it is stopped');
  // Near misses: a part, a longer string, or spaces around it allow nothing.
  for (const allow of [['quiet'], ['quietvale2'], ['quietvale labs'], [' quietvale'], ['quietval'], ['xquietvale']]) {
    assert.equal(hits('QuietVale ships', allow), 1, JSON.stringify(allow));
  }
  // Allowing one mark leaves the longer and shorter marks that hold it.
  const all = (text: string) => scanText(text, { file: 'a', marks, allow: ['quietvale'] }).length;
  assert.equal(all('QuietVale ships from the vale'), 1, 'the shorter mark vale still matches');
  assert.equal(all('QuietVale Labs ships'), 2, 'quietvale labs still matches, and so does vale after a small letter (#434)');
  const finding = scanText('QuietVale Labs', { file: 'a', marks, allow: ['quietvale'] }).map((f) => formatFinding(f)).join('\n');
  assert.ok(!/quietvale|vale/i.test(finding), 'no mark is printed');
});

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

test('marks: a missing file has no marks, and the real home cannot hide that', () => {
  const home = makeTempDir();
  const restore = useRealHome(() => '');
  try {
    assert.deepEqual(loadMarks({ HOME: home }), []);
    // The positive control: the same read finds a mark once the file has one.
    mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
    writeFileSync(marksFile({ HOME: home }), 'a-mark\n');
    assert.deepEqual(loadMarks({ HOME: home }), ['a-mark']);
  } finally {
    restore();
  }
});

test('private marks file: a missing default file fails closed when the real home has one it cannot read (#739)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const home = makeTempDir();
  const real = makeTempDir();
  const hidden = join(real, '.config', 'yokoten', 'private-marks');
  mkdirSync(join(real, '.config', 'yokoten'), { recursive: true });
  writeFileSync(hidden, 'mycity\n');
  chmodSync(hidden, 0o000);
  const extra = join(home, 'extra');
  writeFileSync(extra, 'otherword\n');
  const restore = useRealHome(() => real);
  try {
    assert.throws(() => loadMarks({ HOME: home }), /cannot be read/);
    assert.throws(() => loadMarkKinds({ HOME: home }), /cannot be read/);
    // No HOME is the same file. A process started without HOME cannot skip it.
    assert.throws(() => loadMarks({}), /cannot be read/);
    assert.throws(() => loadMarkKinds({}), /cannot be read/);
    // The setting only adds. It does not hide an unreadable file in the real home.
    assert.throws(() => loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), /cannot be read/);
    assert.throws(() => repoMarkKinds({ HOME: home }, home), /cannot be read/);
  } finally {
    chmodSync(hidden, 0o600);
    restore();
  }
});

// The preload is --require, not --import (#750). A child must still get an empty real home,
// and useRealHome must stack on that same slot. Nothing here prints a path or a mark.
test('private marks: a node child keeps the empty real-home stand-in (#739)', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { loadMarks, useRealHome } from './src/rules/privacy/index.ts';",
    "const key = Symbol.for('yokoten.readRealHome');",
    "const preload = globalThis[key];",
    "if (typeof preload !== 'function' || preload() !== '') process.exit(2);",
    "const home = mkdtempSync(join(tmpdir(), 'yokoten-child-home-'));",
    "if (loadMarks({ HOME: home }).length !== 0) process.exit(3);",
    "const restore = useRealHome(() => join(tmpdir(), 'not-a-home'));",
    "const swapped = globalThis[key]() !== '';",
    "restore();",
    "if (!swapped || globalThis[key] !== preload) process.exit(4);",
    "process.stdout.write('ok');",
  ].join('\n')], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'ok');
});

test('private marks file: a missing real-home file stays empty, and a readable one is used (#739)', () => {
  const home = makeTempDir();
  const real = makeTempDir();
  const restore = useRealHome(() => real);
  try {
    assert.deepEqual(loadMarks({ HOME: home }), []);
    assert.deepEqual(loadMarkKinds({ HOME: home }), []);
    assert.deepEqual(loadMarks({}), []);
    assert.deepEqual(loadMarkKinds({}), []);
    mkdirSync(join(real, '.config', 'yokoten'), { recursive: true });
    writeFileSync(join(real, '.config', 'yokoten', 'private-marks'), 'MyCity\n# added by yokoten from this machine: forge login\nOcto-Jdoe\n');
    // A changed HOME must not skip a marks file the check can read. The role does not matter.
    assert.deepEqual(loadMarks({ HOME: home }), ['mycity', 'octo-jdoe']);
    assert.deepEqual(loadMarks({ HOME: home, YOKOTEN_ROLE: 'worker' }), ['mycity', 'octo-jdoe']);
    // No HOME, or an empty one, still has the real home. The role does not matter.
    assert.deepEqual(loadMarks({}), ['mycity', 'octo-jdoe']);
    assert.deepEqual(loadMarks({ HOME: '' }), ['mycity', 'octo-jdoe']);
    assert.deepEqual(loadMarks({ HOME: 'relative' }), ['mycity', 'octo-jdoe']);
    assert.deepEqual(loadMarks({ YOKOTEN_ROLE: 'worker' }), ['mycity', 'octo-jdoe']);
    assert.deepEqual(loadMarkKinds({ HOME: home }), [
      { value: 'mycity', kind: null },
      { value: 'octo-jdoe', kind: 'forge login' },
    ]);
    assert.deepEqual(loadMarkKinds({}), [
      { value: 'mycity', kind: null },
      { value: 'octo-jdoe', kind: 'forge login' },
    ]);
    // The setting only adds. It does not replace the real home's marks.
    const extra = join(home, 'extra');
    writeFileSync(extra, 'otherword\n');
    assert.deepEqual(loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), ['mycity', 'octo-jdoe', 'otherword']);
    assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: extra }), ['mycity', 'octo-jdoe', 'otherword']);
    // An empty stand-in file is still no marks of its own, so the real file is used.
    mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
    writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), '\n# none\n');
    assert.deepEqual(loadMarks({ HOME: home }), ['mycity', 'octo-jdoe']);
    // The same folder is the one $HOME already names: there is nothing further to read.
    const same = useRealHome(() => home);
    try {
      assert.deepEqual(loadMarks({ HOME: home }), []);
    } finally {
      same();
    }
  } finally {
    restore();
  }
});

test('private marks file: a readable default file does not read the real home (#739)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const home = makeTempDir();
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), 'mycity\n');
  const real = makeTempDir();
  const hidden = join(real, '.config', 'yokoten', 'private-marks');
  mkdirSync(join(real, '.config', 'yokoten'), { recursive: true });
  writeFileSync(hidden, 'otherword\n');
  chmodSync(hidden, 0o000);
  const restore = useRealHome(() => real);
  try {
    assert.deepEqual(loadMarks({ HOME: home }), ['mycity']);
    assert.deepEqual(loadMarkKinds({ HOME: home }), [{ value: 'mycity', kind: null }]);
  } finally {
    chmodSync(hidden, 0o600);
    restore();
  }
});
