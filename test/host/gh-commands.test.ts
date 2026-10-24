// Tests for src/host/gh-commands.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostGuardMisses, hostRunRemoval, isPublishingApiCall } from '../../src/host/gh-commands.ts';
import { checkCommand, commandWords } from '../../src/rules/guards/index.ts';

// The words of the `gh` command. A command substitution puts the substitution's own words
// first, so find the host command rather than take the first (#865).
const wordsOf = (command: string): string[] =>
  commandWords(command).find((words) => words[0] === 'gh') ?? commandWords(command)[0] ?? [];
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

test('publishing routes: a variable repo, a repo create and a shell query are refused (#865)', () => {
  const publishes = (command: string) => isPublishingApiCall(wordsOf(command).slice(2));
  for (const command of [
    'gh api -X POST user/repos -f name=x -f private=false',
    'gh api -X POST orgs/acme/repos -f name=x -f visibility=public',
    'gh api -X PATCH repos/$OWNER/$REPO -f visibility=public',
    'gh api graphql -f query=$(cat /tmp/m.graphql)',
    'gh api graphql -f query=`cat /tmp/m.graphql`',
    'gh api graphql -f query=$QUERY',
    // The GraphQL endpoint has three spellings; a leading slash or a host must not hide
    // the query, and a query from a file may hold a mutation (#865).
    'gh api /graphql --input body.json',
    'gh api https://api.github.com/graphql --input body.json',
    'gh api /graphql -f query=$(cat /tmp/m.graphql)',
    // An option's value is not the endpoint, so `--hostname` or `--input` before it
    // cannot hide the GraphQL route (#865).
    'gh api --hostname github.com graphql --input body.json',
    'gh api --input body.json /graphql',
    // gh keeps the last value of a field given twice, so a benign query first cannot hide
    // a later query the guard cannot read (#865).
    'gh api graphql -f query=query{viewer{login}} -f query=$QUERY',
    'gh api graphql -f query=query{viewer{login}} -F query=@q.graphql',
    'gh api graphql -f "query=query{viewer{login}} $EXTRA"',
  ]) assert.equal(publishes(command), true, command);
  // Creating a repo is a write; listing one is a read. A POST to a repo's own route is not
  // a repo update, so the plain write rule still judges it (#650).
  for (const command of ['gh api orgs/acme/repos', 'gh api -X GET user/repos', 'gh api -X POST repos/$OWNER/$REPO', 'gh api graphql -f query=query{viewer{login}}', 'gh api /graphql -f query=query{viewer{login}}']) {
    assert.equal(publishes(command), false, command);
  }
});

test('publishing routes: a query string is part of the endpoint, not a body field (#865)', () => {
  const publishes = (command: string) => isPublishingApiCall(wordsOf(command).slice(2));
  for (const command of [
    'gh api -X POST repos/o/r/releases -f tag_name=v1',
    'gh api -X POST repos/o/r/releases?draft=false -f tag_name=v1',
    'gh api -X POST repos/o/r/releases?draft=false',
    'gh api -X PATCH repos/o/r?x=1 -f visibility=public',
    'gh api -X DELETE repos/o/r/git/refs/tags/rel-1?x=1',
  ]) assert.equal(publishes(command), true, command);
  // A read with a query string is still a read, and a field is still a field.
  for (const command of ['gh api repos/o/r/releases?per_page=5', 'gh api -X GET repos/o/r/releases?per_page=5', 'gh api -X POST repos/o/r/issues -f labels=bug']) {
    assert.equal(publishes(command), false, command);
  }
});
