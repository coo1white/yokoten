import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { runChild, yokotenSandbox } from '../../../../test/repo/helpers.ts';
import type { Env } from '../../../../src/rules/config.ts';
import { DEFAULTS } from '../../../../src/rules/config.ts';

test('lead-only files: each shell writer form stops a worker, not the lead (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string, env: Env) => checkCommand(command, { env, cwd: sandbox.repo });
  sandbox.write('fix.patch', 'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-a\n+b\n');
  for (const command of [
    'echo x > AGENTS.md',
    'echo x >>AGENTS.md',
    'printf x &> CLAUDE.md',
    'echo x >| yokoten.json',
    'echo x 2>|CLAUDE.md',
    'echo x 2>&1 >&AGENTS.md',
    'cat > AGENTS.md <<EOF\nnew rules\nEOF',
    'sed -i s/a/b/ AGENTS.md',
    'sed -i.bak -e s/a/b/ AGENTS.md',
    'sed --in-place s/a/b/ AGENTS.md',
    'sed -Ei s/a/b/ src/a.ts AGENTS.md',
    'echo x | tee AGENTS.md',
    'echo x | tee -a .github/workflows/ci.yml',
    'cp /tmp/x AGENTS.md',
    'cp x y .github/',
    'cp -t .claude x',
    'mv AGENTS.md notes.md',
    'mv x .github/workflows/ci.yml',
    'install -m 755 x .github/workflows/ci.yml',
    'ln -sf x CLAUDE.md',
    'dd if=x of=AGENTS.md',
    'truncate -s 0 AGENTS.md',
    'rm AGENTS.md',
    'rm -rf .github',
    'perl -pi -e s/a/b/ AGENTS.md',
    'perl -i.bak -pe s/a/b/ AGENTS.md',
    'git checkout -- AGENTS.md',
    'git checkout main -- .github/workflows/ci.yml',
    'git restore AGENTS.md',
    'git restore --source main --worktree --staged AGENTS.md',
    'git rm AGENTS.md',
    'git mv AGENTS.md RULES.md',
    'git apply fix.patch',
    'cd src && cp x ../AGENTS.md',
    'sudo -u x sed -i s/a/b/ AGENTS.md',
    'bash -c "echo x > AGENTS.md"',
    'nice -n 10 tee AGENTS.md < x',
  ]) {
    assert.equal(run(command, worker)?.id, 'lead-only', `should stop a worker: ${JSON.stringify(command)}`);
    assert.equal(run(command, {}), null, `should let the lead: ${JSON.stringify(command)}`);
  }
  // The message names the file and how to hand it over.
  const found = run('sed -i s/a/b/ AGENTS.md', worker);
  assert.match(found?.what ?? '', /writes AGENTS\.md, which is lead-only/);
  assert.match(found?.fix ?? '', /hand the change to the lead/);
});

test('lead-only files: a cd to a quoted ~ is not the home folder, so a worker stays stopped (#465)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  // HOME is outside the repo: read as home, the write would land there and pass. The hook
  // passes the repo it runs in, so a write from a folder the guard can't tell is read there.
  const env = { ...worker, HOME: tmpdir() };
  const repos = [{ root: sandbox.repo, leadOnly: DEFAULTS.leadOnly }];
  const run = (command: string) => checkCommand(command, { env, cwd: sandbox.repo, repos })?.id;
  for (const target of ['"~/x"', "'~/x'", '\\~/x', '~"/x"', '"~"/x', '~""/x', '"~"']) {
    assert.equal(run(`cd ${target} && echo x > AGENTS.md`), 'lead-only', `should stop: cd ${target}`);
  }
  // An unquoted ~ is the home folder, outside the repo: since #591 a worker's cd stays in
  // its worktree, so the cd itself is refused; the lead's write there passes, as before.
  assert.equal(run('cd ~/x && echo x > AGENTS.md'), 'worker-mark');
  assert.equal(run('cd ~/"x" && echo x > AGENTS.md'), 'worker-mark');
  assert.equal(checkCommand('cd ~/x && echo x > AGENTS.md', { env: { HOME: tmpdir() }, cwd: sandbox.repo, repos })?.id, undefined);
});

