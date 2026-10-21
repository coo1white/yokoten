// Tests for src/commands/check.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  at,
  CLI,
  makeSandbox,
} from '../repo/helpers.ts';
import { invoke } from '../repo/invoke.ts';
import { cutPoint } from '../../src/commands/check.ts';
import { wrapForRedact } from '../../src/rules/guards.ts';

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

// ---- redact (#390) ----
//
// One session showed the owner's details six times. Each slip is replayed here in a
// sandbox: the value must come out as a placeholder. All values are made up.
const OWNER = 'Jane Example';
const LOGIN = 'janex';
const CITY = 'Fakeville';
const HOST = 'build.private-host.dev';
const EMAIL = `jane${at}personal-mail.dev`;

/** A sandbox whose repo has the owner as git author and a remote at a private host; with marks unless `marks` is false. */
function ownerSandbox({ marks = true } = {}) {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.name', OWNER);
  sandbox.git('config', 'user.email', EMAIL);
  sandbox.git('remote', 'add', 'origin', `ssh://git${at}${HOST}:2222/${LOGIN}/app.git`);
  sandbox.write('README.md', 'Hello.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: hello');
  if (marks) {
    mkdirSync(join(sandbox.home, '.config', 'yokoten'), { recursive: true });
    writeFileSync(join(sandbox.home, '.config', 'yokoten', 'private-marks'), `# mine\n${OWNER}\n${LOGIN}\n${CITY}\n${HOST}\n`);
  }
  // A command as the hook rewrites it, run by bash: its output, and its exit code.
  const wrapped = (command: string) => spawnSync('bash', ['-c', wrapForRedact(command, `node "${CLI}" redact`)], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  return { sandbox, wrapped };
}

const assertHidden = (output: string, values: string[]) => {
  for (const value of values) assert.ok(!output.toLowerCase().includes(value.toLowerCase()), `a value was left in: ${output}`);
};

test('redact: the six slips come out as placeholders (#390)', () => {
  const { sandbox, wrapped } = ownerSandbox();
  // 1. A git author line.
  const log = wrapped('git log -1');
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /Author: <owner> <<email>>/);
  // 2. A CODEOWNERS file.
  sandbox.write('CODEOWNERS', `* @${LOGIN}\n`);
  assert.equal(wrapped('cat CODEOWNERS').stdout, '* @<mark>\n');
  // 3. A push error with the private remote: the exit code is the command's.
  const push = wrapped(`echo "fatal: unable to access 'https://${HOST}/${LOGIN}/app.git/': Could not resolve host: ${HOST}" >&2; exit 128`);
  assert.equal(push.status, 128);
  assert.equal(push.stdout, "fatal: unable to access 'https://<host>/<mark>/app.git/': Could not resolve host: <host>\n");
  // 4. A deploy log with an email.
  assert.equal(wrapped(`echo "Deployed by ${EMAIL} to ${CITY.toLowerCase()}-worker"`).stdout, 'Deployed by <email> to <mark>-worker\n');
  // 5. A traffic report with the login in a path.
  assert.equal(wrapped(`echo '{"path":"/${LOGIN}/app/blob/main/README.md","count":3}'`).stdout, '{"path":"/<mark>/app/blob/main/README.md","count":3}\n');
  // 6. A page title.
  assert.equal(wrapped(`echo "${LOGIN}/app: Settings - ${OWNER} from ${CITY}"`).stdout, '<mark>/app: Settings - <owner> from <mark>\n');
  for (const result of [log, push]) assertHidden(result.stdout, [OWNER, LOGIN, CITY, HOST, EMAIL]);
});

test('redact: without a private-marks file, git name, email and private hosts are still hidden (#390)', () => {
  const { wrapped } = ownerSandbox({ marks: false });
  const log = wrapped('git log -1; git remote -v');
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /Author: <owner> <<email>>/);
  assert.match(log.stdout, /origin\tssh:\/\/git@<host>:2222\//);
  assertHidden(log.stdout, [OWNER, HOST, EMAIL]);
});

test('redact: keeps line ends, a last line with no end, and text that names nobody (#390)', () => {
  const { sandbox } = ownerSandbox();
  const input = `ok\r\nnoreply${at}github.com and logo${at}2x.png\nannual ${OWNER.toUpperCase()}\nlast`;
  const result = sandbox.run(['redact'], { input });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `ok\r\nnoreply${at}github.com and logo${at}2x.png\nannual <owner>\nlast`);
  // A long output streams through whole.
  const long = `${'line one\n'.repeat(50_000)}${OWNER}\n`;
  const streamed = sandbox.run(['redact'], { input: long });
  assert.equal(streamed.stdout, `${'line one\n'.repeat(50_000)}<owner>\n`);
  assert.deepEqual([sandbox.run(['redact', '--x']).status], [1]);
});

// #475: in this process, redact reads the output from the invocation's stdin as a stream,
// and writes what it hid to the invocation's stdout.
test('redact: in-process, the given stdin comes out hidden, a long one streamed whole (#475)', async () => {
  const { sandbox } = ownerSandbox();
  const run = (stdin: string) => invoke(['redact'], { env: sandbox.env, cwd: sandbox.repo, stdin });
  assert.deepEqual(await run(`by ${OWNER} at ${HOST}\nlast`), { code: 0, stdout: 'by <owner> at <host>\nlast', stderr: '' });
  const long = `${'line one\n'.repeat(50_000)}${EMAIL}\n`;
  assert.equal((await run(long)).stdout, `${'line one\n'.repeat(50_000)}<email>\n`);
  assert.deepEqual(await run(''), { code: 0, stdout: '', stderr: '' });
});

