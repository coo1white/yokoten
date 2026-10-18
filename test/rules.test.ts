import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, matcher } from '../src/rules/config.ts';
import { checkCommand, checkEdit } from '../src/rules/guards.ts';
import { checkBuildOutput, checkLayout, isBuildOutput } from '../src/rules/layout.ts';
import { DOCS_URL, type Finding, finding, formatFinding, type Rule, RULES } from '../src/rules/message.ts';
import { POSITIVE_CONTROL, scanText } from '../src/rules/privacy.ts';
import { SECRET_CONTROL } from '../src/rules/secrets.ts';
import { check, timeZoneNote } from '../src/run/check.ts';
import { parseSourceMarker, sourceMarker, translationNotes } from '../src/run/translations.ts';
import { agentHooks, coreRulesCheck, machineChecks } from '../src/setup/doctor.ts';
import { compareCoreRules, compareVersions, readKitVersion } from '../src/setup/init.ts';
import { explain, explainLines, ids } from '../src/setup/explain.ts';
import { ROAD, serverChecks, stepFinding } from '../src/setup/road.ts';
import { isCodeFile, nameNotes } from '../src/run/names.ts';
import { formatChanges, mergeChanges, parseChange, readChanges, writeChanges } from '../src/run/changelog.ts';
import { addedLinesByFile, changedLines, checkIssueTitle, checkOwnedTier, checkPullRequest, checkPullRequestTitle, isChangeFile, ownersOf, parseCodeOwners, largeDiff, longSentenceNote, longSentences, type PullRequest } from '../src/rules/pr.ts';

test('glob: a slash anchors at the root, no slash matches in any folder', () => {
  const m = (g: string, p: string) => matcher([g])(p);
  assert.ok(m('test/**', 'test/a/b.ts'));
  assert.ok(!m('test/**', 'src/test/a.ts'));
  assert.ok(m('*.test.*', 'src/deep/a.test.ts'));
  assert.ok(m('.github/**', '.github/workflows/ci.yml'));
  assert.ok(!m('.github/**', 'kit/.github/x'));
  assert.ok(m('src/**/x.ts', 'src/x.ts'));
  assert.ok(m('src/**/x.ts', 'src/a/b/x.ts'));
  assert.ok(m('a?.md', 'ab.md'));
  assert.ok(!m('a?.md', 'a/.md'));
  assert.ok(!m('a.md', 'aXmd'), 'a dot is a dot');
});

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

test('layout: changes/ may grow, since a release empties it (#132)', () => {
  const changes = Array.from({ length: 12 }, (_, index) => `changes/${index}-a.md`);
  assert.deepEqual(checkLayout(changes, DEFAULTS), []);
  assert.equal(checkLayout(changes.map((file) => `docs/${file}`), DEFAULTS).length, 1, 'only the changes/ folder at the root');
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

test('config: missing file means defaults, a key overrides, bad JSON says where', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  assert.deepEqual(loadConfig(dir).layout, DEFAULTS.layout);
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ layout: { maxEntries: 9 }, notNow: { ci: 'later' } }));
  const c = loadConfig(dir);
  assert.equal(c.layout.maxEntries, 9);
  assert.deepEqual(c.layout.exempt, []);
  assert.equal(c.notNow.ci, 'later');
  assert.deepEqual(c.tests, DEFAULTS.tests);
  assert.deepEqual(c.allowBuild, []);
  writeFileSync(join(dir, 'yokoten.json'), '{ nope');
  assert.throws(() => loadConfig(dir), /^Error: yokoten\.json:/);
});

const goodPr = (): PullRequest => ({
  title: 'feat(kit): a pull request standard, checked in CI',
  body: 'tier: B\nCloses #47\n\n## Why\nNothing checks it.\n\n## What changed\n- a rule\n\n## How tested\n`node --test`: 50 pass.\n',
  files: ['src/rules/pr.ts', 'CHANGELOG.md'],
  labels: ['feat', 'tier B'],
  milestone: 'M0 pre-hackathon',
});

test('pull request: a good one passes (#47)', () => {
  assert.deepEqual(checkPullRequest(goodPr(), DEFAULTS), []);
  assert.deepEqual(checkPullRequest({ ...goodPr(), title: 'fix!: drop the old flag' }, DEFAULTS), [], 'no area, breaking mark');
});

