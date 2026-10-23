// Tests for src/run/check.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  at,
  CLI,
  makeSandbox,
  makeTempDir,
  makeTranslatedRepo,
} from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { useRealHome } from '../../src/rules/privacy.ts';
import {
  assumeEmptyFolder,
  batchBlobs,
  changedFiles,
  checkHistory,
  configEntries,
  configKey,
  forgetGitReads,
  gitConfig,
  GitReadError,
  parseConfigList,
  readBlobs,
  readGit,
  remembered,
  syncPull,
  withGitReads,
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

// On run, not call: one real child keeps the check entry point (exit code and output through the binary) tested (#475).
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
  assert.match(r.stderr, /src\/b\.md:2: matches a word you added to your private marks/);
  assert.ok(!/mycity/i.test(r.stderr));
});

// YOKOTEN_PRIVATE_MARKS adds a list; an empty one never hides the default file's marks (#656).
test('check --staged: a marks setting that names an empty file still checks the marks in the default file (#656)', async () => {
  const sandbox = makeSandbox();
  const config = join(sandbox.home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'private-marks'), 'mycity\n');
  const empty = join(sandbox.home, 'empty-marks');
  writeFileSync(empty, '');
  sandbox.write('src/b.md', 'I live in MyCity\n');
  sandbox.git('add', '.');
  const r = await sandbox.call(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: empty } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/b\.md:1: matches a word you added to your private marks/);
  assert.ok(!/mycity/i.test(r.stdout + r.stderr));
});

test('check --staged: a default marks file it can not read fails closed, whatever the setting names (#656)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const sandbox = makeSandbox();
  const config = join(sandbox.home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  const own = join(config, 'private-marks');
  writeFileSync(own, 'mycity\n');
  chmodSync(own, 0o000);
  const other = join(sandbox.home, 'other-marks');
  writeFileSync(other, 'otherword\n');
  sandbox.write('src/a.md', 'fine\n');
  sandbox.git('add', '.');
  try {
    const r = await sandbox.call(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: other } });
    assert.notEqual(r.status, 0, 'fails closed');
    assert.ok(!/mycity|otherword/i.test(r.stdout + r.stderr));
  } finally {
    chmodSync(own, 0o600);
  }
});

test('check --staged: a readable real-home marks file is used when the default file is missing (#739)', async () => {
  const sandbox = makeSandbox();
  const real = makeTempDir();
  mkdirSync(join(real, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(real, '.config', 'yokoten', 'private-marks'), 'mycity\n');
  sandbox.write('src/a.md', 'I live in MyCity\n');
  sandbox.git('add', '.');
  const restore = useRealHome(() => real);
  try {
    const found = await sandbox.call(['check', '--staged']);
    assert.notEqual(found.status, 0, 'the real home marks apply');
    assert.match(found.stderr, /src\/a\.md:1: matches a word you added to your private marks/);
    assert.ok(!/mycity/i.test(found.stdout + found.stderr));
  } finally {
    restore();
  }
});

test('check --staged: no HOME still uses a readable real-home marks file (#739)', async () => {
  const sandbox = makeSandbox();
  const real = makeTempDir();
  mkdirSync(join(real, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(real, '.config', 'yokoten', 'private-marks'), 'mycity\n');
  sandbox.write('src/a.md', 'I live in MyCity\n');
  sandbox.git('add', '.');
  const restore = useRealHome(() => real);
  try {
    for (const extra of [{ HOME: '' }, { HOME: '', YOKOTEN_ROLE: 'worker' }] as Record<string, string>[]) {
      const found = await sandbox.call(['check', '--staged'], { extra });
      assert.notEqual(found.status, 0, 'the real home marks apply');
      assert.match(found.stderr, /src\/a\.md:1: matches a word you added to your private marks/);
      assert.ok(!/mycity/i.test(found.stdout + found.stderr));
    }
  } finally {
    restore();
  }
});

test('check --staged: a missing default marks file fails closed when the real home has one it cannot read (#739)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const sandbox = makeSandbox();
  const real = makeTempDir();
  const hidden = join(real, '.config', 'yokoten', 'private-marks');
  mkdirSync(join(real, '.config', 'yokoten'), { recursive: true });
  writeFileSync(hidden, 'mycity\n');
  chmodSync(hidden, 0o000);
  sandbox.write('src/a.md', 'I live in MyCity\n');
  sandbox.git('add', '.');
  const restore = useRealHome(() => real);
  try {
    const r = await sandbox.call(['check', '--staged']);
    assert.notEqual(r.status, 0, 'fails closed');
    assert.match(r.stderr, /cannot be read/);
    assert.ok(!/mycity/i.test(r.stdout + r.stderr));
  } finally {
    chmodSync(hidden, 0o600);
    restore();
  }
});

test('check --staged: stops build output and binaries, lets images and allowed paths through (#56)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('dist/app.js', 'console.log(1);\n');
  writeFileSync(join(sandbox.repo, 'tool'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 0]));
  writeFileSync(join(sandbox.repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  sandbox.git('add', '.');
  let r = await sandbox.call(['check', '--staged']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dist\/app\.js: build output, in a dist\/ folder\./);
  assert.match(r.stderr, /tool: a binary file\. A reviewer can't read it/);
  assert.ok(!r.stderr.includes('logo.png'), 'an image is fine');
  sandbox.write('yokoten.json', JSON.stringify({ allowBuild: ['dist/**', 'tool'] }));
  sandbox.git('add', '.');
  r = await sandbox.call(['check', '--staged']);
  assert.equal(r.status, 0, r.stderr);
});

test('check --staged: a submodule and a path with a colon pass, read by blob id (#244)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // A submodule add, as git records it: a gitlink at mode 160000.
  sandbox.git('update-index', '--add', '--cacheinfo', `160000,${head},sub`);
  sandbox.write('2:notes.md', 'notes\n');
  sandbox.git('add', '2:notes.md');
  let result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
  result = await sandbox.call(['check', '--staged', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).check, 'staged');
  // A pointer bump.
  sandbox.git('commit', '-qm', 'sub');
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'next');
  const next = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('update-index', '--cacheinfo', `160000,${next},sub`);
  result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
});

test('check --staged: a symlink turned into a file is checked for privacy (#244)', async () => {
  const sandbox = makeSandbox();
  symlinkSync('a.md', join(sandbox.repo, 'link'));
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  rmSync(join(sandbox.repo, 'link'));
  sandbox.write('link', `write to me${at}gmail.com\n`);
  sandbox.git('add', 'link');
  const result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /link:1: an email/);
});

test('check and the stop hook read a symlink as its link text, never its target (#244)', async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(dirname(sandbox.repo), 'outside.txt'), `write to me${at}gmail.com\n`);
  symlinkSync('../outside.txt', join(sandbox.repo, 'out'));
  symlinkSync('/dev/zero', join(sandbox.repo, 'zero'));
  sandbox.git('add', '.');
  const stop = () => sandbox.call(['hook', '--stop'], { input: JSON.stringify({ cwd: sandbox.repo, stop_hook_active: false }) });
  let result = await stop();
  assert.deepEqual([result.status, result.stderr], [0, ''], 'staged, before the commit');
  sandbox.git('commit', '-qm', 'links');
  result = await sandbox.call(['check']);
  assert.equal(result.status, 0, result.stderr);
  // A link whose text is itself an email is still caught.
  symlinkSync(`me${at}gmail.com`, join(sandbox.repo, 'mail'));
  sandbox.git('add', 'mail');
  assert.match((await stop()).stderr, /mail:1: an email/);
  assert.match((await sandbox.call(['check'])).stderr, /mail:1: an email/);
});

test('check --staged: binary is decided from the bytes, not .gitattributes (#244)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.gitattributes', 'yarn.lock -diff\n*.pbxproj binary\n');
  sandbox.write('yarn.lock', 'left-pad@1.0.0:\n  version "1.0.0"\n');
  sandbox.write('App.pbxproj', '// !$*UTF8*$!\n{\n}\n');
  sandbox.git('add', '.');
  let result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
  // A NUL in the first 8000 bytes is binary; one after them is not, as git decides.
  writeFileSync(join(sandbox.repo, 'tool'), Buffer.concat([Buffer.from('#!'), Buffer.alloc(1), Buffer.from('x\n')]));
  writeFileSync(join(sandbox.repo, 'late.txt'), Buffer.concat([Buffer.alloc(8000, 'a'), Buffer.alloc(1)]));
  sandbox.git('add', '.');
  result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool: a binary file/);
  assert.ok(!result.stderr.includes('late.txt'), result.stderr);
});

test('check --staged: in a merge, the role checks see only what the merge itself changed (#246)', async () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  // Main changed a lead-only file and a test; a worker brings main into its branch.
  let sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'new rules\n');
  sandbox.write('test/a.test.ts', 'new\n');
  sandbox.git('commit', '-qam', 'lead');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  let result = await sandbox.call(['check', '--staged'], { extra: worker });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main changed AGENTS.md');
  result = await sandbox.call(['check', '--staged'], { extra: { ...worker, YOKOTEN_FIX_TASK: '1' } });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main changed a test, in a fix task');
  // An edit made during the merge is the worker's own.
  sandbox.write('AGENTS.md', 'my rules\n');
  sandbox.git('add', 'AGENTS.md');
  result = await sandbox.call(['check', '--staged'], { extra: worker });
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
  result = await sandbox.call(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);

  // Outside a merge, a worker's commit of AGENTS.md is refused as before.
  sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'my rules\n');
  sandbox.git('add', 'AGENTS.md');
  result = await sandbox.call(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: in a merge, a merged-in file is still checked for privacy (#246)', async () => {
  const sandbox = mergeSandbox();
  sandbox.write('notes.md', `write to me${at}gmail.com\n`);
  sandbox.git('add', 'notes.md');
  sandbox.git('commit', '-qm', 'notes');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  const result = await sandbox.call(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes\.md:1: an email/);
});

