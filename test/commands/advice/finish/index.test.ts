// `yokoten finish`: the controller reaches the agents the board shows (#761).

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { makeSandbox } from '../../../repo/helpers.ts';

describe('yokoten finish', () => {
  it('finishes a run that stopped beating, says where its work is, and leaves it alone next time', async () => {
    const sandbox = makeSandbox();
    sandbox.write('yokoten.json', '{}\n');
    sandbox.write('.yokoten-agent.json', `${JSON.stringify({
      name: 'worker-1',
      vendor: 'example-vendor',
      model: 'model-1',
      role: 'engineer',
      state: 'working',
      updated: '2026-10-23T00:00:00Z',
    }, null, 2)}\n`);
    const dry = await sandbox.call(['finish', '--after', '30', '--dry-run', '--json']);
    assert.equal(dry.status, 0);
    const would = JSON.parse(dry.stdout) as { finish: { kind: string }[]; dryRun: boolean };
    assert.equal(would.dryRun, true);
    assert.equal(would.finish[0]?.kind, 'would-finish');
    assert.equal(existsSync(join(sandbox.repo, 'REPORT-stopped.md')), false);

    const done = await sandbox.call(['finish', '--after', '30', '--json']);
    assert.equal(done.status, 0);
    const result = JSON.parse(done.stdout) as { finish: { kind: string; report: string }[] };
    assert.equal(result.finish[0]?.kind, 'finished');
    assert.equal(result.finish[0]?.report, 'written');
    const report = readFileSync(join(sandbox.repo, 'REPORT-stopped.md'), 'utf8');
    assert.match(report, /Finished by yokoten/);
    assert.match(report, /The branch and its worktree are untouched/);
    const status = JSON.parse(readFileSync(join(sandbox.repo, '.yokoten-agent.json'), 'utf8')) as { state: string; outcome: { value: string } };
    assert.equal(status.state, 'done');
    assert.equal(status.outcome.value, 'stopped');

    const again = await sandbox.call(['finish', '--after', '30', '--json']);
    assert.equal(again.status, 0);
    assert.equal((JSON.parse(again.stdout) as { finish: { kind: string }[] }).finish[0]?.kind, 'skipped');
  });

  it('needs a whole number of minutes', async () => {
    const sandbox = makeSandbox();
    const bad = await sandbox.call(['finish', '--after', 'soon']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--after needs a whole number of minutes above 0/);
  });
});
