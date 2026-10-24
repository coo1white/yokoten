import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { blocked, allowed, makeSandbox, makeTempDir } from '../../../../test/repo/helpers.ts';

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

// Protection 3, red-teamed in #829: the agent cannot publish for you. Every test asks the
// hook the way an agent's Bash call reaches it, in a repo with no yokoten.json, so the
// default safeguard is what answers. A refusal exits 2.
const askHook = (sandbox: ReturnType<typeof makeSandbox>, command: string) =>
  sandbox.call(['hook', '--commands-only'], {
    input: JSON.stringify({ cwd: sandbox.repo, tool_name: 'Bash', tool_input: { command } }),
  });

const refusesAll = async (commands: string[]) => {
  const sandbox = makeSandbox();
  for (const command of commands) {
    const result = await askHook(sandbox, command);
    assert.equal(result.status, 2, `the hook let this through: ${command}`);
  }
};

test('redteam #829: the named release commands are refused', async () => {
  await refusesAll(['gh release create v1', 'npm publish', 'pnpm publish', 'yarn npm publish', 'git tag v1', 'git push --tags', 'gh repo edit --visibility public']);
});

test('redteam #829: gh api cannot publish a release, a tag or a public repo', async () => {
  await refusesAll([
    'gh api -X POST repos/o/r/releases -f tag_name=v1',
    'gh api -X POST repos/o/r/git/refs -f ref=refs/tags/rel-1',
    'gh api repos/o/r -X PATCH -f visibility=public',
    'gh api graphql -f query=mutation{createRelease(input:{tagName:"v1"}){release{id}}}',
  ]);
});

test('redteam #829: a release tool run by npx publishes the package', async () => {
  await refusesAll(['npx changeset publish', 'npx semantic-release']);
});

test('redteam #829: another language publishes its package', async () => {
  await refusesAll([
    'cargo publish',
    'gem push pkg.gem',
    'poetry publish',
    'uv publish',
    'python3 -m twine upload dist/*',
    'dotnet nuget push x.nupkg',
    'bun publish',
    'deno publish',
  ]);
});

test('redteam #829: npm version makes a tag without git tag', async () => {
  await refusesAll(['npm version patch']);
});

test('redteam #829: gh workflow run starts a release workflow', async () => {
  await refusesAll(['gh workflow run release.yml']);
});

test('redteam #829: pushing an image or a chart publishes it', async () => {
  await refusesAll(['docker push example.com/o/i:1', 'podman push example.com/o/i:1', 'helm push chart.tgz oci://example.com/c']);
});

test('redteam #829: a script named release or publish does the publish', async () => {
  await refusesAll(['npm run release', 'make publish']);
});

test('redteam #829: a tag made by git update-ref is refused, and so is pushing it', async () => {
  const sandbox = makeSandbox();
  assert.equal((await askHook(sandbox, 'git update-ref refs/tags/rel-1 HEAD')).status, 2);
  // The tag now exists, as it would if an earlier call had made it: pushing it publishes.
  sandbox.git('commit', '--allow-empty', '-m', 'x');
  sandbox.git('update-ref', 'refs/tags/rel-1', 'HEAD');
  sandbox.git('branch', 'feature-v2');
  assert.equal((await askHook(sandbox, 'git push origin rel-1')).status, 2, 'a tag pushed by name is refused');
  assert.equal((await askHook(sandbox, 'git push origin feature-v2')).status, 0, 'a branch push still passes');
});

test('redteam #829: another code host publishes a release', async () => {
  await refusesAll(['glab release create v1', 'tea release create --tag v1']);
});

test('redteam #865: a query string does not hide a publishing call to the host API', async () => {
  await refusesAll([
    'gh api -X POST repos/o/r/releases?draft=false -f tag_name=v1',
    'gh api -X POST repos/o/r/releases?draft=false',
    'gh api -X PATCH repos/o/r?x=1 -f visibility=public',
    'gh api -X POST repos/o/r/git/refs?x=1 -f ref=refs/tags/rel-1',
  ]);
  // A read stays a read, with a query string or without one.
  const sandbox = makeSandbox();
  for (const command of ['gh api repos/o/r/releases?per_page=5', 'gh api repos/o/r/releases']) {
    assert.equal((await askHook(sandbox, command)).status, 0, `the hook refused a read: ${command}`);
  }
});

test('redteam #865: the host API routes that create a repo or change one are refused', async () => {
  await refusesAll([
    'gh api -X POST user/repos -f name=x -f private=false',
    'gh api -X POST orgs/acme/repos -f name=x -f visibility=public',
    'gh api -X PATCH repos/$OWNER/$REPO -f visibility=public',
    'gh api graphql -f query=$(cat /tmp/m.graphql)',
    'gh api graphql -f query=`cat /tmp/m.graphql`',
    'gh repo create demo --public=true',
  ]);
  const sandbox = makeSandbox();
  for (const command of ['gh api orgs/acme/repos', 'gh api -X GET user/repos', 'gh api -X POST repos/$OWNER/$REPO']) {
    assert.equal((await askHook(sandbox, command)).status, 0, `the hook refused a read: ${command}`);
  }
});

