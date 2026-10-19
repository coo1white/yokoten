// Tests for src/run/check.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  at,
  makeSandbox,
  makeTranslatedRepo,
} from '../helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import {
  batchBlobs,
  checkHistory,
  readBlobs,
} from '../../src/run/check.ts';

// A merge leaves the index and MERGE_HEAD as the pre-merge-commit hook sees them (#246).
function mergeSandbox() {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', 'rules\n');
  sandbox.write('test/a.test.ts', 'old\n');
  sandbox.write('src/a.ts', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  sandbox.git('checkout', '-qb', 'work');
  sandbox.write('src/a.ts', 'b\n');
  sandbox.git('commit', '-qam', 'work');
  sandbox.git('checkout', '-q', 'main');
  return sandbox;
}

test('check --staged: stops a commit with a personal email or a private mark', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  sandbox.write('src/a.md', 'fine\n');
  sandbox.git('add', '.');
  assert.equal(sandbox.run(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } }).status, 0);
  sandbox.write('src/b.md', `write to me${at}gmail.com\nI live in MyCity\n`);
  sandbox.git('add', '.');
  const r = sandbox.run(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/b\.md:1: an email/);
  assert.match(r.stderr, /src\/b\.md:2: matches a line of your private-marks file/);
  assert.ok(!/mycity/i.test(r.stderr));
});

test('check --staged: stops build output and binaries, lets images and allowed paths through (#56)', () => {
  const sandbox = makeSandbox();
  sandbox.write('dist/app.js', 'console.log(1);\n');
  writeFileSync(join(sandbox.repo, 'tool'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 0]));
  writeFileSync(join(sandbox.repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  sandbox.git('add', '.');
  let r = sandbox.run(['check', '--staged']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dist\/app\.js: build output, in a dist\/ folder\./);
  assert.match(r.stderr, /tool: a binary file\. A reviewer can't read it/);
  assert.ok(!r.stderr.includes('logo.png'), 'an image is fine');
  sandbox.write('yokoten.json', JSON.stringify({ allowBuild: ['dist/**', 'tool'] }));
  sandbox.git('add', '.');
  r = sandbox.run(['check', '--staged']);
  assert.equal(r.status, 0, r.stderr);
});

test('check --staged: a submodule and a path with a colon pass, read by blob id (#244)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // A submodule add, as git records it: a gitlink at mode 160000.
  sandbox.git('update-index', '--add', '--cacheinfo', `160000,${head},sub`);
  sandbox.write('2:notes.md', 'notes\n');
  sandbox.git('add', '2:notes.md');
  let result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
  result = sandbox.run(['check', '--staged', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).check, 'staged');
  // A pointer bump.
  sandbox.git('commit', '-qm', 'sub');
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'next');
  const next = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('update-index', '--cacheinfo', `160000,${next},sub`);
  result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
});

test('check --staged: a symlink turned into a file is checked for privacy (#244)', () => {
  const sandbox = makeSandbox();
  symlinkSync('a.md', join(sandbox.repo, 'link'));
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  rmSync(join(sandbox.repo, 'link'));
  sandbox.write('link', `write to me${at}gmail.com\n`);
  sandbox.git('add', 'link');
  const result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /link:1: an email/);
});

test('check and the stop hook read a symlink as its link text, never its target (#244)', () => {
  const sandbox = makeSandbox();
  writeFileSync(join(dirname(sandbox.repo), 'outside.txt'), `write to me${at}gmail.com\n`);
  symlinkSync('../outside.txt', join(sandbox.repo, 'out'));
  symlinkSync('/dev/zero', join(sandbox.repo, 'zero'));
  sandbox.git('add', '.');
  const stop = () => sandbox.run(['hook', '--stop'], { input: JSON.stringify({ cwd: sandbox.repo, stop_hook_active: false }), timeout: 10000 });
  let result = stop();
  assert.deepEqual([result.status, result.stderr], [0, ''], 'staged, before the commit');
  sandbox.git('commit', '-qm', 'links');
  result = sandbox.run(['check'], { timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  // A link whose text is itself an email is still caught.
  symlinkSync(`me${at}gmail.com`, join(sandbox.repo, 'mail'));
  sandbox.git('add', 'mail');
  assert.match(stop().stderr, /mail:1: an email/);
  assert.match(sandbox.run(['check'], { timeout: 10000 }).stderr, /mail:1: an email/);
});

test('check --staged: binary is decided from the bytes, not .gitattributes (#244)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.gitattributes', 'yarn.lock -diff\n*.pbxproj binary\n');
  sandbox.write('yarn.lock', 'left-pad@1.0.0:\n  version "1.0.0"\n');
  sandbox.write('App.pbxproj', '// !$*UTF8*$!\n{\n}\n');
  sandbox.git('add', '.');
  let result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
  // A NUL in the first 8000 bytes is binary; one after them is not, as git decides.
  writeFileSync(join(sandbox.repo, 'tool'), Buffer.concat([Buffer.from('#!'), Buffer.alloc(1), Buffer.from('x\n')]));
  writeFileSync(join(sandbox.repo, 'late.txt'), Buffer.concat([Buffer.alloc(8000, 'a'), Buffer.alloc(1)]));
  sandbox.git('add', '.');
  result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool: a binary file/);
  assert.ok(!result.stderr.includes('late.txt'), result.stderr);
});