test('pull request: each missing part fails with what to do (#47)', () => {
  const one = (change: Partial<PullRequest>, pattern: RegExp) => {
    const problems = checkPullRequest({ ...goodPr(), ...change }, DEFAULTS);
    assert.equal(problems.length, 1, `${JSON.stringify(change)} -> ${problems.map(formatFinding).join(' | ')}`);
    assert.match(formatFinding(problems[0]), pattern);
  };
  one({ title: 'Added a pull request check' }, /^title: not in the commit form\. .* Use `type\(area\): summary`/);
  one({ title: 'feat: a pull request standard.' }, /full stop/);
  one({ title: 'feat: a pull request standard (#47)' }, /issue number/);
  one({ title: `feat: ${'a'.repeat(80)}` }, /over 72/);
  one({ body: goodPr().body.replace('tier: B\n', '') }, /`tier: A`/);
  one({ body: goodPr().body.replace('## How tested\n`node --test`: 50 pass.\n', '') }, /[Aa]dd a `## How tested`/);
  one({ body: goodPr().body.replace('Nothing checks it.', '<!-- say why -->') }, /`## Why` section is empty/);
  // A comment that never closes hides the rest on GitHub's page, so the check skips it too.
  one({ body: goodPr().body.replace('`node --test`', '<!-- how\n`node --test`') }, /`## How tested` section is empty/);
  // A comment rebuilt from pieces is text on GitHub's page, and to the check.
  assert.deepEqual(checkPullRequest({ ...goodPr(), body: goodPr().body.replace('Nothing checks it.', '<!<!---->-- Nothing checks it.') }, DEFAULTS), []);
  // Inside code, `<!--` is only text: in a code span, and in a fenced block.
  assert.deepEqual(checkPullRequest({ ...goodPr(), body: goodPr().body.replace('Nothing checks it.', 'A `<!--` that never closes. Also ``a ` <!-- b``.') }, DEFAULTS), []);
  assert.deepEqual(checkPullRequest({ ...goodPr(), body: goodPr().body.replace('Nothing checks it.', 'See:\n```html\n<!-- open\n```\nThat is all.') }, DEFAULTS), []);
  one({ body: goodPr().body.replace('Closes #47', 'Closes #') }, /Closes #N/);
  one({ files: ['src/rules/pr.ts'] }, /^changelog:/);
  one({ milestone: null }, /^milestone:/);
  one({ labels: [] }, /^labels:/);
  one({ files: ['kit/project/AGENTS.md', 'CHANGELOG.md'] }, /changes `kit\/`/);
});

test('pull request: Closes, Fixes, Part of and Refs each link the issue (#82)', () => {
  for (const link of ['Closes #47', 'Fixes #47', 'Part of #47', 'part of #47', 'Refs #47']) {
    assert.deepEqual(checkPullRequest({ ...goodPr(), body: goodPr().body.replace('Closes #47', link) }, DEFAULTS), [], link);
  }
  for (const link of ['Part of 47', 'Partly #47', 'See #47']) {
    assert.deepEqual(checkPullRequest({ ...goodPr(), body: goodPr().body.replace('Closes #47', link) }, DEFAULTS).map((p) => p.id), ['pr-issue'], link);
  }
});

test('pull request: docs, tests and CI need no changelog line; a reason lets code through (#47)', () => {
  assert.deepEqual(checkPullRequest({ ...goodPr(), files: ['docs/guide.md', 'test/a.test.ts', '.github/workflows/pr.yml'] }, DEFAULTS), []);
  assert.deepEqual(checkPullRequest({ ...goodPr(), files: ['src/a.ts'], body: `${goodPr().body}No changelog: a comment only\n` }, DEFAULTS), []);
});

test('pull request: a file in changes/ counts as the changelog entry (#132)', () => {
  assert.deepEqual(checkPullRequest({ ...goodPr(), files: ['src/rules/pr.ts', 'changes/47-pr-standard.md'] }, DEFAULTS), []);
  const problems = checkPullRequest({ ...goodPr(), files: ['src/rules/pr.ts', 'changes/README.md'] }, DEFAULTS);
  assert.deepEqual(problems.map((problem) => problem.id), ['pr-changelog'], 'the README is not a change file');
  assert.match(formatFinding(problems[0]), /no new file in changes\/\..*Add `changes\/<issue>-<slug>\.md`/);
  const deletedOnly = checkPullRequest({ ...goodPr(), files: ['src/rules/pr.ts', 'changes/12-old.md'], deleted: ['changes/12-old.md'] }, DEFAULTS);
  assert.deepEqual(deletedOnly.map((problem) => problem.id), ['pr-changelog'], 'a deleted change file is not a new entry');
  assert.ok(isChangeFile('changes/1-a.md') && isChangeFile('changes/1-a.txt'));
  assert.ok(!isChangeFile('changes/README.md') && !isChangeFile('changes/.keep') && !isChangeFile('changes/a/b.md') && !isChangeFile('docs/changes/a.md'));
});

// ---- Change files (#132) ----

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- An old entry,',
  '  wrapped.',
  '',
  '### Fixed',
  '',
  '- An old fix.',
  '',
  '## [0.1.0] - 2026-10-18',
  '',
  '### Added',
  '',
  '- The first release.',
  '',
].join('\n');

/** A folder with CHANGELOG.md and the change files given, by name. */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'yokoten-'));
  mkdirSync(join(root, 'changes'));
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  writeFileSync(join(root, 'changes', 'README.md'), '# Change files\n\nNot a change.\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'changes', name), content);
  return root;
}

test('changes: a file is a section, a blank line, then the entry; a bullet is added when missing', () => {
  assert.deepEqual(parseChange('changes/1-a.md', 'Fixed\n\nA crash,\nwhen empty.\n'), { change: { file: 'changes/1-a.md', section: 'Fixed', lines: ['- A crash,', '  when empty.'] }, problems: [] });
  assert.deepEqual(parseChange('changes/1-a.md', 'added\r\n\r\n- One.\r\n- Two.\r\n').change?.lines, ['- One.', '- Two.'], 'several bullets, CRLF, any case');
  const bad = (content: string, file = 'changes/1-a.md') => parseChange(file, content).problems.map((problem) => `${problem.line ?? '-'}: ${problem.what}`);
  assert.deepEqual(bad('Improved\n\nA thing.\n'), ['1: line 1 is not a section']);
  assert.deepEqual(bad('Added\nA thing.\n'), ['2: line 2 is not blank']);
  assert.deepEqual(bad('Added\n\n\n'), ['1: no entry after the section']);
  assert.deepEqual(bad('Added\n'), ['1: no entry after the section']);
  assert.deepEqual(bad('Added\n\nA thing.\n', 'changes/1-a.txt'), ['-: a change file is not Markdown']);
  assert.equal(parseChange('changes/1-a.md', 'Improved\n\nsecret words\n').problems.every((problem) => !JSON.stringify(problem).includes('secret words')), true, 'the text is never printed back');
});

