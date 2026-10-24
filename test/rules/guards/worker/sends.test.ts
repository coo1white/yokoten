import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { allowed } from '../../../../test/repo/helpers.ts';

test('guard: a worker does not push, post or change a git folder; the lead may (#555)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  const refusals: Record<string, string[]> = {
    'worker-push': [
      'git push',
      'git push -u origin task',
      'nice git -C . push',
      'git send-pack origin HEAD:main',
      'git subtree push --prefix=docs origin pages',
      'git config alias.p push',
      "git config --global alias.p '!git push'",
      'git config set alias.p push',
      'git -c alias.p=push p',
      'git --config-env alias.p=X p',
      'yokoten bot -- gh pr create --fill',
      'yokoten bot -- git status',
      'node bin/yokoten.ts bot -- gh issue list',
      'npx yokoten bot -- gh pr merge 1',
      'gh pr create --fill',
      'gh -R a/b pr merge 1 --squash',
      'gh pr edit 1 --title x',
      'gh pr close 1',
      'gh pr comment 1 --body x',
      'env -u gh gh pr merge 1',
      'sudo -u gh gh pr close 1',
      'xargs -a gh gh pr merge 1',
      'env -u yokoten yokoten bot -- gh pr merge 1',
      'gh api -X PUT repos/a/b/pulls/1/merge',
      'gh api --method=DELETE repos/a/b/git/refs/heads/x',
      'gh api -XPATCH repos/a/b/pulls/1',
      'gh api --method post repos/a/b/issues',
      'gh api repos/a/b/issues -f title=x',
      'gh api repos/a/b/issues/1/comments -F body=@note.md',
      'gh api repos/a/b/pulls --input body.json',
      "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'",
      'gh api graphql -F query=@q.graphql',
    ],
    'worker-mark': [
      'rm .git/worktrees/wt/yokoten-worker',
      'rm -rf .git',
      'rm "$(sed "s/gitdir: //" .gi?)"/yokoten-w*',
      'rm "$(git rev-parse --git-dir)/yokoten-worker"',
      'rm -rf "$(git rev-parse --absolute-git-dir)"',
      'rm -rf "$(cut -c9- .gi?)"',
      'rm ../repo/.g*/worktrees/*/yokoten-*',
      'chmod 000 .gi?',
      'chmod 000 .[g]it',
      'mv .gi? x',
      'mv .{git,x} y',
      'mkfifo .git',
      'ln -s ../repo/.git g',
      'echo "gitdir: ../repo/.git" > .git',
      'cat x >> .gi?/config',
      'touch ../repo/.git/worktrees/wt/locked',
      "find . -name 'yokoten-w*' -delete",
      'find .git -exec chmod 000 {} +',
      'find . -name yokoten-worker | xargs rm',
      `python3 -c "import os; os.remove('.git')"`,
      "bash -c 'rm .gi?'",
      'GIT_DIR=x git status',
      'git --git-dir=../repo/.git config user.name x',
      'git worktree remove ../wt',
      'git worktree add ../other -b other',
    ],
  };
  for (const [id, commands] of Object.entries(refusals)) {
    for (const command of commands) {
      assert.equal(checkCommand(command, { cwd: process.cwd(), env: worker })?.id, id, command);
      // The lead may: the same command is not refused for these rules.
      assert.ok(!['worker-push', 'worker-mark'].includes(checkCommand(command, { cwd: process.cwd(), env: {} })?.id ?? ''), `the lead may: ${command}`);
    }
  }
  assert.match(checkCommand('gh api -X PUT x', { cwd: process.cwd(), env: worker })?.fix ?? '', /commit in your worktree and report; the lead pushes after review/);
  // Reads that name .git, GIT_DIR or the mark, and near misses: a worker runs them.
  for (const command of [
    'grep -rn foo --exclude-dir=.git .',
    'find . -path ./.git -prune -o -print',
    "find . -name '*.ts' -not -path './.git/*'",
    'grep -rn GIT_DIR src',
    'tree -I .git',
    'cat ../repo/.git/worktrees/wt/YOKOTEN-WORKER',
    'ls "$(git rev-parse --git-common-dir)"',
    'git rev-parse --git-path yokoten-worker',
    'cat .gitignore .gitattributes',
    'ls .github/workflows',
    'rm -rf dist/* node_modules',
    'rm "$TMPDIR/out.txt"',
    'git clone https://example.com/a/b.git',
    'git worktree list',
    'git status',
    "git log --format='%h %s' -3",
    'git config --get alias.p',
    'git config user.name',
    'npm test',
    'node --test',
    'gh pr view 1',
    'gh pr list --state open',
    'gh issue list',
    'gh api repos/a/b/pulls',
    'gh api -X GET search/issues -f q=is:open',
    "gh api graphql -f query='query { viewer { login } }'",
    'yokoten check',
    'node bin/yokoten.ts check',
  ]) allowed(command, worker);
});

