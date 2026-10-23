// Tests for src/rules/layout.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/rules/config.ts';
import {
  checkBuildOutput,
  checkCodeOwners,
  checkLayout,
  codeOwnersPatternMatches,
  isBuildOutput,
} from '../../src/rules/layout.ts';
import { type Finding, formatFinding } from '../../src/rules/message.ts';

test('layout: a folder over the cap is reported once, the root never', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `docs/f${i}.md`);
  const rootFiles = Array.from({ length: 20 }, (_, i) => `r${i}`);
  const problems = checkLayout([...eight, ...rootFiles, 'docs/sub/a.md'], DEFAULTS);
  assert.equal(problems.length, 1);
  assert.match(formatFinding(problems[0]), /^docs\/: 9 entries, over the cap of 7/);
  assert.deepEqual(checkLayout(eight.slice(0, 7), DEFAULTS), []);
});

test('layout: an exempt folder may grow', () => {
  const records = Array.from({ length: 30 }, (_, i) => `docs/records/${i}.md`);
  assert.deepEqual(checkLayout(records, { layout: { maxEntries: 7, exempt: ['docs/records/'] } }), []);
});

test('layout: the message offers exempt for a log or a fixture set, not only a log (#381)', () => {
  const problems = checkLayout(Array.from({ length: 8 }, (_, i) => `fixtures/f${i}.xls`), DEFAULTS);
  assert.match(formatFinding(problems[0]), /layout\.exempt in yokoten\.json if it may grow: a log, or a third-party fixture set/);
});

const many = (dir: string, count = 9) => Array.from({ length: count }, (_, i) => `${dir}/f${i}.xls`);

test('layout: an exempt glob covers every crate of a Rust workspace, one segment per * (#381)', () => {
  const files = [...many('crates/app-core/tests/data'), ...many('crates/app-csv/tests/data')];
  const notes: Finding[] = [];
  assert.deepEqual(checkLayout(files, { layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } }, notes), []);
  assert.deepEqual(notes, []);
  // `*` is one whole folder: it does not reach two levels down, nor match part of a name.
  const deeper = checkLayout(many('crates/app-core/extra/tests/data'), { layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } });
  assert.equal(deeper.length, 1);
  assert.equal(checkLayout(many('crates/app-core/tests/data'), { layout: { maxEntries: 7, exempt: ['crates/app-*/tests/data'] } }).length, 1);
});

test('layout: ** in an exempt glob is any number of folders, none too (#381)', () => {
  const exempt = { layout: { maxEntries: 7, exempt: ['vendor/**/fixtures'] } };
  assert.deepEqual(checkLayout([...many('vendor/fixtures'), ...many('vendor/a/b/c/fixtures')], exempt), []);
  // The folders on the way stay counted.
  assert.equal(checkLayout(many('vendor/a'), exempt).length, 1);
});

test('layout: a near miss of an exempt glob is still counted (#381)', () => {
  const exempt = { layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } };
  for (const dir of ['crates/app-core/tests/data2', 'crates/app-core/test/data', 'crates/tests/data', 'other/app-core/tests/data', 'crates/app-core/tests']) {
    assert.equal(checkLayout(many(dir), exempt).length, 1, dir);
  }
  // A dot is a dot, not any character.
  assert.equal(checkLayout(many('docsxrecords'), { layout: { maxEntries: 7, exempt: ['docs.records'] } }).length, 1);
});

test('layout: an exempt glob that matches no folder is a note, an exact path is not (#381)', () => {
  const notes: Finding[] = [];
  const problems = checkLayout(many('docs/records'), { layout: { maxEntries: 7, exempt: ['docs/records', 'crates/*/tests/data', 'docs/old'] } }, notes);
  assert.deepEqual(problems, []);
  assert.equal(notes.length, 1);
  assert.match(formatFinding(notes[0]), /^yokoten\.json: layout\.exempt "crates\/\*\/tests\/data" matches no folder/);
  // Without a notes list, nothing is noted and nothing fails.
  assert.deepEqual(checkLayout([], { layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } }), []);
});

test('layout: exact exempt paths work as before, with or without a trailing slash (#381)', () => {
  assert.deepEqual(checkLayout(many('docs/records'), { layout: { maxEntries: 7, exempt: ['docs/records'] } }), []);
  assert.deepEqual(checkLayout(many('docs/records'), { layout: { maxEntries: 7, exempt: ['./docs/records/'] } }), []);
  assert.equal(checkLayout(many('a/docs/records'), { layout: { maxEntries: 7, exempt: ['docs/records'] } }).length, 1, 'anchored at the root');
});

test('layout: changes/ may grow, since a release empties it (#132)', () => {
  const changes = Array.from({ length: 12 }, (_, index) => `changes/${index}-a.md`);
  assert.deepEqual(checkLayout(changes, DEFAULTS), []);
  assert.equal(checkLayout(changes.map((file) => `docs/${file}`), DEFAULTS).length, 1, 'only the changes/ folder at the root');
});

test('layout: .worktrees/ is skipped, whole checkouts and all (#571)', () => {
  const trees = [...Array.from({ length: 12 }, (_, i) => `.worktrees/${i}-x/AGENTS.md`), ...many('.worktrees/571-x/src')];
  assert.deepEqual(checkLayout(trees, DEFAULTS), []);
  // A miss by one letter still counts.
  assert.equal(checkLayout(many('worktrees'), DEFAULTS).length, 1);
});

