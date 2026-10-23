// Tests for src/run/packaging.ts and scripts/packaging.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../repo/helpers.ts';
import { findReleaseProblems, renderHomebrewFormula, renderReleaseFiles, renderScoopManifest, sha256OfFile, writeReleaseFiles } from '../../src/run/packaging.ts';
import { main } from '../../scripts/packaging.ts';

const RELEASE = { version: '0.1.0', sha256: 'a'.repeat(64) };

test('packaging: the formula depends on node and installs the published package', () => {
  const formula = renderHomebrewFormula(RELEASE);
  assert.match(formula, /^class Yokoten < Formula$/m);
  assert.match(formula, /url "https:\/\/registry\.npmjs\.org\/yokoten\/-\/yokoten-0\.1\.0\.tgz"/);
  assert.match(formula, new RegExp(`sha256 "${RELEASE.sha256}"`));
  assert.match(formula, /^  depends_on "node"$/m);
  // std_npm_args re-packs with --ignore-scripts and installs into libexec (#435).
  assert.match(formula, /system "npm", "install", \*std_npm_args/);
  assert.match(formula, /bin\.install_symlink libexec\.glob\("bin\/\*"\)/);
  assert.match(formula, /shell_output\("#\{bin\}\/yokoten --version"\)/);
  assert.match(formula, /shell_output\("#\{bin\}\/yokoten help"\)/, 'the test runs the command a user runs');
  assert.match(formula, /Run `yokoten install` once/, 'the caveat names the second step');
  assert.doesNotMatch(formula, /__|TODO|<version>|<sha256>/, 'no placeholder is left in the formula');
});

test('packaging: the Scoop manifest names Node, npm and the same checksum', () => {
  const manifest = JSON.parse(renderScoopManifest(RELEASE)) as Record<string, any>;
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.homepage, 'https://yokoten.app');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.depends, 'nodejs', 'Scoop installs Node for the command');
  assert.equal(manifest.url, 'https://registry.npmjs.org/yokoten/-/yokoten-0.1.0.tgz');
  assert.equal(manifest.hash, `sha256:${RELEASE.sha256}`);
  assert.equal(manifest.extract_dir, 'package', 'the npm tarball unpacks into package/');
  assert.equal(manifest.bin, 'yokoten.cmd', "npm's global launcher on Windows");
  // The script must never run a package script on the user's machine (#435).
  assert.match(manifest.installer.script.join('\n'), /npm install --global --ignore-scripts --prefix "\$dir" "\$dir"/);
  assert.match(manifest.installer.script.join('\n'), /yokoten\.cmd/, 'a missing launcher is an error, not a silent success');
  assert.equal(manifest.checkver.jsonpath, '$.version');
  assert.deepEqual(manifest.notes, ['Run `yokoten install` once to add the skills, agents and hooks.']);
});

test('packaging: one version and one checksum reach both installers', () => {
  const files = renderReleaseFiles(RELEASE);
  assert.deepEqual(files.map((file) => file.path), ['homebrew-tap/Formula/yokoten.rb', 'scoop-bucket/bucket/yokoten.json']);
  for (const file of files) assert.ok(file.text.includes(RELEASE.sha256), `${file.path} lacks the checksum`);
  const manifest = JSON.parse(files[1].text) as Record<string, string>;
  assert.equal(manifest.version, RELEASE.version);
});

test('packaging: a version or checksum that is not release-ready is refused before a write', () => {
  assert.deepEqual(findReleaseProblems(RELEASE), []);
  assert.deepEqual(findReleaseProblems({ version: '1.2.3-beta.1', sha256: '0'.repeat(64) }), []);
  // Positive control: each known-bad value is caught, not written.
  for (const version of ['v0.1.0', '0.1', '0.1.0 ', '', 'latest']) {
    assert.equal(findReleaseProblems({ version, sha256: RELEASE.sha256 }).length, 1, version);
  }
  for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '', 'sha256:' + 'a'.repeat(64)]) {
    assert.equal(findReleaseProblems({ version: '0.1.0', sha256 }).length, 1, sha256);
  }
  const out = makeTempDir();
  assert.throws(() => writeReleaseFiles({ version: 'v0.1.0', sha256: RELEASE.sha256 }, out), /version "v0.1.0" is not a release version/);
  assert.deepEqual(readdirSync(out), [], 'a refused input wrote nothing');
});

test('packaging: the files land in one folder per repo, and a file sha256 is lowercase hex', () => {
  const out = makeTempDir();
  const files = writeReleaseFiles(RELEASE, out);
  assert.deepEqual(files.map((file) => file.path), ['homebrew-tap/Formula/yokoten.rb', 'scoop-bucket/bucket/yokoten.json']);
  assert.equal(readFileSync(join(out, 'homebrew-tap/Formula/yokoten.rb'), 'utf8'), renderHomebrewFormula(RELEASE));
  assert.equal(readFileSync(join(out, 'scoop-bucket/bucket/yokoten.json'), 'utf8'), renderScoopManifest(RELEASE));
  // The empty string's sha256 is the value every tool prints: a positive control.
  const file = join(out, 'empty.txt');
  writeFileSync(file, '');
  assert.equal(sha256OfFile(file), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('packaging: the command takes a checksum, writes both files, and refuses a bad option', () => {
  const out = makeTempDir();
  assert.equal(main(['--sha256', RELEASE.sha256, '--out', out]), 0);
  assert.ok(existsSync(join(out, 'homebrew-tap/Formula/yokoten.rb')));
  assert.ok(existsSync(join(out, 'scoop-bucket/bucket/yokoten.json')));
  assert.equal(main(['--sha256', 'nope', '--out', makeTempDir()]), 1);
  assert.equal(main(['--sha256']), 1, 'a missing value is a usage error');
  assert.equal(main(['--wat']), 1);
  assert.equal(main(['--sha256', RELEASE.sha256, '--out']), 1);
});
