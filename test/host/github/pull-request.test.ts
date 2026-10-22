// Tests for src/host/github/pull-request.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { GitReadError } from '../../../src/run/check.ts';
import { annotation, annotations, readBranchFiles, readCodeOwners, stepSummary } from '../../../src/host/github/pull-request.ts';

// #91: workflow commands, escaped as GitHub's runner decodes them
// (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands).
test('annotations: escape the message and the properties; a history place goes in the message (#91)', () => {
  const f = { id: 'layout', what: '100% full,\nline two\r', why: 'a: b', fix: 'see a, b', file: 'docs/a,b:c.md', line: 7 };
  assert.equal(annotation(f, 'error'), '::error file=docs/a%2Cb%3Ac.md,line=7,title=yokoten layout::100%25 full,%0Aline two%0D. A: b. See a, b.');
  assert.equal(annotation({ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }, 'warning'), '::warning title=yokoten large-diff::big. W. F.');
  assert.equal(annotation({ id: 'secret', what: 'a secret', why: 'w', fix: 'f', grade: 'likely', ignored: 'a test fixture' }, 'warning'), '::warning title=yokoten secret::a secret [likely; ignored: a test fixture]. W. F.');
  assert.equal(annotation({ ...f, what: 'x', file: 'commit abc (message)', line: 1 }, 'error', false), '::error title=yokoten layout::commit abc (message):1: x. A: b. See a, b.');
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.equal(annotation(linked, 'error'), '::error file=a.md,line=1,title=yokoten email::an email. W. F.%0A  docs: https://example.com/guide#privacy', 'the link goes in the message (#94)');
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const lines = annotations(many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.equal(lines.length, 50, 'GitHub shows at most 50 per job');
  assert.ok(lines.every((l) => l.startsWith('::error ')), 'problems come before notes');
});

test('step summary: a heading with the result, a table, notes apart, at most 50 rows (#91)', () => {
  assert.equal(stepSummary('yokoten check', [], []), '### yokoten check: ok\n\n');
  // GitHub renders the summary as HTML: a `<` in a cell would hide the text after it.
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'an email', why: 'w', fix: 'f', file: '<draft>.md', line: 1 }], []), /\| &lt;draft>\.md:1 \|/);
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'a\\|b', why: 'w', fix: 'f' }], []), /\| a\\\\\\\|b \|/);
  const one = stepSummary('yokoten check --pr', [{ id: 'pr-title', what: 'title: a | b', why: 'why', fix: 'fix it' }], [{ id: 'long-sentence', what: 'long', why: 'w', fix: 'f', file: 'a.md', line: 2 }]);
  assert.equal(one, [
    '### yokoten check --pr: 1 problem',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '|  | pr-title | title: a \\| b | Why | Fix it |',
    '',
    '#### Notes (1): these never fail the check',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '| a.md:2 | long-sentence | long | W | F |',
    '',
    '',
  ].join('\n'));
  // The id links to its section (#94).
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.match(stepSummary('yokoten check', [linked], []), /\n\| a\.md:1 \| \[email\]\(https:\/\/example\.com\/guide#privacy\) \| an email \| W \| F \|\n/);
  assert.match(stepSummary('yokoten check', [{ id: 'secret', what: 'a secret', why: 'w', fix: 'f', file: 'a.env', line: 2, grade: 'likely', ignored: 'a test fixture' }], []), /\n\| a\.env:2 \| secret \| a secret \[likely; ignored: a test fixture\] \| W \| F \|\n/);
  const many = Array.from({ length: 53 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const text = stepSummary('yokoten check', many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.match(text, /^### yokoten check: 53 problems\n/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('| a.md:')).length, 50);
  assert.match(text, /\nAnd 3 more\. The job log lists them all\.\n/);
  assert.match(text, /#### Notes \(1\): these never fail the check\n\nThe job log lists them\.\n/);
});
// #406: the bot reads the branch's files as check --pr reads a pull request's: a rename is its new path.
test('branch files: changed, renamed and deleted paths since the base, from one local diff (#406)', () => {
  const dir = makeTempDir('yokoten-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'old.ts'), 'export const long = "a long enough line for git to see a rename";\n');
  writeFileSync(join(dir, 'gone.md'), 'Gone.\n');
  writeFileSync(join(dir, 'same.md'), 'Same.\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('mv', 'src/old.ts', 'src/new name.ts');
  git('rm', '-q', 'gone.md');
  writeFileSync(join(dir, 'kit.md'), 'New.\n');
  git('add', '.');
  git('commit', '-qm', 'head');
  const read = readBranchFiles(dir, 'origin/main', 'HEAD', process.env);
  assert.deepEqual({ files: read?.files.sort(), deleted: read?.deleted }, { files: ['gone.md', 'kit.md', 'src/new name.ts'], deleted: ['gone.md'] });
  assert.equal(readBranchFiles(dir, 'origin/none', 'HEAD', process.env), null, 'a base git does not have');
});

// No answer from git is never "no CODEOWNERS", which would let a pull request lower its tier (#403).
test('readCodeOwners: the first place the base commit has; a base git can\'t read throws, never null (#403)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'none');
  const none = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('docs/CODEOWNERS', '/docs/ @b\n');
  sandbox.write('CODEOWNERS', '/kit/ @a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'owners');
  const owners = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // The work tree has another file, which a pull request run must not read.
  sandbox.write('CODEOWNERS', '');
  assert.equal(readCodeOwners(sandbox.repo, none, process.env), null);
  assert.deepEqual(readCodeOwners(sandbox.repo, owners, process.env), { text: '/kit/ @a\n', from: 'the base branch' });
  assert.throws(() => readCodeOwners(sandbox.repo, 'f'.repeat(40), process.env), GitReadError);
});

test('annotations: an ignore a pull request adds is a notice, after the problems and before the other notes (#616)', () => {
  const problem = { id: 'secret', what: 'a secret', why: 'w', fix: 'f', file: 'a.ts', line: 1 };
  const added = { id: 'ignore-added', what: 'this pull request lets a secret hit through on this line', why: 'w', fix: 'f', file: 'a.ts', line: 2, ignored: 'a fixture' };
  const note = { id: 'large-diff', what: 'big', why: 'w', fix: 'f' };
  const lines = annotations([problem], [note, added]);
  assert.match(lines[0], /^::error /);
  assert.equal(lines[1], '::notice file=a.ts,line=2,title=yokoten ignore-added::this pull request lets a secret hit through on this line [ignored: a fixture]. W. F.');
  assert.match(lines[2], /^::warning /);
});