test('changes: the collector groups and orders the sections, and skips README.md', () => {
  const root = makeRepo({ '132-b.md': 'Fixed\n\nB.\n', '9-a.md': 'Internal\n\nA.\n', '10-c.md': 'Added\n\nC.\n', '200-d.md': 'Fixed\n\nD.\n' });
  const { changes, problems } = readChanges(root);
  assert.deepEqual(problems, []);
  assert.deepEqual(changes.map((change) => change.file), ['changes/9-a.md', 'changes/10-c.md', 'changes/132-b.md', 'changes/200-d.md'], 'by issue number');
  assert.deepEqual(formatChanges(changes), ['### Added', '', '- C.', '', '### Fixed', '', '- B.', '- D.', '', '### Internal', '', '- A.']);
  assert.deepEqual(readChanges(mkdtempSync(join(tmpdir(), 'yokoten-'))), { changes: [], problems: [] }, 'no changes/ folder');
});

test('changes: a bad file is refused, and nothing is written or deleted', () => {
  const root = makeRepo({ '1-good.md': 'Added\n\nGood.\n', '2-bad.md': 'Improved\n\nBad.\n' });
  const { changes, problems } = writeChanges(root);
  assert.deepEqual(changes, []);
  assert.deepEqual(problems.map((problem) => [problem.id, problem.file, problem.line]), [['change-file', 'changes/2-bad.md', 1]]);
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), CHANGELOG);
  assert.ok(existsSync(join(root, 'changes', '1-good.md')) && existsSync(join(root, 'changes', '2-bad.md')));
  // No Unreleased heading: refused too.
  writeFileSync(join(root, 'changes', '2-bad.md'), 'Fixed\n\nNow good.\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0]\n');
  assert.match(writeChanges(root).problems[0]?.what ?? '', /no `## \[Unreleased\]` heading/);
  assert.ok(existsSync(join(root, 'changes', '1-good.md')));
});

test('changes: --write puts each entry after its section, deletes the files, and keeps released versions', () => {
  const root = makeRepo({ '5-a.md': 'Added\n\nNew A.\n', '6-b.md': 'Changed\n\nNew B,\nwrapped.\n', '7-c.md': 'Internal\n\nNew C.\n', '8-d.md': 'Fixed\n\nNew D.\n' });
  const { changes, problems } = writeChanges(root);
  assert.deepEqual(problems, []);
  assert.equal(changes.length, 4);
  const written = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const [unreleased, released] = written.split('## [0.1.0]');
  assert.equal(`## [0.1.0]${released}`, CHANGELOG.slice(CHANGELOG.indexOf('## [0.1.0]')), 'released versions are not touched');
  assert.equal(
    unreleased,
    ['# Changelog', '', '## [Unreleased]', '', '### Added', '', '- An old entry,', '  wrapped.', '- New A.', '', '### Changed', '', '- New B,', '  wrapped.', '', '### Fixed', '', '- An old fix.', '- New D.', '', '### Internal', '', '- New C.', '', ''].join('\n'),
  );
  assert.deepEqual(readChanges(root), { changes: [], problems: [] }, 'the used files are gone');
  assert.ok(existsSync(join(root, 'changes', 'README.md')), 'the README stays');
  // An empty Unreleased gets its first heading.
  const merged = mergeChanges('# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n', changes.slice(0, 1));
  assert.equal(merged, '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New A.\n\n## [0.1.0]\n');
});

test('CODEOWNERS: anchored, folder, glob, last match wins, comments, several owners', () => {
  const rules = parseCodeOwners(
    [
      '# The owner reviews the rules.',
      '',
      '/AGENTS.md @owner # an inline comment',
      '/kit/ @owner @team/leads',
      'apps/ @apps',
      'docs/* @docs',
      '*.lock @deps',
      '/src/**/secret.ts @sec',
      '/kit/notes/ ',
      '**/logs @logs',
    ].join('\n'),
  );
  const owners = (path: string) => ownersOf(rules, path);
  assert.deepEqual(owners('AGENTS.md'), ['@owner'], 'anchored');
  assert.deepEqual(owners('sub/AGENTS.md'), [], 'a leading slash anchors at the root');
  assert.deepEqual(owners('kit/a/b.md'), ['@owner', '@team/leads'], 'a folder and everything in it; two owners');
  assert.deepEqual(owners('kit'), [], 'a trailing slash needs something inside the folder');
  assert.deepEqual(owners('apps/x.ts'), ['@apps']);
  assert.deepEqual(owners('deep/apps/x.ts'), ['@apps'], 'a folder pattern with no other slash matches in any folder');
  assert.deepEqual(owners('docs/x.md'), ['@docs'], 'docs/* matches a file in docs/');
  assert.deepEqual(owners('docs/a/x.md'), [], 'and not deeper');
  assert.deepEqual(owners('deep/yarn.lock'), ['@deps'], 'no slash matches in any folder');
  assert.deepEqual(owners('src/secret.ts'), ['@sec'], '** matches no folder');
  assert.deepEqual(owners('src/a/b/secret.ts'), ['@sec'], '** crosses folders');
  assert.deepEqual(owners('kit/notes/a.md'), [], 'a later pattern with no owners wins');
  assert.deepEqual(owners('a/b/logs/x.txt'), ['@logs']);
  assert.deepEqual(owners('README.md'), []);
  const all = parseCodeOwners('* @owner\n/docs/ @writer\n');
  assert.deepEqual(ownersOf(all, 'src/deep/a.ts'), ['@owner'], '* matches every path');
  assert.deepEqual(ownersOf(all, 'docs/guide.md'), ['@writer'], 'the last match wins');
});

