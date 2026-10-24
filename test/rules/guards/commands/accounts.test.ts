import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { hardenRead, isRedacted, printsAccount, wrapForRedact } from '../../../../src/rules/guards/index.ts';

test('printsAccount: one plain read from the table is caught (#390)', () => {
  const caught = [
    'git log -3', 'git show HEAD', 'git blame README.md', 'git shortlog -sn HEAD', 'git whatchanged', '/usr/bin/git log',
    'git remote -v', 'git remote get-url origin', 'git remote show origin', 'git config --list', 'git config --global --get user.email', 'git config get remote.origin.url',
    'gh api user', 'gh api repos/o/r/traffic/views --jq .count', 'gh api -X GET users/someone', 'gh api --method=GET user --paginate', 'gh auth status', 'gh auth status --hostname github.com',
    'npm whoami', 'npm whoami --registry https://registry.npmjs.org', 'wrangler whoami', 'npx wrangler whoami', 'pnpm dlx wrangler@3 whoami',
    // Any format: the author can print with no "Author:" line (#413).
    'git log --format=%an', 'git log --pretty=format:%ae', 'git log --oneline', 'git show --pretty=format:%s', 'git log --format=%H -1',
    "git log --format='%an <%ae>'", 'git log --format="%cn <%ce>" -3', 'git shortlog -sne HEAD', 'git shortlog -s -n -e main', 'git blame -e README.md',
    "git for-each-ref --format='%(authorname) %(refname)'", 'git for-each-ref refs/tags', 'git cat-file -p HEAD', 'git cat-file commit HEAD', 'git cat-file tag v1',
    // A quote inside the other kind is plain text.
    `git log '"'`, `git log "'"`, "git log -- '*.md'",
    // A shortlog with a revision; an option's value comes first.
    'git shortlog --group=author HEAD', 'git shortlog --group author HEAD', 'git shortlog -s HEAD -- docs',
  ];
  for (const command of caught) assert.ok(printsAccount(command), `not caught: ${command}`);
  assert.equal(printsAccount('git log -1'), '`git log` prints author names and emails');
  assert.equal(printsAccount('git remote show origin'), '`git remote` prints remote URLs');
});

test('printsAccount: anything more than one plain read is left to the normal flow (#390)', () => {
  const left = [
    // More than one command, or shell around it.
    'cd x && git log', 'git log; ls', 'git log | head', 'git log > out', 'git log 2>/dev/null', 'git log &', 'git log $(echo x)', 'git log `x`', '(git log)', '{ git log; }', 'git log # note', 'git log\ngit push',
    // A prefix or a launcher.
    'FOO=1 git log', 'sudo git log', 'env git log', 'nice git log', 'bash -c "git log"', 'npx --yes wrangler whoami',
    // Options that write a file, run a program, or pick another git.
    'git -c a=b log', 'git -C x log', 'git log --output=x', 'git log -o x', 'git log --ext-diff', 'git show --textconv x', 'git log --exec-path=/x', 'git log --show-signature', 'git show --show-signature HEAD',
    // A subcommand only by name further on.
    'git remote add show x', 'git remote rename get-url x', 'git remote',
    // A write, or something sent.
    'git config user.email x', 'git config --get core.hooksPath', 'git push', 'git fetch', 'git pull', 'git clone x', 'git ls-remote', 'wrangler deploy', 'wrangler login', 'npx wrangler pages deploy',
    'gh api -X PATCH user -f name=x', 'gh api user -f bio=x', 'gh api --method=POST user/emails', 'gh api repos/o/r', 'gh auth status --show-token', 'gh auth token',
    // Not in the table any more: they print secrets, not only the owner.
    'env', 'printenv', 'printenv HOME',
    // A format in a compound command, or quoted text bash still reads (#413).
    "git log --format='%an'; ls", 'git log --format=%an | head', 'git log --format="$(id)"', 'git log --format="`id`"', "git log \\'x;ls'", "git log 'a'\\';ls'", 'git log --format=%an > out', "git log '%an' && git push",
    // A quote the plain-text search can't match to bash's own reading: it could hide a redirect (#413).
    `git log --format="%an %ae'$x" > out.txt --invert-grep --grep='"'`, `git log "'$x" >> ~/.bashrc '"'`, `git log 'x`, `git log "x`, `git log "a\\"b"`,
    // A word that reads as a redirect, even quoted.
    `git log '>' out`, `git log '2>&1'`, `git log '&>' x`,
    // A glob: a file named `--output=x` would become an option (#413).
    'git log *', 'git log -- *.md', 'git show HEAD?', 'git log [a]', 'git blame *',
    // A shortlog with no revision reads stdin: an option's value or a path after -- is none.
    'git shortlog -sne', 'git shortlog -sn', 'git shortlog -s --group author', 'git shortlog --format %an', 'git shortlog -w 20', 'git shortlog -s -- HEAD',
    // The subcommand quoted: the rewrite can't place its options.
    '"git" log -1', "git 'log' -1",
    // A cat-file that is not one object printed: a batch reads stdin, a filter runs a program.
    'git cat-file --batch', 'git cat-file -p', 'git cat-file --filters HEAD:x', 'git cat-file -t HEAD', 'git cat-file -p HEAD extra',
    'git status', 'echo git log',
  ];
  for (const command of left) assert.equal(printsAccount(command), null, command);
});

