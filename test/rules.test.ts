import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Config, DEFAULTS, findUnknownKeys, loadConfig, matcher } from '../src/rules/config.ts';
import { checkCommand, checkEdit } from '../src/rules/guards.ts';
import { checkBuildOutput, checkLayout, isBuildOutput } from '../src/rules/layout.ts';
import { DOCS_URL, type Finding, finding, formatFinding, notRepoFinding, type Rule, RULES } from '../src/rules/message.ts';
import { POSITIVE_CONTROL, scanText } from '../src/rules/privacy.ts';
import { SECRET_CONTROL } from '../src/rules/secrets.ts';
import { batchBlobs, check, checkHistory, readBlobs, timeZoneNote } from '../src/run/check.ts';
import { lateFinding, loadHookConfig } from '../src/run/hook.ts';
import { parseSourceMarker, sourceMarker, translationNotes } from '../src/run/translations.ts';
import { agentHooks, coreRulesCheck, coreRulesControl, findStateFile, formatLessonChecks, lessonChecks, machineChecks, pluginAgeCheck, readState, saveState, seenAfter, selfTest, userAgentHooks } from '../src/setup/doctor.ts';
import { compareCoreRules, compareVersions, readKitVersion } from '../src/setup/init.ts';
import { explain, explainLines, ids } from '../src/setup/advice/explain.ts';
import { ROAD, serverChecks, stepFinding } from '../src/setup/road.ts';
import { readIssue, readPullRequest } from '../src/host/github.ts';
import { isCodeFile, nameNotes } from '../src/run/names.ts';
import { formatChanges, mergeChanges, parseChange, readChanges, writeChanges } from '../src/run/changelog.ts';
import { addedLinesByFile, changedLines, checkIssueTitle, checkOwnedTier, checkPullRequest, checkPullRequestTitle, isChangeFile, largeDiff, longSentenceNote, longSentences, ownersOf, parseCodeOwners, type PullRequest, splitForDependabot, visibleLength } from '../src/rules/pr.ts';
import { draftLesson, findLessonFolders, findLessonGroup, formatDraft, formatLessonRow, formatLessonTable, type Incident, KIT_LESSONS_DIR, LESSONS_TABLE, readLessonTable, readSections, shipLesson, summarize, writeDraft } from '../src/run/learn.ts';

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

test('config: "commands.block" is read, and a wrong shape is a config problem (#192)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  assert.deepEqual(loadConfig(dir).commands, { block: {} });
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ commands: { block: { python3: 'TypeScript only' } } }));
  assert.deepEqual(loadConfig(dir).commands.block, { python3: 'TypeScript only' });
  for (const commands of [[], 'python3', { block: ['python3'] }, { block: { python3: 1 } }, { block: { python3: ' ' } }, { block: { '/usr/bin/python3': 'no' } }, { block: { 'py thon': 'no' } }]) {
    writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ commands }));
    assert.throws(() => loadConfig(dir), /^Error: yokoten\.json: "commands/, JSON.stringify(commands));
  }
});

