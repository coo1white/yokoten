// Tests for src/setup/init/ci-off.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  makeSandbox,
  stubGh,
} from '../../repo/helpers.ts';
import { NO_CI_REASON } from '../../../src/setup/init/index.ts';

test('init: a private repo can keep CI off with --no-ci, finish the road, and take CI up again (#377)', async () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, { 'api users/octo --jq .type': 'User', 'api repos/octo/app --jq .private': 'true' });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const ciFiles = ['.github/workflows/yokoten.yml', '.github/workflows/pr.yml', '.github/workflows/issue.yml', '.github/dependabot.yml'];
  const isThere = (file: string) => existsSync(join(sandbox.repo, file));
  const notNow = () => JSON.parse(readFileSync(join(sandbox.repo, 'yokoten.json'), 'utf8')).notNow;
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, 'not a real key\n');
  const machine = { ...extra, YOKOTEN_PRIVATE_MARKS: marks, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key };
  const session = async () => (await sandbox.call(['doctor', '--session'], { extra: machine })).stdout.trimEnd().split('\n');
  assert.equal(sandbox.run(['install']).status, 0); // a real process: the entry point of install

  // Without the choice: today's behaviour. The workflows are written, and init says what they cost.
  let result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^note: this repo is private, so the workflows in \.github\/workflows use Actions minutes from your plan$/m);
  assert.match(result.stdout, /^to keep CI off, run `yokoten init --no-ci`/m);
  assert.ok(ciFiles.every(isThere));
  assert.deepEqual(notNow(), {}, 'init never makes the choice itself');
  sandbox.write('.github/CODEOWNERS', '* @octo\n');
  sandbox.write('LICENSE', 'placeholder license\n');
  assert.match((await session())[0], /stage 1 of 5, safety net\. Next: no workflow runs a test command/, 'the tests step still asks for CI');

  // With the choice: the kit's copies go, a changed one stays and is named, and "notNow" holds the reason.
  sandbox.write('.github/workflows/issue.yml', 'name: ours\n');
  result = await sandbox.call(['init', '--no-ci'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^wrote "notNow" ci in yokoten\.json/m);
  for (const file of ['.github/workflows/yokoten.yml', '.github/workflows/pr.yml', '.github/dependabot.yml']) {
    assert.match(result.stdout, new RegExp(`^removed ${file.replaceAll('.', '\\.')} \\(the kit's copy; CI is off\\)$`, 'm'));
    assert.ok(!isThere(file), file);
  }
  assert.match(result.stdout, /^kept \.github\/workflows\/issue\.yml: it is not the kit's copy/m);
  assert.equal(result.stdout.match(/^kept \.github\/workflows\/issue\.yml/gm)?.length, 1, 'a kept file is named once');
  assert.doesNotMatch(result.stdout, /this repo is private/, 'the choice is made, so no offer');
  assert.deepEqual(notNow(), { ci: NO_CI_REASON });
  rmSync(join(sandbox.repo, '.github', 'workflows', 'issue.yml'));
  // A later init writes no workflow again, and says why.
  result = await sandbox.call(['init'], { extra });
  assert.match(result.stdout, /^skipped \.github\/workflows\/yokoten\.yml \(yokoten\.json "notNow" names ci\)$/m);
  assert.match(result.stdout, /^skipped \.github\/dependabot\.yml \(yokoten\.json "notNow" names ci\)$/m);
  assert.ok(!ciFiles.some(isThere));

  // The road: no nag about CI, and every step yokoten can check is done or not now.
  assert.deepEqual(await session(), ['yokoten: every step yokoten can check is done, or marked not now.']);
  const full = (await sandbox.call(['doctor'], { extra: machine })).stdout;
  assert.match(full, /^ +not now +tests \(Best Practices: test\): CI is off to save Actions minutes[^\n]*\(notNow ci\); run the tests yourself before each merge$/m);
  assert.match(full, /^ +not now +ci \(Scorecard: CI-Tests\): CI is off to save Actions minutes/m);
  assert.match(full, /^ +not now +titles \([^)]*\): [^\n]*; run `npx yokoten check --pr <number>` before each merge$/m);
  assert.match(full, /^ +done +security-files/m, 'no Dependabot config is asked for');
  // The trade-off, said once: what is not checked, and when to end the choice.
  assert.equal(full.match(/no-ci: /g)?.length, 1, full);
  assert.match(full, /^ +note +no-ci: CI is off \("notNow" names `ci`\), so nothing on the server checks pull requests, issue titles or the workflows, no code scanning such as CodeQL runs[^\n]*; before each merge, run `npx yokoten check --pr <number>` and the tests; when the repo goes public, remove "ci" from "notNow"/m);

  // Taking CI up again: remove the choice, and init brings the workflows back.
  sandbox.write('yokoten.json', JSON.stringify({ notNow: {} }));
  result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(ciFiles.every(isThere), result.stdout);
  assert.match((await session())[0], /stage 1 of 5, safety net\. Next: no workflow runs a test command/);
  assert.doesNotMatch((await sandbox.call(['doctor'], { extra: machine })).stdout, /no-ci/);
});