test('lead-only files: a worker relative write after an unknown cd is refused (#559)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string) => checkCommand(command, { env: worker, cwd: sandbox.repo })?.id;
  // `cd src` may land anywhere through CDPATH, so the folder is unknown and every
  // relative write is unsure, whatever the file is named: unsure means refused.
  for (const command of [
    'cd src && echo x > AGENTS.md',
    'cd src && echo x > notes.md',
    'cd src && cp x ../AGENTS.md',
    'cd src && git checkout -- notes.md',
    'cd src && git commit -m x AGENTS.md',
  ]) {
    assert.equal(run(command), 'lead-only', `should stop a worker: ${JSON.stringify(command)}`);
  }
  const found = checkCommand('cd src && echo x > notes.md', { env: worker, cwd: sandbox.repo });
  assert.match(found?.what ?? '', /can't tell which file that is from an unknown folder/);
  // Controls: a write by full path, and one after a `cd` the guard can read, still pass.
  assert.equal(run(`echo x > ${join(sandbox.repo, 'notes.md')}`), undefined);
  assert.equal(run('cd ./src && echo x > notes.md'), undefined);
  assert.equal(run(`cd ${join(sandbox.repo, 'src')} && echo x > notes.md`), undefined);
});

test('lead-only files: git apply and an unknowable commit from an unknown folder are refused (#559)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string) => checkCommand(command, { env: worker, cwd: sandbox.repo });
  sandbox.write('fix.patch', 'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-a\n+b\n');
  sandbox.write('ok.patch', 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
  // A patch named from an unknown folder cannot be placed: unsure means refused,
  // whatever the patch touches and however the patch itself is named.
  for (const command of [
    'cd src && git apply fix.patch',
    'cd src && git apply ../fix.patch',
    `cd src && git apply ${join(sandbox.repo, 'fix.patch')}`,
    'cd src && git apply ok.patch',
  ]) {
    const found = run(command);
    assert.equal(found?.id, 'lead-only', `should stop a worker: ${JSON.stringify(command)}`);
    assert.match(found?.what ?? '', /from an unknown folder/, `should say unsure: ${JSON.stringify(command)}`);
  }
  // stdin stays the known gap it already was.
  assert.equal(run('cd src && git apply - < fix.patch'), null);
  // A commit that takes the staged files (or with -a, the changed ones too) commits
  // what the guard cannot list from an unknown folder: unsure means refused.
  sandbox.write('AGENTS.md', 'rules\n');
  sandbox.write('src/a.ts', 'export {};\n');
  sandbox.git('add', '.');
  sandbox.write('AGENTS.md', 'new rules\n');
  for (const command of ['cd src && git commit -m x', 'cd src && git commit -am x', 'cd src && git commit -a -m x', 'cd src && git commit --all -m x']) {
    const found = run(command);
    assert.equal(found?.id, 'lead-only', `should stop a worker: ${JSON.stringify(command)}`);
    assert.match(found?.what ?? '', /from an unknown folder/, `should say unsure: ${JSON.stringify(command)}`);
  }
  // A commit that names only absolute paths is still checked one by one.
  assert.equal(run(`cd src && git commit -m x ${join(sandbox.repo, 'AGENTS.md')}`)?.id, 'lead-only');
  assert.equal(run(`cd src && git commit -m x ${join(sandbox.repo, 'src', 'a.ts')}`), null);
  // Controls: the same commands pass where the folder is known and nothing lead-only is in them.
  assert.equal(run(`cd ./src && git apply ${join(sandbox.repo, 'ok.patch')}`), null);
  assert.equal(run(`cd ${sandbox.repo} && git apply ok.patch`), null);
  assert.equal(run(`cd ./src && git commit -m x ${join(sandbox.repo, 'src', 'a.ts')}`), null);
});

