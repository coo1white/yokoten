// Tests for src/host/gh-commands.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostGuardMisses, hostRunRemoval } from '../../src/host/gh-commands.ts';
import { checkCommand, commandWords } from '../../src/rules/guards.ts';

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
  assert.equal(checkCommand('gh api -X POST repos/$OWNER/$REPO/issues', { cwd: process.cwd(), env: lead }), null);
  assert.equal(checkCommand('gh api -X POST repos/$OWNER/$REPO/issues', { cwd: process.cwd(), env: worker })?.id, 'worker-push');
});

test('repo settings: a gh api write is refused, a read passes (#825)', () => {
  const lead = {};
  const worker = { YOKOTEN_ROLE: 'worker' };
  const what = 'this `gh api` call changes repository or organization settings';
  const fix = 'ask the owner, who changes repository and organization settings in the browser';
  const refused = [
    // Visibility and the default branch are settings on the repo itself.
    'gh api -X PATCH repos/o/r -f visibility=public',
    'gh api repos/o/r -f visibility=public',
    'gh api --method PATCH repos/o/r -F default_branch=main',
    'gh api -XPATCH https://api.github.com/repos/o/r --input repo.json',
    'gh api -X PATCH /api/v3/repos/o/r -f visibility=private',
    'gh api -X DELETE repos/o/r',
    'gh api -X PATCH repositories/9 -f visibility=public',
    // Branch protection, and the settings inside it.
    'gh api -X PUT repos/o/r/branches/main/protection -f enforce_admins=true',
    'gh api -X DELETE repos/o/r/branches/main/protection',
    'gh api -X PATCH repos/o/r/branches/release/2.0/protection/required_pull_request_reviews -f dismiss_stale_reviews=true',
    // Rulesets, on the repo and on the organization.
    'gh api -X POST repos/o/r/rulesets --input rules.json',
    'gh api -X PUT repos/o/r/rulesets/1 -f enforcement=active',
    'gh api -X POST orgs/o/rulesets -f name=x',
    // The other settings groups, and an organization.
    'gh api -X PUT repos/o/r/actions/permissions -f enabled=true',
    'gh api -X PUT repos/o/r/vulnerability-alerts',
    'gh api --method PATCH orgs/o -f default_repository_permission=read',
    'gh api -X POST orgs/o/teams -f name=x',
    // Who reaches the code, and what CI runs with.
    'gh api -X PUT repos/o/r/collaborators/x -f permission=admin',
    'gh api -X PUT repos/o/r/teams/dev -f permission=push',
    'gh api -X POST repos/o/r/invitations -f invitee_id=1',
    'gh api -X POST repos/o/r/keys -f title=deploy -f key=x',
    'gh api -X POST repos/o/r/hooks -f config[url]=https://example.com/hook',
    'gh api -X PUT repos/o/r/actions/secrets/TOKEN -f encrypted_value=x',
    'gh api -X PUT repos/o/r/dependabot/secrets/TOKEN -f encrypted_value=x',
    'gh api -X PUT repos/o/r/codespaces/secrets/TOKEN -f encrypted_value=x',
    'gh api -X PATCH repos/o/r/actions/variables/DEBUG -f value=1',
    'gh api -X POST repos/o/r/actions/runners/registration-token',
    'gh api -X PATCH repos/o/r/environments/release -f wait_timer=0',
    // Behind `yokoten bot`, and for a worker too.
    'yokoten bot -- gh api -X PATCH repos/o/r -f visibility=public',
  ];
  for (const command of refused) {
    const found = checkCommand(command, { cwd: process.cwd(), env: lead });
    assert.equal(found?.id, 'repo-settings', command);
    assert.equal(found?.what, what, command);
    assert.equal(found?.fix, fix, command);
  }
  for (const command of ['gh api -X PATCH repos/o/r -f visibility=public', 'gh api -X PUT repos/o/r/branches/main/protection']) {
    assert.equal(checkCommand(command, { cwd: process.cwd(), env: worker })?.id, 'repo-settings', command);
  }
});

test('repo settings: reads and the bot writes it needs pass (#825)', () => {
  const lead = {};
  const reads = [
    'gh api repos/o/r',
    'gh api repos/o/r/branches/main/protection',
    'gh api -X GET repos/o/r/rulesets',
    'gh api --method=GET orgs/o',
    'gh api repos/o/r/actions/permissions',
    'gh api -X GET repos/o/r/issues -f creator=x',
  ];
  for (const command of reads) assert.equal(checkCommand(command, { cwd: process.cwd(), env: lead }), null, command);
  const writes = [
    'gh api -X POST repos/o/r/issues/1/comments -f body=x',
    'gh api -X POST repos/o/r/labels -f name=bug -f color=ff0000',
    'gh api -X POST repos/o/r/pulls/1/reviews -f event=APPROVE -f body=ok',
    'gh api -X POST repos/o/r/issues -f title=x',
    'gh api -X PATCH repos/o/r/issues/1 -f state=closed',
    'gh api -X PUT repos/o/r/pulls/1/merge -f merge_method=squash',
    'gh api --method POST repos/o/r/milestones -f title=v1',
  ];
  for (const command of writes) assert.equal(checkCommand(command, { cwd: process.cwd(), env: lead }), null, command);
});

test('repo settings: a graphql mutation is a settings write, a query passes (#825)', () => {
  const lead = {};
  const what = 'this `gh api graphql` call sends a mutation, which can change repository or organization settings';
  const refused = [
    'gh api graphql -f query=mutation { changeVisibility(input: {visibility: PUBLIC}) { clientMutationId } }',
    'gh api -X POST /graphql -f query=mutation{ updateRepository(input: {}) { clientMutationId } }',
    'gh api -X POST /api/graphql -f query=mutation { x }',
    'gh api -X POST https://api.github.com/graphql -f query=mutation { x }',
    'gh api graphql --raw-field query=mutation { changeVisibility(input: {}) { clientMutationId } }',
    // The document gh would read, which the guard cannot.
    'gh api graphql -F query=@mutation.graphql',
    'gh api graphql --input mutation.json',
    // A document the shell builds, so the guard cannot see it.
    'gh api graphql -f query=$(cat mutation.graphql)',
    'gh api graphql -f query="$DOC"',
    // A method and no document at all.
    'gh api -X POST graphql',
    // Behind `yokoten bot`.
    'yokoten bot -- gh api graphql -f query=mutation { x }',
  ];
  for (const command of refused) {
    const found = checkCommand(command, { cwd: process.cwd(), env: lead });
    assert.equal(found?.id, 'repo-settings', command);
    assert.equal(found?.what, what, command);
  }
  // A worker hears the same refusal: the settings check answers before its own send rule.
  assert.equal(checkCommand(refused[0], { cwd: process.cwd(), env: { YOKOTEN_ROLE: 'worker' } })?.id, 'repo-settings');
  const reads = [
    'gh api graphql -f query=query { viewer { login } }',
    'gh api -X POST graphql -f query={ viewer { login } }',
    // The word only inside a string, in an operation that reads.
    'gh api graphql -f query=query { search(query: "mutation") { issueCount } }',
  ];
  for (const command of reads) assert.equal(checkCommand(command, { cwd: process.cwd(), env: lead }), null, command);
});

test('host samples: doctor hears a miss, and a catch is quiet (#650)', () => {
  assert.deepEqual(hostGuardMisses(() => ({ id: 'x' })), []);
  assert.deepEqual(hostGuardMisses(() => null), ['run-remove guard', 'gh command guard', 'settings guard']);
  assert.deepEqual(hostGuardMisses((command) => checkCommand(command, { env: {}, cwd: null })), []);
});