test('build output: build folders and binaries are refused, images, fonts and allowed paths pass (#56)', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, binary: !/\.(js|ts|md|svg)$/.test(path) }));
  const problems = checkBuildOutput(files('dist/app.js', 'pkg/build/x.js', 'out/a.md', 'tool.exe', 'lib.wasm', 'data.bin'), DEFAULTS);
  assert.equal(problems.length, 6);
  assert.match(formatFinding(problems[0]), /^dist\/app\.js: build output, in a dist\/ folder\..*git rm --cached dist\/app\.js.*allowBuild in yokoten\.json/);
  assert.match(formatFinding(problems[3]), /^tool\.exe: a binary file\./);
  // Text whose name says built still counts; images and fonts do not.
  assert.equal(checkBuildOutput([{ path: 'lib.wasm', binary: false }], DEFAULTS).length, 1);
  assert.deepEqual(checkBuildOutput(files('docs/a.png', 'site/logo.svg', 'fonts/x.woff2', 'src/output.ts', 'distance.js'), DEFAULTS), []);
  assert.deepEqual(checkBuildOutput(files('dist/app.js', 'vendor/tool.zip'), { allowBuild: ['dist/**', '*.zip'] }), []);
  assert.ok(isBuildOutput('a/dist/b.js') && !isBuildOutput('a/dist/b.js', () => true) && !isBuildOutput('dist.md'));
});

test('build output: many files under one folder make one finding for the folder (#521)', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, binary: false }));
  // A dependency folder: one finding, however many files, and one file alone too.
  const modules = Array.from({ length: 48 }, (_, i) => `node_modules/pkg/dist/f${i}.js`);
  const problems = checkBuildOutput(files(...modules, 'src/a.ts'), DEFAULTS);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, 'node_modules/');
  assert.match(formatFinding(problems[0]), /^node_modules\/: a dependency folder, with 48 of its files in the commit\..*git rm -r --cached node_modules.*stays on disk.*add `node_modules\/` to .gitignore/);
  assert.equal(checkBuildOutput(files('web/node_modules/a/dist/x.js'), DEFAULTS)[0].file, 'web/node_modules/');
  // A build folder: two files group, one file keeps its own line.
  const built = checkBuildOutput(files('dist/a.js', 'dist/b.js', 'out/c.js'), DEFAULTS);
  assert.deepEqual(built.map((problem) => problem.file), ['dist/', 'out/c.js']);
  assert.match(formatFinding(built[0]), /^dist\/: build output, with 2 files in a dist\/ folder\..*git rm -r --cached dist/);
  // Every file in node_modules counts, not only built ones; a vendor/ file only when it is built.
  assert.match(formatFinding(checkBuildOutput(files('node_modules/a/index.js', 'node_modules/a/package.json'), DEFAULTS)[0]), /with 2 of its files/);
  assert.deepEqual(checkBuildOutput(files('vendor/lib/a.go'), DEFAULTS), []);
  // allowBuild still lets a path through.
  assert.deepEqual(checkBuildOutput(files('node_modules/a.js'), { allowBuild: ['node_modules/**'] }), []);
});

// ---- CODEOWNERS (#667) ----

const OWNED_FILES = ['.github/CODEOWNERS', 'docs/guide.md', 'src/app.ts', 'src/host/github/index.ts'];

test('codeowners: a line that names a removed file is reported (#667)', () => {
  const found = checkCodeOwners(OWNED_FILES, '# the owners\nsrc/host/github.ts @lead\n');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, 'codeowners');
  assert.equal(found[0]?.file, '.github/CODEOWNERS');
  assert.equal(found[0]?.line, 2);
  assert.match(found[0]?.what ?? '', /^src\/host\/github\.ts matches no file: this rule protects nothing; point it at the new path$/);
  assert.match(found[0]?.fix ?? '', /ask the lead or owner to change it in \.github\/CODEOWNERS/);
});

test('codeowners: a folder, a glob and a file that exist are not reported (#667)', () => {
  assert.deepEqual(checkCodeOwners(OWNED_FILES, '/docs/ @lead\nsrc/**/*.ts @lead\n/.github/CODEOWNERS @lead\n* @lead\n'), []);
});

test('codeowners: an empty file, or none, is quiet (#667)', () => {
  assert.deepEqual(checkCodeOwners(OWNED_FILES, ''), []);
  assert.deepEqual(checkCodeOwners(OWNED_FILES, '# nothing is owned yet\n\n'), []);
});

test('codeowners: a lead-only path init wrote before it exists is a guard, not a stale line (#667)', () => {
  assert.deepEqual(checkCodeOwners(OWNED_FILES, '/.codex/ @lead\n', '.github/CODEOWNERS', new Set(['/.codex/'])), []);
  assert.equal(checkCodeOwners(OWNED_FILES, '/.codex/ @lead\n').length, 1);
});

test('codeowners: a pattern with * matches when any file does (#667)', () => {
  assert.equal(codeOwnersPatternMatches('src/*/index.ts', 'src/host/index.ts'), true);
  assert.equal(codeOwnersPatternMatches('src/*/index.ts', 'src/host/github/index.ts'), false);
  assert.equal(codeOwnersPatternMatches('docs/', 'docs/a/b.md'), true);
  assert.equal(codeOwnersPatternMatches('*.md', 'deep/a/b.md'), true);
  assert.equal(codeOwnersPatternMatches('docs/**/a.md', 'docs/a.md'), true);
});