test('redteam #865: git --git-dir still shows the tag and push.followTags', async () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '--allow-empty', '-q', '-m', 'x');
  sandbox.git('tag', 'rel-1');
  sandbox.git('branch', 'feature-v2');
  const gitDir = `${sandbox.repo}/.git`;
  assert.equal((await askHook(sandbox, 'git push origin rel-1')).status, 2, 'the tag pushed by name is refused');
  assert.equal((await askHook(sandbox, `git --git-dir=${gitDir} push origin rel-1`)).status, 2, 'a tag pushed through --git-dir is refused');
  assert.equal((await askHook(sandbox, `git --git-dir ${gitDir} push origin feature-v2`)).status, 0, 'a branch push still passes');
  sandbox.git('config', 'push.followTags', 'true');
  assert.equal((await askHook(sandbox, `git --git-dir=${gitDir} push`)).status, 2, '--git-dir does not hide push.followTags');
  assert.equal((await askHook(sandbox, `GIT_DIR=${gitDir} git push`)).status, 2, 'GIT_DIR does not hide push.followTags');
  // The shell keeps the last assignment, so a first, decoy GIT_DIR must not hide the repo
  // git reads (#865).
  const decoy = makeSandbox();
  assert.equal((await askHook(sandbox, `GIT_DIR=${decoy.repo}/.git GIT_DIR=${gitDir} git push`)).status, 2, 'the last GIT_DIR is the repo git reads');
  assert.equal((await askHook(sandbox, `GIT_DIR=${decoy.repo}/.git GIT_DIR=${gitDir} git push origin rel-1`)).status, 2, 'the last GIT_DIR still shows the pushed tag');
  // A folder the guard cannot read is not a folder it reads wrongly: a push from there fails too.
  const elsewhere = makeTempDir('yokoten-elsewhere-');
  assert.equal((await askHook(sandbox, `git --git-dir=${elsewhere}/.git push origin feature-v2`)).status, 0);
});

test('redteam #865: a package runner starts a release tool through exec or dlx', async () => {
  await refusesAll([
    'pnpm dlx semantic-release',
    'npm exec semantic-release',
    'yarn dlx semantic-release',
    'npm exec -- semantic-release',
    'npm run release -- --dry-run',
    // A version suffix names the same tool (#865).
    'npx semantic-release@latest',
    'npx semantic-release@24.2.0',
    'npx --yes semantic-release@latest',
    'npm exec semantic-release@latest',
    'pnpm dlx semantic-release@latest',
    'bunx release-it@1.2.3',
  ]);
  const sandbox = makeSandbox();
  for (const command of ['npm exec tsc --noEmit', 'pnpm dlx create-vite app', 'npm install semantic-release']) {
    assert.equal((await askHook(sandbox, command)).status, 0, `the hook refused everyday work: ${command}`);
  }
});

test('redteam #865: a dry run is the exact word for a package tool, and git\'s own abbreviation', async () => {
  await refusesAll([
    'npm publish --dry',
    'npm publish --dry-r',
    'npm publish --dry-run=false',
    'npm publish --dry-run false',
    // The last `--dry-run` or `--dry-run false` decides, as npm reads it.
    'npm publish --dry-run --dry-run false',
    'npm publish --dry-run --dry-run=false',
    // The last `--dry-run` or `--no-dry-run` decides, as git reads it.
    'git push --dry-run --no-dry-run --tags',
    'git push --tags --dry-run --no-dry-run',
    'docker push example.com/o/i:1 --dry',
    // `-o` and `--repo` take the next word: these pushes send the tags (#865).
    'git push -o --dry-run --tags',
    'git push --push-option --dry-run --tags',
    'git push --repo --dry-run --tags',
    'git push -o --help --tags',
  ]);
  const sandbox = makeSandbox();
  // git reads `--dry` as `--dry-run`, so nothing is published and the push passes.
  for (const command of ['npm publish --dry-run', 'npm publish --dry-run=true', 'git push --dry-run --tags', 'git push --dry --tags', 'git push -n --tags', 'git push -o --tags origin main']) {
    assert.equal((await askHook(sandbox, command)).status, 0, `the hook refused a dry run: ${command}`);
  }
});

test('redteam #829: a config change cannot make a later push carry a tag', async () => {
  const sandbox = makeSandbox();
  assert.equal((await askHook(sandbox, 'git config push.followTags true')).status, 2, 'setting it is refused');
  sandbox.git('config', 'push.followTags', 'true');
  assert.equal((await askHook(sandbox, 'git push')).status, 2, 'a later plain push is refused');
  assert.equal((await askHook(sandbox, 'git push --dry-run')).status, 0, 'a dry run still passes');
});

test('redteam #829: a dry run and help still pass', async () => {
  const sandbox = makeSandbox();
  for (const command of ['npm publish --dry-run', 'git push --dry-run --tags', 'npm publish --help', 'gh release create --help']) {
    assert.equal((await askHook(sandbox, command)).status, 0, `the hook refused everyday work: ${command}`);
  }
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