test('check --staged: a malformed MERGE_HEAD is ignored, and the full role check runs (#246)', async () => {
  // A real merge of main, which changed AGENTS.md, then a line git would read as an option.
  const sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'new rules\n');
  sandbox.git('commit', '-qam', 'lead');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  const mergeHead = join(sandbox.repo, sandbox.git('rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim());
  appendFileSync(mergeHead, '--relative=zzz\n');
  const result = await sandbox.call(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: a MERGE_HEAD that descends from HEAD exempts nothing (#246)', async () => {
  // A fast-forward is a one-parent commit, not a merge: a stash of a lead-only edit named
  // in MERGE_HEAD must not let that edit through.
  const sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'my rules\n');
  assert.equal(sandbox.git('stash', '-q').status, 0);
  const stash = sandbox.git('rev-parse', 'stash@{0}').stdout.trim();
  writeFileSync(join(sandbox.repo, sandbox.git('rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim()), `${stash}\n`);
  assert.equal(sandbox.git('checkout', 'stash@{0}', '--', 'AGENTS.md').status, 0);
  const result = await sandbox.call(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: a move is role-checked at its old path too (#259)', async () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  const moved = (from: string, to: string, extra: Record<string, string>) => {
    const sandbox = mergeSandbox();
    assert.equal(sandbox.git('mv', from, to).status, 0);
    assert.match(sandbox.git('diff', '--cached', '--name-status').stdout, /^R/, 'git sees a move');
    return sandbox.call(['check', '--staged'], { extra });
  };
  let result = await moved('AGENTS.md', 'notes.md', worker);
  assert.equal(result.status, 1, 'a worker moves a lead-only file away');
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  result = await moved('src/a.ts', 'src/b.ts', worker);
  assert.deepEqual([result.status, result.stderr], [0, ''], 'a worker moves its own file');
  result = await moved('AGENTS.md', 'notes.md', {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead moves a lead-only file');
  result = await moved('test/a.test.ts', 'test/b.test.ts', { ...worker, YOKOTEN_FIX_TASK: '1' });
  assert.equal(result.status, 1, 'a fix task moves a test');
  assert.match(result.stderr, /test\/a\.test\.ts is a test file/);
});

test('check --staged: in a merge, a move is the worker\'s only if the merge made it (#259)', async () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  // Main moved AGENTS.md; a worker brings main in.
  let sandbox = mergeSandbox();
  assert.equal(sandbox.git('mv', 'AGENTS.md', 'RULES.md').status, 0);
  sandbox.git('commit', '-qm', 'lead move');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  let result = await sandbox.call(['check', '--staged'], { extra: worker });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main moved AGENTS.md');

  // The worker moves AGENTS.md away during a merge of main.
  sandbox = mergeSandbox();
  sandbox.write('notes.md', 'notes\n');
  sandbox.git('add', 'notes.md');
  sandbox.git('commit', '-qm', 'notes');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  assert.equal(sandbox.git('mv', 'AGENTS.md', 'RULES.md').status, 0);
  result = await sandbox.call(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1, 'the merge made the move');
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: in a merge, removing a lead-only file only the other side has is the worker\'s (#259)', async () => {
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
    return sandbox.call(['check', '--staged'], { extra });
  };
  let result = await merged([['mv', '.github/b.yml', 'c.yml']], worker);
  assert.equal(result.status, 1, 'a worker moves the merged-in file away');
  assert.match(result.stderr, /\.github\/b\.yml is lead-only/);
  result = await merged([['rm', '-qf', '.github/b.yml']], worker);
  assert.equal(result.status, 1, 'a worker removes the merged-in file');
  assert.match(result.stderr, /\.github\/b\.yml is lead-only/);
  result = await merged([['mv', '.github/b.yml', 'c.yml']], {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead moves it');
  result = await merged([['rm', '-qf', '.github/b.yml']], {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead removes it');
  result = await merged([], worker);
  assert.deepEqual([result.status, result.stderr], [0, ''], 'a clean merge of the move');
});

test('check --staged: a staged entry git can\'t read fails, not passes as empty (#244)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('update-index', '--add', '--info-only', '--cacheinfo', `100644,${'1'.repeat(40)},ghost.md`);
  const result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ghost\.md: git can't read the staged copy\. .+ Run `git add ghost\.md` again/);
});

test('check --staged: a text file with a NUL after 8000 bytes is scanned for privacy (#244)', async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, 'late.txt'), Buffer.concat([Buffer.from(`write to me${at}gmail.com\n`), Buffer.alloc(9000, 'a'), Buffer.alloc(1)]));
  sandbox.git('add', '.');
  const result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /late\.txt:1: an email/);
  assert.ok(!result.stderr.includes('binary'), result.stderr);
});

test('check --staged: stops a commit whose time carries a time zone, never printing it (#40)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  const zoned = { GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' };
  let r = await sandbox.call(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  assert.ok(!/0700/.test(r.stderr), 'the offset is never printed');
  assert.equal((await sandbox.call(['check', '--staged'], { extra: { GIT_AUTHOR_DATE: '2026-10-18T02:00:00+0000' } })).status, 0);
  // A project can turn it off.
  sandbox.write('yokoten.json', JSON.stringify({ privacy: { utc: false } }));
  sandbox.git('add', '.');
  r = await sandbox.call(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 0, r.stderr);
});

test('check --staged: with nothing staged, no commit time to check (#208)', async () => {
  const sandbox = makeSandbox();
  const zoned = { TZ: 'Asia/Tokyo' };
  // An empty repo, then one with a commit: nothing staged is ok, and says so.
  for (const step of ['empty', 'committed']) {
    if (step === 'committed') sandbox.git('commit', '-q', '--allow-empty', '-m', 'first');
    const r = await sandbox.call(['check', '--staged'], { extra: zoned });
    assert.equal(r.status, 0, `${step}: ${r.stderr}`);
    assert.match(r.stdout, /note: nothing is staged/);
    assert.ok(!/time zone/.test(r.stderr), step);
  }
  // In the commit hook git sets GIT_INDEX_FILE: an empty commit or an amend is checked.
  let r = await sandbox.call(['check', '--staged'], { extra: { ...zoned, GIT_INDEX_FILE: join(sandbox.repo, '.git', 'index') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  // A real staged change is still checked.
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  r = await sandbox.call(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  assert.ok(!/nothing is staged/.test(r.stdout));
});

test('check --history: counts commits with a time zone, as a note that does not fail (#40)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'utc');
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'zoned'], { cwd: sandbox.repo, env: { ...sandbox.env, TZ: 'Asia/Tokyo' } });
  const r = await sandbox.call(['check', '--history']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: 1 commit\(s\) record a time zone other than UTC/);
});

test('check --history: finds what a later commit deleted, and a personal author email', async () => {
  const sandbox = makeSandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('notes.md', `server ${[10, 1, 2, 3].join('.')}\ntoken ${token}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  sandbox.git('rm', '-q', 'notes.md');
  sandbox.git('commit', '-qm', 'remove notes');
  sandbox.git('-c', `user.email=me${at}gmail.com`, 'commit', '-q', '--allow-empty', '-m', 'oops');
  assert.equal((await sandbox.call(['check'])).status, 0, 'the tree today is clean');
  const r = await sandbox.call(['check', '--history']);
  assert.equal(r.status, 1);
  // Named by the commit that added the file (#208), not only by its blob.
  const added = sandbox.git('rev-parse', 'HEAD~2').stdout.slice(0, 8);
  assert.ok(r.stderr.includes(`notes.md @ ${added}:1: an IP address`), r.stderr);
  assert.ok(r.stderr.includes(`notes.md @ ${added}:2: a secret (GitHub token)`), 'a secret deleted later (#8)');
  assert.ok(!r.stderr.includes(token), 'the secret is never printed');
  assert.match(r.stderr, /\(author\/committer\):1: an email/);
});

test('check --history: names a moved file by its path in the commit that added it (#208)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('notes.md', `server ${[10, 1, 2, 3].join('.')}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  const added = sandbox.git('rev-parse', 'HEAD').stdout.slice(0, 8);
  sandbox.git('mv', 'notes.md', 'moved.md');
  sandbox.git('commit', '-qm', 'move notes');
  const r = await sandbox.call(['check', '--history']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`notes.md @ ${added}:1: an IP address`), r.stderr);
  assert.ok(!r.stderr.includes('moved.md @'), 'that commit has no moved.md');
});

test('check --history: a shallow clone fails with one finding, never "every commit" (#266)', async () => {
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
  let result = await sandbox.call(['check', '--history'], { cwd: full });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes\.md @ \w+:1: a secret \(GitHub token\)/);
  // The shallow clone (actions/checkout's default) is not scanned, and says why.
  result = await sandbox.call(['check', '--history'], { cwd: shallow });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(!/every commit/.test(result.stdout + result.stderr), result.stdout);
  assert.match(result.stderr, /1 problem\(s\)\n- this clone is shallow, so the history check can't see old commits\. .+\. Use `fetch-depth: 0` in actions\/checkout, or run `git fetch --unshallow`/);
  assert.ok(!result.stderr.includes('notes.md'), 'nothing was scanned');
  result = await sandbox.call(['check', '--history', '--json'], { cwd: shallow });
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.findings.map((f: { id: string }) => f.id), ['shallow-history']);
  assert.deepEqual(out.notes, []);
  // In GitHub Actions: an error annotation and a row in the job summary.
  const summary = join(sandbox.home, 'summary.md');
  result = await sandbox.call(['check', '--history'], { cwd: shallow, extra: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error title=yokoten shallow-history::.*this clone is shallow/m);
  assert.match(readFileSync(summary, 'utf8'), /1 problem\n[^]*shallow-history[^]*this clone is shallow/);
});

test('check --history: a commit hidden by git replace is still scanned; a grafts file fails with one finding (#284)', async () => {
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
  let result = await sandbox.call(['check', '--history']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /notes\.md @ \w+:1: a secret \(GitHub token\)/);
  assert.ok(!result.stderr.includes(token), 'the secret is never printed');

  // A grafts file can hide commits too: nothing is scanned, and one finding says why.
  const second = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('replace', '-d', first);
  sandbox.write('.git/info/grafts', `${second}\n`);
  result = await sandbox.call(['check', '--history']);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(!/every commit on every branch/.test(result.stdout + result.stderr), result.stdout);
  assert.match(result.stderr, /1 problem\(s\)\n- this repo has a grafts file, so the history check can't see every commit\. .+\. Run `git replace --convert-graft-file`/);
  assert.ok(!result.stderr.includes('notes.md'), 'nothing was scanned');
  result = await sandbox.call(['check', '--history', '--json']);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['shallow-history']);
});

test('check --staged reads the staged blob past git replace; GIT_GRAFT_FILE fails check --history (#294)', async () => {
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
  const result = await sandbox.call(['check', '--staged']);
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
  const history = await sandbox.call(['check', '--history'], { extra: { GIT_GRAFT_FILE: grafts } });
  assert.equal(history.status, 1, history.stdout);
  assert.match(history.stderr, /1 problem\(s\)\n- this repo has a grafts file, so the history check can't see every commit\./);
  assert.ok(!history.stderr.includes('notes.md'), 'nothing was scanned');
});

// #267: a commit the checkout does not have is one finding with the fix, in text, JSON
// and the job summary; git's raw error never reaches the output.
test('check --pr: a base or head commit not in the checkout is one finding, never a git crash (#267)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
  const event = (shas: { base: string; head: string }) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: shas.base }, head: { sha: shas.head } } }));
    return file;
  };
  const noGitError = (out: string) => assert.doesNotMatch(out, /fatal|Command failed|symmetric difference|Invalid/i, out);
  // The positive control: both commits here, so the check passes.
  assert.equal((await sandbox.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base, head }) } })).status, 0);

  // A depth-1 clone has the head but not the base.
  const clone = join(sandbox.home, 'clone');
  const cloned = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${sandbox.repo}`, clone], { env: sandbox.env, encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stderr);
  const summary = join(sandbox.home, 'summary.md');
  let result = await sandbox.call(['check', '--pr'], { cwd: clone, extra: { GITHUB_EVENT_PATH: event({ base, head }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's base commit is not in this checkout\. .+\. Use `fetch-depth: 0` in actions\/checkout, so the checkout has the whole history\.\n  docs: \S+#use-it-as-a-github-action\n$/);
  noGitError(result.stderr);
  result = await sandbox.call(['check', '--pr', '--json'], { cwd: clone, extra: { GITHUB_EVENT_PATH: event({ base, head }), GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
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
  result = await sandbox.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base, head: missing }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's head commit is not in this checkout\. .+fetch-depth: 0/);
  noGitError(result.stderr);
  result = await sandbox.call(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event({ base, head: missing }) } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  report = JSON.parse(result.stdout);
  assert.deepEqual([report.ok, report.findings.length, report.findings[0].id], [false, 1, 'pr-commits']);
  assert.match(report.findings[0].what, /head commit/);
  // Both missing: one finding that names both. A value that is not a commit id is missing too.
  result = await sandbox.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base: missing, head: '--output=x' }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's base and head commits are not in this checkout\./);
  assert.ok(!existsSync(join(sandbox.repo, 'x')), 'a sha is never read as an option');
  // Both here, but with no common commit: git can't read base...head either.
  sandbox.git('checkout', '-q', '--orphan', 'other');
  sandbox.git('commit', '-qm', 'unrelated');
  const unrelated = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  result = await sandbox.call(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event({ base, head: unrelated }) } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.match(JSON.parse(result.stdout).findings[0].what, /no common commit/);
});

test('check --pr and --issue: an event file that is missing or broken is one finding; odd fields are skipped (#267)', async () => {
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
      let result = await sandbox.call(['check', mode], { extra: { GITHUB_EVENT_PATH: file } });
      assert.equal(result.status, 1, `${mode} ${content}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`^yokoten check ${mode}: 1 problem\\(s\\)\\n- the CI event file \\(GITHUB_EVENT_PATH\\) ${what.source}\\. .+\\. Run it in a GitHub Actions job`));
      assert.doesNotMatch(result.stderr, /ENOENT|SyntaxError|TypeError|Unexpected token/);
      assert.ok(!result.stderr.includes(sandbox.home), 'the path is not printed');
      result = await sandbox.call(['check', mode, '--json'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['ci-event']);
    }
  }
  assert.equal(readFileSync(summary, 'utf8').split('| [ci-event](').length - 1, 8, 'each run wrote its summary');
  // A label that is null or has no name, and a title that is not text, are skipped, not a crash.
  writeFileSync(file, JSON.stringify({ issue: { title: 'check: a symptom', labels: [null, 7, { name: 'incident' }, {}] } }));
  let result = await sandbox.call(['check', '--issue'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(file, JSON.stringify({ issue: { title: 42, labels: null } }));
  result = await sandbox.call(['check', '--issue', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(JSON.parse(result.stdout).findings.length > 0, 'an empty title fails its rule');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: null, labels: [null], milestone: 'M0', base: { sha: head }, head: { sha: head } } }));
  result = await sandbox.call(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(JSON.parse(result.stdout).findings.some((f: { id: string }) => f.id === 'pr-labels'));
  // An event with neither is not a run to check, as before.
  writeFileSync(file, JSON.stringify({ action: 'opened', pull_request: null, issue: 'x' }));
  for (const mode of ['--pr', '--issue']) assert.match((await sandbox.call(['check', mode], { extra: { GITHUB_EVENT_PATH: file } })).stdout, /in this run/);
});