test('hardenRead: a log, show or blame runs no textconv or external diff; other reads stay as they are (#413)', () => {
  assert.equal(hardenRead('git log -1'), 'git log --no-ext-diff --no-textconv --no-show-signature -1');
  assert.equal(hardenRead('git show'), 'git show --no-ext-diff --no-textconv --no-show-signature');
  assert.equal(hardenRead('/usr/bin/git whatchanged -p'), '/usr/bin/git whatchanged --no-ext-diff --no-textconv --no-show-signature -p');
  assert.equal(hardenRead('git blame -e README.md'), 'git blame --no-textconv -e README.md');
  for (const command of ['git shortlog -sn HEAD', 'git cat-file -p HEAD', 'git remote -v', 'npm whoami', 'git status']) assert.equal(hardenRead(command), command);
});

test('isRedacted: the wrapper\'s own first line and the call; a comment that names them is not enough (#390)', () => {
  const wrapped = wrapForRedact('git log', '"node" "$HOME/y/bin/yokoten.ts" redact');
  assert.equal(isRedacted(wrapped), true);
  assert.equal(printsAccount(wrapped), null);
  assert.equal(isRedacted('git log # yokoten-redact yokoten redact'), false);
  assert.equal(isRedacted(`echo hi\n${wrapped}`), false);
  assert.equal(isRedacted(wrapped.replace('yokoten.ts" redact', 'other.ts" redact')), false);
  assert.equal(wrapped, 'set -o pipefail # yokoten-redact\n(\ngit log\n) 2>&1 | { "node" "$HOME/y/bin/yokoten.ts" redact || cat; }');
});

test('wrapForRedact: keeps the exit code; a redact that fails passes the output through; a heredoc still ends (#390)', () => {
  const run = (command: string, redact = 'tr a-z A-Z') => spawnSync('bash', ['-c', wrapForRedact(command, redact)], { encoding: 'utf8' });
  assert.deepEqual([run('echo hi; exit 3').status, run('echo hi; exit 3').stdout], [3, 'HI\n']);
  assert.deepEqual([run('echo out; echo err >&2').status, run('echo out; echo err >&2').stdout], [0, 'OUT\nERR\n']);
  assert.equal(run('cat <<EOF\nbody\nEOF').stdout, 'BODY\n');
  // redact missing or failing: the command still runs, and its output and exit code come through.
  const broken = run('echo plain; exit 4', '"/nonexistent/node" "/nonexistent/yokoten.ts" redact');
  assert.deepEqual([broken.status, broken.stdout], [4, 'plain\n']);
  assert.ok(broken.stderr.split('\n').filter(Boolean).length <= 1, broken.stderr);
});

// #555: a worker does not push or post, and does not change a git folder, where the worker
// mark is kept; the lead may do all of it. A read that names .git passes.