// #650: the bot token that reruns a run can also cancel one or delete its log. Both roles
// hear the same refusal, and the fix is to ask the owner. A read and a rerun stay allowed.

test('guard: cancelling or deleting an Actions run is refused for every role (#650)', () => {
  const lead = {};
  const worker = { YOKOTEN_ROLE: 'worker' };
  const why = 'a cancelled run turns a check red and blocks the merge, and a deleted log is evidence gone';
  const fix = 'ask the owner, who can cancel or delete the run on the Actions page';
  const refused: { what: string; commands: string[] }[] = [
    {
      what: '`gh run cancel` cancels an Actions run',
      commands: [
        'gh run cancel',
        'gh run cancel 123',
        'gh run cancel --force 123',
        'gh run cancel 123 --force',
        'gh -R o/r run cancel 123',
        'gh --repo=o/r run cancel 1',
        'GH_REPO=o/r gh run cancel 1',
        'env GH_HOST=github.example.com gh run cancel 1',
        'yokoten bot -- gh run cancel 1',
        'npx yokoten bot -- gh run cancel 9',
        'bin/yokoten.ts bot -- gh run cancel 1',
        '/usr/bin/gh run cancel 1',
        "bash -c 'gh run cancel 1'",
        'gh run cancel 1 > /tmp/out',
        'env -u gh gh run cancel 1',
        'sudo -u gh gh run cancel 1',
        'xargs -a gh gh run cancel',
      ],
    },
    {
      what: '`gh run delete` deletes an Actions run and its log',
      commands: [
        'gh run delete 123',
        'gh run --repo o/r delete 123',
        'sudo gh run delete 1',
        'node bin/yokoten.ts bot -- gh run delete 1',
        'gh.exe run delete 2',
        'echo ok && gh run delete 1',
        'env -u gh gh run delete 1',
      ],
    },
    {
      what: 'this `gh api` call cancels an Actions run',
      commands: [
        'gh api -X POST repos/o/r/actions/runs/123/cancel',
        'gh api --method POST repos/o/r/actions/runs/123/cancel',
        'gh api --method=post repos/o/r/actions/runs/123/force-cancel',
        'gh api -XPOST repos/o/r/actions/runs/123/cancel',
        'gh api --method POST /repos/o/r/actions/runs/123/force-cancel',
        'gh api repos/o/r/actions/runs/123/cancel -X POST',
        'gh api repos/{owner}/{repo}/actions/runs/44/force-cancel --method POST',
        'gh api -X POST --hostname github.example.com repos/o/r/actions/runs/1/cancel',
        'gh api --silent -X POST repos/o/r/actions/runs/1/cancel --paginate',
        "gh api -H 'Accept: application/vnd.github+json' -X POST repos/o/r/actions/runs/1/cancel",
        'yokoten bot -- gh api -X POST repos/o/r/actions/runs/1/cancel',
        'gh api repos/o/r/actions/runs/1/cancel -f confirm=1',
        'gh api --input payload.json repos/o/r/actions/runs/1/force-cancel',
        'gh api -X POST repos/o/r/actions%2Fruns/5/cancel',
        'gh api -X POST /repos/$REPO/actions/runs/$RUN_ID/cancel',
        'gh api -X POST repos/$OWNER/$REPO/actions/runs/$RUN_ID/cancel',
        'gh api -X POST "/repos/${REPO}/actions/runs/${RUN_ID}/force-cancel"',
        'gh api -X POST -q -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST --jq -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST -t -XGET repos/o/r/actions/runs/1/force-cancel',
        'gh api -X POST --template -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST -p -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST --preview -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST -H -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST --header -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST --hostname -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST --cache -XGET repos/o/r/actions/runs/1/cancel',
        'gh api -X POST repositories/123/actions/runs/4/cancel',
        'gh api -X POST repositories/123/actions/runs/4/force-cancel',
        'gh api -fk=v repos/o/r/actions/runs/1/cancel',
        'gh api -X POST REPOS/o/r/Actions/Runs/1/Cancel',
        'gh api -X POST REPOS/o/r/Actions/Runs/1/Force-Cancel',
        'gh api -X POST repos/o/r/actions/runs/1//cancel',
        'gh api -X POST repos/o/r/actions/./runs/1/cancel',
        'gh api -X POST repos/o/r/actions/runs/1/extra/../cancel',
        'gh api -X POST repos/o/r/foo/../actions/runs/1/cancel',
        'gh api -X POST /repos/$1/actions/runs/2/cancel',
        "gh api -X POST '/repos/$@/actions/runs/2/cancel'",
        'gh api -X POST "/repos/$*/actions/runs/2/force-cancel"',
        "gh api -X POST '/repos/${1}/actions/runs/2/cancel'",
      ],
    },
    {
      what: 'this `gh api` call deletes an Actions run',
      commands: [
        'gh api -X=DELETE repos/o/r/actions/runs/123',
        'gh api --method delete repos/o/r/actions/runs/123',
        'gh api -X DELETE repos/{owner}/{repo}/actions/runs/123',
        'gh api -X DELETE /repos/o/r/actions/runs/123',
        'gh api -X DELETE repos/o/r/actions/runs/123/',
        'gh api -X DELETE https://api.github.com/repos/o/r/actions/runs/123',
        'gh api -X DELETE "https://api.github.com/repos/o/r/actions/runs/123?per_page=1"',
        'node bin/yokoten.ts bot -- gh api -X DELETE https://github.example.com/api/v3/repos/o/r/actions/runs/5',
        'gh api -X DELETE /repos/$REPO/actions/runs/$RUN_ID',
        'gh api -X DELETE "repos/${OWNER}/${REPO}/actions/runs/${RUN_ID}"',
        'gh api -X DELETE -t --method=GET repos/o/r/actions/runs/1',
        'gh api -X DELETE --jq --method=GET repos/o/r/actions/runs/1',
        'gh api -X DELETE repositories/9/actions/runs/4',
        'gh api -XDELETE repos/o/r/actions/runs/1',
        'gh api -X DELETE REPOS/o/r/Actions/Runs/1',
        'gh api -X DELETE repos/o/r/actions/runs/../runs/9',
        'gh api -X DELETE /repos/$1/actions/runs/2',
        "gh api -X DELETE '/repos/$@/actions/runs/2'",
        'gh api -X DELETE "/repos/$*/actions/runs/2"',
      ],
    },
    {
      what: 'this `gh api` call deletes an Actions log',
      commands: [
        'gh api -X DELETE https://api.github.com/repos/o/r/actions/runs/123/logs',
        'gh api -X DELETE repos/o/r/actions/jobs/456/logs',
        'yokoten bot -- gh api --method=DELETE repos/{owner}/{repo}/actions/runs/1/logs',
        "gh api -X DELETE 'repos/o/r/actions/runs/9/logs?pretty=1'",
        'gh api --method DELETE -- repos/o/r/actions/jobs/7/logs',
        "gh api -X DELETE 'https://api.github.com/repos/o/r/actions/jobs/8/logs#part'",
        'gh api -X DELETE repos/o/r/actions/runs/not-a-token-marker/logs',
        'gh api -X DELETE repositories/9/actions/runs/4/logs',
        'gh api -X DELETE repositories/9/actions/jobs/4/logs',
        'gh api -X DELETE repos/o/r/actions/runs/4/./logs',
        'gh api -X DELETE repos/o/r/actions/jobs/4//logs',
        'gh api -X DELETE REPOS/o/r/Actions/Jobs/1/Logs',
      ],
    },
  ];
  for (const env of [lead, worker]) {
    for (const { what, commands } of refused) {
      for (const command of commands) {
        const found = checkCommand(command, { cwd: process.cwd(), env });
        assert.equal(found?.id, 'run-remove', command);
        assert.equal(found?.what, what, command);
        assert.equal(found?.why, why, command);
        assert.equal(found?.fix, fix, command);
        assert.ok(!found?.what.includes('not-a-token-marker'), command);
        assert.ok(!JSON.stringify(found).includes('/repos/'), command);
      }
    }
    for (const command of [
      'gh run rerun 123',
      'gh run rerun --failed 123',
      'gh run view 123',
      'gh run view 123 --log',
      'gh run list',
      'gh run list --workflow ci.yml',
      'gh run watch 123',
      'gh run download 123',
      'gh api repos/o/r/actions/runs/123',
      'gh api -X GET repos/o/r/actions/runs/123',
      'gh api -X GET repos/o/r/actions/runs/123/logs',
      'gh api -X GET repos/o/r/actions/jobs/456/logs',
      'gh api repos/o/r/actions/runs/123/cancel',
      'gh api -X GET repos/o/r/actions/runs/123/cancel',
      'gh api -X GET -q .id repos/o/r/actions/runs/1/cancel',
      'gh api -X GET repositories/123/actions/runs/4',
      'gh api -X GET repositories/123/actions/runs/4/cancel',
      'gh api repos/o/r/actions/./runs/1',
      'gh api repos/o/r//actions/runs/1',
      'gh api -X GET /repos/$1/actions/runs/8/cancel',
      'gh api -X GET REPOS/o/r/Actions/Runs/1/Cancel',
      'gh api -X GET repos/o/r/actions/runs/$ID/cancel',
      'gh api -q.id repos/o/r/actions/runs/1',
      'gh -Ro/r run list',
      'gh -Ro/r api repos/o/r/actions/runs/1',
      'echo gh run cancel 1',
      'gh help run cancel',
      'TZ=UTC gh run list',
      'gh alias list',
      'gh alias delete rc',
      'gh help alias',
    ]) assert.equal(checkCommand(command, { cwd: process.cwd(), env }), null, command);
    // A launcher's value may be the word `gh`. The program after it is still read.
    // A worker may not use `env -u` at all, so these are the lead's.
    for (const command of ['env -u gh gh run rerun 1', 'sudo -u gh gh run view 1', 'xargs -a gh gh run list']) {
      assert.equal(checkCommand(command, { cwd: process.cwd(), env: lead }), null, command);
    }
  }
  // A write that is not a cancel or a delete stays the worker's own rule. The lead may rerun.
  for (const command of [
    'gh api -X POST repos/o/r/actions/runs/123/rerun',
    'gh api --method=POST repos/o/r/actions/runs/123/rerun-failed-jobs',
    'gh api -X POST repos/o/r/actions/runs/123',
    'gh api --method=DELETE repos/a/b/git/refs/heads/x',
    'gh api -X DELETE repos/o/r/actions/artifacts/1',
    'gh api -X DELETE repos/o/r/actions/jobs/1',
    'gh api -X DELETE repos/o/r/actions/runs/123/force-cancel',
    'gh api -X POST repositories/9/actions/runs/3/rerun',
    'gh api -X DELETE repositories/9/actions/artifacts/1',
    'yokoten bot -- gh run rerun 1',
    'yokoten bot -- gh run view 1',
    'yokoten bot -- gh run list',
    'yokoten bot -- gh run watch 1',
  ]) {
    assert.equal(checkCommand(command, { cwd: process.cwd(), env: lead }), null, `the lead may: ${command}`);
    assert.equal(checkCommand(command, { cwd: process.cwd(), env: worker })?.id, 'worker-push', command);
  }
  // An alias hides the next command, so both roles hear the alias rule, not a parsed cancel.
  const aliasFix = 'ask the owner to add the alias by hand';
  for (const command of ["gh alias set rc 'run cancel'", 'gh alias set --clobber rc "run cancel"', 'gh alias import aliases.yml', 'sudo gh alias import f.yml', 'yokoten bot -- gh alias set rc "run delete"', 'env -u gh gh alias set rc "run cancel"']) {
    for (const env of [lead, worker]) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'alias', command);
      assert.equal(found?.fix, aliasFix, command);
      assert.match(found?.what ?? '', /gh alias (set|import)/, command);
    }
  }
});

