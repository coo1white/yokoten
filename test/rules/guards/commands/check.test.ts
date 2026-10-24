import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { blocked, allowed } from '../../../../test/repo/helpers.ts';

test('the bot is not a way around the guard', () => {
  assert.ok(checkCommand('node .yokoten/bin/yokoten.ts bot -- git push --tags', { cwd: process.cwd(), env: {} }));
  assert.ok(checkCommand('yokoten bot -- gh release create v1', { cwd: process.cwd(), env: {} }));
});

// .yokoten/ is the copy of yokoten the hooks and CI run: a worker that changes it can turn the checks off (#297).

test('release: tag pushes, release commands and publishing are the owner\'s', () => {
  for (const command of [
    'git push --tags',
    'git push origin --follow-tags',
    'git push --mirror backup',
    'git push origin v1.2.0',
    'git push origin refs/tags/v1',
    'git push origin HEAD:refs/tags/x',
    'git -c push.followTags=true push',
    'git -C ../other push --tags',
    "bash -c 'git push --tags'",
    'echo ok && git push --tags',
    '/usr/bin/git push --tags',
    'gh release create v1.0.0',
    'gh release upload v1 file',
    'npm publish',
    'pnpm publish --access public',
    'yarn npm publish',
  ]) blocked(command);
});

test('release: making a tag is creating a release, so the owner does it (#812)', () => {
  for (const command of ['git tag v1.2.0', 'git tag -a v1.2.0 -m release', 'git tag -s v1 -m x', 'git tag -f v1']) {
    const found = checkCommand(command, { cwd: process.cwd(), env: {} });
    assert.equal(found?.id, 'release', command);
    assert.match(found?.what ?? '', /^creating the tag /, command);
  }
  allowed('git tag');
  allowed('git tag -l');
  allowed('git tag --list "v*"');
  allowed('git tag -d v1.2.0');
  allowed('git tag -v v1.2.0');
  allowed('git tag v1.2.0', { YOKOTEN_RELEASE_APPROVAL: '1' });
  assert.match(checkCommand('git tag v1.2.0', { cwd: process.cwd(), env: {} })?.fix ?? '', /run `git tag v1\.2\.0` themselves/);
  // A name the shell would run is quoted, so the line handed back can be pasted (#847).
  const runLine = checkCommand('git tag v1$(id)', { cwd: process.cwd(), env: {} })?.fix ?? '';
  assert.match(runLine, /run `git tag 'v1\$\(id\)'` themselves/);
});

test('release: making a repo public is the owner\'s', () => {
  blocked('gh repo edit --visibility public');
  blocked('gh repo edit octo/demo --visibility=public');
  blocked('gh repo create octo/demo --public');
  blocked('gh repo create demo --visibility=public');
  blocked('gh repo edit --visibility private --visibility public');
  allowed('gh repo edit --visibility public --visibility private');
  allowed('gh repo edit --visibility private');
  allowed('gh repo create octo/demo --private');
});

test('losing work: a hard reset is stopped', () => {
  for (const command of ['git reset --hard', 'git reset --hard origin/main', 'git -C ../other reset --hard HEAD~1']) blocked(command);
  allowed('git reset --soft HEAD~1');
  allowed('git reset');
  allowed('git restore --staged AGENTS.md');
});

test('release: the refusal names the whole push, remote included (#557)', () => {
  assert.equal(checkCommand('git push origin v1.2.0', { cwd: process.cwd(), env: {} })?.what, 'git push origin v1.2.0 pushes a release tag');
  assert.equal(checkCommand('git push v1.2.0', { cwd: process.cwd(), env: {} })?.what, 'git push v1.2.0 pushes a release tag');
});

test('release: the owner\'s approval lets it through', () => {
  const env = { YOKOTEN_RELEASE_APPROVAL: '1' };
  allowed('git push --tags', env);
  allowed('gh release create v1.0.0', env);
  allowed('npm publish', env);
});

