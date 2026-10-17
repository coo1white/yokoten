import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig } from '../src/rules/config.ts';
import { matcher } from '../src/rules/glob.ts';
import { checkBuildOutput, checkLayout, isBuildOutput } from '../src/rules/layout.ts';
import { changedLines, checkIssueTitle, checkPullRequest, formatTitleProblem, largeDiff, longSentences, type PullRequest } from '../src/rules/pr.ts';

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
  assert.match(problems[0], /^docs\/ has 9 entries/);
  assert.deepEqual(checkLayout(eight.slice(0, 7), DEFAULTS), []);
});

test('layout: an exempt folder may grow', () => {
  const records = Array.from({ length: 30 }, (_, i) => `docs/records/${i}.md`);
  assert.deepEqual(checkLayout(records, { layout: { maxEntries: 7, exempt: ['docs/records/'] } }), []);
});

test('build output: build folders and binaries are refused, images, fonts and allowed paths pass (#56)', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, binary: !/\.(js|ts|md|svg)$/.test(path) }));
  const problems = checkBuildOutput(files('dist/app.js', 'pkg/build/x.js', 'out/a.md', 'tool.exe', 'lib.wasm', 'data.bin'), DEFAULTS);
  assert.equal(problems.length, 6);
  assert.match(problems[0], /^dist\/app\.js: build output, in a dist\/ folder\..*git rm --cached dist\/app\.js.*allowBuild in yokoten\.json/);
  assert.match(problems[3], /^tool\.exe: a binary file\./);
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
    assert.equal(problems.length, 1, `${JSON.stringify(change)} -> ${problems.join(' | ')}`);
    assert.match(problems[0], pattern);
  };
  one({ title: 'Added a pull request check' }, /^title: use `type\(area\): summary`/);
  one({ title: 'feat: a pull request standard.' }, /full stop/);
  one({ title: 'feat: a pull request standard (#47)' }, /issue number/);
  one({ title: `feat: ${'a'.repeat(80)}` }, /over 72/);
  one({ body: goodPr().body.replace('tier: B\n', '') }, /`tier: A`/);
  one({ body: goodPr().body.replace('## How tested\n`node --test`: 50 pass.\n', '') }, /add a `## How tested`/);
  one({ body: goodPr().body.replace('Nothing checks it.', '<!-- say why -->') }, /`## Why` section is empty/);
  one({ body: goodPr().body.replace('Closes #47', 'Closes #') }, /Closes #N/);
  one({ files: ['src/rules/pr.ts'] }, /^changelog:/);
  one({ milestone: null }, /^milestone:/);
  one({ labels: [] }, /^labels:/);
  one({ files: ['kit/project/AGENTS.md', 'CHANGELOG.md'] }, /changes `kit\/`/);
});

test('pull request: docs, tests and CI need no changelog line; a reason lets code through (#47)', () => {
  assert.deepEqual(checkPullRequest({ ...goodPr(), files: ['docs/guide.md', 'test/a.test.ts', '.github/workflows/pr.yml'] }, DEFAULTS), []);
  assert.deepEqual(checkPullRequest({ ...goodPr(), files: ['src/a.ts'], body: `${goodPr().body}No changelog: a comment only\n` }, DEFAULTS), []);
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
  const note = largeDiff(401) ?? '';
  assert.match(note, /changes 401 lines, over 400\. Smaller pull requests are easier to review; split it if you can\./);
  assert.ok(note.split(/\s+/).length <= 25, 'plain English: 25 words or fewer');
  assert.match(largeDiff(150, 100) ?? '', /over 100/);
});

test('large pull request: lines added and deleted; binary files and lock files do not count (#57)', () => {
  const numstat = ['3\t2\tsrc/a.ts', '-\t-\tlogo.png', '900\t40\tpackage-lock.json', '5\t0\tweb/yarn.lock', '1\t1\t', 'old name.ts', 'new\tname.ts', ''].join('\0');
  assert.equal(changedLines(numstat), 7);
  assert.equal(changedLines(''), 0);
});

const AREAS = { areas: ['doctor', 'check', 'kit'] };

test('issue title: `area: verb phrase` or `area: symptom` passes', () => {
  assert.deepEqual(checkIssueTitle('doctor: add the review step', AREAS), []);
  assert.deepEqual(checkIssueTitle('check: misses a key in a JSON file', AREAS, ['incident']), []);
  assert.deepEqual(checkIssueTitle('dev-env: set up the container', {}), [], 'no list: any lowercase word, hyphens allowed');
  assert.deepEqual(checkIssueTitle(`kit: ${'a'.repeat(55)}`, AREAS), [], '60 characters is the most');
});

test('issue title: each break fails with what, why and the fix', () => {
  const one = (title: string, pattern: RegExp, config: { areas?: string[] } = AREAS, labels: string[] = []) => {
    const problems = checkIssueTitle(title, config, labels);
    assert.equal(problems.length, 1, `${title} -> ${problems.map(formatTitleProblem).join(' | ')}`);
    for (const key of ['what', 'why', 'fix'] as const) assert.ok(problems[0][key], `${title}: no ${key}`);
    assert.match(formatTitleProblem(problems[0]), pattern);
  };
  one(`doctor: ${'a'.repeat(60)}`, /^the title has 68 characters, over 60\. .+\. Shorten it/);
  one('doctor: add the review step.', /full stop/);
  one('doctor: add the review step (#59)', /issue number/);
  one('Add the review step to doctor', /does not start with an area\. .+`area: verb phrase`/);
  one('A crash when the file is empty', /`area: symptom`/, AREAS, ['incident']);
  one('Doctor: add the review step', /not one lowercase word/);
  one('doctor check: add a step', /does not start with an area/);
  one('area: add the review step', /placeholder `area`/, {});
  one('site: turn off analytics', /not in yokoten\.json "areas"\. .+Use one of: doctor, check, kit\.$/);
});

test('pull request: an area outside the configured list fails; no list lets any through', () => {
  assert.deepEqual(checkPullRequest(goodPr(), { ...DEFAULTS, areas: ['kit'] }), []);
  assert.deepEqual(checkPullRequest({ ...goodPr(), title: 'feat: no area' }, { ...DEFAULTS, areas: ['kit'] }), []);
  const problems = checkPullRequest({ ...goodPr(), title: 'feat(site): a page' }, { ...DEFAULTS, areas: ['kit'] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /the area `site` is not in yokoten\.json "areas"/);
  assert.deepEqual(checkPullRequest({ ...goodPr(), title: 'feat(site): a page' }, DEFAULTS), []);
});

test('config: yokoten\'s own areas cover its open work', () => {
  const own = loadConfig(join(import.meta.dirname, '..'));
  assert.ok(own.areas.includes('doctor') && own.areas.includes('owner'));
  assert.deepEqual(DEFAULTS.areas, []);
});