test('lead-only files: reads, other files and files outside the repo pass a worker (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const command of [
    'cat AGENTS.md',
    'grep x AGENTS.md',
    'grep -n ">" AGENTS.md',
    'echo ">" AGENTS.md',
    'head -5 AGENTS.md > /dev/null',
    'sed -n 1,5p AGENTS.md',
    'perl -ne print AGENTS.md',
    'cp AGENTS.md notes.md',
    'diff AGENTS.md CLAUDE.md 2>&1',
    'echo x > src/a.ts',
    'sed -i s/a/b/ src/a.ts',
    'rm -rf dist',
    'git checkout main',
    'git checkout -b 402-x',
    'git restore --staged AGENTS.md',
    'git diff AGENTS.md',
    'git log -p -- .github',
    'echo x > /tmp/AGENTS.md',
  ]) {
    assert.equal(checkCommand(command, { env: worker, cwd: sandbox.repo }), null, `should allow: ${JSON.stringify(command)}`);
  }
});

test('lead-only files: a redirect is read when its operator is unquoted, glued or quoted file and all (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string) => checkCommand(command, { env: worker, cwd: sandbox.repo })?.id ?? null;
  for (const command of [
    'echo hi >"AGENTS.md"',
    "echo hi >'AGENTS.md'",
    'echo hi >"dir with space/AGENTS.md"',
    'echo hi>AGENTS.md',
    'ls>AGENTS.md',
    'echo hi>>AGENTS.md',
    'echo x>|AGENTS.md',
    'echo x >|AGENTS.md | cat',
    'echo hi&>AGENTS.md',
    'echo hi 2>AGENTS.md',
    'echo hi 2>"AGENTS.md"',
  ]) assert.equal(run(command), 'lead-only', `should stop: ${JSON.stringify(command)}`);
  // A quoted or escaped operator is text.
  for (const command of ['echo ">AGENTS.md"', "echo '>AGENTS.md'", 'echo \\>AGENTS.md', 'echo "a>AGENTS.md"', 'grep "x>" AGENTS.md']) {
    assert.equal(run(command), null, `should allow: ${JSON.stringify(command)}`);
  }
});

test('lead-only files: git apply reads only a plain patch file under 1 MB, and stops a worker on any other (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string) => checkCommand(command, { env: worker, cwd: sandbox.repo });
  sandbox.write('ok.patch', 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n');
  assert.equal(run('git apply ok.patch'), null);
  sandbox.write('big.patch', `diff --git a/src/a.ts b/src/a.ts\n${'+x\n'.repeat(600_000)}`);
  assert.match(run('git apply big.patch')?.what ?? '', /can't read which files it changes/);
  assert.equal(run('git apply missing.patch')?.id, 'lead-only');
  assert.equal(run('git apply /dev/stdin')?.id, 'lead-only', 'a device is never read');
  if (process.platform !== 'win32') {
    assert.equal(spawnSync('mkfifo', [join(sandbox.repo, 'pipe.patch')]).status, 0);
    // A guard that opened the FIFO would wait for a writer forever, so it runs in a child:
    // a hang is killed and named, and no clock is read (#436).
    const code = [
      "import { readFileSync } from 'node:fs';",
      "const { guards, command, cwd } = JSON.parse(readFileSync(0, 'utf8'));",
      'const { checkCommand } = await import(guards);',
      "process.stdout.write(String(checkCommand(command, { env: { YOKOTEN_ROLE: 'worker' }, cwd })?.id));",
    ].join('\n');
    const guards = pathToFileURL(join(process.cwd(), 'src/rules/guards/index.ts')).href;
    const child = runChild(process.execPath, ['--input-type=module', '-e', code], { input: JSON.stringify({ guards, command: 'git apply pipe.patch', cwd: sandbox.repo }) });
    assert.deepEqual([child.status, child.stdout], [0, 'lead-only'], `a FIFO is never read, nor waited on: ${child.stderr}`);
  }
  // stdin is a known gap: the guide says so.
  assert.equal(run('git apply - < ok.patch'), null);
  assert.equal(checkCommand('git apply big.patch', { env: {}, cwd: sandbox.repo }), null, 'the lead');
});