test('CODEOWNERS: an owned file needs tier A; the paths set the lowest tier', () => {
  const codeOwners = { text: '/kit/ @owner\n/AGENTS.md @owner\n', from: 'the base branch' as const };
  const pr = (tier: string, files: string[]) => ({ body: `tier: ${tier}\nCloses #1\n`, files });
  const found = checkOwnedTier(pr('B', ['kit/a.md', 'src/x.ts', 'AGENTS.md']), codeOwners);
  assert.equal(found?.id, 'pr-owned');
  assert.match(formatFinding(found as Finding), /`tier: B`, and this changes 2 file\(s\) that CODEOWNERS owns \(read from the base branch\): kit\/a\.md, AGENTS\.md\. .*Make the first line `tier: A`/);
  assert.equal(checkOwnedTier(pr('C', ['kit/a.md']), codeOwners)?.id, 'pr-owned');
  assert.equal(checkOwnedTier(pr('A', ['kit/a.md']), codeOwners), null, 'tier A is fine');
  assert.equal(checkOwnedTier(pr('B', ['src/x.ts', 'docs/a.md']), codeOwners), null, 'no owned file');
  assert.equal(checkOwnedTier(pr('B', ['kit/a.md']), null), null, 'no CODEOWNERS file');
  const many = checkOwnedTier(pr('B', Array.from({ length: 8 }, (_, i) => `kit/${i}.md`)), codeOwners);
  assert.match(many?.what ?? '', /kit\/4\.md, and 3 more$/);
});

test('plain English: long sentences are found; code, tables and comments are not (#49)', () => {
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ') + '.';
  const text = ['# A heading that is not prose', '', 'Short one. Another short one.', long, '', '```', long, '```', `| ${long} |`, `<!-- ${long} -->`, '- a list item.', `- ${long}`].join('\n');
  assert.deepEqual(longSentences(text), [
    { line: 4, words: 30 },
    { line: 12, words: 30 },
  ]);
  assert.deepEqual(longSentences(`A [link with many words in its text](https://example.com/${'x'.repeat(50)}) is short.`), []);
});

test('large pull request: a note over 400 changed lines, none at or below (#57)', () => {
  assert.equal(largeDiff(400), null);
  assert.equal(largeDiff(12), null);
  const large = largeDiff(401);
  assert.ok(large);
  const note = formatFinding(large);
  assert.match(note, /changes 401 lines, over 400\. Smaller pull requests are easier to review\. Split it if you can\./);
  assert.ok(note.split(/\s+/).length <= 25, 'plain English: 25 words or fewer');
  assert.match(largeDiff(150, 100)?.what ?? '', /over 100/);
});

test('large pull request: lines added and deleted; binary files and lock files do not count (#57)', () => {
  const numstat = ['3\t2\tsrc/a.ts', '-\t-\tlogo.png', '900\t40\tpackage-lock.json', '5\t0\tweb/yarn.lock', '1\t1\t', 'old name.ts', 'new\tname.ts', ''].join('\0');
  assert.equal(changedLines(numstat), 7);
  assert.equal(changedLines(''), 0);
});

// A file with a long-lived one-letter name on line 1, a 5-word name on line 2, and `i`
// in a short loop on line 3. The one-letter name is used on line 15.
const NAMED = [
  'const t = 0;',
  'const loadTheWholeUserList = () => [];',
  'for (let i = 0; i < 3; i++) console.log(i);',
  ...Array(11).fill('// filler'),
  'console.log(t);',
].join('\n');

test('names: a note for a long-lived one-letter name and a 5-word name on added lines (#111)', () => {
  const notes = nameNotes('src/cart.ts', NAMED, new Set([1, 2, 3]));
  assert.deepEqual(notes.map(formatFinding), [
    `src/cart.ts:1: "t" is used for 14 lines. A reader must scroll back to learn what it holds. Name what it is, e.g. "text".\n  docs: ${DOCS_URL}#naming`,
    `src/cart.ts:2: "loadTheWholeUserList" has 5 words, over 4. A long name is slow to read, and the words that matter get lost. Keep the words a reader needs; the file and the type say the rest, e.g. "processTheUserInputDataNow" becomes "parseInput".\n  docs: ${DOCS_URL}#naming`,
  ]);
  assert.deepEqual(notes.map((note) => note.id), ['name-short', 'name-long']);
  assert.deepEqual(nameNotes('src/cart.ts', NAMED, new Set([3])), [], '`i` in a short loop is fine');
  assert.deepEqual(nameNotes('src/cart.ts', NAMED, new Set([4, 15])), [], 'names on unchanged lines are left alone');
  assert.deepEqual(nameNotes('src/a.ts', 'export const x = 1;\nconst ignore = (_: unknown) => 1;\nconst _count = 2;\n', new Set([1, 2, 3])).map((note) => note.what), ['"x" is one letter, and exported'], 'only the two name notes; `_` for an unused parameter passes');
});

test('names: TypeScript and JavaScript files are read, others are not (#111)', () => {
  for (const file of ['a.ts', 'b/c.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts']) assert.ok(isCodeFile(file), file);
  for (const file of ['a.md', 'a.json', 'a.d', 'ts', 'a.tsv', 'a.py']) assert.ok(!isCodeFile(file), file);
});