test('check --staged: in a merge, the role checks see only what the merge itself changed (#246)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  // Main changed a lead-only file and a test; a worker brings main into its branch.
  let sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'new rules\n');
  sandbox.write('test/a.test.ts', 'new\n');
  sandbox.git('commit', '-qam', 'lead');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  let result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main changed AGENTS.md');
  result = sandbox.run(['check', '--staged'], { extra: { ...worker, YOKOTEN_FIX_TASK: '1' } });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main changed a test, in a fix task');
  // An edit made during the merge is the worker's own.
  sandbox.write('AGENTS.md', 'my rules\n');
  sandbox.git('add', 'AGENTS.md');
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);

  // A conflict in AGENTS.md resolved by a new edit is refused.
  sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'lead rules\n');
  sandbox.git('commit', '-qam', 'lead');
  sandbox.git('checkout', '-q', 'work');
  sandbox.write('AGENTS.md', 'worker rules\n');
  sandbox.git('commit', '-qam', 'worker edit');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 1, 'a conflict');
  sandbox.write('AGENTS.md', 'both rules\n');
  sandbox.git('add', 'AGENTS.md');
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);

  // Outside a merge, a worker's commit of AGENTS.md is refused as before.
  sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'my rules\n');
  sandbox.git('add', 'AGENTS.md');
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: in a merge, a merged-in file is still checked for privacy (#246)', () => {
  const sandbox = mergeSandbox();
  sandbox.write('notes.md', `write to me${at}gmail.com\n`);
  sandbox.git('add', 'notes.md');
  sandbox.git('commit', '-qm', 'notes');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  const result = sandbox.run(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes\.md:1: an email/);
});