test('config: for the hook, a wrong "commands" drops only the block list, said once (#192)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ leadOnly: ['secret/**'], commands: { block: ['python3'] } }));
  const lines: string[] = [];
  const config = loadHookConfig(dir, (line) => lines.push(line));
  assert.deepEqual(config.commands.block, {});
  assert.deepEqual(config.leadOnly, ['secret/**'], 'the rest of the file still counts');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^yokoten hook: yokoten\.json "commands" was ignored, .*core checks still run\. yokoten\.json: "commands" must look like/);
  assert.equal(checkCommand('git push --force', { env: {}, config })?.id, 'force-push', 'the core checks still run');
  // Positive control: check and doctor still see it as a config problem.
  assert.throws(() => loadConfig(dir), /^Error: yokoten\.json: "commands/);
  // A good list says nothing; outside a repo, the defaults.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ commands: { block: { python3: 'TypeScript only' } } }));
  assert.deepEqual(loadHookConfig(dir, (line) => lines.push(line)).commands.block, { python3: 'TypeScript only' });
  assert.equal(loadHookConfig(null, (line) => lines.push(line)), DEFAULTS);
  assert.equal(lines.length, 1);
  // A file that is not one JSON object gives the defaults, said once (#218).
  for (const text of ['{ nope', '[]', 'null']) {
    writeFileSync(join(dir, 'yokoten.json'), text);
    assert.throws(() => loadConfig(dir), /^Error: yokoten\.json: /, text);
    assert.equal(loadHookConfig(dir, (line) => lines.push(line)), DEFAULTS, text);
    assert.match(lines.at(-1) ?? '', /^yokoten hook: yokoten\.json was ignored, so the defaults apply; the core checks still run\. yokoten\.json: \S/);
  }
  assert.equal(lines.length, 4);
});

// #228: each key with the wrong shape, by its key path, and the key it falls back on.
const WRONG_KEYS: [string, Record<string, unknown>][] = [
  ['layout', { layout: 'x' }],
  ['layout.maxEntries', { layout: { maxEntries: '7', exempt: ['docs/records'] } }],
  ['layout.maxEntries', { layout: { maxEntries: 0 } }],
  ['layout.maxEntries', { layout: { maxEntries: 1.5 } }],
  ['layout.exempt', { layout: { exempt: 'docs/records' } }],
  ['tests', { tests: 5 }],
  ['leadOnly', { leadOnly: 'x' }],
  ['leadOnly', { leadOnly: ['ok', 3] }],
  ['privacy', { privacy: [] }],
  ['privacy.allow', { privacy: { allow: 'a' } }],
  ['privacy.skip', { privacy: { skip: [1] } }],
  ['privacy.utc', { privacy: { utc: 'yes' } }],
  ['notNow', { notNow: ['ci'] }],
  ['notNow', { notNow: { ci: 1 } }],
  ['allowBuild', { allowBuild: 'dist/**' }],
  ['areas', { areas: 'doctor' }],
  ['translations', { translations: true }],
  ['translations.fail', { translations: { fail: 'no' } }],
  ['commands', { commands: 'python3' }],
  ['commands', { commands: { block: ['python3'] } }],
];

test('config: a key with the wrong shape is a config error that names it, and the hook uses its default (#228)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  for (const [path, file] of WRONG_KEYS) {
    const label = JSON.stringify(file);
    writeFileSync(join(dir, 'yokoten.json'), JSON.stringify(file));
    // check and doctor: a config error that names the key.
    assert.throws(() => loadConfig(dir), (err: Error) => err.message.startsWith(`yokoten.json: "${path.split('.')[0]}`) && err.message.includes(`"${path}"`), label);
    // The hook: one line names the key, that key has its default, and the core checks run.
    const lines: string[] = [];
    const config = loadHookConfig(dir, (line) => lines.push(line));
    assert.equal(lines.length, 1, label);
    assert.ok(lines[0].startsWith(`yokoten hook: yokoten.json "${path}" was ignored, so its default applies; the core checks still run. yokoten.json: `), `${label}: ${lines[0]}`);
    const [key, field] = path.split('.') as [keyof Config, string | undefined];
    const got = config[key] as unknown as Record<string, unknown>;
    const want = DEFAULTS[key] as unknown as Record<string, unknown>;
    assert.deepEqual(field ? got[field] : got, field ? want[field] : want, label);
    assert.equal(checkCommand('git push --force', { env: {}, config })?.id, 'force-push', `${label}: the core checks still run`);
    assert.equal(checkEdit('AGENTS.md', { config, env: { YOKOTEN_ROLE: 'worker' } })?.id, 'lead-only', label);
  }
  // Only the wrong field falls back; the rest of the file still counts.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ layout: { maxEntries: '7', exempt: ['docs/records'] }, tests: ['spec/**'], leadOnly: 'x' }));
  const lines: string[] = [];
  const config = loadHookConfig(dir, (line) => lines.push(line));
  assert.deepEqual(config.layout, { maxEntries: 7, exempt: ['docs/records'] });
  assert.deepEqual(config.tests, ['spec/**']);
  assert.deepEqual(config.leadOnly, DEFAULTS.leadOnly);
  assert.deepEqual(lines.map((line) => /"([^"]+)" was ignored/.exec(line)?.[1]), ['layout.maxEntries', 'leadOnly'], 'one line for each wrong key');
});

test('config: null is a missing key; check lists every wrong key at once; unknown "commands" fields are notes (#228)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  // null gives the default, as before #228: no problem, no note, no hook line.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ leadOnly: null, notNow: null, layout: null, privacy: { utc: null }, commands: { block: null } }));
  assert.deepEqual(loadConfig(dir), { ...DEFAULTS, privacy: { ...DEFAULTS.privacy } });
  const lines: string[] = [];
  loadHookConfig(dir, (line) => lines.push(line));
  assert.deepEqual(lines, []);
  assert.deepEqual(findUnknownKeys(dir), []);
  // Three wrong keys: one error names all three, so one run shows them.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ leadOnly: 'x', tests: 5, layout: { maxEntries: '7' } }));
  assert.throws(() => loadConfig(dir), (err: Error) => {
    const [head, ...rest] = err.message.split('\n');
    assert.equal(head, 'yokoten.json: 3 keys have the wrong shape:');
    assert.deepEqual(rest.map((line) => /^- "([^"]+)" must be /.exec(line)?.[1]), ['layout.maxEntries', 'tests', 'leadOnly']);
    return true;
  });
  // A misspelled field under "commands" blocks nothing: a note for check, and the hook stays quiet.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ commands: { blok: { python3: 'TypeScript only' } } }));
  assert.deepEqual(loadConfig(dir).commands.block, {});
  const quiet: string[] = [];
  loadHookConfig(dir, (line) => quiet.push(line));
  assert.deepEqual(quiet, []);
  assert.deepEqual(findUnknownKeys(dir).map((note) => /^"([^"]+)"/.exec(note.what)?.[1]), ['commands.blok']);
});

test('config: an unknown key is a note, never a problem; yokoten\'s own files and the kit\'s pass with no note (#228)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ colour: 'blue', layout: { maxEntry: 9 }, tests: ['spec/**'] }));
  assert.deepEqual(loadConfig(dir).tests, ['spec/**']);
  const lines: string[] = [];
  loadHookConfig(dir, (line) => lines.push(line));
  assert.deepEqual(lines, [], 'the hook says nothing');
  const notes = findUnknownKeys(dir);
  assert.deepEqual(notes.map((note) => [note.id, note.file, /^"([^"]+)"/.exec(note.what)?.[1]]), [['config-key', 'yokoten.json', 'colour'], ['config-key', 'yokoten.json', 'layout.maxEntry']]);
  // A broken file gives no notes: loadConfig reports it.
  writeFileSync(join(dir, 'yokoten.json'), '{ nope');
  assert.deepEqual(findUnknownKeys(dir), []);
  for (const root of [join(import.meta.dirname, '..'), join(import.meta.dirname, '..', 'kit', 'project')]) {
    assert.ok(existsSync(join(root, 'yokoten.json')), root);
    const problems: string[] = [];
    loadConfig(root, { onProblem: (problem) => problems.push(problem) });
    assert.deepEqual(problems, [], root);
    assert.deepEqual(findUnknownKeys(root), [], root);
  }
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
  one({ labels: ['feat'] }, /^labels: no tier label/);
  one({ files: ['kit/project/AGENTS.md', 'CHANGELOG.md'] }, /changes `kit\/`/);
});

test('pull request: one type label and one tier label that matches the body (#225)', () => {
  const labelProblems = (labels: string[], body = goodPr().body) => checkPullRequest({ ...goodPr(), labels, body }, DEFAULTS).map(formatFinding);
  // No labels: each missing part has its own fix.
  const none = labelProblems([]);
  assert.equal(none.length, 2, none.join(' | '));
  assert.match(none[0], /^labels: no type label\. .*Add one type label, such as feat, bug, docs/);
  assert.match(none[1], /^labels: no tier label\. .*Add the label `tier B`/);
  // A type only, or a tier only.
  assert.deepEqual(labelProblems(['bug']).map((p) => p.split('.')[0]), ['labels: no tier label']);
  assert.deepEqual(labelProblems(['tier B']).map((p) => p.split('.')[0]), ['labels: no type label']);
  // A tier label that disagrees with the body.
  const wrong = labelProblems(['feat', 'tier A']);
  assert.equal(wrong.length, 1, wrong.join(' | '));
  assert.match(wrong[0], /^labels: `tier A` does not match the body's `tier: B`\. .*Change the label to `tier B`, or the first line of the body to `tier: A`/);
  assert.match(labelProblems(['feat', 'tier A', 'tier B'])[0], /^labels: 2 tier labels\. .*Keep one tier label: `tier B`/);
  // Both right, in each form and with each name a project may use for the type.
  for (const labels of [['feat', 'tier B'], ['bug', 'tier: B'], ['fix', 'Tier B'], ['enhancement', 'tier:B'], ['docs', 'owner', 'tier B']]) {
    assert.deepEqual(labelProblems(labels), [], labels.join(', '));
  }
  // No tier line in the body: pr-tier says so, and the labels do not say it again.
  const noTier = checkPullRequest({ ...goodPr(), body: goodPr().body.replace('tier: B\n', '') }, DEFAULTS).map((p) => p.id);
  assert.deepEqual(noTier, ['pr-tier']);
  const noTierNoLabel = checkPullRequest({ ...goodPr(), labels: ['feat'], body: goodPr().body.replace('tier: B\n', '') }, DEFAULTS).map(formatFinding);
  assert.equal(noTierNoLabel.length, 2);
  assert.match(noTierNoLabel[1], /^labels: no tier label\. .*Add the label `tier A`, `tier B` or `tier C`, the same as the first line of the body/);
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
  // A file deeper in changes/ would pass here and stop `changelog --write` at the release (#281).
  const deep = checkPullRequest({ ...goodPr(), files: ['src/rules/pr.ts', 'changes/47-pr-standard.md', 'changes/sub/x.md'] }, DEFAULTS);
  assert.deepEqual(deep.map((problem) => [problem.id, problem.file]), [['change-file', 'changes/sub/x.md']]);
  assert.match(formatFinding(deep[0]), /change files go directly in changes\//i);
  assert.deepEqual(checkPullRequest({ ...goodPr(), files: ['src/rules/pr.ts', 'changes/47-pr-standard.md', 'changes/sub/x.md'], deleted: ['changes/sub/x.md'] }, DEFAULTS), [], 'deleting one is fine');
});

// #299: the body Dependabot writes for the kit's grouped actions update, cut short.
const DEPENDABOT_BODY = [
  'Bumps the actions group with 1 update: [actions/checkout](https://github.com/actions/checkout).',
  '',
  'Updates `actions/checkout` from 4.2.1 to 4.2.2',
  '<details>',
  '<summary>Release notes</summary>',
  '<p><em>Sourced from <a href="https://github.com/actions/checkout/releases">actions/checkout\'s releases</a>.</em></p>',
  '</details>',
  '<br />',
  '',
  '[![Dependabot compatibility score](https://dependabot-badges.githubapp.com/badges/compatibility_score?dependency-name=actions/checkout&package-manager=github_actions&previous-version=4.2.1&new-version=4.2.2)](https://docs.github.com/en/github/managing-security-vulnerabilities/about-dependabot-security-updates#about-compatibility-scores)',
  '',
  "Dependabot will resolve any conflicts with this PR as long as you don't alter it yourself. You can also trigger a rebase manually by commenting `@dependabot rebase`.",
  '',
  '[//]: # (dependabot-automerge-start)',
  '[//]: # (dependabot-automerge-end)',
  '',
  '---',
  '',
  '<details>',
  '<summary>Dependabot commands and options</summary>',
  '<br />',
  '',
  'You can trigger Dependabot actions by commenting on this PR:',
  '- `@dependabot rebase` will rebase this PR',
  '- `@dependabot recreate` will recreate this PR, overwriting any edits that have been made to it',
  '</details>',
  '',
].join('\n');
const dependabotPr = (): PullRequest => ({
  title: 'ci: bump the actions group with 1 update',
  body: DEPENDABOT_BODY,
  files: ['.github/workflows/ci.yml'],
  labels: ['dependencies', 'github_actions'],
  milestone: null,
  author: 'dependabot[bot]',
});

test('pull request: Dependabot gets the title check, and the body rules as notes (#299)', () => {
  // The kit's dependabot.yml sets the prefix `ci`, so Dependabot's title shapes pass the title rule.
  const prefix = /^\s*prefix: (\S+)$/m.exec(readFileSync(join(import.meta.dirname, '..', 'kit', 'project', '.github', 'dependabot.yml'), 'utf8'))?.[1];
  assert.equal(prefix, 'ci');
  for (const title of [`${prefix}: bump the actions group with 1 update`, `${prefix}: bump the actions group across 1 directory with 3 updates`, `${prefix}: bump actions/checkout from 4.2.1 to 4.2.2`]) {
    assert.deepEqual(checkPullRequestTitle(title, DEFAULTS), [], title);
  }
  const found = checkPullRequest(dependabotPr(), DEFAULTS);
  assert.deepEqual(found.map((f) => f.id), ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-milestone', 'pr-labels', 'pr-labels'], 'the rules find the same things');
  const owned = checkOwnedTier({ files: ['.github/workflows/ci.yml'], body: 'tier: B\n' }, { text: '/.github/ @owner\n', from: 'the base branch' });
  assert.ok(owned);
  const split = splitForDependabot(dependabotPr(), [...found, owned]);
  assert.deepEqual(split.problems, [], 'nothing fails');
  assert.deepEqual(split.notes.map((f) => f.id), ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-milestone', 'pr-labels', 'pr-labels', 'pr-owned'], 'every one is still shown');
  assert.match(formatFinding(split.notes[0]), /Dependabot opened this pull request, so it is a note./);
  for (const id of ['pr-labels', 'pr-changelog', 'pr-kit'] as const) assert.equal(splitForDependabot(dependabotPr(), [finding(id, 'x', 'y')]).notes.length, 1, id);

  // The same body from anyone else fails as before; so does no login at all.
  for (const author of ['someone', 'dependabot', 'Dependabot[bot]', '', undefined]) {
    const other = splitForDependabot({ author }, found);
    assert.deepEqual([other.problems, other.notes], [found, []], String(author));
  }
  // A bad title from Dependabot still fails.
  const badTitle = splitForDependabot(dependabotPr(), checkPullRequest({ ...dependabotPr(), title: 'Bump the actions group with 1 update' }, DEFAULTS));
  assert.deepEqual(badTitle.problems.map((f) => f.id), ['pr-title']);
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
  // A heading would go into CHANGELOG.md as is, even a fake version (#281).
  assert.deepEqual(bad('Added\n\n- A thing.\n## 9.9.9\n'), ['4: line 4 is a heading']);
  assert.deepEqual(bad('Added\n\n### Fixed\n'), ['3: line 3 is a heading']);
  assert.deepEqual(bad('Added\n\nA thing,\n#281 and more.\n'), [], 'an issue number is not a heading');
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

test('changes: a link in changes/, dangling or not, is a finding, never a crash (#281)', () => {
  const root = makeRepo({ '1-good.md': 'Added\n\nGood.\n' });
  symlinkSync(join(root, 'changes', '1-good.md'), join(root, 'changes', '2-link.md'));
  symlinkSync(join(root, 'nowhere.md'), join(root, 'changes', '3-dangling.md'));
  const { changes, problems } = readChanges(root);
  assert.deepEqual(changes.map((change) => change.file), ['changes/1-good.md']);
  assert.deepEqual(problems.map((problem) => [problem.id, problem.file]), [['change-file', 'changes/2-link.md'], ['change-file', 'changes/3-dangling.md']]);
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
  // A CRLF file stays CRLF (#281).
  const crlf = mergeChanges(CHANGELOG.replaceAll('\n', '\r\n'), changes);
  assert.equal(crlf, written.replaceAll('\n', '\r\n'));
  // One stray CRLF line: the file is still read, and its lines keep their bytes (#281).
  const [firstLine, ...otherLines] = CHANGELOG.split('\n');
  const mixed = mergeChanges([`${firstLine}\r`, ...otherLines].join('\n'), changes);
  assert.equal(typeof mixed, 'string', 'a stray CRLF line still has an Unreleased heading');
  assert.ok((mixed as string).startsWith(CHANGELOG.split('\n')[0] + '\r\n'), 'the CRLF line is kept');
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

test('titles: limits count the characters a person sees, not code units (#268)', () => {
  const flag = '🇯🇵';
  const family = '👨‍👩‍👧‍👦';
  assert.equal(visibleLength(flag), 1, 'a flag is one character');
  assert.equal(visibleLength(family), 1, 'a ZWJ family is one character');
  assert.equal(visibleLength('漢字🎉a'), 4);
  // A pull request title of 72: 6 + 10 + 1 + 1 + 54.
  const pr = `feat: ${'🚀'.repeat(10)}${flag}${family}${'a'.repeat(54)}`;
  assert.equal(visibleLength(pr), 72);
  assert.deepEqual(checkPullRequestTitle(pr, {}), [], '72 characters with emoji is the most');
  const prOver = checkPullRequestTitle(`${pr}b`, {});
  assert.equal(prOver.length, 1);
  assert.match(formatFinding(prOver[0]), /^title: 73 characters, over 72\./);
  // An issue title of 60: 5 + 40 + 5 + 1 + 1 + 8.
  const issue = `kit: ${'漢'.repeat(40)}${'🎉'.repeat(5)}${flag}${family}${'a'.repeat(8)}`;
  assert.equal(visibleLength(issue), 60);
  assert.deepEqual(checkIssueTitle(issue, AREAS), [], '60 characters with CJK and emoji is the most');
  const issueOver = checkIssueTitle(`${issue}字`, AREAS);
  assert.equal(issueOver.length, 1);
  assert.match(formatFinding(issueOver[0]), /^title: 61 characters, over 60\./);
});

test('config: yokoten\'s own areas cover its open work', () => {
  const own = loadConfig(join(import.meta.dirname, '..'));
  assert.ok(own.areas.includes('doctor') && own.areas.includes('owner'));
  assert.ok(Object.hasOwn(own.commands.block, 'python') && Object.hasOwn(own.commands.block, 'python3'), 'no Python here (#192)');
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
  add(checkCommand('python3 --version', { env: {}, config: { commands: { block: { python3: 'this project is TypeScript only' } } } }));
  add(checkCommand(`bash -c "${':;'.repeat(300000)}"`, { env: {} })); // too many commands to read
  add(checkEdit('test/a.test.ts', { config: DEFAULTS, env }));
  add(checkEdit('AGENTS.md', { config: DEFAULTS, env }));
  add(lateFinding({ command: 'ls', paths: [], worker: false }, 5000));
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
  // `check --history` in a shallow clone (#266).
  const shallow = mkdtempSync(join(tmpdir(), 'yokoten-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${translated.root}`, shallow], { stdio: 'ignore' });
  found.push(...checkHistory(shallow, { config: DEFAULTS, env: {} }));
  found.push(...parseChange('changes/1-a.md', 'Improved\n\nA thing.\n').problems);
  translated.git('update-index', '--add', '--info-only', '--cacheinfo', `100644,${'1'.repeat(40)},ghost.md`);
  add(check(translated.root, { config: DEFAULTS, env: {}, staged: true }).find((f) => f.id === 'missing-blob'));
  // A CI event that can't be read, and a pull request whose commits are not here (#267).
  const unreadable = (read: unknown) => (read && typeof read === 'object' && 'problem' in read ? (read.problem as Finding) : null);
  add(unreadable(readIssue({ GITHUB_EVENT_PATH: join(translated.root, 'no-event.json') })));
  const event = join(translated.root, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: 'f'.repeat(40) }, head: { sha: translated.git('rev-parse', 'HEAD') } } }));
  add(unreadable(readPullRequest(translated.root, { GITHUB_EVENT_PATH: event })));
  // The road and the machine, from an empty folder and an empty home.
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  for (const step of ROAD) add(stepFinding(step, dir, { HOME: dir }));
  add(notRepoFinding(dir));
  writeFileSync(join(dir, 'yokoten.json'), '{ "colour": "blue" }');
  add(findUnknownKeys(dir)[0]);
  rmSync(join(dir, 'yokoten.json'));
  for (const c of [...agentHooks(dir), ...machineChecks({ HOME: dir, YOKOTEN_PRIVATE_MARKS: join(dir, 'none') })]) add(c.finding);
  // The Codex and Gemini CLI user hooks (#211): only once their folders exist.
  for (const folder of ['.codex', '.gemini']) mkdirSync(join(dir, folder));
  for (const c of userAgentHooks({ HOME: dir })) add(c.finding);
  // The plugin (#198): enabled, and installed at a version older than this yokoten.
  const pluginHome = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const pluginFolder = join(pluginHome, 'plugin');
  mkdirSync(join(pluginHome, '.claude', 'plugins'), { recursive: true });
  mkdirSync(pluginFolder);
  writeFileSync(join(pluginHome, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  writeFileSync(join(pluginHome, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'yokoten@yokoten': [{ scope: 'user', installPath: pluginFolder }] } }));
  writeFileSync(join(pluginFolder, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  add(pluginAgeCheck(null, { HOME: pluginHome }));
  // The core rules (#120): behind the kit, and with no heading to compare by.
  for (const rules of ['# old rules\n\n## This project\n', '# rules\n']) {
    writeFileSync(join(dir, 'AGENTS.md'), rules);
    add(coreRulesCheck(dir)?.finding);
  }
  // The server, with every setting off, and with nothing readable.
  const off = { pullRequest: false, codeOwnerReview: false, mergeMethods: [], requiredChecks: [], noForcePush: false, noDeletion: false, approvals: 0 };
  const security = { secretScanning: false, pushProtection: false, privateReporting: false, dependabotAlerts: false };
  const server = { repo: 'octo/demo', defaultBranch: 'main', isPrivate: false, actionsCanApprove: false, mergeMethods: ['merge', 'squash'], deleteBranchOnMerge: false, branch: off, tags: false, security, forgotten: ['old'] };
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

// `yokoten learn` (#77): an incident issue becomes a check draft, from the issue's own
// sections. The issue text is stubbed here; nothing reaches the network.
const incidentOf = (body: string, title = 'check: misses a key in a JSON file'): Incident => ({ number: 12, title, body, url: 'https://example.com/issues/12', labels: ['incident'] });

test('learn: the draft takes what, why and the fix from the issue\'s sections', () => {
  const body = '## What happened\n\nA key in a JSON file was not checked.\n\n## Why it matters\n\nA leaked key opens the account.\n\n## Why it got through\n\nThe privacy check read Markdown only.\n\n## Fix\n\nThe check reads JSON too.\nIt has a test.\n\nMore detail.\n';
  const draft = draftLesson(incidentOf(body));
  assert.deepEqual(draft.finding, { id: 'incident-12', what: 'misses a key in a JSON file', why: 'A leaked key opens the account', fix: 'the check reads JSON too. It has a test' });
  assert.deepEqual(draft.todos, []);
  assert.deepEqual(draft.files.map((file) => file.path), ['lessons/incident-12/lesson.ts', 'lessons/incident-12/lesson.test.ts']);
  const [lesson, check] = draft.files.map((file) => file.text);
  assert.match(lesson, /^\/\/ A lesson from incident #12: check: misses a key in a JSON file\n\/\/ https:\/\/example\.com\/issues\/12\n/);
  assert.match(lesson, /\n\/\/ Fix \(from the issue\):\n\/\/   The check reads JSON too\.\n\/\/   It has a test\.\n\/\/\n\/\/   More detail\.\n/);
  assert.match(lesson, /\n {2}why: 'A leaked key opens the account',\n/);
  assert.match(lesson, /\n\/\/ Why it got through \(from the issue\):\n\/\/   The privacy check read Markdown only\.\n/);
  // The check gets the repo's folder, as doctor runs it in a project (#147).
  assert.match(lesson, /export function findProblems\(root: string\): Finding\[\] \{\n {2}\/\/ TODO\(reviewer\)/);
  // The draft's own test is a positive control that fails until the check is written.
  assert.match(check, /import \{ findProblems, lesson \} from '\.\/lesson\.ts';/);
  assert.match(check, /test\('incident-12: catches the known-bad case'[^]*\[lesson\.id\]\);/);
  assert.match(formatDraft(incidentOf(body), draft).join('\n'), /The issue answers every field\.[^]*\n--- lessons\/incident-12\/lesson\.ts\n/);
});

test('learn: a missing section gives a TODO for the reviewer, never a made-up answer (positive control)', () => {
  const draft = draftLesson(incidentOf('## What happened\n\nA key was not checked.\n\n## Why it got through\n\n_No response_\n'));
  assert.deepEqual(draft.todos, ['why: the issue has no "Why it matters" section', 'fix: the issue has no "Fix" section']);
  assert.match(draft.finding.why, /^TODO\(reviewer\): the issue has no "Why it matters" section; /);
  assert.match(draft.finding.fix, /^TODO\(reviewer\): the issue has no "Fix" section; /);
  assert.ok(!/No response/.test(draft.files[0].text), 'an empty form field is not copied as an answer');
  // No sections at all: every field the body should give is a TODO, and what comes from the title.
  const empty = draftLesson(incidentOf('Something broke.', 'Commit times carry a time zone'));
  assert.equal(empty.finding.what, 'commit times carry a time zone');
  assert.equal(empty.todos.length, 2);
  const lines = formatDraft({ ...incidentOf(''), labels: [] }, draftLesson(incidentOf(''))).join('\n');
  assert.match(lines, /Note: the issue has no `incident` label; it is drafted anyway\.\n2 TODO\(s\) for the reviewer:\n- why: /);
});

test('learn: with no "Why it matters", the why starts from "Why it got through", with a TODO (#147)', () => {
  const draft = draftLesson(incidentOf('## What happened\n\nA key was not checked.\n\n## Why it got through\n\nThe check read Markdown only.\n\n## Fix\n\nRead JSON too.\n'));
  assert.deepEqual(draft.todos, ['why: the issue has no "Why it matters" section; the draft uses "Why it got through"']);
  assert.equal(draft.finding.why, 'TODO(reviewer): the issue has no "Why it matters" section; rewrite this from "Why it got through": The check read Markdown only');
  // A bold label works too, and "Why it matters" is never read as "Why it got through".
  const labelled = draftLesson(incidentOf('**Why it matters:** a leak.\n**Why:** no check.\n**Fix:** a check.'));
  assert.deepEqual([labelled.finding.why, labelled.todos], ['a leak', []]);
});

test('learn: an issue made from the kit\'s incident template drafts with no TODO (#169)', () => {
  // GitHub writes an issue form as `### <label>`, a blank line, then the answer.
  const template = readFileSync(join(import.meta.dirname, '..', 'kit/project/.github/ISSUE_TEMPLATE/incident.yml'), 'utf8');
  const labels = [...template.matchAll(/^\s+label: (.+)$/gm)].map((match) => match[1].trim());
  assert.ok(labels.includes('Fix'), 'the template has a "Fix" field');
  const body = labels.map((label) => `### ${label}\n\n${label === 'Fix' ? 'The check reads JSON too, with a test' : `An answer for ${label}`}`).join('\n\n');
  const draft = draftLesson(incidentOf(body));
  assert.deepEqual(draft.todos, []);
  // The first letter's case is the draft's to shape (#182), so it is not held here.
  assert.match(draft.finding.fix, /^[Tt]he check reads JSON too, with a test$/);
  // Positive control: the same issue with "Fix" left empty gets a TODO.
  const empty = draftLesson(incidentOf(body.replace('The check reads JSON too, with a test', '_No response_')));
  assert.deepEqual(empty.todos, ['fix: the issue has no "Fix" section']);
});

test('learn: sections by heading or bold label, outside code blocks; one line per field', () => {
  const sections = readSections('Intro.\n**What happened:** a commit kept its time zone.\n### Fix and check\n\n- [ ] The commit check refuses it,\n  with a test.\n- [ ] init sets TZ.\n\n```sh\n# a comment\n```\n');
  assert.deepEqual(sections.map((section) => section.heading), ['What happened', 'Fix and check']);
  assert.equal(sections[0].text, 'a commit kept its time zone.');
  assert.equal(summarize(sections[1].text), 'The commit check refuses it, with a test');
  assert.equal(summarize('1. First step:\n2. Second'), 'First step');
  // A quote in the issue stays inside the generated string.
  assert.match(draftLesson(incidentOf('## Fix\n\nIt\'s fixed with a \\ path.')).files[0].text, /fix: 'it\\'s fixed with a \\\\ path',/);
});

// #182: doctor prints "<what>; <fix>", so the fix is shaped like the what: lower case
// after the semicolon, no full stop. A code span or an acronym stays as it is.
test('learn: the fix reads as part of one sentence with the what (#182)', () => {
  const fixOf = (text: string) => draftLesson(incidentOf(`## Fix\n\n${text}\n`)).finding.fix;
  assert.equal(fixOf('The test sets X.'), 'the test sets X');
  assert.equal(fixOf('A check.'), 'a check');
  assert.equal(fixOf('`NO_PROXY` is set.'), '`NO_PROXY` is set');
  assert.equal(fixOf('CI runs it.'), 'CI runs it');
  assert.equal(fixOf('NO_PROXY is set.'), 'NO_PROXY is set');
  assert.equal(fixOf('GitHub keeps it.'), 'GitHub keeps it');
  assert.equal(fixOf('I set NO_PROXY in the test.'), 'I set NO_PROXY in the test', 'the word I stays');
  assert.equal(fixOf("I'm setting it."), "I'm setting it");
  assert.equal(fixOf('It sets it.'), 'it sets it');
  // A missing Fix section keeps its TODO as it is.
  assert.match(draftLesson(incidentOf('')).finding.fix, /^TODO\(reviewer\): /);
});

test('learn: issue text never becomes code in the draft (positive control: the payload is real code)', () => {
  // JavaScript ends a line at U+2028, U+2029 and a lone CR too. A title or body could end a
  // `//` comment there and run the rest when the draft's test imports lesson.ts.
  const [lineSeparator, paragraphSeparator] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
  const payload = "process.getBuiltinModule('node:fs').writeFileSync('PWNED','x');//";
  const hostile = (end: string) => `${end}${payload}`;
  const nasty = "*/ ${x} `tick` 'quote' \"dq\" \\ \u0000\u001b\u0085";
  const title = `repo: tests break${hostile(lineSeparator)}${hostile(paragraphSeparator)}${hostile('\r')}`;
  const body = [
    '## What happened',
    '',
    `It broke.${hostile(lineSeparator)}`,
    `Again.${hostile(paragraphSeparator)} ${nasty}`,
    '',
    '## Why it got through',
    '',
    `No check.${hostile('\r')}`,
    '',
    '## Fix',
    '',
    `A check.${hostile(lineSeparator)}${hostile(paragraphSeparator)}${hostile('\r')} ${nasty}`,
    '',
    '## Lesson',
    '',
    `Read twice.${hostile('\r\n')}`,
  ].join('\n');
  // Writes the draft to a new folder and imports its lesson.ts there, as the draft's own
  // test does: the import parses the file and runs any code in it.
  const importDraft = (made: ReturnType<typeof draftLesson>) => {
    const root = mkdtempSync(join(tmpdir(), 'yokoten-learn-hostile-'));
    writeDraft(root, made);
    const path = made.files[0].path;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const { lesson } = await import('./${path}'); console.log(JSON.stringify(lesson));`], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    return { root, run, lesson: readFileSync(join(root, path), 'utf8') };
  };
  const draft = draftLesson({ ...incidentOf(body, title), url: `https://example.com/issues/12${hostile(lineSeparator)}` });
  const { root, run, lesson } = importDraft(draft);
  // The same with no lone CR: without the fix this draft parses, so the payload would run.
  const parsing = draftLesson({
    ...incidentOf(`## Fix\n\nA check.${hostile(lineSeparator)}${hostile(paragraphSeparator)}\n\n## Lesson\n\nRead twice.${hostile(paragraphSeparator)}`, `repo: tests break${hostile(lineSeparator)}${hostile(paragraphSeparator)}`),
    number: 13,
  });
  const second = importDraft(parsing);
  assert.ok(!existsSync(join(root, 'PWNED')), 'the payload did not run');
  assert.ok(!existsSync(join(second.root, 'PWNED')), 'the payload did not run (no lone CR)');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(second.run.status, 0, second.run.stderr);
  assert.equal(JSON.parse(second.run.stdout).what, parsing.finding.what);
  assert.ok(!/[\r\u{2028}\u{2029}]/u.test(lesson), 'no line end but LF in the draft');
  for (const line of lesson.split('\n').filter((line) => line.includes('writeFileSync'))) {
    assert.match(line, /^(\/\/|  (what|why|fix): ')/, `the payload is only in a comment or a string: ${JSON.stringify(line)}`);
  }
  // A string keeps its text, but for CR and LF, which become a space as before.
  const expected = Object.fromEntries(Object.entries(draft.finding).map(([key, value]) => [key, value.replace(/\r\n|[\n\r]/g, ' ')]));
  assert.deepEqual(JSON.parse(run.stdout), expected, 'the strings keep their text');
  assert.ok(draft.finding.fix.includes(payload) && draft.finding.what.includes(lineSeparator), 'the payload reached the draft as text');
});

test('learn: the printed draft sends no terminal escape from the issue, shown as \\uXXXX instead', () => {
  // Clear the line and move up: a title could hide or fake a line of the preview. OSC 8: a link.
  const title = 'repo: tests break \u001b[2K\u001b[1A \u001b]8;;https://example.com/x\u0007click\u001b]8;;\u0007 \u009b31m';
  const body = '## Fix\n\nA check \u001b[31mred\u001b[0m.\n\n## Lesson\n\nKeep \u001b]0;title\u0007 out.';
  const incident = { ...incidentOf(body, title), labels: [] };
  const text = formatDraft(incident, draftLesson(incident)).join('\n');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text), 'no control character but tab and newline');
  assert.match(text, /^a check draft from issue #12, "repo: tests break \\u001b\[2K\\u001b\[1A \\u001b\]8;;https:\/\/example\.com\/x\\u0007click\\u001b\]8;;\\u0007 \\u009b31m"\.\n/);
  assert.match(text, /\/\/ {3}A check {2}\[31mred \[0m\./, 'a comment in the draft has a space for each');
});

test('learn: bidi controls from the issue are shown as \\uXXXX in the preview and the draft (positive control: raw ones fail)', () => {
  // RLO and the isolates reorder what a reviewer sees ("trojan source"). Built by code, so
  // this file holds none of them raw.
  const bidi = [0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((code) => String.fromCharCode(code));
  const raw = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  const title = `repo: tests break ${bidi.join('x')} end`;
  const body = `## Fix\n\nA check ${bidi.join('')}.\n\n## Lesson\n\nKeep ${bidi[0]}out.`;
  const incident = { ...incidentOf(body, title), labels: [] };
  const draft = draftLesson(incident);
  const text = formatDraft(incident, draft).join('\n');
  assert.ok(!raw.test(text), 'no raw bidi control in the preview');
  assert.ok(text.includes('repo: tests break \\u202ex\\u2066x\\u2067x\\u2068x\\u2069 end'), 'the preview shows each as \\uXXXX');
  const root = mkdtempSync(join(tmpdir(), 'yokoten-learn-bidi-'));
  writeDraft(root, draft);
  for (const file of draft.files) assert.ok(!raw.test(readFileSync(join(root, file.path), 'utf8')), `no raw bidi control in ${file.path}`);
  const lesson = readFileSync(join(root, draft.files[0].path), 'utf8');
  assert.ok(lesson.includes('// A lesson from incident #12: repo: tests break \\u202ex\\u2066x'), 'a comment shows each as \\uXXXX text');
  assert.ok(lesson.includes("  fix: 'a check \\u202e\\u2066\\u2067\\u2068\\u2069',"), 'a string escapes each');
});

test('learn: --write adds the draft\'s files and keeps a file that is there', () => {
  const root = mkdtempSync(join(tmpdir(), 'yokoten-learn-'));
  const draft = draftLesson(incidentOf('## Fix\n\nA check.'));
  assert.deepEqual(writeDraft(root, draft), { written: ['lessons/incident-12/lesson.ts', 'lessons/incident-12/lesson.test.ts'], kept: [] });
  writeFileSync(join(root, 'lessons/incident-12/lesson.ts'), 'reviewed\n');
  assert.deepEqual(writeDraft(root, draft), { written: [], kept: ['lessons/incident-12/lesson.ts', 'lessons/incident-12/lesson.test.ts'] });
  assert.equal(readFileSync(join(root, 'lessons/incident-12/lesson.ts'), 'utf8'), 'reviewed\n', 'a reviewer\'s work is never overwritten');
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
  commit('zh.md', `${sourceMarker('en.md')}\n# 指南\n\n第一步。\n`);
  return { root, git, commit };
}

// #244: blobs are read in batches under a cap, so one buffer never holds a whole big commit.
test('readBlobs: batches under the cap; a blob over it is read only for its start (#244)', () => {
  const sizes = new Map([['a', 10], ['b', 20], ['c', 30], ['d', 41], ['e', 40], ['f', 0]]);
  assert.deepEqual(batchBlobs(sizes, 40), { batches: [['a', 'b'], ['c'], ['e', 'f']], over: ['d'] });
  const repo = makeTranslatedRepo();
  const blob = (bytes: Buffer) => {
    writeFileSync(join(repo.root, 'b'), bytes);
    return repo.git('hash-object', '-w', 'b');
  };
  const small = [10, 20, 30].map((n) => blob(Buffer.alloc(n, String(n))));
  const big = blob(Buffer.concat([Buffer.alloc(9000, 'a'), Buffer.alloc(1)]));
  const missing = 'f'.repeat(40);
  const read = readBlobs(repo.root, [...small, small[0], big, missing], 40);
  assert.deepEqual([...read.keys()].sort(), [...small, big].sort(), 'a missing blob is left out; a repeat is read once');
  for (const [i, n] of [10, 20, 30].entries()) assert.deepEqual(read.get(small[i]), { bytes: Buffer.alloc(n, String(n)), size: n, whole: true });
  const start = read.get(big);
  assert.deepEqual([start?.bytes.length, start?.size, start?.whole], [8000, 9001, false], 'only the first 8000 bytes, enough to tell binary');
  assert.deepEqual(readBlobs(repo.root, []), new Map());
});

// Every read of repo content ignores `git replace` (#284, #294): readBlobs too, in the batch
// and in the over-cap read.
test('readBlobs: reads the bytes as stored, past a replace ref, in the batch and the over-cap read (#244, #294)', () => {
  const repo = makeTranslatedRepo();
  const blob = (bytes: Buffer) => {
    writeFileSync(join(repo.root, 'b'), bytes);
    return repo.git('hash-object', '-w', 'b');
  };
  const stored = blob(Buffer.from('stored bytes\n'));
  const shown = blob(Buffer.from('replacement\n'));
  const big = blob(Buffer.alloc(9000, 'a'));
  const bigShown = blob(Buffer.alloc(9000, 'b'));
  repo.git('replace', stored, shown);
  repo.git('replace', big, bigShown);
  const first = (read: Map<string, { bytes: Buffer }>, id: string) => read.get(id)?.bytes.subarray(0, 1).toString();
  assert.equal(repo.git('cat-file', '-p', stored), 'replacement', 'git itself shows the replacement');
  const read = readBlobs(repo.root, [stored, big], 100);
  assert.deepEqual([read.get(stored)?.bytes.toString(), first(read, big)], ['stored bytes\n', 'a'], 'the bytes as stored');
});

test('check --history: a blob swapped by git replace is read as committed, not as the swap shows it (#284)', () => {
  const repo = makeTranslatedRepo();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  repo.commit('notes.md', `token ${token}\n`);
  const blob = repo.git('rev-parse', 'HEAD:notes.md');
  writeFileSync(join(repo.root, 'harmless.txt'), 'nothing here\n');
  const harmless = repo.git('hash-object', '-w', 'harmless.txt');
  repo.git('replace', blob, harmless);
  assert.equal(repo.git('cat-file', '-p', blob), 'nothing here', 'git itself now shows the harmless bytes');
  const found = checkHistory(repo.root, { config: DEFAULTS, env: {} });
  assert.ok(found.some((f) => f.file?.startsWith(`notes.md @ blob ${blob.slice(0, 8)}`)), JSON.stringify(found));
  assert.ok(!JSON.stringify(found).includes(token), 'the secret is never printed');
});

// The older marker form (#87), with the English blob; still read (#166).
const blobMarker = (source: string, blob: string) => `<!-- source: ${source} blob ${blob} -->`;

test('translations: line 1 names the source; the older form adds a blob; other first lines are not markers (#87, #166)', () => {
  const blob = 'a'.repeat(40);
  assert.equal(sourceMarker('docs/guide.md'), '<!-- source: docs/guide.md -->');
  assert.deepEqual(parseSourceMarker(`${sourceMarker('docs/guide.md')}\n# Title`), { source: 'docs/guide.md', blob: null });
  assert.deepEqual(parseSourceMarker(`${blobMarker('docs/guide.md', blob)}\n# Title`), { source: 'docs/guide.md', blob });
  assert.equal(parseSourceMarker('# Title\n<!-- source: a.md -->'), null, 'only line 1');
  assert.equal(parseSourceMarker('<!-- source: -->'), null, 'no path');
  assert.equal(parseSourceMarker('---\nsource: a.md\n---'), null, 'front matter is not the form');
  // Only a relative path (#181): an attribution comment names a URL, and an absolute path is no repo file.
  for (const source of ['https://example.com/post', 'mailto:a@example.com', '/docs/guide.md', 'C:\\docs\\guide.md']) {
    assert.equal(parseSourceMarker(`${sourceMarker(source)}\n# Title`), null, source);
  }
});

test('translations: a note when English changed after the translation, none when it is current (#87)', () => {
  const repo = makeTranslatedRepo();
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md']), [], 'current: no note');
  const translated = repo.git('rev-parse', 'HEAD');
  repo.commit('en.md', '# Guide\n\nStep one.\nStep two.\n');
  repo.commit('en.md', '# Guide\n\nStep one.\nStep two.\nStep three.\n');
  const [note, ...rest] = translationNotes(repo.root, ['en.md', 'zh.md']);
  assert.deepEqual(rest, []);
  assert.equal(note.id, 'translation-behind');
  assert.equal(note.file, 'zh.md');
  assert.equal(note.line, 1);
  assert.equal(note.what, 'is behind en.md by 2 commits');
  assert.ok(note.fix.includes(`git diff ${translated.slice(0, 12)} HEAD -- en.md`), note.fix);
  // Brought up to date, line 1 unchanged: the note goes.
  repo.commit('zh.md', `${sourceMarker('en.md')}\n# 指南\n\n第一步。第二步。第三步。\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), []);
  // An English edit not yet committed is behind; a translation edit with it is current.
  writeFileSync(join(repo.root, 'en.md'), '# Guide, edited\n');
  assert.equal(translationNotes(repo.root, ['zh.md'])[0]?.what, 'is behind en.md by edits not yet committed');
  writeFileSync(join(repo.root, 'zh.md'), `${sourceMarker('en.md')}\n# 指南（改）\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), []);
});

test('translations: a missing source gives a clear note; a URL or an absolute path is not a marker (#87, #181)', () => {
  const repo = makeTranslatedRepo();
  writeFileSync(join(repo.root, 'gone.md'), `${sourceMarker('nowhere.md')}\n`);
  writeFileSync(join(repo.root, 'out.md'), `${sourceMarker('../en.md')}\n`);
  writeFileSync(join(repo.root, 'credit.md'), '<!-- source: https://example.com/post -->\n# A post\n');
  writeFileSync(join(repo.root, 'root.md'), `${sourceMarker(join(repo.root, 'en.md'))}\n`);
  const notes = translationNotes(repo.root, ['gone.md', 'out.md', 'credit.md', 'root.md']);
  assert.equal(notes.length, 2, notes.map((n) => n.file).join(', '));
  assert.match(notes[0].what, /names nowhere\.md as its English source, which is not in the repo/);
  assert.match(notes[1].what, /names \.\.\/en\.md as its English source, which is not in the repo/);
});

test('translations: a shallow clone gives one note for the run, never a note per file, never a problem (#87, #181)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  repo.commit('zh2.md', `${sourceMarker('en.md')}\n# 指南二\n`);
  const shallowClone = (depth: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
    execFileSync('git', ['clone', '-q', '--depth', String(depth), `file://${repo.root}`, dir], { stdio: 'ignore' });
    return dir;
  };
  // CI's default checkout: one commit, which seems to add every file. Deeper is still shallow.
  for (const depth of [1, 2]) {
    const shallow = shallowClone(depth);
    const notes = translationNotes(shallow, ['en.md', 'zh.md', 'zh2.md']);
    assert.equal(notes.length, 1, `depth ${depth}: ${notes.map((n) => n.what).join('; ')}`);
    assert.equal(notes[0].file, undefined, 'not about one file');
    assert.equal(notes[0].what, "translations weren't checked: this clone is shallow");
    assert.match(notes[0].fix, /fetch-depth: 0/);
    // Even with "fail": a note, never a problem.
    const found: Finding[] = [];
    const problems = check(shallow, { config: { ...DEFAULTS, translations: { fail: true } }, env: {}, notes: found });
    assert.deepEqual(problems.filter((f) => f.id === 'translation-behind'), []);
    assert.deepEqual(found.map((f) => f.what), ["translations weren't checked: this clone is shallow"]);
  }
  // A translation edited in the work tree needs no history: no note.
  const shallow = shallowClone(1);
  writeFileSync(join(shallow, 'zh.md'), `${sourceMarker('en.md')}\n# 指南（改）\n`);
  assert.deepEqual(translationNotes(shallow, ['zh.md']), []);
});

test('translations: two branches that each change both files never edit the same line, and merge in turn with no note (#166)', () => {
  const repo = makeTranslatedRepo();
  const english = (top: string, bottom: string) => `# Guide\n\n${top}\n\nMiddle.\n\n${bottom}\n`;
  const translation = (top: string, bottom: string) => `${sourceMarker('en.md')}\n# 指南\n\n${top}\n\n中。\n\n${bottom}\n`;
  const change = (englishText: string, translationText: string, message: string) => {
    writeFileSync(join(repo.root, 'en.md'), englishText);
    writeFileSync(join(repo.root, 'zh.md'), translationText);
    repo.git('add', 'en.md', 'zh.md');
    repo.git('commit', '-q', '-m', message);
  };
  change(english('Top.', 'Bottom.'), translation('上。', '下。'), 'base');
  // Branches A and B both start here. A changes the top, B the bottom; each updates zh.md.
  repo.git('checkout', '-q', '-b', 'a');
  change(english('Top, A.', 'Bottom.'), translation('上，A。', '下。'), 'a');
  repo.git('checkout', '-q', '-b', 'b', 'main');
  change(english('Top.', 'Bottom, B.'), translation('上。', '下，B。'), 'b');
  // The lines each branch changes in zh.md: none in common, and never line 1.
  const changedLines = (branch: string) => repo.git('diff', '-U0', 'main', branch, '--', 'zh.md').split('\n').filter((line) => line.startsWith('@@')).map((line) => line.split(' ')[1]);
  const [linesA, linesB] = [changedLines('a'), changedLines('b')];
  assert.ok(linesA.length > 0 && linesB.length > 0, 'both branches change the translation');
  assert.deepEqual(linesA.filter((line) => linesB.includes(line)), [], `A ${linesA}, B ${linesB}`);
  assert.ok(![...linesA, ...linesB].some((line) => line === '-1' || line.startsWith('-1,')), 'line 1 is never edited');
  // Squash-merged in turn: git merges B after A with no conflict (it throws on one).
  repo.git('checkout', '-q', 'main');
  for (const branch of ['a', 'b']) {
    repo.git('merge', '-q', '--squash', branch);
    repo.git('commit', '-q', '-m', `squash ${branch}`);
  }
  assert.equal(readFileSync(join(repo.root, 'zh.md'), 'utf8'), translation('上，A。', '下，B。'));
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md']), [], 'both were translated: no note');
  // The English changes later, with no translation: a note, counted from history.
  repo.commit('en.md', english('Top, A.', 'Bottom, B, then C.'));
  const [note, ...rest] = translationNotes(repo.root, ['zh.md']);
  assert.deepEqual(rest, []);
  assert.equal(note.what, 'is behind en.md by 1 commit');
  assert.match(note.fix, /git diff [0-9a-f]{12} HEAD -- en\.md/);
  // The known cost, written in the guide: a typo fix to the translation counts as following.
  repo.commit('zh.md', translation('上，A。', '下，B！'));
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), []);
});

test('translations: the older marker with a blob still works, and its fix offers the line that never changes (#166)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('zh.md', `${blobMarker('en.md', repo.git('hash-object', 'en.md'))}\n# 指南\n\n第一步。\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), [], 'blob is the English: current');
  // Even in a shallow clone, a blob equal to the English is current.
  const shallow = mkdtempSync(join(tmpdir(), 'yokoten-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo.root}`, shallow], { stdio: 'ignore' });
  assert.deepEqual(translationNotes(shallow, ['zh.md']), []);
  // A stale blob: the history decides. Changed together, current; the English later, behind.
  writeFileSync(join(repo.root, 'en.md'), '# Guide\n\nStep one, two.\n');
  writeFileSync(join(repo.root, 'zh.md'), `${blobMarker('en.md', 'b'.repeat(40))}\n# 指南\n\n第一步，第二步。\n`);
  repo.git('add', 'en.md', 'zh.md');
  repo.git('commit', '-q', '-m', 'both');
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), [], 'a blob no commit had, changed with the English: current');
  repo.commit('en.md', '# Guide\n\nStep one, two, three.\n');
  const [note] = translationNotes(repo.root, ['zh.md']);
  assert.equal(note.what, 'is behind en.md by 1 commit');
  assert.ok(note.fix.includes(sourceMarker('en.md')), note.fix);
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

// Shipped lessons (#147): a reviewed lesson moves into the kit, and doctor runs it in every
// project. The lessons here are small ones, written for the test.
const ENV_LESSON = [
  '// A lesson from incident #12: check: a .env file is committed',
  '// https://example.com/issues/12',
  "import { existsSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "export const lesson = { id: 'incident-12', what: 'a .env file is in the repo', why: 'it can hold a secret', fix: 'remove it, and add it to .gitignore' };",
  "export function findProblems(root: string) { return existsSync(join(root, '.env')) ? [lesson] : []; }",
  '',
].join('\n');
const ENV_LESSON_TEST = [
  "import assert from 'node:assert/strict';",
  "import { mkdtempSync, writeFileSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "import { test } from 'node:test';",
  "import { findProblems } from './lesson.ts';",
  "test('catches a .env file', () => {",
  "  const root = mkdtempSync(join(tmpdir(), 'lesson-'));",
  "  writeFileSync(join(root, '.env'), 'KEY=1\\n');",
  '  assert.equal(findProblems(root).length, 1);',
  '});',
  '',
].join('\n');

/** A folder that Node reads as ES modules, as yokoten's own folder is. */
function makeModuleDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
  return root;
}

test('lessons: the table gives each row\'s id, folder, incident and version; other lines are left out', () => {
  const text = ['# Lessons', '', 'Text with | a pipe.', '', '| Lesson | Folder | Incident | Added in |', '|---|---|---|---|', formatLessonRow({ id: 'incident-138', folder: '1/incident-138', url: 'https://example.com/issues/138', version: '0.1.0' }), '| incident-8 | 2/1/incident-8 | https://example.com/issues/8 | 0.2.0 |', ''].join('\n');
  assert.deepEqual(readLessonTable(text), [
    { id: 'incident-138', folder: '1/incident-138', url: 'https://example.com/issues/138', version: '0.1.0' },
    { id: 'incident-8', folder: '2/1/incident-8', url: 'https://example.com/issues/8', version: '0.2.0' },
  ]);
  // A row from before groups (#171): its folder is its id. A folder out of the groups, or not ending in the id, is no row.
  const old = ['| Lesson | Incident | Added in |', '|---|---|---|', '| incident-7 | https://example.com/issues/7 | 0.2.0 |', '| incident-9 | ../incident-9 | https://example.com/issues/9 | 0.2.0 |', '| incident-6 | 1/incident-5 | https://example.com/issues/6 | 0.2.0 |', '| 12 | 1/12 | https://example.com/issues/12 | 0.2.0 |'].join('\n');
  assert.deepEqual(readLessonTable(old), [{ id: 'incident-7', folder: 'incident-7', url: 'https://example.com/issues/7', version: '0.2.0' }]);
  // Written again, the table gets the folder column; the text around it stays.
  const rewritten = formatLessonTable(`# Lessons\n\nIntro.\n\n${old}\n\nAfter.\n`, readLessonTable(old));
  assert.equal(rewritten, '# Lessons\n\nIntro.\n\n| Lesson | Folder | Incident | Added in |\n|---|---|---|---|\n| incident-7 | incident-7 | https://example.com/issues/7 | 0.2.0 |\n\nAfter.\n');
  assert.match(formatLessonTable(null, []), /^# Lessons\n[^]*\n\n\| Lesson \| Folder \| Incident \| Added in \|\n\|---\|---\|---\|---\|\n$/);
});

// #171: lessons sit in numbered groups, so shipping any number of them never breaks the cap.
test('lessons: groups take 5 lessons and 2 groups, by levels; 100 lessons keep every folder within the cap', () => {
  const kit = mkdtempSync(join(tmpdir(), 'yokoten-groups-'));
  writeFileSync(join(kit, 'README.md'), '# Lessons\n');
  const folders: string[] = [];
  for (let n = 1; n <= 100; n++) {
    const folder = `${findLessonGroup(kit)}/incident-${n}`;
    mkdirSync(join(kit, folder), { recursive: true });
    writeFileSync(join(kit, folder, 'lesson.ts'), '');
    writeFileSync(join(kit, folder, 'lesson.test.ts'), '');
    folders.push(folder);
  }
  assert.deepEqual([folders[0], folders[4], folders[5], folders[29], folders[30], folders[35], folders[42]], ['1/incident-1', '1/incident-5', '2/incident-6', '6/incident-30', '1/1/incident-31', '1/2/incident-36', '2/1/incident-43']);
  const files = [join(KIT_LESSONS_DIR, 'README.md'), ...folders.flatMap((folder) => ['lesson.ts', 'lesson.test.ts'].map((name) => join(KIT_LESSONS_DIR, folder, name)))];
  assert.deepEqual(checkLayout(files, DEFAULTS), []);
  assert.ok(Math.max(...folders.map((folder) => folder.split('/').length)) <= 4, 'the depth grows by levels, not one per lesson');
  assert.deepEqual(findLessonFolders(kit).sort(), [...folders].sort(), 'the walk finds each lesson');
});

test('lessons: --ship refuses a draft with a TODO or a failing test, and moves nothing (positive control)', () => {
  const root = makeModuleDir('yokoten-ship-');
  const draftDir = join(root, 'lessons/incident-12');
  assert.match(String((shipLesson(root, '12', '0.1.0') as { problems: string[] }).problems), /no kit\/ here/);
  mkdirSync(join(root, 'kit'));
  assert.match(String((shipLesson(root, '12', '0.1.0') as { problems: string[] }).problems), /no lesson in lessons\/incident-12: run `yokoten learn <issue> --write` first/);
  assert.match(String((shipLesson(root, '../x', '0.1.0') as { problems: string[] }).problems), /is not a lesson id/);
  // A fresh draft: TODOs in both files.
  writeDraft(root, draftLesson(incidentOf('## Why it matters\n\nA leak.\n\n## Fix\n\nA check.\n')));
  let shipped = shipLesson(root, '12', '0.1.0') as { problems: string[] };
  assert.deepEqual(shipped.problems.map((problem) => problem.replace(/\d+ TODO/, 'N TODO')), ['lessons/incident-12/lesson.ts still has N TODO(reviewer): fill each one in', 'lessons/incident-12/lesson.test.ts still has N TODO(reviewer): fill each one in']);
  // No TODO left, but the check finds nothing: its positive control fails.
  writeFileSync(join(draftDir, 'lesson.ts'), ENV_LESSON.replace("existsSync(join(root, '.env')) ? [lesson] : []", '[]'));
  writeFileSync(join(draftDir, 'lesson.test.ts'), ENV_LESSON_TEST);
  shipped = shipLesson(root, 'incident-12', '0.1.0') as { problems: string[] };
  assert.deepEqual(shipped.problems, ['the lesson\'s test fails: run `node --test lessons/incident-12/lesson.test.ts` to see why, and fix the check']);
  assert.ok(existsSync(join(draftDir, 'lesson.ts')) && !existsSync(join(root, 'kit/lessons')), 'nothing moved');
  // Reviewed: it moves, with a row in the table, and the empty drafts folder goes.
  writeFileSync(join(draftDir, 'lesson.ts'), ENV_LESSON);
  assert.deepEqual(shipLesson(root, '12', '0.1.0'), { lesson: { id: 'incident-12', folder: '1/incident-12', url: 'https://example.com/issues/12', version: '0.1.0' } });
  assert.ok(existsSync(join(root, 'kit/lessons/1/incident-12/lesson.test.ts')) && !existsSync(join(root, 'lessons')));
  assert.deepEqual(readLessonTable(readFileSync(join(root, 'kit/lessons/README.md'), 'utf8')).map((row) => row.id), ['incident-12']);
  writeDraft(root, draftLesson(incidentOf('')));
  assert.match(String((shipLesson(root, '12', '0.1.0') as { problems: string[] }).problems), /kit\/lessons\/1\/incident-12 is already there/);
});

test('lessons: doctor runs each lesson as a note; a broken lesson is a note for itself alone; not now skips one', () => {
  const kit = makeModuleDir('yokoten-kit-');
  const ids = ['incident-1', 'incident-2', 'incident-3', 'incident-4', 'incident-5'];
  writeFileSync(join(kit, 'README.md'), ['| Lesson | Incident | Added in |', '|---|---|---|', ...ids.map((id) => `| ${id} | https://example.com/issues/1 | 0.1.0 |`), ''].join('\n'));
  const write = (id: string, text: string) => {
    mkdirSync(join(kit, id));
    writeFileSync(join(kit, id, 'lesson.ts'), text);
  };
  write('incident-1', ENV_LESSON);
  write('incident-2', "export function findProblems() { throw new Error('a bug in the lesson'); }\n");
  // incident-3 has no code.
  write('incident-4', ENV_LESSON);
  write('incident-5', 'export function findProblems() { return [{ what: 1 }]; }\n');
  const project = mkdtempSync(join(tmpdir(), 'yokoten-project-'));
  writeFileSync(join(project, '.env'), 'KEY=1\n');
  const place = { dir: kit, codeDir: kit, codeFile: 'lesson.ts' };
  const checks = lessonChecks(project, { 'incident-4': 'we keep a sample .env' }, place);
  assert.deepEqual(checks.map(({ id, mark }) => `${id} ${mark}`), ['incident-1 note', 'incident-2 note', 'incident-3 note', 'incident-4 not now', 'incident-5 note']);
  assert.deepEqual(formatLessonChecks(checks), [
    '  note    lesson incident-1: a .env file is in the repo; remove it, and add it to .gitignore',
    '  note    lesson incident-2: can\'t run this lesson: a bug in the lesson; run `yokoten install` again; if it stays, report it in an issue',
    '  note    lesson incident-3: can\'t run this lesson: there is no lesson.ts; run `yokoten install` again; if it stays, report it in an issue',
    '  not now lesson incident-4: we keep a sample .env',
    '  note    lesson incident-5: can\'t run this lesson: a finding has no what, why or fix; run `yokoten install` again; if it stays, report it in an issue',
  ]);
  // The finding takes the lesson's id, whatever the lesson said.
  assert.deepEqual(checks[0].findings, [{ id: 'incident-1', what: 'a .env file is in the repo', why: 'it can hold a secret', fix: 'remove it, and add it to .gitignore' }]);
  // A clean project: ok. No table (a project copy of yokoten has no kit): no lessons.
  assert.deepEqual(lessonChecks(mkdtempSync(join(tmpdir(), 'yokoten-clean-')), {}, place).map(({ mark }) => mark), ['ok', 'note', 'note', 'ok', 'note']);
  assert.deepEqual(lessonChecks(project, {}, { ...place, dir: join(kit, 'none') }), []);
});

// #171: doctor finds each lesson by the table's folder: in a group, or flat as before groups.
test('lessons: doctor runs a lesson in a group and a flat one from an older table', () => {
  const kit = makeModuleDir('yokoten-kit-');
  writeFileSync(join(kit, 'README.md'), ['| Lesson | Folder | Incident | Added in |', '|---|---|---|---|', '| incident-1 | 2/1/incident-1 | https://example.com/issues/1 | 0.1.0 |', '| incident-2 | incident-2 | https://example.com/issues/2 | 0.1.0 |', ''].join('\n'));
  for (const folder of ['2/1/incident-1', 'incident-2']) {
    mkdirSync(join(kit, folder), { recursive: true });
    writeFileSync(join(kit, folder, 'lesson.ts'), ENV_LESSON);
  }
  const project = mkdtempSync(join(tmpdir(), 'yokoten-project-'));
  writeFileSync(join(project, '.env'), 'KEY=1\n');
  const checks = lessonChecks(project, {}, { dir: kit, codeDir: kit, codeFile: 'lesson.ts' });
  assert.deepEqual(checks.map(({ id, mark }) => `${id} ${mark}`), ['incident-1 note', 'incident-2 note']);
});

// #172: the first time a clone runs a lesson, doctor says so once, even when it finds nothing.
test('lessons: a lesson not yet seen is new, with what it looks for; not now and no state give no new note', () => {
  const kit = makeModuleDir('yokoten-kit-');
  writeFileSync(join(kit, 'README.md'), ['| Lesson | Incident | Added in |', '|---|---|---|', ...['incident-1', 'incident-2', 'incident-3'].map((id) => `| ${id} | https://example.com/issues/1 | 0.1.0 |`), ''].join('\n'));
  for (const id of ['incident-1', 'incident-2', 'incident-3']) {
    mkdirSync(join(kit, id));
    writeFileSync(join(kit, id, 'lesson.ts'), ENV_LESSON);
  }
  const place = { dir: kit, codeDir: kit, codeFile: 'lesson.ts' };
  const clean = mkdtempSync(join(tmpdir(), 'yokoten-clean-'));
  const checks = lessonChecks(clean, { 'incident-3': 'not for us' }, place, ['incident-2']);
  assert.deepEqual(checks.map(({ id, isNew }) => `${id} ${isNew === true}`), ['incident-1 true', 'incident-2 false', 'incident-3 false']);
  assert.deepEqual(formatLessonChecks(checks), [
    '  note    new lesson: incident-1 (a .env file is in the repo); doctor now runs it in this project',
    '  ok      lesson incident-1',
    '  ok      lesson incident-2',
    '  not now lesson incident-3: not for us',
  ]);
  // A new lesson that finds a problem: the new line, then the problem.
  writeFileSync(join(clean, '.env'), 'KEY=1\n');
  assert.deepEqual(formatLessonChecks(lessonChecks(clean, {}, place, ['incident-2', 'incident-3'])).slice(0, 2), [
    '  note    new lesson: incident-1 (a .env file is in the repo); doctor now runs it in this project',
    '  note    lesson incident-1: a .env file is in the repo; remove it, and add it to .gitignore',
  ]);
  // No state (outside a git repo): nothing is new.
  assert.ok(lessonChecks(clean, {}, place).every((check) => !check.isNew));
  // A lesson that can't run is not new and is not saved as seen; once it is fixed, the note shows once.
  const broken = makeModuleDir('yokoten-broken-');
  mkdirSync(join(broken, 'incident-1'));
  writeFileSync(join(broken, 'incident-1', 'lesson.ts'), "export function findProblems() { throw new Error('a bug in the lesson'); }\n");
  const crashed = lessonChecks(clean, {}, { ...place, codeDir: broken }, ['incident-2', 'incident-3']);
  assert.ok(!formatLessonChecks(crashed).some((line) => line.includes('new lesson')), formatLessonChecks(crashed).join('\n'));
  assert.deepEqual(seenAfter(['incident-2', 'incident-3'], crashed), ['incident-2', 'incident-3']);
  const fixed = lessonChecks(clean, {}, place, seenAfter(['incident-2', 'incident-3'], crashed));
  assert.equal(formatLessonChecks(fixed)[0], '  note    new lesson: incident-1 (a .env file is in the repo); doctor now runs it in this project');
  assert.deepEqual(seenAfter(['incident-2', 'incident-3'], fixed), ['incident-2', 'incident-3', 'incident-1']);
});

test('lessons: the state file is in the git folder; missing, broken or unwritable state is empty, never an error', () => {
  const outside = mkdtempSync(join(tmpdir(), 'yokoten-outside-'));
  assert.equal(findStateFile(outside), null, 'outside a git repo: no state');
  assert.deepEqual(readState(null), {});
  saveState(null, { seenLessons: ['incident-1'] });
  const repo = mkdtempSync(join(tmpdir(), 'yokoten-state-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const file = findStateFile(repo) as string;
  assert.equal(file, join(realpathSync(repo), '.git', 'yokoten', 'state.json'));
  assert.deepEqual(readState(file), {}, 'missing');
  for (const broken of ['{ not json', '[1]', 'null', '{"seenLessons": "incident-1"}']) {
    writeFileSync(join(repo, '.git', 'state-broken.json'), broken);
    assert.deepEqual(readState(join(repo, '.git', 'state-broken.json')), {}, broken);
  }
  // Keys this version does not know are kept; an id that is not text is dropped.
  saveState(file, { seenLessons: ['incident-1'], server: { ci: 'ok' } });
  assert.deepEqual(readState(file), { seenLessons: ['incident-1'], server: { ci: 'ok' } });
  writeFileSync(file, '{"seenLessons": ["incident-1", 7]}');
  assert.deepEqual(readState(file), { seenLessons: ['incident-1'] });
  // A path that can't be written: no throw.
  saveState(join(file, 'under-a-file.json'), { seenLessons: [] });
});

test('lessons: every lesson the kit ships has a row, its incident, no TODO, and a passing positive control', () => {
  const kitLessons = join(import.meta.dirname, '..', KIT_LESSONS_DIR);
  const rows = readLessonTable(readFileSync(join(kitLessons, LESSONS_TABLE), 'utf8'));
  assert.ok(rows.length > 0, 'the kit ships at least one lesson');
  assert.deepEqual(findLessonFolders(kitLessons).sort(), rows.map((row) => row.folder).sort(), 'each folder has one row in the table, and each row a folder');
  for (const { id, folder, url, version } of rows) {
    assert.notEqual(folder, id, `${id}: the lesson is in a group (#171)`);
    assert.match(url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/, `${id}: the incident is an issue URL`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `${id}: the version is x.y.z`);
    const code = readFileSync(join(kitLessons, folder, 'lesson.ts'), 'utf8');
    const test = readFileSync(join(kitLessons, folder, 'lesson.test.ts'), 'utf8');
    assert.ok(code.includes(`// ${url}\n`), `${id}: lesson.ts names its incident`);
    assert.ok(!`${code}${test}`.includes('TODO(reviewer)'), `${id}: no TODO(reviewer) is left`);
    assert.ok(/known-bad case/.test(test), `${id}: lesson.test.ts has a positive control`);
    // Without NODE_TEST_CONTEXT, or the child reports to this run and exits 0 whatever happens.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', join(kitLessons, folder, 'lesson.test.ts')], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, `${id}: its test passes\n${run.stdout}`);
  }
});

test('self-test: the core-rules control passes the real check and fails a broken one (#170)', () => {
  assert.deepEqual(coreRulesControl(), []);
  assert.ok(!selfTest().some((name) => name.startsWith('core rules')));
  const always = (mark: 'ok' | 'MISSING' | 'note') => (root: string) => ({ mark, finding: { ...coreRulesCheck(root)!.finding } });
  assert.deepEqual(coreRulesControl(always('ok')), ['core rules check (edited by hand)', 'core rules check (newer kit)'], 'a check that passes everything');
  assert.deepEqual(coreRulesControl(always('MISSING')), ['core rules check (newer kit)'], 'a check that calls a newer kit MISSING');
  assert.deepEqual(coreRulesControl(always('note')), ['core rules check (edited by hand)'], 'a check that only gives notes');
  // A compare that never sees a version: the newer kit looks hand-edited, so MISSING.
  const noVersion = (root: string) => {
    const result = coreRulesCheck(root)!;
    return result.mark === 'note' ? { mark: 'MISSING' as const, finding: result.finding } : result;
  };
  assert.deepEqual(coreRulesControl(noVersion), ['core rules check (newer kit)']);
});