// #273: an event whose base or head commit id is empty, missing or not text is one
// finding, never an empty diff that lets the file rules pass.
test('check --pr: a pull request event with no base or head commit id is one finding (#273)', async () => {
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
    let result = await sandbox.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file } });
    assert.equal(result.status, 1, what);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`^yokoten check --pr: 1 problem\\(s\\)\\n- the pull request's ${what} missing from the event\\. .+\\. Run it in a GitHub Actions job on a \`pull_request\` event`));
    result = await sandbox.call(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
    assert.equal(result.status, 1, what);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.deepEqual([report.check, report.ok, report.findings.map((f: { id: string }) => f.id)], ['pr', false, ['pr-commits']]);
    assert.match(report.findings[0].what, new RegExp(`${what} missing from the event`));
  }
});

// #244: blobs are read in batches under a cap, so one buffer never holds a whole big commit.
test('readBlobs: batches under the cap; a blob over it is read only for its start (#244)', async () => {
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
  const read = readBlobs(repo.root, [...small, small[0], big, missing], process.env, 40);
  assert.deepEqual([...read.keys()].sort(), [...small, big].sort(), 'a missing blob is left out; a repeat is read once');
  for (const [i, n] of [10, 20, 30].entries()) assert.deepEqual(read.get(small[i]), { bytes: Buffer.alloc(n, String(n)), size: n, whole: true });
  const start = read.get(big);
  assert.deepEqual([start?.bytes.length, start?.size, start?.whole], [8000, 9001, false], 'only the first 8000 bytes, enough to tell binary');
  assert.deepEqual(readBlobs(repo.root, [], process.env), new Map());
});

// Every read of repo content ignores `git replace` (#284, #294): readBlobs too, in the batch
// and in the over-cap read.
test('readBlobs: reads the bytes as stored, past a replace ref, in the batch and the over-cap read (#244, #294)', async () => {
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
  const read = readBlobs(repo.root, [stored, big], process.env, 100);
  assert.deepEqual([read.get(stored)?.bytes.toString(), first(read, big)], ['stored bytes\n', 'a'], 'the bytes as stored');
});

test('check --history: a blob swapped by git replace is read as committed, not as the swap shows it (#284)', async () => {
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

test('check --staged: a staged change file is read as `yokoten changelog` reads it (#346)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('changes/README.md', '# Change files\n');
  sandbox.write('changes/7-dark.md', '### Internal\n\nA dark mode (#7).\n');
  sandbox.git('add', '.');
  let result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /changes\/7-dark\.md:1: line 1 is not a section\. `yokoten changelog` puts each entry under its section/);
  assert.match(result.stderr, /Make line 1 one of: Added, Changed, Deprecated, Removed, Fixed, Security, Internal\./);
  assert.ok(!result.stderr.includes('README.md'), 'the README is not a change file');
  // A long sentence is a note, as in `check --pr`; it never fails the commit.
  const long = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
  sandbox.write('changes/7-dark.md', `Added\n\nA dark mode (#7).\n${long}.\n`);
  sandbox.git('add', '.');
  result = await sandbox.call(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /note: changes\/7-dark\.md:4: a sentence of 30 words/);
});