test('check --staged: a malformed MERGE_HEAD is ignored, and the full role check runs (#246)', () => {
  // A real merge of main, which changed AGENTS.md, then a line git would read as an option.
  const sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'new rules\n');
  sandbox.git('commit', '-qam', 'lead');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  const mergeHead = join(sandbox.repo, sandbox.git('rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim());
  appendFileSync(mergeHead, '--relative=zzz\n');
  const result = sandbox.run(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: a MERGE_HEAD that descends from HEAD exempts nothing (#246)', () => {
  // A fast-forward is a one-parent commit, not a merge: a stash of a lead-only edit named
  // in MERGE_HEAD must not let that edit through.
  const sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'my rules\n');
  assert.equal(sandbox.git('stash', '-q').status, 0);
  const stash = sandbox.git('rev-parse', 'stash@{0}').stdout.trim();
  writeFileSync(join(sandbox.repo, sandbox.git('rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim()), `${stash}\n`);
  assert.equal(sandbox.git('checkout', 'stash@{0}', '--', 'AGENTS.md').status, 0);
  const result = sandbox.run(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: a move is role-checked at its old path too (#259)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  const moved = (from: string, to: string, extra: Record<string, string>) => {
    const sandbox = mergeSandbox();
    assert.equal(sandbox.git('mv', from, to).status, 0);
    assert.match(sandbox.git('diff', '--cached', '--name-status').stdout, /^R/, 'git sees a move');
    return sandbox.run(['check', '--staged'], { extra });
  };
  let result = moved('AGENTS.md', 'notes.md', worker);
  assert.equal(result.status, 1, 'a worker moves a lead-only file away');
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  result = moved('src/a.ts', 'src/b.ts', worker);
  assert.deepEqual([result.status, result.stderr], [0, ''], 'a worker moves its own file');
  result = moved('AGENTS.md', 'notes.md', {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead moves a lead-only file');
  result = moved('test/a.test.ts', 'test/b.test.ts', { ...worker, YOKOTEN_FIX_TASK: '1' });
  assert.equal(result.status, 1, 'a fix task moves a test');
  assert.match(result.stderr, /test\/a\.test\.ts is a test file/);
});

test('check --staged: in a merge, a move is the worker\'s only if the merge made it (#259)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  // Main moved AGENTS.md; a worker brings main in.
  let sandbox = mergeSandbox();
  assert.equal(sandbox.git('mv', 'AGENTS.md', 'RULES.md').status, 0);
  sandbox.git('commit', '-qm', 'lead move');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  let result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main moved AGENTS.md');

  // The worker moves AGENTS.md away during a merge of main.
  sandbox = mergeSandbox();
  sandbox.write('notes.md', 'notes\n');
  sandbox.git('add', 'notes.md');
  sandbox.git('commit', '-qm', 'notes');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  assert.equal(sandbox.git('mv', 'AGENTS.md', 'RULES.md').status, 0);
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1, 'the merge made the move');
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: in a merge, removing a lead-only file only the other side has is the worker\'s (#259)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  // Main moves .github/a.yml to .github/b.yml; a worker merges main in, then runs `then`.
  const merged = (then: string[][], extra: Record<string, string>) => {
    const sandbox = makeSandbox();
    sandbox.write('.github/a.yml', 'on: push\n');
    sandbox.write('src/a.ts', 'a\n');
    sandbox.git('add', '.');
    sandbox.git('commit', '-qm', 'start');
    sandbox.git('checkout', '-qb', 'work');
    sandbox.write('src/a.ts', 'b\n');
    sandbox.git('commit', '-qam', 'work');
    sandbox.git('checkout', '-q', 'main');
    assert.equal(sandbox.git('mv', '.github/a.yml', '.github/b.yml').status, 0);
    sandbox.git('commit', '-qm', 'lead move');
    sandbox.git('checkout', '-q', 'work');
    assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
    for (const args of then) assert.equal(sandbox.git(...args).status, 0, args.join(' '));
    return sandbox.run(['check', '--staged'], { extra });
  };
  let result = merged([['mv', '.github/b.yml', 'c.yml']], worker);
  assert.equal(result.status, 1, 'a worker moves the merged-in file away');
  assert.match(result.stderr, /\.github\/b\.yml is lead-only/);
  result = merged([['rm', '-qf', '.github/b.yml']], worker);
  assert.equal(result.status, 1, 'a worker removes the merged-in file');
  assert.match(result.stderr, /\.github\/b\.yml is lead-only/);
  result = merged([['mv', '.github/b.yml', 'c.yml']], {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead moves it');
  result = merged([['rm', '-qf', '.github/b.yml']], {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead removes it');
  result = merged([], worker);
  assert.deepEqual([result.status, result.stderr], [0, ''], 'a clean merge of the move');
});

test('check --staged: a staged entry git can\'t read fails, not passes as empty (#244)', () => {
  const sandbox = makeSandbox();
  sandbox.git('update-index', '--add', '--info-only', '--cacheinfo', `100644,${'1'.repeat(40)},ghost.md`);
  const result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ghost\.md: git can't read the staged copy\. .+ Run `git add ghost\.md` again/);
});

test('check --staged: a text file with a NUL after 8000 bytes is scanned for privacy (#244)', () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, 'late.txt'), Buffer.concat([Buffer.from(`write to me${at}gmail.com\n`), Buffer.alloc(9000, 'a'), Buffer.alloc(1)]));
  sandbox.git('add', '.');
  const result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /late\.txt:1: an email/);
  assert.ok(!result.stderr.includes('binary'), result.stderr);
});

test('check --staged: stops a commit whose time carries a time zone, never printing it (#40)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  const zoned = { GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' };
  let r = sandbox.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  assert.ok(!/0700/.test(r.stderr), 'the offset is never printed');
  assert.equal(sandbox.run(['check', '--staged'], { extra: { GIT_AUTHOR_DATE: '2026-10-18T02:00:00+0000' } }).status, 0);
  // A project can turn it off.
  sandbox.write('yokoten.json', JSON.stringify({ privacy: { utc: false } }));
  sandbox.git('add', '.');
  r = sandbox.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 0, r.stderr);
});

test('check --staged: with nothing staged, no commit time to check (#208)', () => {
  const sandbox = makeSandbox();
  const zoned = { TZ: 'Asia/Tokyo' };
  // An empty repo, then one with a commit: nothing staged is ok, and says so.
  for (const step of ['empty', 'committed']) {
    if (step === 'committed') sandbox.git('commit', '-q', '--allow-empty', '-m', 'first');
    const r = sandbox.run(['check', '--staged'], { extra: zoned });
    assert.equal(r.status, 0, `${step}: ${r.stderr}`);
    assert.match(r.stdout, /note: nothing is staged/);
    assert.ok(!/time zone/.test(r.stderr), step);
  }
  // In the commit hook git sets GIT_INDEX_FILE: an empty commit or an amend is checked.
  let r = sandbox.run(['check', '--staged'], { extra: { ...zoned, GIT_INDEX_FILE: join(sandbox.repo, '.git', 'index') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  // A real staged change is still checked.
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  r = sandbox.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  assert.ok(!/nothing is staged/.test(r.stdout));
});

test('check --history: counts commits with a time zone, as a note that does not fail (#40)', () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'utc');
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'zoned'], { cwd: sandbox.repo, env: { ...sandbox.env, TZ: 'Asia/Tokyo' } });
  const r = sandbox.run(['check', '--history']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: 1 commit\(s\) record a time zone other than UTC/);
});

test('check --history: finds what a later commit deleted, and a personal author email', () => {
  const sandbox = makeSandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('notes.md', `server ${[10, 1, 2, 3].join('.')}\ntoken ${token}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  sandbox.git('rm', '-q', 'notes.md');
  sandbox.git('commit', '-qm', 'remove notes');
  sandbox.git('-c', `user.email=me${at}gmail.com`, 'commit', '-q', '--allow-empty', '-m', 'oops');
  assert.equal(sandbox.run(['check']).status, 0, 'the tree today is clean');
  const r = sandbox.run(['check', '--history']);
  assert.equal(r.status, 1);
  // Named by the commit that added the file (#208), not only by its blob.
  const added = sandbox.git('rev-parse', 'HEAD~2').stdout.slice(0, 8);
  assert.ok(r.stderr.includes(`notes.md @ ${added}:1: an IP address`), r.stderr);
  assert.ok(r.stderr.includes(`notes.md @ ${added}:2: a secret (GitHub token)`), 'a secret deleted later (#8)');
  assert.ok(!r.stderr.includes(token), 'the secret is never printed');
  assert.match(r.stderr, /\(author\/committer\):1: an email/);
});

test('check --history: names a moved file by its path in the commit that added it (#208)', () => {
  const sandbox = makeSandbox();
  sandbox.write('notes.md', `server ${[10, 1, 2, 3].join('.')}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  const added = sandbox.git('rev-parse', 'HEAD').stdout.slice(0, 8);
  sandbox.git('mv', 'notes.md', 'moved.md');
  sandbox.git('commit', '-qm', 'move notes');
  const r = sandbox.run(['check', '--history']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`notes.md @ ${added}:1: an IP address`), r.stderr);
  assert.ok(!r.stderr.includes('moved.md @'), 'that commit has no moved.md');
});

test('check --history: a shallow clone fails with one finding, never "every commit" (#266)', () => {
  const sandbox = makeSandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('notes.md', `token ${token}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  sandbox.git('rm', '-q', 'notes.md');
  sandbox.git('commit', '-qm', 'remove notes');
  // A full clone finds the secret a later commit deleted.
  const full = join(sandbox.home, 'full');
  const shallow = join(sandbox.home, 'shallow');
  spawnSync('git', ['clone', '-q', `file://${sandbox.repo}`, full], { env: sandbox.env });
  spawnSync('git', ['clone', '-q', '--depth', '1', `file://${sandbox.repo}`, shallow], { env: sandbox.env });
  let result = sandbox.run(['check', '--history'], { cwd: full });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes\.md @ \w+:1: a secret \(GitHub token\)/);
  // The shallow clone (actions/checkout's default) is not scanned, and says why.
  result = sandbox.run(['check', '--history'], { cwd: shallow });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(!/every commit/.test(result.stdout + result.stderr), result.stdout);
  assert.match(result.stderr, /1 problem\(s\)\n- this clone is shallow, so the history check can't see old commits\. .+\. Use `fetch-depth: 0` in actions\/checkout, or run `git fetch --unshallow`/);
  assert.ok(!result.stderr.includes('notes.md'), 'nothing was scanned');
  result = sandbox.run(['check', '--history', '--json'], { cwd: shallow });
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.findings.map((f: { id: string }) => f.id), ['shallow-history']);
  assert.deepEqual(out.notes, []);
  // In GitHub Actions: an error annotation and a row in the job summary.
  const summary = join(sandbox.home, 'summary.md');
  result = sandbox.run(['check', '--history'], { cwd: shallow, extra: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error title=yokoten shallow-history::.*this clone is shallow/m);
  assert.match(readFileSync(summary, 'utf8'), /1 problem\n[^]*shallow-history[^]*this clone is shallow/);
});

test('check --history: a commit hidden by git replace is still scanned; a grafts file fails with one finding (#284)', () => {
  const sandbox = makeSandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('notes.md', `token ${token}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  const first = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('rm', '-q', 'notes.md');
  sandbox.git('commit', '-qm', 'remove notes');
  // Swap the first commit for an empty root commit: git log and rev-list now skip the token.
  const emptyTree = sandbox.git('hash-object', '-w', '-t', 'tree', '/dev/null').stdout.trim();
  const emptyRoot = sandbox.git('commit-tree', emptyTree, '-m', 'add notes').stdout.trim();
  assert.equal(sandbox.git('replace', first, emptyRoot).status, 0);
  assert.equal(sandbox.git('log', '--all', '--format=%H', '--', 'notes.md').stdout.trim(), '', 'git itself no longer sees the token');
  let result = sandbox.run(['check', '--history']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /notes\.md @ \w+:1: a secret \(GitHub token\)/);
  assert.ok(!result.stderr.includes(token), 'the secret is never printed');

  // A grafts file can hide commits too: nothing is scanned, and one finding says why.
  const second = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('replace', '-d', first);
  sandbox.write('.git/info/grafts', `${second}\n`);
  result = sandbox.run(['check', '--history']);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(!/every commit on every branch/.test(result.stdout + result.stderr), result.stdout);
  assert.match(result.stderr, /1 problem\(s\)\n- this repo has a grafts file, so the history check can't see every commit\. .+\. Run `git replace --convert-graft-file`/);
  assert.ok(!result.stderr.includes('notes.md'), 'nothing was scanned');
  result = sandbox.run(['check', '--history', '--json']);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['shallow-history']);
});

test('check --staged reads the staged blob past git replace; GIT_GRAFT_FILE fails check --history (#294)', () => {
  const sandbox = makeSandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('notes.md', `token ${token}\n`);
  sandbox.git('add', 'notes.md');
  // Swap the staged blob for a clean one: git show :notes.md now prints the clean text,
  // while the commit would still hold the token.
  const staged = sandbox.git('rev-parse', ':notes.md').stdout.trim();
  const clean = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: sandbox.repo, env: sandbox.env, input: 'nothing here\n', encoding: 'utf8' }).stdout.trim();
  assert.equal(sandbox.git('replace', staged, clean).status, 0);
  assert.equal(sandbox.git('show', ':notes.md').stdout, 'nothing here\n', 'git itself shows the clean blob');
  const result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /notes\.md:1: a secret \(GitHub token\)/);
  assert.ok(!result.stderr.includes(token), 'the secret is never printed');

  // A grafts file named by GIT_GRAFT_FILE hides commits like .git/info/grafts does.
  sandbox.git('replace', '-d', staged);
  sandbox.git('commit', '-qm', 'add notes');
  sandbox.git('rm', '-q', 'notes.md');
  sandbox.git('commit', '-qm', 'remove notes');
  const grafts = join(sandbox.home, 'grafts');
  writeFileSync(grafts, `${sandbox.git('rev-parse', 'HEAD').stdout.trim()}\n`);
  const history = sandbox.run(['check', '--history'], { extra: { GIT_GRAFT_FILE: grafts } });
  assert.equal(history.status, 1, history.stdout);
  assert.match(history.stderr, /1 problem\(s\)\n- this repo has a grafts file, so the history check can't see every commit\./);
  assert.ok(!history.stderr.includes('notes.md'), 'nothing was scanned');
});

test('check --pr: reads the CI event, lists the changed files from git, notes long prose (#47)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.write('README.md', `Short.\n${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}.\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (body: string) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\n';
  let result = sandbox.run(['check', '--pr'], { extra: event(body) });
  assert.equal(result.status, 1, 'src/a.ts changed with no changelog line');
  assert.match(result.stderr, /changelog: 1 changed file/);
  assert.match(result.stdout, /note: 1 long sentence\(s\)\n- README\.md:2: a sentence of 30 words/);
  result = sandbox.run(['check', '--pr'], { extra: event(`${body}No changelog: a test\n`) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --pr: ok/);
  assert.doesNotMatch(result.stdout, /lines, over 400/, 'a small diff gets no size note (#57)');
  // Outside a pull request run, there is nothing to check.
  result = sandbox.run(['check', '--pr']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no pull request in this run/);
});

test('check --pr: a change file counts as the changelog entry, and its form is checked (#132)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const commit = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) sandbox.write(file, content);
    sandbox.git('add', '.');
    sandbox.git('commit', '-qm', 'head');
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  const good = commit({ 'src/a.ts': 'export const a = 1;\n', 'changes/1-a.md': 'Added\n\nA new thing.\n' });
  const bad = commit({ 'changes/1-a.md': 'Improved\n\nA new thing.\n' });
  const event = (head: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let result = sandbox.run(['check', '--pr'], { extra: event(good) });
  assert.equal(result.status, 0, result.stderr);
  result = sandbox.run(['check', '--pr'], { extra: event(bad) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- changes\/1-a\.md:1: line 1 is not a section\. .*Make line 1 one of: Added, Changed/);
  assert.doesNotMatch(result.stderr, /changelog: /, 'the file still counts as the entry');
});

test('check --pr: CODEOWNERS comes from the base branch, so a pull request cannot lower its own tier', () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/CODEOWNERS', '/kit/ @owner\n');
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // The pull request edits CODEOWNERS to drop kit/, and changes kit/.
  sandbox.write('.github/CODEOWNERS', '/nothing/ @owner\n');
  sandbox.write('kit/a.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (tier: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = `tier: ${tier}\nCloses #1\nThis changes the kit.\n## Why\nx\n## What changed\nx\n## How tested\nx\n`;
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: `tier ${tier}` }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = sandbox.run(['check', '--pr'], { extra: event('B') });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /this changes 1 file\(s\) that CODEOWNERS owns \(read from the base branch\): kit\/a\.md/);
  r = sandbox.run(['check', '--pr'], { extra: event('A') });
  assert.equal(r.status, 0, r.stderr);
});

test('check --pr: a large pull request gets a note, never a failure; lock files do not count (#57)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const a${i} = ${i};\n`).join('');
  sandbox.write('package-lock.json', lines(1000));
  sandbox.write('src/a.ts', lines(300));
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'small');
  const small = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/b.ts', lines(200));
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'large');
  const large = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (head: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = sandbox.run(['check', '--pr'], { extra: event(small) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /lines, over 400/, '300 lines; the lock file does not count');
  r = sandbox.run(['check', '--pr'], { extra: event(large) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: this pull request changes 500 lines, over 400\. Smaller pull requests are easier to review/);
  assert.match(r.stdout, /check --pr: ok/);
});

test('check --issue: reads the issue from the CI event; a bad title fails, a good one passes', () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['doctor', 'check'] }));
  const event = (issue: object) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ action: 'opened', issue }));
    return { GITHUB_EVENT_PATH: file };
  };
  let result = sandbox.run(['check', '--issue'], { extra: event({ title: 'doctor: add the review step', labels: [{ name: 'feat' }] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --issue: ok/);
  result = sandbox.run(['check', '--issue'], { extra: event({ title: 'The review step is missing.', labels: [{ name: 'incident' }] }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue: 2 problem\(s\)\n- title: it does not start with an area\. .+`area: symptom`.+\n  docs: \S+#issue-titles\n- title: a full stop at the end\./);
  assert.doesNotMatch(result.stderr, /The review step is missing/, 'the title is user input; it is not printed back');
  result = sandbox.run(['check', '--issue'], { extra: event({ title: 'site: a page', labels: [] }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use one of: doctor, check\./);
  result = sandbox.run(['check', '--issue', '--json'], { extra: event({ title: 'site: a page.', labels: [] }) });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.check, 'issue');
  assert.deepEqual(report.findings.map((f: { id: string }) => f.id), ['issue-area', 'issue-title']);
  assert.ok(!result.stdout.includes('a page'), 'the title is not printed back');
  result = sandbox.run(['check', '--issue', '--pr']);
  assert.equal(result.status, 1, 'two modes are a usage error');
  assert.equal(result.stdout, '');
  // A comment on a pull request comes as an issue too; it is not an issue to check.
  result = sandbox.run(['check', '--issue'], { extra: event({ title: 'Anything', pull_request: { url: 'x' } }) });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no issue in this run/);
  result = sandbox.run(['check', '--issue']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no issue in this run/);
  result = sandbox.run(['check', '--issue', '--json']);
  assert.deepEqual(JSON.parse(result.stdout).skipped, 'no issue in this run (it reads the CI event); nothing to check');
});

// #267: a commit the checkout does not have is one finding with the fix, in text, JSON
// and the job summary; git's raw error never reaches the output.
test('check --pr: a base or head commit not in the checkout is one finding, never a git crash (#267)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
  const event = (shas: { base: string; head: string }) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: shas.base }, head: { sha: shas.head } } }));
    return file;
  };
  const noGitError = (out: string) => assert.doesNotMatch(out, /fatal|Command failed|symmetric difference|Invalid/i, out);
  // The positive control: both commits here, so the check passes.
  assert.equal(sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base, head }) } }).status, 0);

  // A depth-1 clone has the head but not the base.
  const clone = join(sandbox.home, 'clone');
  const cloned = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${sandbox.repo}`, clone], { env: sandbox.env, encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stderr);
  const summary = join(sandbox.home, 'summary.md');
  let result = sandbox.run(['check', '--pr'], { cwd: clone, extra: { GITHUB_EVENT_PATH: event({ base, head }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's base commit is not in this checkout\. .+\. Use `fetch-depth: 0` in actions\/checkout, so the checkout has the whole history\.\n  docs: \S+#use-it-as-a-github-action\n$/);
  noGitError(result.stderr);
  result = sandbox.run(['check', '--pr', '--json'], { cwd: clone, extra: { GITHUB_EVENT_PATH: event({ base, head }), GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  let report = JSON.parse(result.stdout);
  assert.deepEqual([report.check, report.ok, report.findings.map((f: { id: string }) => f.id)], ['pr', false, ['pr-commits']]);
  assert.match(report.findings[0].what, /base commit/);
  assert.match(report.findings[0].fix, /fetch-depth: 0/);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check --pr: 1 problem\n\n\| Place \| Rule \| What \| Why \| Fix \|\n\|[-|]+\|\n\|  \| \[pr-commits\]\(\S+\) \| the pull request's base commit is not in this checkout \| .+ \| Use `fetch-depth: 0` in actions\/checkout/);

  // A full clone, with a head that was never fetched.
  const missing = 'f'.repeat(40);
  result = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base, head: missing }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's head commit is not in this checkout\. .+fetch-depth: 0/);
  noGitError(result.stderr);
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event({ base, head: missing }) } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  report = JSON.parse(result.stdout);
  assert.deepEqual([report.ok, report.findings.length, report.findings[0].id], [false, 1, 'pr-commits']);
  assert.match(report.findings[0].what, /head commit/);
  // Both missing: one finding that names both. A value that is not a commit id is missing too.
  result = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base: missing, head: '--output=x' }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's base and head commits are not in this checkout\./);
  assert.ok(!existsSync(join(sandbox.repo, 'x')), 'a sha is never read as an option');
  // Both here, but with no common commit: git can't read base...head either.
  sandbox.git('checkout', '-q', '--orphan', 'other');
  sandbox.git('commit', '-qm', 'unrelated');
  const unrelated = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event({ base, head: unrelated }) } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.match(JSON.parse(result.stdout).findings[0].what, /no common commit/);
});

test('check --pr and --issue: an event file that is missing or broken is one finding; odd fields are skipped (#267)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const file = join(sandbox.home, 'event.json');
  const summary = join(sandbox.home, 'summary.md');
  const cases: [string | null, RegExp][] = [
    [null, /can't be read/],
    ['{ broken', /is not valid JSON/],
    ['null', /is not a JSON object/],
    ['[1]', /is not a JSON object/],
  ];
  for (const mode of ['--pr', '--issue']) {
    for (const [content, what] of cases) {
      rmSync(file, { force: true });
      if (content !== null) writeFileSync(file, content);
      let result = sandbox.run(['check', mode], { extra: { GITHUB_EVENT_PATH: file } });
      assert.equal(result.status, 1, `${mode} ${content}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`^yokoten check ${mode}: 1 problem\\(s\\)\\n- the CI event file \\(GITHUB_EVENT_PATH\\) ${what.source}\\. .+\\. Run it in a GitHub Actions job`));
      assert.doesNotMatch(result.stderr, /ENOENT|SyntaxError|TypeError|Unexpected token/);
      assert.ok(!result.stderr.includes(sandbox.home), 'the path is not printed');
      result = sandbox.run(['check', mode, '--json'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['ci-event']);
    }
  }
  assert.equal(readFileSync(summary, 'utf8').split('| [ci-event](').length - 1, 8, 'each run wrote its summary');
  // A label that is null or has no name, and a title that is not text, are skipped, not a crash.
  writeFileSync(file, JSON.stringify({ issue: { title: 'check: a symptom', labels: [null, 7, { name: 'incident' }, {}] } }));
  let result = sandbox.run(['check', '--issue'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(file, JSON.stringify({ issue: { title: 42, labels: null } }));
  result = sandbox.run(['check', '--issue', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(JSON.parse(result.stdout).findings.length > 0, 'an empty title fails its rule');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: null, labels: [null], milestone: 'M0', base: { sha: head }, head: { sha: head } } }));
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(JSON.parse(result.stdout).findings.some((f: { id: string }) => f.id === 'pr-labels'));
  // An event with neither is not a run to check, as before.
  writeFileSync(file, JSON.stringify({ action: 'opened', pull_request: null, issue: 'x' }));
  for (const mode of ['--pr', '--issue']) assert.match(sandbox.run(['check', mode], { extra: { GITHUB_EVENT_PATH: file } }).stdout, /in this run/);
});