test('release: without an agent, the fix names none (#350)', () => {
  assert.equal(checkCommand('git push --tags', { cwd: process.cwd(), env: {} })?.fix, 'if the owner asked for this, they start a new session of their agent with YOKOTEN_RELEASE_APPROVAL=1; do not look for another way');
});

test('approval in the command text does not count', () => {
  blocked('YOKOTEN_RELEASE_APPROVAL=1 git push --tags');
});

test('force push: plain force is stopped, lease is fine', () => {
  for (const c of ['git push --force', 'git push -f origin main', 'git push -uf origin x', 'git push origin +main']) blocked(c);
  allowed('git push --force-with-lease');
  allowed('git push -u origin feature');
});

test('skipping the commit check is stopped', () => {
  for (const c of ['git commit --no-verify -m x', 'git commit -nm x', 'git push --no-verify', 'git config core.hooksPath /dev/null', 'git config --local core.hooksPath ""']) blocked(c);
  allowed('git config core.hooksPath .githooks');
  allowed('git commit -m "no --verify needed"'.replace('--verify', 'verify'));
});

// The hooks setting (#114). Each row of the issue's table first, then the other forms.

test('git options that take a value are skipped before the subcommand (#114)', () => {
  // `--attr-source <tree>` takes a value; without it in the list, `HEAD` looked like the subcommand.
  blocked('git --attr-source HEAD push --tags');
  blocked('git -C . --namespace x push --tags');
});

test('checkCommand: without the host rules loaded, a gh command is refused, not let through (#650)', () => {
  const guards = pathToFileURL(join(process.cwd(), 'src/rules/guards/index.ts')).href;
  const script = `const { checkCommand } = await import(process.argv[1]); const at = (c) => checkCommand(c, { cwd: process.cwd(), env: {} })?.id ?? 'allowed'; console.log(at('gh run cancel 1'), at('gh pr view 1'), at('ls'));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, guards], { encoding: 'utf8' });
  assert.equal(result.stdout.trim(), 'run-remove run-remove allowed', result.stderr);
});

// #659, #668: with gh's token, curl or a script calls the host around every gh rule.

test('release: creating a local tag is the owner\'s too, not only pushing it (#812)', () => {
  for (const command of [
    'git tag v1.2.3',
    'git tag -a v1.2.3 -m "release 1.2.3"',
    'git tag -s v1.2.3 -m "release 1.2.3"',
    'git tag -f v1.2.3',
    'git tag v1.2.3 HEAD~1',
    'git -C ../other tag v1.2.3',
    // A listing option does not turn a named tag into a listing (#873).
    'git tag -a v1.2.3 --sort=creatordate -m msg',
    'git tag -a v1.2.3 --sort creatordate -m msg',
    'git tag --format=%(refname) v1.2.3',
    'git tag --format=%(refname) v1.2.3',
    'git tag -a v1.2.3 --format=%(refname) -m msg',
    'git tag -a v1.2.3 --column -m msg',
    'git tag --column=always v1.2.3',
    'git tag --sort creatordate -- v1.2.3',
    // The word reader keeps a git format atom whole without hiding what follows it (#873).
    'echo %(git push --tags)',
    'git tag --format=%(refname; git push --tags)',
    'git tag --format=%(refname\ngit push --tags',
    // A short-flag group with a writing letter still writes.
    'git tag -an v1.2.3 -m msg',
  ]) blocked(command);
  // Listing, and changing a tag that already exists, publish nothing.
  allowed('git tag');
  allowed('git tag -l');
  allowed('git tag --contains HEAD');
  allowed('git tag -n v1');
  allowed('git tag -ln v1');
  allowed('git tag -nl v1');
  allowed('git tag -d old-tag');
  allowed('git tag --sort=creatordate');
  allowed('git tag --sort creatordate');
  allowed('git tag --format=%(refname)');
  allowed('git tag --format %(refname)');
  allowed('git tag --column');
  allowed('git tag -l --format=%(refname)');
  allowed('git tag v1.2.3', { YOKOTEN_RELEASE_APPROVAL: '1' });
});