test('check: a sure secret fails, a likely one warns, and an ignored one stays listed (#616)', async () => {
  const sandbox = makeSandbox();
  const sure = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  const ignored = 'Q7w3R9t2Y5u8I1o4'.repeat(2);
  const likely = 'a1B2c3D4e5F6g7H8'.repeat(2);
  const sureIgnored = `${'gh'}p_${'a1B2c3'.repeat(6)}`;
  const names = ['GITHUB_' + 'TOKEN', 'api_' + 'key', 'OLD_' + 'KEY', 'NEW_' + 'TOKEN'];
  const marker = ['yokoten', 'ignore'].join('-');
  sandbox.write('a.env', [`${names[0]}=${sure}`, `${names[1]}="${likely}"`, `${names[2]}=${ignored} # ${marker} secret: a test fixture`, `${names[3]}=${sureIgnored} # ${marker} secret: a test fixture`, ''].join('\n'));
  sandbox.git('add', 'a.env');
  const result = await sandbox.call(['check', '--staged', '--json']);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as { findings: { id: string; grade?: string; line?: number }[]; notes: { grade?: string; ignored?: string }[] };
  // A sure secret fails, with or without a comment: only .yokotenignore may let it through.
  assert.deepEqual(output.findings.map((f) => [f.id, f.grade, f.line]), [['secret', 'sure', 1], ['secret', 'sure', 4]], JSON.stringify(output.findings));
  assert.ok(output.notes.some((f) => f.grade === 'likely' && f.ignored === undefined), JSON.stringify(output.notes));
  assert.ok(output.notes.some((f) => f.grade === 'likely' && f.ignored === 'a test fixture'), JSON.stringify(output.notes));
  for (const secret of [sure, ignored, likely, sureIgnored]) assert.ok(!result.stdout.includes(secret), 'no secret appears in the output');
  const text = await sandbox.call(['check', '--staged']);
  assert.match(text.stdout, /warning: .*\[likely\]/);
  assert.match(text.stdout, /ignored: a test fixture/);
});

test('check --staged: reads the staged change file, not the work tree; plain check reads the work tree (#346)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('src/a.ts', 'a\n');
  sandbox.write('changes/8-old.md', 'Added\n\nOld (#8).\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  // A wrong file that is not staged does not stop the commit of something else.
  sandbox.write('changes/8-old.md', 'Nothing\n\nOld (#8).\n');
  sandbox.write('changes/9-new.md', '## Fixed\n\nNew (#9).\n');
  sandbox.write('src/a.ts', 'b\n');
  sandbox.git('add', 'src/a.ts');
  assert.equal((await sandbox.call(['check', '--staged'])).status, 0);
  // Plain check reads every change file present, as `changelog` does.
  const tree = await sandbox.call(['check']);
  assert.equal(tree.status, 1);
  assert.match(tree.stderr, /changes\/8-old\.md:1: line 1 is not a section/);
  assert.match(tree.stderr, /changes\/9-new\.md:1: line 1 is not a section/);
  // Staged wrong, then fixed only in the work tree: the commit holds the staged copy.
  sandbox.git('add', 'changes/9-new.md');
  sandbox.write('changes/9-new.md', 'Fixed\n\nNew (#9).\n');
  const staged = await sandbox.call(['check', '--staged']);
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /changes\/9-new\.md:1: line 1 is not a section/);
  assert.ok(!staged.stderr.includes('8-old'), 'the unstaged file is not read');
});

test('check: a stale exempt glob is a note for the tree and the doctor, never at a commit (#381)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } }));
  sandbox.git('add', '.');
  const note = /note: yokoten\.json: layout\.exempt "crates\/\*\/tests\/data" matches no folder/;
  const tree = await sandbox.call(['check']);
  assert.match(tree.stdout, note);
  assert.equal(tree.status, 0, 'a note never fails the check');
  const staged = await sandbox.call(['check', '--staged']);
  assert.doesNotMatch(staged.stdout + staged.stderr, /matches no folder/);
  assert.match((await sandbox.call(['doctor'])).stdout, /note +yokoten\.json: layout\.exempt "crates\/\*\/tests\/data" matches no folder/);
  // Once a crate has the folder, the note goes.
  for (let index = 0; index < 9; index++) sandbox.write(`crates/app-core/tests/data/f${index}.xls`, 'x\n');
  sandbox.git('add', '.');
  const covered = await sandbox.call(['check']);
  assert.doesNotMatch(covered.stdout, /matches no folder/);
  assert.equal(covered.status, 0);
});

// One marks file for the machine, two repos (#424): the private project allows its own name
// in its yokoten.json, so its check and its commit hook pass; the other repo is stopped.
test('check and the commit hook: a mark allowed in one repo is stopped in another with the same marks file (#424)', async () => {
  const own = makeSandbox();
  const other = makeSandbox();
  const marks = join(own.home, 'shared-marks');
  writeFileSync(marks, 'quietvale\nquietvale labs\n');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks };
  const setup = async (sandbox: ReturnType<typeof makeSandbox>, allow: string[]) => {
    sandbox.write('yokoten.json', JSON.stringify({ privacy: { allow } }));
    sandbox.write('README.md', 'QuietVale ships\n');
    assert.equal((await sandbox.call(['init'], { extra })).status, 0);
    sandbox.git('add', '.');
  };
  await setup(own, ['QUIETVALE']);
  await setup(other, ['quietval', 'quietvale2']); // near misses allow nothing
  const commit = (sandbox: ReturnType<typeof makeSandbox>) =>
    spawnSync('git', ['commit', '-qm', 'start'], { cwd: sandbox.repo, env: { ...sandbox.env, ...extra }, encoding: 'utf8' });
  for (const args of [['check'], ['check', '--staged']]) {
    assert.equal((await own.call(args, { extra })).status, 0, `${args.join(' ')} in the repo that allows it`);
    const stopped = await other.call(args, { extra });
    assert.equal(stopped.status, 1, `${args.join(' ')} in the other repo`);
    assert.match(stopped.stderr, /README\.md:1: matches a word you added to your private marks/);
    assert.ok(!/quietvale/i.test(stopped.stderr + stopped.stdout), 'the mark is never printed');
  }
  assert.equal(commit(own).status, 0, 'the commit hook lets the repo that allows it commit');
  const refused = commit(other);
  assert.notEqual(refused.status, 0, 'the commit hook stops the other repo');
  assert.match(refused.stderr, /matches a word you added to your private marks/);
  assert.ok(!/quietvale/i.test(refused.stderr + refused.stdout));
  // The longer mark is not allowed by the shorter one.
  own.write('README.md', 'QuietVale Labs ships\n');
  own.git('add', '.');
  assert.equal((await own.call(['check', '--staged'], { extra })).status, 1);
  assert.notEqual(spawnSync('git', ['commit', '-qm', 'labs'], { cwd: own.repo, env: { ...own.env, ...extra }, encoding: 'utf8' }).status, 0);
  // doctor counts the allowed marks, never names them.
  own.write('README.md', 'QuietVale ships\n');
  own.git('add', '.');
  const doctor = (await own.call(['doctor'], { extra })).stdout;
  assert.match(doctor, /own-marks: 1 of your private marks allowed here by privacy\.allow/);
  assert.ok(!/quietvale/i.test(doctor));
  assert.doesNotMatch((await other.call(['doctor'], { extra })).stdout, /own-marks/);
});

test('check: an added forge login is fine where a file names accounts, and found everywhere else (#410)', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  mkdirSync(dirname(marks), { recursive: true });
  writeFileSync(marks, '# my own\nmycity\n# added by yokoten from this machine: forge login\nocto-jdoe\n');
  sandbox.write('.github/CODEOWNERS', '* @octo-jdoe\n/docs/ @octo-jdoe/docs-team\n');
  sandbox.write('.claude-plugin/plugin.json', '{\n  "name": "x",\n  "author": {\n    "name": "octo-jdoe",\n    "url": "https://github.com/octo-jdoe"\n  }\n}\n');
  sandbox.write('package.json', '{\n  "name": "x",\n  "author": "octo-jdoe"\n}\n');
  sandbox.write('LICENSE', 'MIT License\n\nCopyright (c) 2026 octo-jdoe\n');
  sandbox.write('README.md', 'Hello.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: hello');
  let result = await sandbox.call(['check']);
  assert.equal(result.status, 0, result.stderr);
  // Anywhere else, the same login is still found, and never printed.
  sandbox.write('src/x.ts', "const who = 'octo-jdoe';\n");
  sandbox.write('docs/a.md', 'Ask @octo-jdoe.\n');
  sandbox.write('LICENSE', 'MIT License\n\nCopyright (c) 2026 octo-jdoe\nWritten by octo-jdoe.\n');
  sandbox.write('package.json', '{\n  "name": "x",\n  "description": "by octo-jdoe",\n  "author": "octo-jdoe"\n}\n');
  sandbox.git('add', '.');
  result = await sandbox.call(['check']);
  assert.equal(result.status, 1);
  for (const place of ['src/x.ts:1', 'docs/a.md:1', 'LICENSE:4', 'package.json:3']) assert.match(result.stderr, new RegExp(`${place.replace('.', '\\.')}: matches your forge login \\(a private mark yokoten added by itself\\)`));
  assert.ok(!/LICENSE:3|package\.json:4/.test(result.stderr), result.stderr);
  assert.ok(!/octo-jdoe/i.test(result.stdout + result.stderr), 'check printed the login');
});

