import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hideHome, loadMarks, notUtc, POSITIVE_CONTROL, scanText } from '../src/rules/privacy.ts';

// Samples are built from pieces so this file passes its own check.
const at = '@';
const ip = (...n: number[]) => n.join('.');

test('positive control: the known-bad sample is caught', () => {
  assert.equal(scanText(POSITIVE_CONTROL, { file: 'x' }).length, 2);
});

test('emails: personal ones are caught, noreply and examples are fine', () => {
  assert.equal(scanText(`me${at}gmail.com`, { file: 'a' }).length, 1);
  assert.match(scanText(`x\nmail me${at}mydomain.dev`, { file: 'a.md' })[0], /^a\.md:2: an email/);
  for (const ok of [`1+me${at}users.noreply.github.com`, `noreply${at}anthropic.com`, `you${at}example.com`, `a${at}host.test`]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  assert.deepEqual(scanText(`help${at}company.com`, { file: 'a', allow: [`help${at}company.com`] }), []);
});

test('emails: role addresses, forge SSH remotes and .local point at no person (#11)', () => {
  for (const ok of [
    `contact support${at}github.com`,
    `security${at}gitlab.com`,
    `remote: git${at}gitlab.com:owner/repo.git`,
    `git clone git${at}github.com:owner/repo`,
    `conf${at}test.local`,
    `1-me${at}users.noreply.gitlab.com`,
  ]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Still caught: a person at the same domains, and an SSH remote that names a private host.
  for (const bad of [`someone${at}gmail.com`, `someone${at}github.com`, `git${at}code.my-company.dev:team/app.git`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
});

test('IPs: real ones are caught, documentation ranges and versions are not', () => {
  for (const bad of [ip(100, 64, 1, 2), ip(10, 0, 0, 5), ip(8, 8, 8, 8), `host=${ip(203, 0, 114, 9)}:22`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
  for (const ok of [ip(127, 0, 0, 1), ip(192, 0, 2, 10), ip(198, 51, 100, 1), ip(0, 0, 0, 0), ip(999, 1, 1, 1), 'v1.2.3', '1.2.3.4.5']) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
});

test('private marks: matched without case, never echoed', () => {
  const problems = scanText('Deploy to Secret-Box tonight', { file: 'a', marks: ['secret-box'] });
  assert.equal(problems.length, 1);
  assert.ok(!/secret-box/i.test(problems[0]), 'the mark must not appear in the output');
});

test('private marks file: comments and blanks skipped, missing file is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const file = join(dir, 'marks');
  writeFileSync(file, '# header\n\nMyCity\n  myserver  \n');
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: file }), ['mycity', 'myserver']);
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: join(dir, 'none') }), []);
});

test('commit times: an ident with a non-UTC offset is caught (#40)', () => {
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 +0700`), true);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 -0500`), true);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 +0000`), false);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 -0000`), false);
  assert.equal(notUtc('no time here'), false);
});

test('output: the home folder shows as ~ (#25)', () => {
  assert.equal(hideHome('wrote /home/someone/.local/share/yokoten', { HOME: '/home/someone' }), 'wrote ~/.local/share/yokoten');
  assert.equal(hideHome('a /home/someone/ b /home/someone', { HOME: '/home/someone/' }), 'a ~/ b ~');
  assert.equal(hideHome('/x', { HOME: '/' }), '/x', 'a root home hides nothing');
});
