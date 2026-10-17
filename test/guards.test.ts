import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, type Env } from '../src/rules/config.ts';
import { checkCommand, checkEdit } from '../src/rules/guards.ts';

const blocked = (command: string, env: Env = {}) => assert.ok(checkCommand(command, { env }), `should block: ${command}`);
const allowed = (command: string, env: Env = {}) => assert.equal(checkCommand(command, { env }), null, `should allow: ${command}`);

test('release: tag pushes, release commands and publishing are the owner\'s', () => {
  for (const c of [
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
  ]) blocked(c);
});

test('release: the owner\'s approval lets it through', () => {
  const env = { YOKOTEN_RELEASE_APPROVAL: '1' };
  allowed('git push --tags', env);
  allowed('gh release create v1.0.0', env);
  allowed('npm publish', env);
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

test('everyday commands pass', () => {
  for (const c of ['git status', 'git push', 'git push origin feature-v2', 'git commit -m "fix v1 parser"', 'npm test', 'gh pr create --fill', 'ls -la', 'gh release list']) allowed(c);
});

test('fix task: test files are off limits', () => {
  const env = { YOKOTEN_FIX_TASK: '1' };
  for (const p of ['test/a.ts', 'src/a.test.ts', 'web/b.spec.js', 'pkg/x_test.go', 'tests/fixtures/x.json']) {
    assert.ok(checkEdit(p, { config: DEFAULTS, env }), p);
  }
  assert.equal(checkEdit('src/a.ts', { config: DEFAULTS, env }), null);
  assert.equal(checkEdit('test/a.ts', { config: DEFAULTS, env: {} }), null);
});

test('lead-only files: a worker is stopped, the lead is not', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const p of ['AGENTS.md', 'CLAUDE.md', 'yokoten.json', '.claude/settings.json', '.github/workflows/ci.yml', '.githooks/pre-commit']) {
    assert.ok(checkEdit(p, { config: DEFAULTS, env: worker }), p);
    assert.equal(checkEdit(p, { config: DEFAULTS, env: {} }), null, p);
  }
  // A glob with a slash is the root's folder only; one without matches in any folder.
  assert.ok(checkEdit('kit/project/AGENTS.md', { config: DEFAULTS, env: worker }));
  assert.equal(checkEdit('kit/project/.github/workflows/x.yml', { config: DEFAULTS, env: worker }), null);
});
