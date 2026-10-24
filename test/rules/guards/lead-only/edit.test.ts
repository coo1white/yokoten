import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand, checkEdit, isGranted, isLeadOnly, stripWorktreeRoot } from '../../../../src/rules/guards/index.ts';
import { makeSandbox, yokotenSandbox } from '../../../../test/repo/helpers.ts';
import type { Env } from '../../../../src/rules/config.ts';
import { DEFAULTS } from '../../../../src/rules/config.ts';

test('the vendored .yokoten/ runtime is lead-only: the hook and check --staged stop a worker, not the lead (#297)', async () => {
  const sandbox = makeSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const edit = (extra?: Record<string, string>) => sandbox.call(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { file_path: join(sandbox.repo, '.yokoten', 'src', 'run', 'check.ts') } }), extra });
  let result = await edit(worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\.yokoten\/src\/run\/check\.ts is lead-only/);
  assert.equal((await edit()).status, 0, 'the lead may edit it');
  sandbox.write('.yokoten/src/run/check.ts', 'export {};\n');
  sandbox.git('add', '.');
  result = await sandbox.call(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.yokoten\/src\/run\/check\.ts is lead-only/);
  result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
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
  for (const p of ['AGENTS.md', 'CLAUDE.md', 'yokoten.json', '.claude/settings.json', '.claude-plugin/plugin.json', '.codex/hooks.json', '.gemini/settings.json', '.github/workflows/ci.yml', '.githooks/pre-commit', '.yokoten/src/run/check.ts', '.yokotenignore']) {
    assert.ok(checkEdit(p, { config: DEFAULTS, env: worker }), p);
    assert.equal(checkEdit(p, { config: DEFAULTS, env: {} }), null, p);
  }
  // A glob with a slash is the root's folder only; one without matches in any folder.
  assert.ok(checkEdit('kit/project/AGENTS.md', { config: DEFAULTS, env: worker }));
  assert.equal(checkEdit('kit/project/.github/workflows/x.yml', { config: DEFAULTS, env: worker }), null);
});

test('lead-only files: a path under .worktrees/<issue>/ reads from that worktree (#571)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  assert.equal(stripWorktreeRoot('.worktrees/571-x/AGENTS.md'), 'AGENTS.md');
  assert.equal(stripWorktreeRoot('.worktrees/a/.worktrees/b/.github/workflows/ci.yml'), '.github/workflows/ci.yml', 'a worktree in a worktree');
  assert.equal(stripWorktreeRoot('.worktrees/571-x'), '.worktrees/571-x', 'a worktree itself stays');
  assert.equal(stripWorktreeRoot('src/a.ts'), 'src/a.ts');
  // A lead-only file there is still lead-only, for an edit and a shell write alike.
  for (const p of ['.worktrees/571-x/AGENTS.md', '.worktrees/571-x/.github/workflows/ci.yml', '.worktrees/571-x/yokoten.json']) {
    const found = checkEdit(p, { config: DEFAULTS, env: worker });
    assert.equal(found?.id, 'lead-only', p);
    assert.match(found?.what ?? '', new RegExp(`${p.replaceAll('.', '\\.')} is lead-only`), 'the message keeps the full path');
    assert.equal(checkEdit(p, { config: DEFAULTS, env: {} }), null, `the lead passes: ${p}`);
  }
  assert.equal(checkEdit('.worktrees/571-x/src/a.ts', { config: DEFAULTS, env: worker }), null, 'other files pass');
  // A grant names the worktree's own path, as if the session ran there.
  const granted = { YOKOTEN_ROLE: 'worker', YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' };
  assert.equal(checkEdit('.worktrees/571-x/AGENTS.md', { config: DEFAULTS, env: granted }), null);
  assert.ok(checkEdit('.worktrees/571-x/CLAUDE.md', { config: DEFAULTS, env: granted }));
});

test('lead-only files: YOKOTEN_LEAD_ONLY_OK lets the paths it names through, and no others (#402)', () => {
  const sandbox = yokotenSandbox();
  const granted = { YOKOTEN_ROLE: 'worker', YOKOTEN_LEAD_ONLY_OK: ' AGENTS.md, ./.github/workflows/*.yml' };
  const run = (command: string) => checkCommand(command, { env: granted, cwd: sandbox.repo });
  assert.equal(run('sed -i s/a/b/ AGENTS.md'), null);
  assert.equal(run('echo x > .github/workflows/ci.yml'), null);
  assert.equal(run('echo x > CLAUDE.md')?.id, 'lead-only');
  assert.equal(run('echo x > .github/CODEOWNERS')?.id, 'lead-only');
  assert.equal(run('rm -rf .github')?.id, 'lead-only', 'a folder that holds more than the grant');
  assert.equal(checkEdit('AGENTS.md', { config: DEFAULTS, env: granted }), null);
  assert.ok(checkEdit('CLAUDE.md', { config: DEFAULTS, env: granted }));
  assert.ok(checkEdit('kit/AGENTS.md', { config: DEFAULTS, env: granted }), 'a path is the one path, not a glob');
  // A trailing /, \\ for / and empty entries are read as the lead meant them.
  assert.ok(isGranted('.github/workflows/ci.yml', { YOKOTEN_LEAD_ONLY_OK: ',, .github\\workflows\\ci.yml ,' }, false));
  assert.ok(isGranted('CLAUDE.md', { YOKOTEN_LEAD_ONLY_OK: 'CLAUDE.md/' }, false));
  assert.ok(!isGranted('CLAUDE.md', { YOKOTEN_LEAD_ONLY_OK: ' , ' }, false), 'no entry grants nothing');
  // `*` grants every lead-only file.
  assert.ok(isGranted('.github/workflows/ci.yml', { YOKOTEN_LEAD_ONLY_OK: '*' }, false));
  assert.ok(isGranted('AGENTS.md', { YOKOTEN_LEAD_ONLY_OK: '*' }, false));
});