// #273: an event whose base or head commit id is empty, missing or not text is one
// finding, never an empty diff that lets the file rules pass.
test('check --pr: a pull request event with no base or head commit id is one finding (#273)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(sandbox.home, 'event.json');
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
  const cases: [object, object, string][] = [
    [{}, { sha: head }, 'base commit is'],
    [{ sha: head }, { sha: 7 }, 'head commit is'],
    [{ sha: '' }, { sha: '' }, 'base and head commits are'],
  ];
  for (const [baseField, headField, what] of cases) {
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: baseField, head: headField } }));
    let result = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file } });
    assert.equal(result.status, 1, what);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`^yokoten check --pr: 1 problem\\(s\\)\\n- the pull request's ${what} missing from the event\\. .+\\. Run it in a GitHub Actions job on a \`pull_request\` event`));
    result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
    assert.equal(result.status, 1, what);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.deepEqual([report.check, report.ok, report.findings.map((f: { id: string }) => f.id)], ['pr', false, ['pr-commits']]);
    assert.match(report.findings[0].what, new RegExp(`${what} missing from the event`));
  }
});

// #91: in GitHub Actions, the findings show on the pull request page: an annotation per
// finding on stdout, and a job summary. The finding text is reused, so no private value.
test('check in GitHub Actions: annotations and a job summary, place but never content (#91)', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  const email = `me${at}gmail.com`;
  sandbox.write('a.md', 'fine\n');
  sandbox.write('notes/b.md', `fine\n${email}\nI live in MyCity\ntoken ${token}\n`);
  sandbox.git('add', '.');
  const summary = join(sandbox.home, 'summary.md');
  const actions = { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, YOKOTEN_PRIVATE_MARKS: marks };
  const before = sandbox.run(['check'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  const result = sandbox.run(['check'], { extra: actions });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, before.stderr, 'the text for people is the same');
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^::error file=notes\/b\.md,line=2,title=yokoten email::an email address\. .+\. .+\.%0A  docs: https:\/\/\S+#privacy$/);
  assert.match(lines[1], /^::error file=notes\/b\.md,line=3,title=yokoten private-mark::matches a line of your private-marks file\. /);
  assert.match(lines[2], /^::error file=notes\/b\.md,line=4,title=yokoten secret::a secret \(GitHub token\)\. /);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check: 3 problems\n\n\| Place \| Rule \| What \| Why \| Fix \|\n/);
  assert.match(text, /\| notes\/b\.md:2 \| \[email\]\(https:\/\/\S+#privacy\) \| an email address \| .+ \| .+ \|/);
  assert.match(text, /\| notes\/b\.md:3 \| \[private-mark\]\(\S+\) \| matches a line of your private-marks file \|/);
  assert.match(text, /\| notes\/b\.md:4 \| \[secret\]\(\S+\) \| a secret \(GitHub token\) \|/);
  // The positive control: the place is there, the matched text is not (core rule 11).
  for (const out of [result.stdout, text]) {
    assert.ok(!out.includes(token) && !out.includes(email) && !/mycity/i.test(out), 'no matched text');
    assert.ok(!out.includes(sandbox.home), 'the home folder is never shown');
  }
  // --json keeps stdout pure JSON; the summary is still written. The summary file grows.
  const json = sandbox.run(['check', '--json'], { extra: actions });
  assert.equal(JSON.parse(json.stdout).ok, false);
  assert.equal(readFileSync(summary, 'utf8').split('### yokoten check: 3 problems').length, 3, 'appended, not replaced');
  // ok, with the mode in the heading.
  sandbox.git('rm', '-q', '--cached', 'notes/b.md');
  rmSync(join(sandbox.repo, 'notes'), { recursive: true });
  const ok = sandbox.run(['check', '--staged'], { extra: actions });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'yokoten check: ok\n', 'no findings, no annotations');
  assert.match(readFileSync(summary, 'utf8'), /### yokoten check --staged: ok\n\n$/);
});

test('check outside GitHub Actions: the output is unchanged and no summary is written (#91)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', `me${at}gmail.com\n`);
  sandbox.git('add', '.');
  const summary = join(sandbox.home, 'summary.md');
  const plain = sandbox.run(['check']);
  assert.equal(plain.status, 1);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /^yokoten check: 1 problem\(s\)\n- a\.md:1: an email address\. [^\n]+\.\n  docs: https:\/\/\S+#privacy\n$/);
  for (const extra of [{ GITHUB_STEP_SUMMARY: summary }, { GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: summary }] as Record<string, string>[]) {
    const r = sandbox.run(['check'], { extra });
    assert.deepEqual([r.status, r.stdout, r.stderr], [plain.status, plain.stdout, plain.stderr], JSON.stringify(extra));
  }
  assert.ok(!existsSync(summary), 'no summary outside Actions');
});

