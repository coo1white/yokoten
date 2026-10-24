// Tests for src/host/gh-commands.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostGuardMisses, hostRunRemoval } from '../../src/host/gh-commands.ts';
import { checkCommand, commandWords } from '../../src/rules/guard/guards.ts';

const wordsOf = (command: string): string[] => commandWords(command)[0] ?? [];
const pathWhat = 'this `gh api` call takes its path from the shell, so the run is not clear';

test('host routes: cancel, delete, logs and an open variable, in any case (#650)', () => {
  const found = (command: string) => hostRunRemoval(wordsOf(command));
  assert.match(found('gh api -X POST repos/o/r/actions/runs/1/cancel')?.what ?? '', /cancels an Actions run/);
  assert.match(found('gh api -X DELETE REPOS/o/r/Actions/Runs/1')?.what ?? '', /deletes an Actions run/);
  assert.match(found('gh api -X DELETE repositories/9/actions/jobs/4/logs')?.what ?? '', /deletes an Actions log/);
  assert.equal(found('gh api -X DELETE repos/$URL')?.what, pathWhat);
  assert.equal(found('gh api -X POST repositories/$ID')?.what, pathWhat);
  assert.equal(found('gh api -X DELETE repos/$URL/actions/runs/1')?.what, 'this `gh api` call deletes an Actions run');
  assert.equal(found('gh api -X GET repos/$URL'), undefined);
  assert.equal(found('gh api -X POST repos/$OWNER/$REPO'), undefined);
  assert.equal(found('gh run list'), undefined);
});

test('host commands: an open variable path and extension exec or browse are refused (#650)', () => {
  const lead = {};
  const worker = { YOKOTEN_ROLE: 'worker' };
  const extensionFix = 'ask the owner to change extensions by hand';
  const open = [
    'gh api -X DELETE repos/$URL',
    'gh api -X POST repositories/$ID',
    'gh api -X DELETE "repos/$URL"',
    'gh api -X DELETE repos/$URL/',
    'gh api -X DELETE https://api.github.com/repos/$URL',
    'gh api repos/$URL -f a=b',
    'gh api -X POST repositories/${ID}',
  ];
  for (const env of [lead, worker]) {
    for (const command of open) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'run-remove', command);
      assert.equal(found?.what, pathWhat, command);
    }
    assert.equal(checkCommand('gh api -X GET repos/$URL', { cwd: process.cwd(), env }), null);
    assert.equal(checkCommand('gh api -X GET repositories/$ID', { cwd: process.cwd(), env }), null);
    assert.equal(checkCommand('gh api repos/$URL', { cwd: process.cwd(), env }), null);
    // A `$` outside the owner/repo slot is still refused, including an issue comment.
    assert.equal(checkCommand('gh api -X POST repos/o/r/issues/$N/comments', { cwd: process.cwd(), env })?.id, 'run-remove');
    assert.equal(checkCommand('gh api -X GET repos/o/r/issues/$N/comments', { cwd: process.cwd(), env }), null);
    // A harmless short-option cluster is still refused.
    assert.equal(checkCommand('gh api -sv user', { cwd: process.cwd(), env })?.id, 'run-remove');
    assert.equal(checkCommand('gh extension list', { cwd: process.cwd(), env }), null);
    assert.equal(checkCommand('gh extension', { cwd: process.cwd(), env }), null);
    for (const command of ['gh extension exec demo', 'gh extension browse', 'gh extension --force browse']) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'alias', command);
      assert.match(found?.what ?? '', command.includes('exec') ? /`gh extension exec`/ : /`gh extension browse`/, command);
      assert.equal(found?.fix, extensionFix, command);
    }
  }
  // A variable only in the owner/repo slot is not an open path. The lead may write. A worker may not.
  assert.equal(checkCommand('gh api -X POST repos/$OWNER/$REPO', { cwd: process.cwd(), env: lead }), null);
  assert.equal(checkCommand('gh api -X POST repos/$OWNER/$REPO', { cwd: process.cwd(), env: worker })?.id, 'worker-push');
});

test('host samples: doctor hears a miss, and a catch is quiet (#650)', () => {
  assert.deepEqual(hostGuardMisses(() => ({ id: 'x' })), []);
  assert.deepEqual(hostGuardMisses(() => null), ['run-remove guard', 'gh command guard']);
  assert.deepEqual(hostGuardMisses((command) => checkCommand(command, { env: {}, cwd: null })), []);
});