test('redact: fails open; a marks file it cannot read passes the output through, with one line (#390)', () => {
  const { sandbox, wrapped } = ownerSandbox();
  // A folder where the file should be: reading it fails.
  const broken = join(sandbox.home, 'marks-folder');
  mkdirSync(broken);
  const result = sandbox.run(['redact'], { input: `by ${OWNER}\n`, extra: { YOKOTEN_PRIVATE_MARKS: broken } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `by ${OWNER}\n`);
  assert.match(result.stderr, /^yokoten redact: output is not hidden, because [^\n]*\n$/);
  // In the wrapper, the command's own exit code still comes through.
  const pass = spawnSync('bash', ['-c', wrapForRedact('echo hi; exit 5', `node "${CLI}" redact`)], { cwd: sandbox.repo, env: { ...sandbox.env, YOKOTEN_PRIVATE_MARKS: broken }, encoding: 'utf8' });
  assert.deepEqual([pass.status, pass.stdout], [5, 'hi\n']);
  assert.equal(wrapped('true').status, 0);
});

test('redact: a long line is cut only at a space or tab, never inside a value (#390)', () => {
  assert.equal(cutPoint('a\nb', 10), 2);
  assert.equal(cutPoint('short', 10), 0);
  assert.equal(cutPoint('word word longvalue', 10), 10);
  assert.equal(cutPoint('x'.repeat(20), 10), 20, 'no space: the whole buffer goes, redacted as one');
  // Through the command: a value at the end of a long run with no line end is still hidden.
  const { sandbox } = ownerSandbox();
  // A one-word value: a value with a space in it may be cut at that space.
  const input = `${'y'.repeat((1 << 20) + 10)} ${LOGIN}`;
  const result = spawnSync('node', [CLI, 'redact'], { cwd: sandbox.repo, env: sandbox.env, input, encoding: 'utf8', maxBuffer: 8 << 20 });
  assert.ok(result.stdout === `${'y'.repeat((1 << 20) + 10)} <mark>`, `ends with: ${result.stdout.slice(-20)}`);
});

// #377: a repo without CI checks a pull request by its number, read through gh.
test('check --pr <number>: reads the pull request through gh and checks it with the commits here (#377)', () => {
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
  // A gh first on PATH that answers `pr view 12` only. `pr view 13` fails as gh does for
  // a number the repo does not have; every other call fails plainly.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const answer = (title: string, headSha: string, author: object = { login: 'octo' }, prBody = body) =>
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env node
if (process.argv[4] === '13') { console.error('GraphQL: Could not resolve to a PullRequest with the number of 13. (repository.pullRequest)'); process.exit(1); }
if (process.argv.slice(2, 4).join(' ') !== 'pr view' || process.argv[4] !== '12') process.exit(1);
console.log(${JSON.stringify(JSON.stringify({ title, body: prBody, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, author, baseRefOid: base, headRefOid: headSha }))});
`,
      { mode: 0o755 },
    );
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  answer('feat: a', head);
  let result = sandbox.run(['check', '--pr', '12'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten check --pr: ok$/m);
  // The control: a bad title fails, as in CI.
  answer('a', head);
  result = sandbox.run(['check', '--pr', '12', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).findings.some((f: { id: string }) => f.id === 'pr-title'), result.stdout);
  // gh names Dependabot `app/dependabot`; it counts as dependabot[bot], as in CI, so its body rules are notes.
  const dependabotBody = (author: object) => {
    // Dependabot writes its own body: no tier line, no sections.
    answer('ci: bump the actions group', head, author, 'Bumps the actions group.');
    const report = JSON.parse(sandbox.run(['check', '--pr', '12', '--json'], { extra }).stdout);
    return report.notes.some((f: { why: string }) => /Dependabot opened this pull request/.test(f.why));
  };
  assert.equal(dependabotBody({ login: 'app/dependabot', is_bot: true }), true);
  assert.equal(dependabotBody({ login: 'octo', is_bot: false }), false, 'the control: a person is held to every rule');
  // A head commit this clone has not fetched: the fix names what to fetch.
  answer('feat: a', 'f'.repeat(40));
  result = sandbox.run(['check', '--pr', '12'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the pull request's head commit is not in this checkout\. .+ Run `git fetch origin` and `git fetch origin pull\/12\/head`, then run it again\./);
  // gh can't read it: one finding, never a crash.
  result = sandbox.run(['check', '--pr', '13', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string; what: string }) => [f.id, f.what]), [['pr-read', 'no pull request 13 in octo/app']]);
  result = sandbox.run(['check', '--pr', '14', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).findings[0].what, /^pull request 14 can't be read: /, 'any other gh failure keeps its own reason');
  // A number goes with --pr only, and must be a number.
  result = sandbox.run(['check', '12'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a number goes with --pr/);
  result = sandbox.run(['check', '--pr', '--x'], { extra });
  assert.equal(result.status, 1);
  result = sandbox.run(['check', '--pr', 'main', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).findings[0].what, /"main" is not a pull request number/);
});