test('names: the added lines of each file, from git diff (#111)', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +2,2 @@',
    '+const one = 1;',
    '++++ not a header',
    '@@ -9 +11 @@ function f() {',
    '-old',
    '+new',
    'diff --git a/old.ts b/new name.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to new name.ts',
    '--- a/old.ts',
    '+++ b/new name.ts\t',
    '@@ -5,2 +5,3 @@',
    ' kept',
    '-gone',
    '+added',
    '+more',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
    'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
    '--- /dev/null',
    '+++ "b/tab\\there.ts"',
    '@@ -0,0 +1 @@',
    '+y',
    '',
  ].join('\n');
  const added = addedLinesByFile(diff);
  assert.deepEqual([...added.keys()], ['src/a.ts', 'new name.ts', 'tab\there.ts']);
  assert.deepEqual([...(added.get('src/a.ts') ?? [])], [2, 3, 11]);
  assert.deepEqual([...(added.get('new name.ts') ?? [])], [6, 7], 'a renamed file counts only its new lines');
  assert.deepEqual([...(added.get('tab\there.ts') ?? [])], [1]);
  assert.equal(addedLinesByFile('').size, 0);
});

const AREAS = { areas: ['doctor', 'check', 'kit'] };

test('issue title: `area: verb phrase` or `area: symptom` passes', () => {
  assert.deepEqual(checkIssueTitle('doctor: add the review step', AREAS), []);
  assert.deepEqual(checkIssueTitle('check: misses a key in a JSON file', AREAS, ['incident']), []);
  assert.deepEqual(checkIssueTitle('dev-env: set up the container', {}), [], 'no list: any lowercase word, hyphens allowed');
  assert.deepEqual(checkIssueTitle(`kit: ${'a'.repeat(55)}`, AREAS), [], '60 characters is the most');
});