test('check: the git name install added is found in a LICENSE copyright line and an author field too; only the login is fine there (#434)', async () => {
  const sandbox = makeSandbox();
  const name = ['Ann', 'Sample'].join(' ');
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  mkdirSync(dirname(marks), { recursive: true });
  writeFileSync(marks, `# added by yokoten from this machine: git name\n${name}\n`);
  sandbox.write('LICENSE', `MIT License\n\nCopyright (c) 2026 ${name}\n`);
  sandbox.write('package.json', `{\n  "name": "x",\n  "author": "${name}"\n}\n`);
  sandbox.write('docs/a.md', `Written by ${name}.\n`);
  sandbox.git('add', '.');
  const result = await sandbox.call(['check']);
  assert.equal(result.status, 1);
  // The owner may hide the real name behind a noreply address and a mailmap: safe by default.
  for (const place of ['LICENSE:3', 'package.json:3', 'docs/a.md:1']) assert.match(result.stderr, new RegExp(`${place.replace('.', '\\.')}: matches your git name \\(a private mark yokoten added by itself\\)`));
  assert.ok(!/ann|sample/i.test(result.stdout + result.stderr), 'check printed the name');
});

test('check: a mark the owner wrote is found in CODEOWNERS too (#410)', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  mkdirSync(dirname(marks), { recursive: true });
  writeFileSync(marks, 'octo-jdoe\n');
  sandbox.write('.github/CODEOWNERS', '* @octo-jdoe\n');
  sandbox.git('add', '.');
  const result = await sandbox.call(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.github\/CODEOWNERS:1: matches a word you added to your private marks/);
  assert.ok(!/octo-jdoe/i.test(result.stdout + result.stderr));
});

// A gate that can't read git stops and says so (#403): never "clean", never "no changes".
test('check: every gate refuses when git can\'t answer, never passes as clean (#403)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'a');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('changes/1-a.md', 'Fixed\n\nA thing (#1).\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'b');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = join(sandbox.home, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { title: 'fix(check): a', body: 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n', labels: [{ name: 'fix' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
  const gates = [['check'], ['check', '--staged'], ['check', '--history'], ['check', '--pr']];
  const pr = { GITHUB_EVENT_PATH: event };
  // The positive control: each gate passes when git answers.
  for (const args of gates) assert.equal((await sandbox.call(args, { extra: pr })).status, 0, args.join(' '));
  // GIT_DIR pointing nowhere: no repo, so each gate stops before it reads anything.
  for (const args of gates) {
    const result = await sandbox.call([...args, '--json'], { extra: { ...pr, GIT_DIR: join(sandbox.home, 'nowhere') } });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(JSON.parse(result.stdout).ok, false, args.join(' '));
  }
  const refused = async (args: string[], extra: Record<string, string>) => {
    const result = await sandbox.call([...args, '--json'], { extra });
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual([report.ok, report.findings.map((f: { id: string }) => f.id)], [false, ['git-read']], args.join(' '));
    assert.match(report.findings[0].what, /gave no answer: it exited 128: fatal: /);
    const text = await sandbox.call(args, { extra });
    assert.match(text.stderr, /: 1 problem\(s\)\n- git can't answer, so the check stopped without looking: `git /, args.join(' '));
  };
  // The repo is found, but its index can't be read: the tree check and the commit check stop.
  const badIndex = join(sandbox.home, 'index');
  writeFileSync(badIndex, 'not an index\n');
  await refused(['check'], { GIT_INDEX_FILE: badIndex });
  await refused(['check', '--staged'], { GIT_INDEX_FILE: badIndex });
  // A ref to a commit that is not there: the history can't be walked.
  writeFileSync(join(sandbox.repo, '.git', 'refs', 'heads', 'broken'), `${'1'.repeat(40)}\n`);
  await refused(['check', '--history'], {});
  rmSync(join(sandbox.repo, '.git', 'refs', 'heads', 'broken'));
  // Both commits are here, but a blob the pull request changed is gone: its diff can't be read.
  const blob = sandbox.git('rev-parse', `${head}:changes/1-a.md`).stdout.trim();
  rmSync(join(sandbox.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  await refused(['check', '--pr'], pr);
});

test('readGit: no answer is a GitReadError, whatever the reason (#403)', async () => {
  const repo = makeTranslatedRepo();
  assert.throws(() => readGit(repo.root, ['rev-parse', '--verify', 'nothing-here'], { env: process.env }), (err: Error) => err instanceof GitReadError && /`git rev-parse --verify nothing-here` gave no answer: it exited 128: fatal: /.test(err.message));
  assert.throws(() => readGit(repo.root, ['ls-files', '-z'], { env: process.env, maxBuffer: 2 }), (err: Error) => err instanceof GitReadError && /its output is over the 2 bytes yokoten reads/.test(err.message));
  assert.throws(() => readGit(join(repo.root, 'no-such-folder'), ['status'], { env: process.env }), GitReadError);
  assert.equal(readGit(repo.root, ['rev-parse', '--is-inside-work-tree'], { env: process.env }).toString().trim(), 'true');
});

// The case from #403: a status read hidden by a user setting, or cut off by a buffer.
test('changedFiles: reads 5,000 new files in full, past status.showUntrackedFiles=no (#403)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'status.showUntrackedFiles', 'no');
  // Long names, so git's output is well over Node's default 1 MB buffer.
  const long = 'n'.repeat(200);
  mkdirSync(join(sandbox.repo, 'many'));
  for (let i = 0; i < 5000; i++) writeFileSync(join(sandbox.repo, 'many', `${long}-${i}.txt`), '');
  assert.equal(sandbox.git('status', '--porcelain').stdout, '', 'the setting hides them from a plain status');
  const files = changedFiles(sandbox.repo, process.env);
  assert.equal(files.length, 5000);
  assert.ok(files.includes(`many/${long}-4999.txt`));
});

test('check --staged: reads 5,000 staged files in full, past the default buffer (#403)', async () => {
  const sandbox = makeSandbox();
  const long = 'n'.repeat(200);
  mkdirSync(join(sandbox.repo, 'many'));
  for (let i = 0; i < 5000; i++) writeFileSync(join(sandbox.repo, 'many', `${long}-${i}.txt`), '');
  sandbox.git('add', '.');
  const result = await sandbox.call(['check', '--staged', '--json']);
  const report = JSON.parse(result.stdout);
  // All 5,000 were read: the layout rule counts every one of them.
  assert.deepEqual(report.findings.map((f: { id: string }) => f.id), ['layout']);
  assert.match(report.findings[0].what, /^5000 entries, over the cap of 7/);
});

// ---- Git answers kept for a run (#453) ----

test('git reads: a key as git config --list prints it, the subsection as it is', async () => {
  assert.equal(configKey('core.hooksPath'), 'core.hookspath');
  assert.equal(configKey('remote.Origin.URL'), 'remote.Origin.url');
  assert.equal(configKey('a.b.c.D'), 'a.b.c.d');
});

test('git reads: the list with scopes, a key with no value, and a value with a newline', async () => {
  assert.deepEqual(parseConfigList('global\0user.name\nA B\0local\0core.bare\0local\0x.y\nline\nnext\0'), [
    { scope: 'global', key: 'user.name', value: 'A B' },
    { scope: 'local', key: 'core.bare', value: '' },
    { scope: 'local', key: 'x.y', value: 'line\nnext' },
  ]);
  assert.deepEqual(parseConfigList(''), []);
});

test('git reads: an answer is kept for the run, a failure too, and dropped when the run is over or forgotten', async () => {
  let calls = 0;
  const read = () => remembered('key', () => ++calls);
  assert.deepEqual(withGitReads(() => [read(), read()]), [1, 1]);
  assert.equal(read(), 2, 'outside a run, each call reads');
  assert.deepEqual(
    withGitReads(() => {
      const first = read();
      forgetGitReads();
      return [first, read()];
    }),
    [3, 4],
  );
  let failures = 0;
  const fail = () =>
    remembered('fails', () => {
      failures++;
      throw new Error('no answer');
    });
  withGitReads(() => {
    assert.throws(fail, /no answer/);
    assert.throws(fail, /no answer/);
  });
  assert.equal(failures, 1, 'a failure is not read again in the run');
});

test('git reads: in a run, the values git config --get gives, from one list', async () => {
  const sandbox = makeSandbox();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: sandbox.repo, encoding: 'utf8' });
  git('config', '--add', 'x.many', 'first');
  git('config', '--add', 'x.many', 'second');
  // A key with no `=`, and a subsection in capitals.
  appendFileSync(join(sandbox.repo, '.git', 'config'), '[x]\n\tbare\n[remote "Up"]\n\turl = https://example.com/a.git\n');
  for (const key of ['x.many', 'X.Many', 'x.bare', 'remote.Up.url', 'remote.up.url', 'x.none', 'user.name']) {
    let expected = '';
    try {
      expected = git('config', '--get', key).trim();
    } catch {
      // not set
    }
    assert.equal(withGitReads(() => gitConfig(sandbox.repo, key, process.env)), expected, key);
    assert.equal(gitConfig(sandbox.repo, key, process.env), expected, `${key}, outside a run`);
  }
  const scopes = withGitReads(() => configEntries(sandbox.repo, 'x.many', process.env)?.map((entry) => `${entry.scope} ${entry.value}`));
  assert.deepEqual(scopes, ['local first', 'local second']);
  assert.equal(configEntries(sandbox.repo, 'x.many', process.env), null, 'outside a run, no list: the caller asks per key');
});

