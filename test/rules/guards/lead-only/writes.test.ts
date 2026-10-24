import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { makeSandbox, yokotenSandbox } from '../../../../test/repo/helpers.ts';
import type { Env } from '../../../../src/rules/config.ts';

test('lead-only files: a worker shell write under .worktrees/<issue>/ is stopped, not the lead (#571)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string, env: Env = worker) => checkCommand(command, { env, cwd: sandbox.repo });
  assert.equal(run('echo x > .worktrees/571-x/AGENTS.md')?.id, 'lead-only');
  assert.match(run('echo x > .worktrees/571-x/AGENTS.md')?.what ?? '', /\.worktrees\/571-x\/AGENTS\.md, which is lead-only/);
  assert.equal(run('echo x > .worktrees/571-x/.github/workflows/ci.yml')?.id, 'lead-only');
  assert.equal(run('rm -rf .worktrees/571-x/.github')?.id, 'lead-only', 'a folder that may hold one');
  assert.equal(run('echo x > .worktrees/571-x/src/a.ts'), null, 'other files pass');
  assert.equal(run('echo x > .worktrees/571-x/AGENTS.md', {}), null, 'the lead passes');
  // A grant names the worktree's own path.
  assert.equal(run('echo x > .worktrees/571-x/AGENTS.md', { ...worker, YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' }), null);
});

test('lead-only files: the hook stops a shell write from the plugin agent yokoten:worker, with no YOKOTEN_ROLE (#402)', async () => {
  // The session folder is reached through a symlink, as /var is /private/var on macOS: git
  // names the root by its real path, the agent by the link. The full hook rules the session's
  // repo with no yokoten.json, as it does for an edit.
  const sandbox = makeSandbox();
  const link = join(sandbox.home, 'repo-link');
  symlinkSync(sandbox.repo, link);
  for (const cwd of [sandbox.repo, link]) {
    const call = (agentType?: string) =>
      sandbox.call(['hook'], { cwd, input: JSON.stringify({ cwd, agent_type: agentType, tool_input: { command: 'sed -i s/a/b/ AGENTS.md' } }) });
    const result = await call('yokoten:worker');
    assert.equal(result.status, 2, `${cwd === link ? 'through the link' : 'the repo'}: ${result.stderr}`);
    assert.match(result.stderr, /writes AGENTS\.md, which is lead-only/);
    assert.equal((await call()).status, 0, 'the lead');
    assert.equal((await call('yokoten:reviewer')).status, 0, 'not a worker');
  }
});