test('issue title: each break fails with what, why and the fix', () => {
  const one = (title: string, id: string, pattern: RegExp, config: { areas?: string[] } = AREAS, labels: string[] = []) => {
    const problems = checkIssueTitle(title, config, labels);
    assert.equal(problems.length, 1, `${title} -> ${problems.map(formatFinding).join(' | ')}`);
    assert.equal(problems[0].id, id);
    assert.match(formatFinding(problems[0]), pattern);
  };
  one(`doctor: ${'a'.repeat(60)}`, 'issue-title', /^title: 68 characters, over 60\. .+\. Shorten it/);
  one('doctor: add the review step.', 'issue-title', /full stop/);
  one('doctor: add the review step (#59)', 'issue-title', /issue number/);
  one('Add the review step to doctor', 'issue-area', /does not start with an area\. .+`area: verb phrase`/);
  one('A crash when the file is empty', 'issue-area', /`area: symptom`/, AREAS, ['incident']);
  one('Doctor: add the review step', 'issue-area', /not one lowercase word/);
  one('doctor check: add a step', 'issue-area', /does not start with an area/);
  one('area: add the review step', 'issue-area', /placeholder `area`/, {});
  one('site: turn off analytics', 'issue-area', /not in yokoten\.json "areas"\. .+Use one of: doctor, check, kit\.\n  docs: \S+#issue-titles$/);
});

test('pull request: an area outside the configured list fails; no list lets any through', () => {
  assert.deepEqual(checkPullRequest(goodPr(), { ...DEFAULTS, areas: ['kit'] }), []);
  assert.deepEqual(checkPullRequest({ ...goodPr(), title: 'feat: no area' }, { ...DEFAULTS, areas: ['kit'] }), []);
  const problems = checkPullRequest({ ...goodPr(), title: 'feat(site): a page' }, { ...DEFAULTS, areas: ['kit'] });
  assert.equal(problems.length, 1);
  assert.match(formatFinding(problems[0]), /the area `site` is not in yokoten\.json "areas"\. .+\. Use one of: kit\.\n  docs: \S+#the-core-rules$/);
  assert.deepEqual(checkPullRequest({ ...goodPr(), title: 'feat(site): a page' }, DEFAULTS), []);
});

test('pull request title: one rule for check --pr and the bot (#117)', () => {
  const config = { areas: ['host'] };
  assert.deepEqual(checkPullRequestTitle('feat(host): check the title', config), []);
  const bad = ['feat(guard): a step', `feat(host): ${'a'.repeat(62)}`, 'feat(host): a step.', 'feat(host): a step (#1)', 'Add a step'];
  for (const title of bad) {
    const problems = checkPullRequestTitle(title, config);
    assert.equal(problems.length, 1, title);
    assert.equal(problems[0].id, 'pr-title');
    assert.deepEqual(checkPullRequest({ ...goodPr(), title }, { ...DEFAULTS, ...config }), problems, 'checkPullRequest gives the same title findings');
  }
});

test('config: yokoten\'s own areas cover its open work', () => {
  const own = loadConfig(join(import.meta.dirname, '..'));
  assert.ok(own.areas.includes('doctor') && own.areas.includes('owner'));
  assert.deepEqual(DEFAULTS.areas, []);
});

// #42: every message has the same shape. Each check and guard gets a known-bad input,
// and each message must say what, why and the fix, in text and in JSON.
test('messages: every check and guard says what, why and the fix, in text and JSON (#42)', () => {
  const found: Finding[] = [];
  const add = (f: Finding | null | undefined) => {
    assert.ok(f, 'a known-bad input must be caught');
    found.push(f);
  };
  const env = { YOKOTEN_FIX_TASK: '1', YOKOTEN_ROLE: 'worker' };
  for (const c of ['git push --tags', 'git push origin v1.0.0', 'git -c push.followTags=true push', 'gh release create v1', 'npm publish', 'git push --force', 'git commit --no-verify -m x', 'git commit -nm x', 'git config core.hooksPath /dev/null']) add(checkCommand(c, { env: {} }));
  add(checkEdit('test/a.test.ts', { config: DEFAULTS, env }));
  add(checkEdit('AGENTS.md', { config: DEFAULTS, env }));
  found.push(...scanText(`${POSITIVE_CONTROL}\n${SECRET_CONTROL}\nhome town`, { file: 'a.md', marks: ['home town'] }));
  found.push(...checkLayout(Array.from({ length: 8 }, (_, i) => `d/${i}`), DEFAULTS));
  found.push(...checkBuildOutput([{ path: 'dist/a.js', binary: false }, { path: 'a.bin', binary: true }], DEFAULTS));
  found.push(...checkPullRequest({ title: `Bad title (#1) ${'x'.repeat(70)}.`, body: '## Why\n\n', files: ['src/a.ts', 'kit/x'], labels: [], milestone: null }, DEFAULTS));
  add(checkOwnedTier({ body: 'tier: B\n', files: ['kit/x'] }, { text: '/kit/ @owner\n', from: 'the base branch' }));
  found.push(...checkIssueTitle('Bad title (#1) that runs on well past the sixty character limit.', {}));
  add(largeDiff(500));
  add(longSentenceNote('a.md', { line: 3, words: 30 }));
  found.push(...nameNotes('a.ts', NAMED, new Set([1, 2])));
  add(timeZoneNote(2));
  const translated = makeTranslatedRepo();
  translated.commit('en.md', '# Guide\n\nStep one, changed.\n');
  add(translationNotes(translated.root, ['zh.md'])[0]);
  found.push(...parseChange('changes/1-a.md', 'Improved\n\nA thing.\n').problems);
  // The road and the machine, from an empty folder and an empty home.
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  for (const step of ROAD) add(stepFinding(step, dir, { HOME: dir }));
  for (const c of [...agentHooks(dir), ...machineChecks({ HOME: dir, YOKOTEN_PRIVATE_MARKS: join(dir, 'none') })]) add(c.finding);
  // The core rules (#120): behind the kit, and with no heading to compare by.
  for (const rules of ['# old rules\n\n## This project\n', '# rules\n']) {
    writeFileSync(join(dir, 'AGENTS.md'), rules);
    add(coreRulesCheck(dir)?.finding);
  }
  // The server, with every setting off, and with nothing readable.
  const off = { pullRequest: false, codeOwnerReview: false, mergeMethods: [], requiredChecks: [], noForcePush: false, noDeletion: false, approvals: 0 };
  const security = { secretScanning: false, pushProtection: false, privateReporting: false, dependabotAlerts: false };
  const server = { repo: 'octo/demo', defaultBranch: 'main', isPrivate: false, mergeMethods: ['merge', 'squash'], deleteBranchOnMerge: false, branch: off, tags: false, security, forgotten: ['old'] };
  for (const c of [...serverChecks(server), ...serverChecks({ unread: 'gh is not installed', fix: 'get it' })]) add(c.finding);

  const known = new Set(ids());
  for (const f of found) {
    const text = formatFinding(f);
    for (const field of ['what', 'why', 'fix'] as const) {
      assert.ok(f[field].trim().length > 3, `${f.id}: ${field} is empty`);
      assert.ok(!/[.]$/.test(f[field]), `${f.id}: ${field} ends with a full stop; the text form adds it: "${f[field]}"`);
      assert.ok(text.toLowerCase().includes(f[field].toLowerCase()), `${f.id}: the text form leaves out the ${field}`);
    }
    assert.ok(known.has(f.id), `${f.id}: yokoten explain does not know this id`);
    const json = JSON.parse(JSON.stringify(f));
    assert.deepEqual(Object.keys(json).filter((k) => !['id', 'what', 'why', 'fix', 'docs', 'file', 'line'].includes(k)), [], `${f.id}: only the stable fields`);
    assert.ok(json.id && json.what && json.why && json.fix, `${f.id}: JSON has id, what, why and fix`);
  }
  // Every rule and every step was reached, so none is left without the shape. The self-test
  // finding needs a broken check, which the CLI test cannot make either.
  const reached = new Set(found.map((f) => f.id));
  assert.deepEqual([...known].filter((id) => !reached.has(id) && id !== 'self-test'), []);
  // Never a private value: the mark, the secret and the sample address are not in any field.
  const all = JSON.stringify(found);
  for (const secret of ['home town', 'personal-mail', `${'gh'}p_`, 'MIIE']) assert.ok(!all.includes(secret), secret);
});

test('explain: each rule and step, its reason and its check; ids are unique (#42)', () => {
  const all = ids();
  assert.equal(new Set(all).size, all.length, 'a rule and a step share an id');
  assert.ok(Object.keys(RULES).length >= 20);
  for (const id of all) {
    const e = explain(id);
    assert.ok(e && e.what && e.why && e.check, id);
    assert.ok(![e.what, e.why, e.check].some((t) => /[.]$/.test(t)), `${id}: no full stop at the end`);
  }
  assert.equal(explain('nope'), null);
  assert.equal(explain('toString'), null, 'only own keys');
});

// #94: a finding links to where its rule is explained. The anchors are made as GitHub
// makes them: lower case, punctuation dropped, spaces to `-`, and `-1`, `-2` for a repeat.
const guideAnchors = (markdown: string): Set<string> => {
  const anchors = new Set<string>();
  let isInFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) isInFence = !isInFence;
    const heading = isInFence ? null : line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const slug = heading[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    let anchor = slug;
    for (let count = 1; anchors.has(anchor); count++) anchor = `${slug}-${count}`;
    anchors.add(anchor);
  }
  return anchors;
};

test('docs: every link goes to a heading of docs/guide.md, so a renamed heading fails (#94)', () => {
  const anchors = guideAnchors(readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8'));
  assert.ok(anchors.has('naming') && anchors.has('what-it-doesnt-do'), 'GitHub drops punctuation');
  assert.ok(!anchors.has('githubworkflowsyokotenyml'), 'a `#` line in a code block is not a heading');
  const linked = Object.entries(RULES as Record<string, Rule>).filter(([, rule]) => rule.docs !== undefined);
  assert.ok(linked.length >= 30, `most rules have a link; ${linked.length} do`);
  for (const [id, rule] of linked) {
    const [base, anchor, ...rest] = (rule.docs ?? '').split('#');
    assert.equal(base, DOCS_URL, `${id}: the link starts with DOCS_URL, so the site can replace it in one place`);
    assert.deepEqual(rest, [], `${id}: one anchor`);
    assert.ok(anchors.has(anchor), `${id}: docs/guide.md has no heading for #${anchor}`);
  }
});

test('docs: a finding carries its rule\'s link, in text, JSON and explain (#94)', () => {
  const link = `${DOCS_URL}#the-core-rules`;
  const found = finding('skip-check', 'it skips the check', 'run it again');
  assert.equal(found.docs, link);
  assert.equal(formatFinding(found), `it skips the check. The commit check is the inspection step, and a skipped check makes a broken commit look reviewed. Run it again.\n  docs: ${link}`);
  assert.equal(JSON.parse(JSON.stringify(found)).docs, link);
  const plain = finding('large-diff', 'big', 'split it');
  assert.equal(plain.docs, undefined, 'no section fits: no link');
  assert.ok(!formatFinding(plain).includes('docs:'));
  const explained = explain('skip-check');
  assert.equal(explained?.docs, link);
  assert.equal(explained && explainLines(explained).at(-1), `Docs: ${link}`);
  const step = explain('commit-check');
  assert.ok(step && step.docs === undefined && !explainLines(step).some((line) => line.startsWith('Docs:')), 'a step has no link yet');
});

/**
 * A git repo with an English file and a translation whose line 1 names it, at the
 * English text as committed. `git` runs in it with no global config, in UTC.
 */
function makeTranslatedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const env = { PATH: process.env.PATH, HOME: root, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'none') };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  const commit = (path: string, text: string) => {
    writeFileSync(join(root, path), text);
    git('add', path);
    git('commit', '-q', '-m', `change ${path}`);
  };
  commit('en.md', '# Guide\n\nStep one.\n');
  commit('zh.md', `${sourceMarker('en.md', git('hash-object', 'en.md'))}\n# 指南\n\n第一步。\n`);
  return { root, git, commit };
}