// #650 round 2: a short-option cluster, a shell variable, or a gh command the guard does not
// know can hide a cancel. Both roles hear the same refusal. A plain read still passes.

test('guard: joined flags, shell variables and hidden gh commands are refused (#650)', () => {
  const lead = {};
  const worker = { YOKOTEN_ROLE: 'worker' };
  const runWhy = 'a cancelled run turns a check red and blocks the merge, and a deleted log is evidence gone';
  const runFix = 'ask the owner, who can cancel or delete the run on the Actions page';
  const joinedWhat = 'this `gh api` call joins short options, so its method is not clear';
  const joinedFix = 'write each short option as its own word, so the guard can read the method';
  const methodWhat = 'this `gh api` call takes its method from the shell on a run path';
  const pathWhat = 'this `gh api` call takes its path from the shell, so the run is not clear';
  const runVarWhat = '`gh run` with a subcommand from the shell can cancel or delete a run';
  const clusters = [
    'gh api -iXDELETE repos/o/r/actions/runs/1',
    'gh api -iX DELETE repos/o/r/actions/runs/1',
    'gh api -ivX DELETE repos/o/r/actions/runs/1',
    'gh api -iXPOST repos/o/r/actions/runs/1/cancel',
    'gh api -if x=1 repos/o/r/actions/runs/1/cancel',
    'gh api -iF x=1 repos/o/r/actions/runs/1/cancel',
  ];
  const methods = ['gh api -X $M repos/o/r/actions/runs/1/cancel', 'gh api -X $M repos/o/r/actions/runs/1'];
  const paths = ['gh api -X DELETE $URL', 'gh api -X DELETE "$B"/runs/1'];
  const runVars = ['gh run $X 1', 'gh run "$X" 1'];
  for (const env of [lead, worker]) {
    for (const command of clusters) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'run-remove', command);
      assert.equal(found?.what, joinedWhat, command);
      assert.equal(found?.why, runWhy, command);
      assert.equal(found?.fix, joinedFix, command);
    }
    for (const command of methods) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'run-remove', command);
      assert.equal(found?.what, methodWhat, command);
      assert.equal(found?.fix, runFix, command);
    }
    for (const command of paths) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'run-remove', command);
      assert.equal(found?.what, pathWhat, command);
      assert.equal(found?.fix, runFix, command);
    }
    for (const command of runVars) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'run-remove', command);
      assert.equal(found?.what, runVarWhat, command);
      assert.equal(found?.fix, runFix, command);
    }
    for (const command of [
      'gh run view 1 --log',
      'gh run list',
      'gh api repos/o/r/actions/runs/1',
      'gh api -X GET -q .id repos/o/r/actions/runs/1/cancel',
      'gh api -X GET $URL',
      'gh alias list',
      'gh extension list',
      'gh pr view 1',
      'gh issue list',
      'gh auth status',
      'gh config list',
      'gh config set editor vim',
    ]) assert.equal(checkCommand(command, { cwd: process.cwd(), env }), null, command);
  }
  // A variable method on a path that is not a run. The lead may send it. A worker may not write.
  assert.equal(checkCommand('gh api -X $M repos/o/r/issues/1', { cwd: process.cwd(), env: lead }), null);
  assert.equal(checkCommand('gh api -X $M repos/o/r/issues/1', { cwd: process.cwd(), env: worker })?.id, 'worker-push');
  const aliasWhy = 'an alias runs another command under a new name, so the guard cannot check what it runs';
  const hidden: { command: string; what: RegExp; fix: string }[] = [
    { command: 'gh x 1', what: /`gh x` is not a gh command/, fix: 'run the gh command by its own name, so the guard can read it' },
    { command: 'gh ext install someone/gh-x', what: /`gh ext` is not a gh command/, fix: 'run the gh command by its own name, so the guard can read it' },
    { command: 'gh extension install someone/gh-x', what: /`gh extension install`/, fix: 'ask the owner to change extensions by hand' },
    { command: 'gh extension upgrade', what: /`gh extension upgrade`/, fix: 'ask the owner to change extensions by hand' },
    { command: 'gh config set aliases.x "run cancel"', what: /`gh config set aliases`/, fix: 'ask the owner to add the alias by hand' },
  ];
  for (const env of [lead, worker]) {
    for (const { command, what, fix } of hidden) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'alias', command);
      assert.match(found?.what ?? '', what, command);
      assert.equal(found?.why, aliasWhy, command);
      assert.equal(found?.fix, fix, command);
    }
  }
});

// #555: the mark is found with no git process, and it fails closed: a .git link the guard
// can't read makes the session a worker. A FIFO named .git never blocks it.