test('lead-only files: a worker\'s git commit of a lead-only file is stopped, in the guard and the commit check (#402)', async () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  sandbox.write('AGENTS.md', 'rules\n');
  sandbox.write('src/a.ts', 'export {};\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const run = (command: string, env: Env = worker) => checkCommand(command, { env, cwd: sandbox.repo });
  sandbox.write('AGENTS.md', 'new rules\n');
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  // Not staged yet: only -a commits it.
  assert.equal(run('git commit -m x'), null);
  assert.equal(run('git commit -am x')?.id, 'lead-only');
  assert.equal(run('git commit --all -m x')?.id, 'lead-only');
  assert.equal(run('git commit -m x AGENTS.md')?.id, 'lead-only');
  sandbox.git('add', '.');
  const found = run('git commit -m "feat(x): y"');
  assert.equal(found?.id, 'lead-only');
  assert.match(found?.what ?? '', /this commit changes AGENTS\.md/);
  assert.match(found?.fix ?? '', /git restore --staged AGENTS\.md/);
  assert.equal(run(`git -C ${sandbox.repo} commit -qm x`)?.id, 'lead-only');
  assert.equal(run(`cd ${join(sandbox.repo, 'src')} && git commit -m x`)?.id, 'lead-only');
  // Pathspecs commit only what they name.
  assert.equal(run('git commit -m x src/a.ts'), null);
  assert.equal(run('git commit -i -m x src/a.ts')?.id, 'lead-only');
  assert.equal(run('git commit -m x', {}), null, 'the lead');
  assert.equal(run('git commit -m x', { ...worker, YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' }), null, 'the grant');
  // The commit check refuses the same commit for a YOKOTEN_ROLE worker, unless granted.
  let result = await sandbox.call(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  result = await sandbox.call(['check', '--staged'], { extra: { ...worker, YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' } });
  assert.equal(result.status, 0, result.stderr);
});

test('lead-only files: a symlink to a lead-only file is that file (#402)', () => {
  const sandbox = yokotenSandbox();
  sandbox.write('AGENTS.md', 'rules\n');
  symlinkSync('AGENTS.md', join(sandbox.repo, 'link.md'));
  const worker = { YOKOTEN_ROLE: 'worker' };
  const found = checkCommand('echo x > link.md', { env: worker, cwd: sandbox.repo });
  assert.equal(found?.id, 'lead-only');
  assert.match(found?.what ?? '', /writes AGENTS\.md/);
  assert.equal(checkCommand('echo x > notes.md', { env: worker, cwd: sandbox.repo }), null);
});

test('lead-only files: on macOS and Windows a name matches in any case (#402)', () => {
  assert.ok(isLeadOnly('agents.md', DEFAULTS.leadOnly, true));
  assert.ok(isLeadOnly('.GitHub/workflows/ci.yml', DEFAULTS.leadOnly, true));
  assert.ok(!isLeadOnly('agents.md', DEFAULTS.leadOnly, false), 'Linux: another file');
  assert.ok(isGranted('agents.md', { YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' }, true));
  assert.ok(!isGranted('agents.md', { YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' }, false));
});

test('lead-only files: shell writes follow the edit guard\'s scope (#402, #816)', async () => {
  const sandbox = makeSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  // No yokoten.json and no repo from the hook: the guard itself has no file list here.
  assert.equal(checkCommand('sed -i s/a/b/ AGENTS.md', { env: worker, cwd: sandbox.repo }), null);
  assert.equal(checkEdit('AGENTS.md', { config: DEFAULTS, env: worker }) === null, false, 'the edit guard has the same list');
  const hook = (flags: string[], command: string) => sandbox.call(['hook', ...flags], { input: JSON.stringify({ cwd: sandbox.repo, agent_type: 'yokoten:worker', tool_input: { command } }) });
  const edit = (flags: string[]) => sandbox.call(['hook', ...flags], { input: JSON.stringify({ cwd: sandbox.repo, agent_type: 'yokoten:worker', tool_input: { file_path: join(sandbox.repo, 'AGENTS.md') } }) });
  // In a repo without yokoten.json the safeguard's defaults still apply (#816), so a worker
  // is stopped in the user-level hook and the repo's own hook alike.
  assert.equal((await edit(['--commands-only'])).status, 2);
  assert.equal((await hook(['--commands-only'], 'echo x > AGENTS.md')).status, 2);
  sandbox.write('yokoten.json', '{}\n');
  assert.equal((await edit(['--commands-only'])).status, 2);
  assert.equal((await hook(['--commands-only'], 'echo x > AGENTS.md')).status, 2);
  // The repo's own list applies.
  sandbox.write('yokoten.json', '{ "leadOnly": ["RULES.md"] }\n');
  assert.equal((await hook(['--commands-only'], 'echo x > AGENTS.md')).status, 0);
  assert.equal((await hook(['--commands-only'], 'echo x > RULES.md')).status, 2);
  assert.equal(checkCommand('echo x > RULES.md', { env: worker, cwd: sandbox.repo })?.id, 'lead-only', 'found by the walk up');
  // A repo the hook passes in is ruled as given, with no walk: here the file system's root.
  const root = join(sandbox.repo, '..');
  assert.equal(checkCommand('echo x > other/AGENTS.md', { env: worker, cwd: root, repos: [{ root, leadOnly: DEFAULTS.leadOnly }] })?.id, 'lead-only');
});
