// Tests for src/rules/pr.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { checkCommand } from '../../src/rules/guards.ts';
import { judge } from '../../src/run/hook.ts';
import {
  finding,
  type Finding,
  formatFinding,
} from '../../src/rules/message.ts';
import {
  changedLines,
  checkIssueTitle,
  checkOwnedTier,
  hasMadeWith,
  checkPullRequest,
  checkPullRequestBody,
  checkPullRequestTitle,
  isChangeFile,
  largeDiff,
  longSentences,
  ownersOf,
  parseCodeOwners,
  noMilestoneFinding,
  readCommandBody,
  readCommandMilestone,
  readLinkedIssues,
  type PullRequest,
  splitForDependabot,
  visibleLength,
} from '../../src/rules/pr.ts';

const goodPr = (): PullRequest => ({
  title: 'feat(kit): a pull request standard, checked in CI',
  body: 'tier: B\nCloses #47\n\n## Why\nNothing checks it.\n\n## What changed\n- a rule\n\n## How tested\n`node --test`: 50 pass.\n\nMade with worker (opus)\n',
  files: ['src/rules/pr.ts', 'CHANGELOG.md'],
  labels: ['feat', 'tier B'],
  milestone: 'M0 pre-hackathon',
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

const AREAS = { areas: ['doctor', 'check', 'kit'] };

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
  // It hides the `Made with` line as well, so the check names that too.
  assert.deepEqual(checkPullRequest({ ...goodPr(), body: goodPr().body.replace('`node --test`', '<!-- how\n`node --test`') }, DEFAULTS).map((p) => p.id), ['pr-section', 'pr-made-with']);
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

// #570: every pull request names the AI and model that made it, on its last line.
test('pull request body: the last line is `Made with <agent> (<model>)` (#570)', () => {
  const made = '\nMade with worker (opus)\n';
  const bodies = (body: string) => checkPullRequestBody({ body, files: goodPr().files }, DEFAULTS).map((p) => p.id);
  // Positive controls: with the line the body passes, without it only this fails.
  assert.deepEqual(bodies(goodPr().body), [], 'with the line');
  assert.deepEqual(bodies(goodPr().body.replace(made, '\n')), ['pr-made-with'], 'without the line');
  assert.ok(hasMadeWith(goodPr().body));
  assert.equal(hasMadeWith(goodPr().body.replace(made, '\n')), false);
  // The canonical form has the robot emoji; the bare form still passes.
  const emoji = '\n🤖 Made with worker (opus)\n';
  assert.deepEqual(bodies(goodPr().body.replace(made, emoji)), [], 'with the emoji line');
  assert.ok(hasMadeWith(goodPr().body.replace(made, emoji)));
  // Blank lines after it are fine; anything else is not.
  assert.deepEqual(bodies(`${goodPr().body}\n\n`), [], 'trailing blank lines');
  assert.deepEqual(bodies(goodPr().body.replace(made, `${made}Thanks\n`)), ['pr-made-with'], 'text after the line');
  assert.deepEqual(bodies(goodPr().body.replace(made, `${emoji}Thanks\n`)), ['pr-made-with'], 'text after the emoji line');
  assert.deepEqual(bodies(goodPr().body.replace(made, '\nMade with worker ()\n')), ['pr-made-with'], 'no model');
  assert.deepEqual(bodies(goodPr().body.replace(made, '\n🤖 Made with worker ()\n')), ['pr-made-with'], 'no model with the emoji');
  assert.deepEqual(bodies(goodPr().body.replace(made, '\nMade with worker\n')), ['pr-made-with'], 'no model in brackets');
  assert.deepEqual(bodies(goodPr().body.replace(made, '\nMade by worker (opus)\n')), ['pr-made-with'], 'another wording');
  assert.deepEqual(bodies(goodPr().body.replace(made, '\n🤖 Made by worker (opus)\n')), ['pr-made-with'], 'another wording with the emoji');
  // A commented line counts neither way: hidden credit is no credit.
  assert.deepEqual(bodies(goodPr().body.replace(made, '\n<!-- Made with worker (opus) -->\n')), ['pr-made-with'], 'a comment hides it');
  assert.deepEqual(bodies(goodPr().body.replace(made, '\n<!-- 🤖 Made with worker (opus) -->\n')), ['pr-made-with'], 'a comment hides the emoji line');
  assert.deepEqual(bodies(`${goodPr().body}<!-- a note -->\n`), [], 'a trailing comment is set aside');
});

test('pull request: docs, tests and CI need no changelog line; a reason lets code through (#47)', () => {
  assert.deepEqual(checkPullRequest({ ...goodPr(), files: ['docs/guide.md', 'test/a.test.ts', '.github/workflows/pr.yml'] }, DEFAULTS), []);
  assert.deepEqual(checkPullRequest({ ...goodPr(), files: ['src/a.ts'], body: `${goodPr().body.replace('\nMade with worker (opus)\n', '\nNo changelog: a comment only\n\nMade with worker (opus)\n')}` }, DEFAULTS), []);
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

test('pull request: Dependabot gets the title check, and the body rules as notes (#299)', () => {
  // The kit's dependabot.yml sets the prefix `ci`, so Dependabot's title shapes pass the title rule.
  const prefix = /^\s*prefix: (\S+)$/m.exec(readFileSync(join(import.meta.dirname, '../..', 'kit', 'project', '.github', 'dependabot.yml'), 'utf8'))?.[1];
  assert.equal(prefix, 'ci');
  for (const title of [`${prefix}: bump the actions group with 1 update`, `${prefix}: bump the actions group across 1 directory with 3 updates`, `${prefix}: bump actions/checkout from 4.2.1 to 4.2.2`]) {
    assert.deepEqual(checkPullRequestTitle(title, DEFAULTS), [], title);
  }
  const found = checkPullRequest(dependabotPr(), DEFAULTS);
  assert.deepEqual(found.map((f) => f.id), ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-made-with', 'pr-milestone', 'pr-labels', 'pr-labels'], 'the rules find the same things');
  const owned = checkOwnedTier({ files: ['.github/workflows/ci.yml'], body: 'tier: B\n' }, { text: '/.github/ @owner\n', from: 'the base branch' });
  assert.ok(owned);
  const split = splitForDependabot(dependabotPr(), [...found, owned]);
  assert.deepEqual(split.problems, [], 'nothing fails');
  assert.deepEqual(split.notes.map((f) => f.id), ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-made-with', 'pr-milestone', 'pr-labels', 'pr-labels', 'pr-owned'], 'every one is still shown');
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

// The tool-call guard runs the bot's title check on plain gh too (#391), so an issue CI
// would fail is never opened.
test('guard: a gh title is checked before it is sent, plain or through the bot (#391)', () => {
  const config = { ...DEFAULTS, areas: ['check', 'doctor'] };
  const guard = (command: string) => checkCommand(command, { cwd: process.cwd(), env: {}, config, titles: true });
  const unknownArea = guard('gh issue create --title "billing: add invoices" --body ok');
  const [expected] = checkIssueTitle('billing: add invoices', config);
  assert.deepEqual(unknownArea, expected, 'the same finding as the bot gives');
  const long = `check: ${'add a very long title '.repeat(4).trim()}`;
  assert.ok(long.length > 60);
  assert.match(guard(`gh issue create --title "${long}" --body ok`)?.what ?? '', /over 60/);
  assert.deepEqual(guard('gh issue edit 3 -t "nonsense"'), checkIssueTitle('nonsense', config)[0]);
  assert.equal(guard('gh pr create --title "add things" --body ok')?.id, 'pr-title');
  assert.deepEqual(guard('gh pr edit 3 --title="feat(billing): add invoices"'), checkPullRequestTitle('feat(billing): add invoices', config)[0]);
  assert.deepEqual(guard('yokoten bot -- gh issue create --title "billing: add invoices"'), expected);
  assert.equal(guard('gh issue create --title "doctor: add the review step" --body ok'), null);
  assert.equal(guard('gh pr create --title "feat(check): read the title" --body ok'), null);
  assert.equal(guard('yokoten bot -- gh pr create --title "fix(doctor): name the step" --body ok'), null);
  assert.equal(guard('gh pr create --fill'), null, 'no title: CI checks it');
  assert.equal(guard('echo gh issue create --title nonsense'), null, 'not a gh command');
});

// A title follows its own project's rules (#391 review): only a project hook in a repo
// with a yokoten.json checks it. The user-level hook runs in every repo, and does not.
test('guard: titles are checked only by a project hook in a repo with a yokoten.json (#391)', () => {
  const bad = 'gh issue create --title "Login fails on Safari" --body ok';
  const action = { command: bad, paths: [], worker: false };
  const plain = makeTempDir('yokoten-titles-');
  assert.equal(judge({ ...action, cwd: plain }, { root: plain, config: DEFAULTS, env: {}, cwd: process.cwd() }), null, 'no yokoten.json');
  const project = makeTempDir('yokoten-titles-');
  writeFileSync(join(project, 'yokoten.json'), '{}');
  assert.equal(judge({ ...action, cwd: project }, { root: project, config: DEFAULTS, env: {}, cwd: process.cwd() })?.id, checkIssueTitle('Login fails on Safari', DEFAULTS)[0].id);
  assert.equal(judge({ ...action, cwd: project }, { root: project, config: DEFAULTS, env: {}, cwd: process.cwd(), commandsOnly: true }), null, 'the user-level hook');
  assert.equal(checkCommand(bad, { cwd: process.cwd(), env: {} }), null, 'off unless asked for');
});

// #406: the bot checks a pull request's body with the body part of the CI rules.
test('pull request body: the body rules of check --pr, without the title, milestone or labels (#406)', () => {
  const body = { body: goodPr().body, files: goodPr().files };
  assert.deepEqual(checkPullRequestBody(body, DEFAULTS), []);
  assert.deepEqual(checkPullRequestBody({ ...body, body: 'x' }, DEFAULTS).map((p) => p.id), ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-made-with']);
  assert.deepEqual(checkPullRequestBody({ ...body, files: ['kit/a.md'] }, DEFAULTS).map((p) => p.id), ['pr-kit']);
  // checkPullRequest still gives every finding, in the same order as before.
  const all = checkPullRequest({ ...goodPr(), title: 'x', body: 'x', files: ['kit/a.ts'], labels: [], milestone: null }, DEFAULTS).map((p) => p.id);
  assert.deepEqual(all, ['pr-title', 'pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-made-with', 'pr-changelog', 'pr-kit', 'pr-milestone', 'pr-labels', 'pr-labels']);
});

test('pull request body: read from gh pr create and edit, in every spelling gh takes (#406)', () => {
  const none = { base: null, repo: null, head: null };
  assert.deepEqual(readCommandBody(['gh', 'pr', 'create', '--body', 'tier: A']), { ...none, body: { text: 'tier: A' } });
  assert.deepEqual(readCommandBody(['gh', 'pr', 'new', '-b', 'a', '--body-file', 'f.md']), { ...none, body: { file: 'f.md' } }, 'the last one wins');
  assert.deepEqual(readCommandBody(['gh', 'pr', 'create', '-F-', '-B', 'dev', '-H', 'topic']), { ...none, body: { file: '-' }, base: 'dev', head: 'topic' });
  assert.deepEqual(readCommandBody(['gh', '-R', 'o/r', 'pr', 'edit', '12', '--body=x', '--base=dev']), { body: { text: 'x' }, base: 'dev', repo: 'o/r', head: '12' });
  assert.deepEqual(readCommandBody(['gh', 'pr', 'edit', '-dzbx']), null, 'a run-together word the title check refuses');
  // No body, or not a pull request create or edit: nothing to check.
  for (const command of [['gh', 'pr', 'edit', '5', '--add-label', 'bug'], ['gh', 'pr', 'create', '--fill'], ['gh', 'issue', 'create', '--body', 'x'], ['gh', 'pr', 'comment', '5', '--body', 'x'], ['git', 'push'], ['gh', 'pr', 'create', '--title', 'feat: a', '--', '--body', 'x']]) {
    assert.equal(readCommandBody(command), null, command.join(' '));
  }
});

// #512: the issues whose milestone `gh pr create` takes, read without the network.
test('readCommandMilestone: the linked issues of a new pull request with no milestone (#512)', () => {
  const body = 'tier: B\nPart of #4\nCloses #7, refs #4\n';
  assert.deepEqual(readLinkedIssues(body), [4, 7]);
  assert.deepEqual(readCommandMilestone(['gh', 'pr', 'create', '-t', 'feat: a'], body), { issues: [4, 7], repo: null });
  assert.deepEqual(readCommandMilestone(['gh', 'pr', 'new', '-R', 'o/r'], body), { issues: [4, 7], repo: 'o/r' });
  // Positive controls: a milestone the command gives, in each spelling, is kept.
  for (const given of [['--milestone', 'M1'], ['--milestone=M1'], ['-m', 'M1'], ['-mM1'], ['-dm', 'M1']]) {
    assert.equal(readCommandMilestone(['gh', 'pr', 'create', ...given], body), null, given.join(' '));
  }
  // Not a new pull request, no body, or no linked issue: nothing to do.
  assert.equal(readCommandMilestone(['gh', 'pr', 'edit', '5'], body), null);
  assert.equal(readCommandMilestone(['gh', 'issue', 'create'], body), null);
  assert.equal(readCommandMilestone(['git', 'push'], body), null);
  assert.equal(readCommandMilestone(['gh', 'pr', 'create'], null), null);
  assert.equal(readCommandMilestone(['gh', 'pr', 'create'], 'tier: B\n'), null);
  // The refusal names the flag to add.
  assert.match(noMilestoneFinding([2]).what, /^milestone: none given, and the linked issue #2 has none$/);
  assert.match(noMilestoneFinding([2, 3]).what, /none of the linked issues #2, #3 has one/);
  assert.match(noMilestoneFinding([2]).fix, /--milestone/);
});