test('check --pr: notes hard-to-read names on added code lines, and the exit code does not change (#111)', () => {
  const project = makeSandbox();
  const filler = Array(11).fill('// filler');
  // An old file with a long-lived one-letter name: not noted, its lines are not added.
  project.write('src/old.ts', ['const t = 0;', ...filler, 'console.log(t);', ''].join('\n'));
  project.write('src/moved.ts', ['const q = 0;', ...filler, 'console.log(q);', ''].join('\n'));
  project.git('add', '.');
  project.git('commit', '-qm', 'base');
  const base = project.git('rev-parse', 'HEAD').stdout.trim();
  project.write('src/old.ts', ['const t = 0;', ...filler, 'console.log(t);', 'const count = t + 1;', ''].join('\n'));
  project.git('mv', 'src/moved.ts', 'src/renamed.ts');
  project.write('src/cart.js', ['const s = 0;', 'const loadTheWholeUserList = () => [];', 'for (let i = 0; i < 3; i++) console.log(i);', ...filler, 'console.log(s);', ''].join('\n'));
  project.git('add', '.');
  project.git('commit', '-qm', 'head');
  const head = project.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(project.home, 'event.json');
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
  const r = project.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: 2 hard-to-read name\(s\)\n- src\/cart\.js:1: "s" is used for 14 lines\. A reader must scroll back to learn what it holds\. Name what it is, e\.g\. "text"\.\n  docs: \S+#naming\n- src\/cart\.js:2: "loadTheWholeUserList" has 5 words, over 4\. /);
  assert.doesNotMatch(r.stdout, /"i"|old\.ts|renamed\.ts/, 'no note for `i` in a short loop, for unchanged lines, or for a moved file');
  assert.match(r.stdout, /check --pr: ok/);
  const json = JSON.parse(project.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } }).stdout);
  assert.equal(json.ok, true, 'notes never fail the check');
  assert.deepEqual(json.notes.map((note: { id: string; file: string; line: number }) => `${note.id} ${note.file}:${note.line}`), ['name-short src/cart.js:1', 'name-long src/cart.js:2']);
});