test('init --no-ci: the dependabot.yml init wrote with an ecosystem block is removed too (#377, #379)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{}\n');
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(sandbox.repo, '.github', 'dependabot.yml'), 'utf8'), /package-ecosystem: npm/);
  result = await sandbox.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^removed \.github\/dependabot\.yml \(the kit's copy; CI is off\)$/m);
  assert.ok(!existsSync(join(sandbox.repo, '.github', 'dependabot.yml')));
});

test('init: only "notNow" ci leaves kit files out; other steps in "notNow" keep today\'s files (#377)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { templates: 'later', changelog: 'later', codeowners: 'later', 'security-files': 'later', titles: 'later' } }));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^skipped /m);
  for (const file of ['.github/ISSUE_TEMPLATE/task.yml', '.github/pull_request_template.md', 'changes/README.md', '.github/SECURITY.md', '.github/dependabot.yml', '.github/CODEOWNERS', '.github/workflows/pr.yml']) {
    assert.ok(existsSync(join(sandbox.repo, file)), file);
  }
});

test('init --no-ci: a kit copy with Windows line ends is removed; a symlinked file or folder is kept and named (#377)', { skip: process.platform === 'win32' && 'symlinks need rights on Windows' }, async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const workflows = join(sandbox.repo, '.github', 'workflows');
  // A Windows checkout (core.autocrlf) has CRLF line ends on every line.
  const pr = join(workflows, 'pr.yml');
  writeFileSync(pr, readFileSync(pr, 'utf8').replace(/\n/g, '\r\n'));
  // A symlinked file: the file it points at stays, whatever it holds.
  const target = join(sandbox.home, 'issue.yml');
  cpSync(join(workflows, 'issue.yml'), target);
  rmSync(join(workflows, 'issue.yml'));
  symlinkSync(target, join(workflows, 'issue.yml'));
  let result = await sandbox.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^removed \.github\/workflows\/pr\.yml \(the kit's copy; CI is off\)$/m);
  assert.match(result.stdout, /^kept \.github\/workflows\/issue\.yml: \.github\/workflows\/issue\.yml is a symlink, and init never deletes through one/m);
  assert.ok(existsSync(target));
  assert.ok(lstatSync(join(workflows, 'issue.yml')).isSymbolicLink());

  // A symlinked .github/workflows folder: nothing in it is deleted.
  const other = makeSandbox();
  assert.equal((await other.call(['init'])).status, 0);
  const real = join(other.home, 'workflows');
  cpSync(join(other.repo, '.github', 'workflows'), real, { recursive: true });
  rmSync(join(other.repo, '.github', 'workflows'), { recursive: true });
  symlinkSync(real, join(other.repo, '.github', 'workflows'));
  result = await other.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml: \.github\/workflows is a symlink/m);
  assert.deepEqual(readdirSync(real).sort(), ['issue.yml', 'pr.yml', 'yokoten.yml']);
  // The control: dependabot.yml is a plain file, the kit's copy, so it goes.
  assert.match(result.stdout, /^removed \.github\/dependabot\.yml/m);
});

test('init --no-ci: only the "notNow" key changes in yokoten.json; the rest keeps its formatting (#377)', async () => {
  const sandbox = makeSandbox();
  const own = '{\n    "areas": ["cli",   "docs"],\n    "notNow": {\n        "bot": "no app yet"\n    }\n}\n';
  sandbox.write('yokoten.json', own);
  let result = await sandbox.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(sandbox.repo, 'yokoten.json'), 'utf8'), `{\n    "areas": ["cli",   "docs"],\n    "notNow": {\n        "ci": ${JSON.stringify(NO_CI_REASON)},\n        "bot": "no app yet"\n    }\n}\n`);
  // No "notNow" key yet: one is added after the opening brace, and nothing else moves.
  const other = makeSandbox();
  other.write('yokoten.json', '{ "areas": ["cli"] }\n');
  result = await other.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(other.repo, 'yokoten.json'), 'utf8'), `{ "notNow": { "ci": ${JSON.stringify(NO_CI_REASON)} }, "areas": ["cli"] }\n`);
  // A second run keeps it.
  assert.match((await other.call(['init', '--no-ci'])).stdout, /^kept "notNow" ci in yokoten\.json$/m);
});