test('git reads: the folder of a self-test reads as no repo and no config, only in the run', async () => {
  const dir = makeTempDir();
  withGitReads(() => {
    assumeEmptyFolder(dir, process.env);
    assert.deepEqual(configEntries(dir, /./, process.env), []);
    assert.throws(() => remembered(`ls-files\0${dir}`, () => ['a file']), /not in a git repository/);
  });
  assumeEmptyFolder(dir, process.env);
  assert.equal(configEntries(dir, /./, process.env), null);
});

// The machine allows a mark for one repo (#447): neither repo has yokoten.json, and the
// allow is kept beside the marks file, keyed by the origin remote. The allowing repo's check
// and commit hook pass; another repo with the same marks is stopped; a renamed remote, two
// matching entries and the way back all stop it again. No output holds the mark.
test('marks allow --here: the machine allows a mark in one repo with no yokoten.json, and only there (#447)', async () => {
  const own = makeSandbox();
  const other = makeSandbox();
  const marks = join(own.home, 'shared-marks');
  writeFileSync(marks, 'quietvale\nquietvale labs\n');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks };
  // The allow file is beside the default marks file, never the setting's (#656).
  const allowFile = join(own.home, '.config', 'yokoten', 'private-marks-allow.json');
  mkdirSync(dirname(allowFile), { recursive: true });
  const said: string[] = [];
  const run = async (sandbox: ReturnType<typeof makeSandbox>, args: string[]) => {
    const r = await sandbox.call(args, { extra });
    said.push(r.stdout, r.stderr);
    return r;
  };
  const commit = (sandbox: ReturnType<typeof makeSandbox>, message: string) => {
    const r = spawnSync('git', ['commit', '-qm', message], { cwd: sandbox.repo, env: { ...sandbox.env, ...extra }, encoding: 'utf8' });
    said.push(r.stdout, r.stderr);
    return r;
  };
  for (const [sandbox, remote] of [[own, 'https://someone@Example.COM/octo/app.git'], [other, 'git@example.com:octo/other.git']] as const) {
    sandbox.git('remote', 'add', 'origin', remote);
    sandbox.write('README.md', 'QuietVale ships\n');
    // The commit hook, as a project with no yokoten.json may run it by hand.
    sandbox.write('.git/hooks/pre-commit', `#!/bin/sh\nexec node "${CLI}" check --staged\n`);
    chmodSync(join(sandbox.repo, '.git/hooks/pre-commit'), 0o755);
    sandbox.git('add', 'README.md');
  }

  // Only a mark in the marks file can be allowed; the refusal never echoes a mark.
  const refused = await run(own, ['marks', 'allow', 'quietval', '--here']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not a line of your private-marks file/);
  assert.equal(existsSync(allowFile), false, 'a refused allow writes nothing');
  assert.equal((await run(own, ['marks', 'allow', 'quietvale'])).status, 1, '--here is needed');
  assert.equal((await run(own, ['marks', 'allow', 'quietvale', 'extra', '--here'])).status, 1);

  const allowed = await run(own, ['marks', 'allow', 'QuietVale', '--here']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /allowed in this repo only/);
  assert.deepEqual(JSON.parse(readFileSync(allowFile, 'utf8')), { repos: [{ remote: 'example.com/octo/app', allow: ['quietvale'] }] });
  assert.equal(existsSync(join(own.repo, 'yokoten.json')), false, 'the repo still has no yokoten.json');
  assert.equal(own.git('status', '--porcelain', '--untracked-files=all').stdout.trim(), 'A  README.md', 'nothing is written into the repo');
  assert.equal((await run(own, ['marks', 'allow', 'quietvale', '--here'])).status, 0, 'a second allow changes nothing');

  for (const args of [['check'], ['check', '--staged']]) {
    assert.equal((await run(own, args)).status, 0, `${args.join(' ')} in the repo the machine allows it in`);
    const stopped = await run(other, args);
    assert.equal(stopped.status, 1, `${args.join(' ')} in the other repo`);
    assert.match(stopped.stderr, /README\.md:1: matches a word you added to your private marks/);
  }
  const doctor = (await run(own, ['doctor'])).stdout;
  assert.match(doctor, /own-marks: 1 of your private marks allowed here by this machine/);
  assert.doesNotMatch(doctor, /by privacy\.allow/);
  assert.doesNotMatch((await run(other, ['doctor'])).stdout, /own-marks/);
  assert.equal(commit(own, 'start').status, 0, 'the commit hook lets the allowed repo commit');
  assert.notEqual(commit(other, 'start').status, 0, 'the commit hook stops the other repo');

  // The longer mark is not allowed by the shorter one.
  own.write('README.md', 'QuietVale Labs ships\n');
  own.git('add', 'README.md');
  assert.equal((await run(own, ['check', '--staged'])).status, 1);
  own.write('README.md', 'QuietVale ships, again\n');
  own.git('add', 'README.md');

  // A renamed remote is another repo: no longer allowed.
  own.git('remote', 'set-url', 'origin', 'https://example.com/octo/renamed.git');
  assert.equal((await run(own, ['check', '--staged'])).status, 1, 'a renamed remote is stopped');
  own.git('remote', 'set-url', 'origin', 'https://example.com/octo/app');

  // Two entries for the same repo: unsure, so nothing is allowed, and doctor says why.
  const kept = readFileSync(allowFile, 'utf8');
  writeFileSync(allowFile, JSON.stringify({ repos: [{ remote: 'example.com/octo/app', allow: ['quietvale'] }, { remote: 'EXAMPLE.com/octo/app', allow: ['quietvale'] }] }));
  assert.equal((await run(own, ['check', '--staged'])).status, 1, 'two matching entries allow nothing');
  assert.match((await run(own, ['doctor'])).stdout, /own-marks: this machine allows no private mark here, because two entries in this machine's allow file match this repo/);
  assert.equal((await run(own, ['marks', 'allow', 'quietvale', '--here'])).status, 1, 'and the command will not guess which to change');
  writeFileSync(allowFile, kept);
  assert.equal((await run(own, ['check', '--staged'])).status, 0);

  // The way back: the mark is stopped here again, and the entry is gone.
  const removed = await run(own, ['marks', 'allow', '--remove', 'quietvale', '--here']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(readFileSync(allowFile, 'utf8')), { repos: [] });
  assert.equal((await run(own, ['check', '--staged'])).status, 1);
  assert.notEqual(commit(own, 'again').status, 0, 'the commit hook stops it again');
  assert.match((await run(own, ['marks', 'allow', '--remove', 'quietvale', '--here'])).stdout, /not allowed here, so nothing changed/);

  assert.ok(!said.some((text) => /quietval/i.test(text)), 'no output holds a mark');
});

test('check and doctor: a mark that names the repo is skipped there, counted by doctor, and privacy.skipOwnName turns it off (#447)', async () => {
  const own = makeSandbox();
  const stranger = makeSandbox();
  const marks = join(own.home, 'shared-marks');
  writeFileSync(marks, 'quiet vale\nsecondmark\n');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks };
  const said: string[] = [];
  const run = async (sandbox: ReturnType<typeof makeSandbox>, args: string[], more: Record<string, string> = {}) => {
    const r = await sandbox.call(args, { extra: { ...extra, ...more } });
    said.push(r.stdout, r.stderr);
    return r;
  };
  for (const [sandbox, remote] of [[own, 'https://example.com/octo/quiet-vale.git'], [stranger, 'https://github.com/stranger/other']] as const) {
    sandbox.git('remote', 'add', 'origin', remote);
    sandbox.write('README.md', 'Quiet Vale ships\n');
    sandbox.git('add', 'README.md');
  }
  for (const args of [['check'], ['check', '--staged']]) assert.equal((await run(own, args)).status, 0, `${args.join(' ')} in the repo the mark names`);
  const doctor = (await run(own, ['doctor'])).stdout;
  assert.match(doctor, /own-marks: 1 of your private marks skipped here because they name this repo/);

  // CI's repo name is not read: a checkout whose origin is stranger/other is stopped, faked or not.
  const ci = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'octo/quiet-vale' };
  for (const args of [['check'], ['check', '--staged']]) assert.equal((await run(stranger, args, ci)).status, 1, `${args.join(' ')} with a faked CI repo`);
  assert.doesNotMatch((await run(stranger, ['doctor'])).stdout, /own-marks/);

  // The way back: off in yokoten.json looks for the mark again, and doctor no longer counts it.
  own.write('yokoten.json', JSON.stringify({ privacy: { skipOwnName: false } }));
  assert.equal((await run(own, ['check', '--staged'])).status, 1, 'off: stopped');
  assert.doesNotMatch((await run(own, ['doctor'])).stdout, /name this repo/);
  own.write('yokoten.json', JSON.stringify({ privacy: { skipOwnName: true } }));
  assert.equal((await run(own, ['check', '--staged'])).status, 0, 'on again');
  assert.match((await run(own, ['doctor'])).stdout, /own-marks: 1 of your private marks skipped here because they name this repo/);

  // The machine's switch, kept when `marks allow` writes the file.
  // The allow file is beside the default marks file, never the setting's (#656).
  const allowFile = join(own.home, '.config', 'yokoten', 'private-marks-allow.json');
  mkdirSync(dirname(allowFile), { recursive: true });
  // The switch alone, with no repos key, as the guide shows it: read as no repos.
  writeFileSync(allowFile, JSON.stringify({ skipOwnName: false }));
  assert.equal((await run(own, ['check', '--staged'])).status, 1, 'off on this machine');
  const switchedOff = (await run(own, ['doctor'])).stdout;
  assert.doesNotMatch(switchedOff, /name this repo/);
  assert.doesNotMatch(switchedOff, /allow file/, 'doctor reads the switch alone as a good file');
  assert.equal((await run(own, ['marks', 'allow', 'secondmark', '--here'])).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(allowFile, 'utf8')), { skipOwnName: false, repos: [{ remote: 'example.com/octo/quiet-vale', allow: ['secondmark'] }] }, 'marks allow keeps the switch and writes both keys');
  rmSync(allowFile);
  assert.equal((await run(own, ['check', '--staged'])).status, 0, 'on again with no allow file');

  assert.ok(!said.some((text) => /quiet vale|secondmark/i.test(text)), 'no output holds a mark');
});