test('check --pr in GitHub Actions: notes are warnings, in their own section (#91)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('README.md', `Short.\n${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}.\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(sandbox.home, 'event.json');
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\n', labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: null, base: { sha: base }, head: { sha: head } } }));
  const summary = join(sandbox.home, 'summary.md');
  const r = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.status, 1, 'no milestone');
  assert.match(r.stdout, /^::error title=yokoten pr-milestone::/m, 'a finding with no place has no file');
  assert.match(r.stdout, /^::warning file=README\.md,line=2,title=yokoten long-sentence::a sentence of 30 words\. /m);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check --pr: 1 problem\n/);
  assert.match(text, /\n#### Notes \(1\): these never fail the check\n\n\| Place \| Rule \| What \| Why \| Fix \|\n\|[-|]+\|\n\| README\.md:2 \| long-sentence \| a sentence of 30 words \|/);
});

// #299: Dependabot writes its own body, so its pull request gets the title check and the
// body rules as notes, in text, JSON and the job summary.
test('check --pr: a Dependabot pull request passes with notes; the same body from anyone else fails (#299)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/CODEOWNERS', '/.github/ @owner\n');
  sandbox.write('.github/workflows/ci.yml', 'steps:\n  - uses: actions/checkout@v4.2.1\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('.github/workflows/ci.yml', 'steps:\n  - uses: actions/checkout@v4.2.2\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const body = [
    'Bumps the actions group with 1 update: [actions/checkout](https://github.com/actions/checkout).',
    '',
    'Updates `actions/checkout` from 4.2.1 to 4.2.2',
    '',
    "Dependabot will resolve any conflicts with this PR as long as you don't alter it yourself. You can also trigger a rebase manually by commenting `@dependabot rebase`.",
    '',
    '[//]: # (dependabot-automerge-start)',
    '[//]: # (dependabot-automerge-end)',
    '',
    '---',
    '',
    '<details>',
    '<summary>Dependabot commands and options</summary>',
    '</details>',
  ].join('\n');
  const event = (login: string, title = 'ci: bump the actions group with 1 update') => {
    const file = join(sandbox.home, 'event.json');
    const labels = [{ name: 'dependencies' }, { name: 'github_actions' }];
    writeFileSync(file, JSON.stringify({ pull_request: { title, body, user: { login, type: 'Bot' }, labels, milestone: null, base: { sha: base }, head: { sha: head } } }));
    return file;
  };
  const summary = join(sandbox.home, 'summary.md');
  let result = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]') } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --pr: note: 8 pull request rule\(s\) Dependabot does not meet\n- body: the first line is not a tier\. .*Dependabot opened this pull request, so it is a note\./);
  assert.match(result.stdout, /\n- milestone: none set\./);
  assert.match(result.stdout, /check --pr: ok\n$/);
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]'), GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual([report.ok, report.findings, report.notes.map((note: { id: string }) => note.id)], [true, [], ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-milestone', 'pr-labels', 'pr-labels']]);
  assert.match(readFileSync(summary, 'utf8'), /#### Notes \(8\): these never fail the check\n[^]*\| \[pr-tier\]\(\S+\) \| body: the first line is not a tier \|/);

  // The same body from anyone else fails as before.
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event('someone') } });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-milestone', 'pr-labels', 'pr-labels']);
  // A bad title from Dependabot still fails.
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]', 'Bump the actions group with 1 update') } });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['pr-title']);
});