test('translations: line 1 names the source and its blob; other first lines are not markers (#87)', () => {
  const blob = 'a'.repeat(40);
  assert.deepEqual(parseSourceMarker(`${sourceMarker('docs/guide.md', blob)}\n# Title`), { source: 'docs/guide.md', blob });
  assert.equal(parseSourceMarker('# Title\n<!-- source: a.md blob abcdef1 -->'), null, 'only line 1');
  assert.equal(parseSourceMarker('<!-- source: a.md -->'), null, 'no blob');
  assert.equal(parseSourceMarker('---\nsource: a.md\n---'), null, 'front matter is not the form');
});

test('translations: a note when English changed after the marker, none when it is current (#87)', () => {
  const repo = makeTranslatedRepo();
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md']), [], 'current: no note');
  const old = repo.git('hash-object', 'en.md');
  repo.commit('en.md', '# Guide\n\nStep one.\nStep two.\n');
  repo.commit('en.md', '# Guide\n\nStep one.\nStep two.\nStep three.\n');
  const [note, ...rest] = translationNotes(repo.root, ['en.md', 'zh.md']);
  assert.deepEqual(rest, []);
  assert.equal(note.id, 'translation-behind');
  assert.equal(note.file, 'zh.md');
  assert.equal(note.line, 1);
  assert.equal(note.what, 'is behind en.md by 2 commits');
  assert.ok(note.fix.includes(`git diff ${old.slice(0, 12)} HEAD:en.md`), note.fix);
  assert.ok(note.fix.includes(sourceMarker('en.md', repo.git('hash-object', 'en.md'))), 'the fix gives the new line 1');
  // Brought up to date: the note goes.
  repo.commit('zh.md', `${sourceMarker('en.md', repo.git('hash-object', 'en.md'))}\n# 指南\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), []);
  // An edit not yet committed is behind too.
  writeFileSync(join(repo.root, 'en.md'), '# Guide, edited\n');
  assert.equal(translationNotes(repo.root, ['zh.md'])[0]?.what, 'is behind en.md by edits not yet committed');
});

test('translations: a missing source, an unknown blob and a shallow clone each give a clear note (#87)', () => {
  const repo = makeTranslatedRepo();
  writeFileSync(join(repo.root, 'gone.md'), `${sourceMarker('nowhere.md', 'b'.repeat(40))}\n`);
  writeFileSync(join(repo.root, 'out.md'), `${sourceMarker('../en.md', 'b'.repeat(40))}\n`);
  writeFileSync(join(repo.root, 'odd.md'), `${sourceMarker('en.md', 'b'.repeat(40))}\n`);
  const notes = translationNotes(repo.root, ['gone.md', 'out.md', 'odd.md']);
  assert.match(notes[0].what, /names nowhere\.md as its English source, which is not in the repo/);
  assert.match(notes[1].what, /names \.\.\/en\.md as its English source, which is not in the repo/);
  assert.match(notes[2].what, /is behind en\.md: blob bbbbbbbbbbbb is not in its history/);
  // A shallow clone (CI's default checkout): behind, but how far is not known.
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  const shallow = mkdtempSync(join(tmpdir(), 'yokoten-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo.root}`, shallow], { stdio: 'ignore' });
  const [note] = translationNotes(shallow, ['zh.md']);
  assert.match(note.what, /is behind en\.md: this clone is shallow, so how far is not known/);
  assert.match(note.fix, /fetch-depth: 0/);
});