test('marks allow --here: a repo with no origin gets no machine allow; a held lock and a dangling link are refused (#447)', async () => {
  const sandbox = makeSandbox();
  const config = join(sandbox.home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'private-marks'), 'quietvale\n');
  const allowFile = join(config, 'private-marks-allow.json');
  sandbox.write('README.md', 'QuietVale ships\n');
  sandbox.git('add', 'README.md');
  const none = await sandbox.call(['marks', 'allow', 'quietvale', '--here']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /because this repo has no origin remote\. .*"privacy\.allow" in yokoten\.json/);
  assert.equal(existsSync(allowFile), false);
  sandbox.git('remote', 'add', 'origin', 'https://example.com/octo/app');
  // A lock another run holds: refused, and the file is not made.
  writeFileSync(`${allowFile}.lock`, '');
  const busy = await sandbox.call(['marks', 'allow', 'quietvale', '--here']);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /another `yokoten marks` is changing the allow file/);
  assert.equal(existsSync(allowFile), false);
  // A lock left by a run that died is taken over.
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${allowFile}.lock`, old, old);
  const taken = await sandbox.call(['marks', 'allow', 'quietvale', '--here']);
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(existsSync(`${allowFile}.lock`), false, 'the lock is released');
  assert.equal((await sandbox.call(['check'])).status, 0);
  // A link to nothing: refused, and the link is left as it is.
  rmSync(allowFile);
  symlinkSync(join(sandbox.home, 'gone.json'), allowFile);
  const dangling = await sandbox.call(['marks', 'allow', 'quietvale', '--here']);
  assert.equal(dangling.status, 1);
  assert.match(dangling.stderr, /a link to a file that is not there/);
  assert.doesNotMatch(dangling.stderr, /gone\.json/);
  assert.ok(lstatSync(allowFile).isSymbolicLink());
  assert.equal((await sandbox.call(['check'])).status, 1, 'a dangling link allows nothing');
  assert.match((await sandbox.call(['doctor'])).stdout, /own-marks: this machine allows no private mark here, because this machine's allow file can't be read/);
});

test('marks allow: no mark is echoed, -- takes a mark that starts with -, a linked file stays a link, and a failed save says so plainly (#447)', async () => {
  const sandbox = makeSandbox();
  const config = join(sandbox.home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'private-marks'), 'quietvale\n-quietvale\n');
  sandbox.git('remote', 'add', 'origin', 'https://example.com/octo/app');
  const said: string[] = [];
  const run = async (args: string[]) => {
    const r = await sandbox.call(args);
    said.push(r.stdout, r.stderr);
    return r;
  };
  const unknown = await run(['marks', 'allow', '--quietvale', '--here']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /an unknown option; to give a mark that starts with -, put it after --/);
  // The allow file is a link to a file elsewhere: the link is kept, and the file it names changes.
  const real = join(sandbox.home, 'kept', 'allow.json');
  mkdirSync(dirname(real));
  writeFileSync(real, '{"repos": []}\n');
  symlinkSync(real, join(config, 'private-marks-allow.json'));
  const dashed = await run(['marks', 'allow', '--here', '--', '-quietvale']);
  assert.equal(dashed.status, 0, dashed.stderr);
  assert.ok(lstatSync(join(config, 'private-marks-allow.json')).isSymbolicLink(), 'the link is kept');
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')).repos[0].allow, ['-quietvale']);
  assert.equal((await run(['marks', 'allow', '--remove', '--here', '--', '-quietvale'])).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')).repos, []);
  // A folder that can't be written: one plain line, no path.
  rmSync(join(config, 'private-marks-allow.json'));
  chmodSync(config, 0o500);
  try {
    const failed = await run(['marks', 'allow', 'quietvale', '--here']);
    if (process.getuid?.() !== 0) {
      assert.equal(failed.status, 1);
      assert.doesNotMatch(failed.stderr, /\.config|allow\.json|\/tmp/);
    }
  } finally {
    chmodSync(config, 0o700);
  }
  assert.ok(!said.some((text) => /quietval/i.test(text)), 'no output holds a mark');
});

// #503: a stopped commit says how to take the named files out of it, and that they stay on disk.
test('check --staged: a stopped commit says how to unstage the files it names (#503)', async () => {
  const sandbox = makeSandbox();
  // No commit yet: there is no HEAD to restore from, so the command is git rm --cached.
  sandbox.write('dist/app.js', 'console.log(1);\n');
  // A name with a space is quoted.
  writeFileSync(join(sandbox.repo, 'my tool'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 0]));
  sandbox.git('add', '.');
  let result = await sandbox.call(['check', '--staged']);
  assert.match(result.stderr, /To take these files out of the commit, run `git rm --cached dist\/app\.js 'my tool'`\. They stay on disk, with your changes\./);
  // After a commit: git restore --staged.
  sandbox.write('yokoten.json', JSON.stringify({ allowBuild: ['dist/**'] }));
  sandbox.git('add', '.');
  sandbox.git('rm', '-q', '--cached', 'dist/app.js', 'my tool');
  sandbox.git('commit', '-q', '-m', 'chore: start');
  writeFileSync(join(sandbox.repo, 'tool'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 0]));
  sandbox.git('add', 'tool');
  result = await sandbox.call(['check', '--staged']);
  assert.match(result.stderr, /To take this file out of the commit, run `git restore --staged tool`\. It stays on disk, with your changes\./);
  assert.equal(readFileSync(join(sandbox.repo, 'tool')).length, 8, 'the check changes nothing on disk');
  // A clean commit has no such line, and neither does a problem that names no staged file.
  sandbox.git('restore', '--staged', 'tool');
  result = await sandbox.call(['check', '--staged']);
  assert.doesNotMatch(result.stderr, /out of the commit/);
});

// #521: a staged dependency folder is one finding, and the hint names the folder, not its files.
test('check --staged: a staged node_modules is one line with the untrack command (#521)', async () => {
  const sandbox = makeSandbox();
  for (let i = 0; i < 30; i += 1) sandbox.write(`node_modules/pkg/dist/f${i}.js`, `module.exports = ${i};\n`);
  sandbox.git('add', '.');
  let result = await sandbox.call(['check', '--staged']);
  assert.match(result.stderr, /: 1 problem\(s\)/);
  assert.match(result.stderr, /node_modules\/: a dependency folder, with 30 of its files in the commit/);
  assert.match(result.stderr, /git rm -r --cached node_modules.*add `node_modules\/` to \.gitignore/);
  assert.match(result.stderr, /To take this folder out of the commit, run `git rm -r --cached node_modules\/`\. It stays on disk/);
  assert.doesNotMatch(result.stderr, /f29\.js/);
});

// ---- `yokoten pr sync` (#432) ----
//
// Real git, a bare remote and two branches: the sync merges the base into the branch,
// resolves only the two mechanical conflicts, verifies, and pushes. A push in these tests
// is the same git push, to the bare remote; the bot is tested where it belongs.

/** A sandbox with a bare origin, one commit on main, and main pushed. */
function remoteSandbox() {
  const sandbox = makeSandbox();
  const remote = makeTempDir('yokoten-remote-');
  const bare = spawnSync('git', ['init', '--bare', '-q', remote], { env: sandbox.env, encoding: 'utf8' });
  assert.equal(bare.status, 0, bare.stderr);
  sandbox.write('base.txt', 'base\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  sandbox.git('remote', 'add', 'origin', remote);
  sandbox.git('push', '-q', '-u', 'origin', 'main');
  return { sandbox, remote };
}

/** The sync's git, run where it asks. The real commands keep the test honest. */
const syncGit = (sandbox: ReturnType<typeof makeSandbox>) => (args: string[], cwd: string) => {
  const result = spawnSync('git', args, { cwd, env: sandbox.env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/** Push as the test's bot stand-in: the same git push, to the bare remote. */
const syncPush = (sandbox: ReturnType<typeof makeSandbox>, pushes: string[]) => async (worktree: string, branch: string) => {
  pushes.push(branch);
  const result = spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktree, env: sandbox.env, encoding: 'utf8' });
  return { ok: result.status === 0, said: String(result.stderr ?? '').trim() };
};

/** Put a branch and main apart: the branch works, then main moves on, and both are pushed. */
function diverge(sandbox: ReturnType<typeof makeSandbox>, change: (side: 'branch' | 'main') => void) {
  sandbox.git('switch', '-q', '-c', 'work');
  change('branch');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'work');
  sandbox.git('push', '-q', '-u', 'origin', 'work');
  sandbox.git('switch', '-q', 'main');
  change('main');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'main');
  sandbox.git('push', '-q', 'origin', 'main');
  sandbox.git('fetch', '-q', 'origin');
}

/** One sync run of `work` into `main`, with the test's push and a chosen verifier. */
function runSync(sandbox: ReturnType<typeof makeSandbox>, verifier = () => ({ ok: true, said: '' })) {
  const pushes: string[] = [];
  const checked: string[][] = [];
  const run = () =>
    syncPull({
      root: sandbox.repo,
      number: 1,
      branch: 'work',
      base: 'main',
      git: syncGit(sandbox),
      push: syncPush(sandbox, pushes),
      verify: (_, files) => {
        checked.push(files);
        return verifier();
      },
      tempRoot: join(sandbox.repo, '.tmp', 'yokoten-pr-sync'),
    });
  return { go: run, pushes, checked };
}

test('pr sync: a branch behind main gets main merged in and is pushed (#432)', async () => {
  const { sandbox } = remoteSandbox();
  diverge(sandbox, (side) => sandbox.write(`${side}.txt`, `${side}\n`));
  const sync = runSync(sandbox);
  const outcome = await sync.go();
  assert.equal(outcome.state, 'merged');
  assert.deepEqual(sync.checked, [['main.txt']], 'a clean merge is verified before the push (#809)');
  assert.deepEqual(sync.pushes, ['work'], 'the branch is pushed once');
  sandbox.git('fetch', '-q', 'origin');
  assert.equal(sandbox.git('merge-base', '--is-ancestor', 'origin/main', 'origin/work').status, 0, 'the remote branch holds main');
  assert.equal(sandbox.git('status', '--porcelain').stdout.trim(), '', 'the main checkout is untouched');
});

test('pr sync: a clean merge that fails verification is not pushed (#809)', async () => {
  const { sandbox } = remoteSandbox();
  diverge(sandbox, (side) => sandbox.write(`${side}.txt`, `${side}\n`));
  const before = sandbox.git('rev-parse', 'origin/work').stdout.trim();
  const sync = runSync(sandbox, () => ({ ok: false, said: 'typecheck failed: boom' }));
  const outcome = await sync.go();
  assert.equal(outcome.state, 'needs-agent');
  assert.match(outcome.reason ?? '', /failed after the merge/);
  assert.deepEqual(sync.checked, [['main.txt']]);
  assert.deepEqual(sync.pushes, [], 'nothing is pushed');
  assert.equal(sandbox.git('rev-parse', 'origin/work').stdout.trim(), before, 'the remote branch is untouched');
  assert.ok(outcome.worktree && existsSync(outcome.worktree), 'the temporary worktree waits for the agent');
});

test('pr sync: two added blocks at one spot are kept, tested and pushed (#432)', async () => {
  const { sandbox } = remoteSandbox();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'code');
  sandbox.git('push', '-q', 'origin', 'main');
  diverge(sandbox, (side) =>
    sandbox.write('src/a.ts', `export const a = 1;\nexport const ${side === 'branch' ? 'work' : 'main'} = () => ${side === 'branch' ? 2 : 3};\n`),
  );
  const sync = runSync(sandbox);
  const outcome = await sync.go();
  assert.equal(outcome.state, 'resolved');
  assert.equal(outcome.hunks, 1);
  assert.deepEqual(sync.checked, [['src/a.ts']], 'typecheck and the tests of the touched file run');
  assert.deepEqual(sync.pushes, ['work']);
  sandbox.git('fetch', '-q', 'origin');
  const merged = sandbox.git('show', 'origin/work:src/a.ts').stdout;
  assert.match(merged, /export const work = \(\) => 2;/);
  assert.match(merged, /export const main = \(\) => 3;/);
});

test('pr sync: two changed import lists become one list, then pass and push (#432)', async () => {
  const { sandbox } = remoteSandbox();
  const base = "import { a } from './x.ts';\nimport { b } from './y.ts';\n\nexport const value = a + b;\n";
  sandbox.write('src/b.ts', base);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'code');
  sandbox.git('push', '-q', 'origin', 'main');
  diverge(sandbox, (side) =>
    sandbox.write('src/b.ts', base.replace("import { a } from './x.ts';", `import { a, ${side === 'branch' ? 'c' : 'd'} } from './x.ts';`)),
  );
  const sync = runSync(sandbox);
  const outcome = await sync.go();
  assert.equal(outcome.state, 'resolved');
  assert.equal(outcome.hunks, 1);
  assert.deepEqual(sync.pushes, ['work']);
  sandbox.git('fetch', '-q', 'origin');
  const merged = sandbox.git('show', 'origin/work:src/b.ts').stdout;
  assert.match(merged, /^import \{ a, c, d \} from '\.\/x\.ts';$/m, 'both additions are kept, each name once');
});

test('pr sync: an import list keeps a name the base had unless one side deleted it (#809)', async () => {
  const { sandbox } = remoteSandbox();
  const base = "import { a, secret } from './x.ts';\n\nexport const value = a;\n";
  sandbox.write('src/d.ts', base);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'code');
  sandbox.git('push', '-q', 'origin', 'main');
  diverge(sandbox, (side) => {
    const names = side === 'branch' ? 'a, secret, b' : 'a';
    sandbox.write('src/d.ts', base.replace('{ a, secret }', `{ ${names} }`));
  });
  const sync = runSync(sandbox);
  const outcome = await sync.go();
  assert.equal(outcome.state, 'resolved');
  assert.equal(outcome.hunks, 1);
  assert.deepEqual(sync.pushes, ['work']);
  sandbox.git('fetch', '-q', 'origin');
  const merged = sandbox.git('show', 'origin/work:src/d.ts').stdout;
  assert.match(merged, /^import \{ a, b \} from '\.\/x\.ts';$/m, 'the branch keeps its add and main\'s delete applies');
});

test('pr sync: a semantic conflict stops, prints its hunks, and pushes nothing (#432)', async () => {
  const { sandbox } = remoteSandbox();
  sandbox.write('src/c.ts', 'export const n = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'code');
  sandbox.git('push', '-q', 'origin', 'main');
  diverge(sandbox, (side) => sandbox.write('src/c.ts', `export const n = ${side === 'branch' ? 2 : 3};\n`));
  const before = sandbox.git('rev-parse', 'origin/work').stdout.trim();
  const sync = runSync(sandbox);
  const outcome = await sync.go();
  assert.equal(outcome.state, 'needs-agent');
  assert.deepEqual(sync.pushes, [], 'nothing is pushed');
  assert.deepEqual(outcome.files, ['src/c.ts']);
  const hunks = outcome.hunksText?.join('\n') ?? '';
  assert.match(hunks, /<<<<<<< HEAD/);
  assert.match(hunks, /export const n = 2;/);
  assert.match(hunks, /export const n = 3;/);
  assert.match(outcome.brief ?? '', /Worktree: /, 'the dispatch brief is ready');
  assert.equal(sandbox.git('rev-parse', 'origin/work').stdout.trim(), before, 'the remote branch is untouched');
  assert.ok(outcome.worktree && existsSync(outcome.worktree), 'the conflict is left for the agent to resolve');
});

test('pr sync: a conflict on a checked-out branch is aborted before needs-agent (#809)', async () => {
  const { sandbox } = remoteSandbox();
  sandbox.write('src/e.ts', 'export const n = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'code');
  sandbox.git('push', '-q', 'origin', 'main');
  sandbox.git('switch', '-q', '-c', 'work');
  sandbox.write('src/e.ts', 'export const n = 2;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'work');
  sandbox.git('push', '-q', '-u', 'origin', 'work');
  sandbox.git('switch', '-q', 'main');
  sandbox.write('src/e.ts', 'export const n = 3;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'main');
  sandbox.git('push', '-q', 'origin', 'main');
  sandbox.git('fetch', '-q', 'origin');
  sandbox.git('switch', '-q', 'work');
  const sync = runSync(sandbox);
  const outcome = await sync.go();
  assert.equal(outcome.state, 'needs-agent');
  assert.deepEqual(sync.pushes, [], 'nothing is pushed');
  assert.deepEqual(outcome.files, ['src/e.ts']);
  assert.equal(sandbox.git('status', '--porcelain').stdout.trim(), '', 'the checked-out branch is left clean');
  assert.notEqual(sandbox.git('rev-parse', '--verify', '--quiet', 'MERGE_HEAD').status, 0, 'no merge is left in progress');
  assert.equal(readFileSync(join(sandbox.repo, 'src/e.ts'), 'utf8'), 'export const n = 2;\n', 'the branch file is back as it was');
  assert.equal(outcome.worktree, undefined, 'the checkout is not handed to an agent mid-merge');
});

test('pr sync: a resolution whose tests fail stops and pushes nothing (#432)', async () => {
  const { sandbox } = remoteSandbox();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'code');
  sandbox.git('push', '-q', 'origin', 'main');
  diverge(sandbox, (side) => sandbox.write('src/a.ts', `export const a = 1;\nexport const ${side === 'branch' ? 'work' : 'main'} = 2;\n`));
  const before = sandbox.git('rev-parse', 'origin/work').stdout.trim();
  const sync = runSync(sandbox, () => ({ ok: false, said: 'the tests failed: boom' }));
  const outcome = await sync.go();
  assert.equal(outcome.state, 'needs-agent');
  assert.match(outcome.reason ?? '', /tests failed/);
  assert.deepEqual(sync.pushes, [], 'nothing is pushed');
  assert.equal(sandbox.git('rev-parse', 'origin/work').stdout.trim(), before, 'the remote branch is untouched');
  assert.ok(outcome.worktree && existsSync(outcome.worktree), 'the merge commit waits for the agent');
});