// #244: blobs are read in batches under a cap, so one buffer never holds a whole big commit.
test('readBlobs: batches under the cap; a blob over it is read only for its start (#244)', () => {
  const sizes = new Map([['a', 10], ['b', 20], ['c', 30], ['d', 41], ['e', 40], ['f', 0]]);
  assert.deepEqual(batchBlobs(sizes, 40), { batches: [['a', 'b'], ['c'], ['e', 'f']], over: ['d'] });
  const repo = makeTranslatedRepo();
  const blob = (bytes: Buffer) => {
    writeFileSync(join(repo.root, 'b'), bytes);
    return repo.git('hash-object', '-w', 'b');
  };
  const small = [10, 20, 30].map((n) => blob(Buffer.alloc(n, String(n))));
  const big = blob(Buffer.concat([Buffer.alloc(9000, 'a'), Buffer.alloc(1)]));
  const missing = 'f'.repeat(40);
  const read = readBlobs(repo.root, [...small, small[0], big, missing], 40);
  assert.deepEqual([...read.keys()].sort(), [...small, big].sort(), 'a missing blob is left out; a repeat is read once');
  for (const [i, n] of [10, 20, 30].entries()) assert.deepEqual(read.get(small[i]), { bytes: Buffer.alloc(n, String(n)), size: n, whole: true });
  const start = read.get(big);
  assert.deepEqual([start?.bytes.length, start?.size, start?.whole], [8000, 9001, false], 'only the first 8000 bytes, enough to tell binary');
  assert.deepEqual(readBlobs(repo.root, []), new Map());
});