test('translations: two pull requests that each change both files, squash-merged in turn, give no note (#155)', () => {
  const repo = makeTranslatedRepo();
  const english = (top: string, bottom: string) => `# Guide\n\n${top}\n\nMiddle.\n\n${bottom}\n`;
  const translation = (blob: string, body: string) => `${sourceMarker('en.md', blob)}\n# 指南\n\n${body}\n`;
  const blobOf = (text: string) => {
    writeFileSync(join(repo.root, 'scratch.txt'), text);
    return repo.git('hash-object', 'scratch.txt');
  };
  // One squash commit on main that changes both files, as a merged pull request does.
  const merge = (englishText: string, translationText: string) => {
    writeFileSync(join(repo.root, 'en.md'), englishText);
    writeFileSync(join(repo.root, 'zh.md'), translationText);
    repo.git('add', 'en.md', 'zh.md');
    repo.git('commit', '-q', '-m', 'squash merge');
  };
  merge(english('Top.', 'Bottom.'), translation(blobOf(english('Top.', 'Bottom.')), '上。下。'));
  // Branches A and B both start here. A changes the top, B the bottom; each updates zh.md.
  merge(english('Top, A.', 'Bottom.'), translation(blobOf(english('Top, A.', 'Bottom.')), '上，A。下。'));
  // B's marker names the English as B saw it, a blob main never holds.
  const branchBlob = blobOf(english('Top.', 'Bottom, B.'));
  merge(english('Top, A.', 'Bottom, B.'), translation(branchBlob, '上，A。下，B。'));
  assert.notEqual(repo.git('hash-object', 'en.md'), branchBlob, 'the marker is stale');
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md']), [], 'both were translated: no note');
  // The English changes later, with no translation: a note, counted from history.
  repo.commit('en.md', english('Top, A.', 'Bottom, B, then C.'));
  const [note, ...rest] = translationNotes(repo.root, ['zh.md']);
  assert.deepEqual(rest, []);
  assert.equal(note.what, 'is behind en.md by 1 commit');
  assert.match(note.fix, /git diff [0-9a-f]{12} HEAD -- en\.md/);
  // A typo fix that leaves the marker alone does not make it current.
  repo.commit('zh.md', translation(branchBlob, '上，A。下，B！'));
  assert.equal(translationNotes(repo.root, ['zh.md'])[0]?.what, 'is behind en.md by 1 commit');
});

test('translations: check gives a note, and yokoten.json "translations": { "fail": true } a problem (#87)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  const notes: Finding[] = [];
  const problems = check(repo.root, { config: DEFAULTS, env: {}, notes });
  assert.deepEqual(problems, []);
  assert.deepEqual(notes.map((f) => f.id), ['translation-behind']);
  const strict = { ...DEFAULTS, translations: { fail: true } };
  assert.deepEqual(check(repo.root, { config: strict, env: {} }).map((f) => f.id), ['translation-behind']);
  writeFileSync(join(repo.root, 'yokoten.json'), '{ "translations": { "fail": true } }');
  assert.equal(loadConfig(repo.root).translations.fail, true);
});

// The kit version mark in AGENTS.md (#141): newer is never "behind", and no mark compares by content.
test('core rules: the kit version mark tells older from newer; no mark compares by content (#141)', () => {
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1, 'numbers, not text');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1, 'a pre-release is older than its release');
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('{{version}}', '0.1.0'), null, 'not a version');
  assert.equal(readKitVersion('<!-- yokoten kit 0.3.1 -->\r\n# rules\n'), '0.3.1');
  assert.equal(readKitVersion('# rules\n'), null);

  const kit = '<!-- yokoten kit 0.2.0 -->\n# rules\n\n## This project\n';
  const own = '## This project\n\nours\n';
  const newer = compareCoreRules(`<!-- yokoten kit 0.3.0 -->\n# rules, later\n\n${own}`, kit);
  assert.deepEqual(newer, { state: 'newer', version: '0.3.0', kitVersion: '0.2.0' });
  const older = compareCoreRules(`<!-- yokoten kit 0.1.0 -->\n# old rules\n\n${own}`, kit);
  assert.equal(older.state, 'behind');
  assert.equal(older.state === 'behind' && older.updated, `<!-- yokoten kit 0.2.0 -->\n# rules\n\n${own}`, 'the update writes the new mark');
  const unmarked = compareCoreRules(`# old rules\n\n${own}`, kit);
  assert.equal(unmarked.state === 'behind' && unmarked.updated, `<!-- yokoten kit 0.2.0 -->\n# rules\n\n${own}`, 'no mark: an unknown version, compared by content');
  assert.equal(compareCoreRules(`# rules\n\n${own}`, kit).state, 'same', 'the mark alone is no change');
  assert.equal(compareCoreRules(`<!-- yokoten kit 0.9.0 -->\n# rules\n\n${own}`, kit).state, 'same', 'a newer mark with the same text is up to date');
  assert.equal(compareCoreRules(`<!-- yokoten kit {{version}} -->\n# rules, later\n\n${own}`, kit).state, 'behind', 'a mark that is not a version is unknown');
});