// Every read of repo content ignores `git replace` (#284, #294): readBlobs too, in the batch
// and in the over-cap read.
test('readBlobs: reads the bytes as stored, past a replace ref, in the batch and the over-cap read (#244, #294)', () => {
  const repo = makeTranslatedRepo();
  const blob = (bytes: Buffer) => {
    writeFileSync(join(repo.root, 'b'), bytes);
    return repo.git('hash-object', '-w', 'b');
  };
  const stored = blob(Buffer.from('stored bytes\n'));
  const shown = blob(Buffer.from('replacement\n'));
  const big = blob(Buffer.alloc(9000, 'a'));
  const bigShown = blob(Buffer.alloc(9000, 'b'));
  repo.git('replace', stored, shown);
  repo.git('replace', big, bigShown);
  const first = (read: Map<string, { bytes: Buffer }>, id: string) => read.get(id)?.bytes.subarray(0, 1).toString();
  assert.equal(repo.git('cat-file', '-p', stored), 'replacement', 'git itself shows the replacement');
  const read = readBlobs(repo.root, [stored, big], 100);
  assert.deepEqual([read.get(stored)?.bytes.toString(), first(read, big)], ['stored bytes\n', 'a'], 'the bytes as stored');
});

test('check --history: a blob swapped by git replace is read as committed, not as the swap shows it (#284)', () => {
  const repo = makeTranslatedRepo();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  repo.commit('notes.md', `token ${token}\n`);
  const blob = repo.git('rev-parse', 'HEAD:notes.md');
  const added = repo.git('rev-parse', 'HEAD').slice(0, 8);
  writeFileSync(join(repo.root, 'harmless.txt'), 'nothing here\n');
  const harmless = repo.git('hash-object', '-w', 'harmless.txt');
  repo.git('replace', blob, harmless);
  assert.equal(repo.git('cat-file', '-p', blob), 'nothing here', 'git itself now shows the harmless bytes');
  const found = checkHistory(repo.root, { config: DEFAULTS, env: {} });
  assert.ok(found.some((f) => f.file?.startsWith(`notes.md @ ${added}`)), JSON.stringify(found));
  assert.ok(!JSON.stringify(found).includes(token), 'the secret is never printed');
});
