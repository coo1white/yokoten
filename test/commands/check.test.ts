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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

// On run, not call: one real child keeps the check entry point (exit code and output through the binary) tested (#475).
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
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n';
  let result = sandbox.run(['check', '--pr'], { extra: event(body) });
  assert.equal(result.status, 1, 'src/a.ts changed with no changelog line');
  assert.match(result.stderr, /changelog: 1 changed file/);
  assert.match(result.stdout, /note: 1 long sentence\(s\)\n- README\.md:2: a sentence of 30 words/);
  result = sandbox.run(['check', '--pr'], { extra: event(body.replace('Made with worker', 'No changelog: a test\n\nMade with worker')) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --pr: ok/);
  assert.doesNotMatch(result.stdout, /lines, over 400/, 'a small diff gets no size note (#57)');
  // Outside a pull request run, there is nothing to check.
  result = sandbox.run(['check', '--pr']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no pull request in this run/);
});

test('check --pr: a change file counts as the changelog entry, and its form is checked (#132)', async () => {
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
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let result = await sandbox.call(['check', '--pr'], { extra: event(good) });
  assert.equal(result.status, 0, result.stderr);
  result = await sandbox.call(['check', '--pr'], { extra: event(bad) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- changes\/1-a\.md:1: line 1 is not a section\. .*Make line 1 one of: Added, Changed/);
  assert.doesNotMatch(result.stderr, /changelog: /, 'the file still counts as the entry');
});

test('check --pr: CODEOWNERS comes from the base branch, so a pull request cannot lower its own tier', async () => {
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
    const body = `tier: ${tier}\nCloses #1\nThis changes the kit.\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n`;
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: `tier ${tier}` }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = await sandbox.call(['check', '--pr'], { extra: event('B') });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /this changes 1 file\(s\) that CODEOWNERS owns \(read from the base branch\): kit\/a\.md/);
  r = await sandbox.call(['check', '--pr'], { extra: event('A') });
  assert.equal(r.status, 0, r.stderr);
});

test('check --pr: a large pull request gets a note, never a failure; lock files do not count (#57)', async () => {
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
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = await sandbox.call(['check', '--pr'], { extra: event(small) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /lines, over 400/, '300 lines; the lock file does not count');
  r = await sandbox.call(['check', '--pr'], { extra: event(large) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: this pull request changes 500 lines, over 400\. Smaller pull requests are easier to review/);
  assert.match(r.stdout, /check --pr: ok/);
});

test('check --issue: reads the issue from the CI event; a bad title fails, a good one passes', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['doctor', 'check'] }));
  const event = (issue: object) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ action: 'opened', issue }));
    return { GITHUB_EVENT_PATH: file };
  };
  let result = await sandbox.call(['check', '--issue'], { extra: event({ title: 'doctor: add the review step', labels: [{ name: 'feat' }] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --issue: ok/);
  result = await sandbox.call(['check', '--issue'], { extra: event({ title: 'The review step is missing.', labels: [{ name: 'incident' }] }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue: 2 problem\(s\)\n- title: it does not start with an area\. .+`area: symptom`.+\n  docs: \S+#issue-titles\n- title: a full stop at the end\./);
  assert.doesNotMatch(result.stderr, /The review step is missing/, 'the title is user input; it is not printed back');
  result = await sandbox.call(['check', '--issue'], { extra: event({ title: 'site: a page', labels: [] }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use one of: doctor, check\./);
  result = await sandbox.call(['check', '--issue', '--json'], { extra: event({ title: 'site: a page.', labels: [] }) });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.check, 'issue');
  assert.deepEqual(report.findings.map((f: { id: string }) => f.id), ['issue-area', 'issue-title']);
  assert.ok(!result.stdout.includes('a page'), 'the title is not printed back');
  result = await sandbox.call(['check', '--issue', '--pr']);
  assert.equal(result.status, 1, 'two modes are a usage error');
  assert.equal(result.stdout, '');
  // A comment on a pull request comes as an issue too; it is not an issue to check.
  result = await sandbox.call(['check', '--issue'], { extra: event({ title: 'Anything', pull_request: { url: 'x' } }) });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no issue in this run/);
  result = await sandbox.call(['check', '--issue']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no issue in this run/);
  result = await sandbox.call(['check', '--issue', '--json']);
  assert.deepEqual(JSON.parse(result.stdout).skipped, 'no issue in this run (it reads the CI event); nothing to check');
});

// #544: `check --issue` also checks the labels: one type label and one tier label,
// when the repo has those labels. A repo without a kind gets no line for it.
test('check --issue: an issue needs the type and tier labels its repo has (#544)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['doctor'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  // A gh first on PATH that answers `label list` from labels.json; every other call fails.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const labelsFile = join(sandbox.home, 'labels.json');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node\nconst fs = require("node:fs");\nif (process.argv.slice(2, 4).join(" ") === "label list") { process.stdout.write(fs.readFileSync(${JSON.stringify(labelsFile)}, "utf8")); process.exit(0); }\nprocess.exit(1);\n`,
    { mode: 0o755 },
  );
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  const setLabels = (names: string[]) => writeFileSync(labelsFile, JSON.stringify(names.map((name) => ({ name }))));
  const event = (labels: string[]) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ action: 'opened', issue: { title: 'doctor: add the review step', labels: labels.map((name) => ({ name })) } }));
    return { GITHUB_EVENT_PATH: file, ...extra };
  };
  setLabels(['feat', 'bug', 'docs', 'tier A', 'tier B', 'tier C']);
  // Both: none.
  let result = await sandbox.call(['check', '--issue'], { extra: event(['bug', 'tier B']) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --issue: ok/);
  // No type label: one line (the positive control).
  result = await sandbox.call(['check', '--issue'], { extra: event(['tier B']) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue: 1 problem\(s\)\n- labels: no type label\. .*Add one type label, such as feat, bug, docs\./);
  assert.match(result.stderr, /docs: \S+#issue-titles/);
  assert.doesNotMatch(result.stderr, /tier B.*no tier label/, 'the tier label it has is not named');
  // No tier label: one line (the positive control).
  result = await sandbox.call(['check', '--issue'], { extra: event(['bug']) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue: 1 problem\(s\)\n- labels: no tier label\. .*Add one tier label/);
  // Both missing: one line each.
  result = await sandbox.call(['check', '--issue'], { extra: event(['kit']) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue: 2 problem\(s\)/);
  // A repo without tier labels: no line for the tier.
  setLabels(['feat', 'bug', 'docs']);
  result = await sandbox.call(['check', '--issue'], { extra: event(['bug']) });
  assert.equal(result.status, 0, result.stderr);
  // A repo without type labels: no line for the type.
  setLabels(['tier A', 'tier B']);
  result = await sandbox.call(['check', '--issue'], { extra: event(['tier A']) });
  assert.equal(result.status, 0, result.stderr);
  // gh can't list the labels: only the title is checked.
  const bare = makeSandbox();
  bare.write('yokoten.json', JSON.stringify({ areas: ['doctor'] }));
  const bareEvent = join(bare.home, 'event.json');
  writeFileSync(bareEvent, JSON.stringify({ action: 'opened', issue: { title: 'doctor: add the review step', labels: [] } }));
  result = await bare.call(['check', '--issue'], { extra: { GITHUB_EVENT_PATH: bareEvent } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --issue: ok/);
});

// #91: in GitHub Actions, the findings show on the pull request page: an annotation per
// finding on stdout, and a job summary. The finding text is reused, so no private value.
test('check in GitHub Actions: annotations and a job summary, place but never content (#91)', async () => {
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
  const before = await sandbox.call(['check'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  const result = await sandbox.call(['check'], { extra: actions });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, before.stderr, 'the text for people is the same');
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^::error file=notes\/b\.md,line=2,title=yokoten email::an email address\. .+\. .+\.%0A  docs: https:\/\/\S+#privacy$/);
  assert.match(lines[1], /^::error file=notes\/b\.md,line=3,title=yokoten private-mark::matches a word you added to your private marks\. /);
  assert.match(lines[2], /^::error file=notes\/b\.md,line=4,title=yokoten secret::a secret \(GitHub token\)\. /);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check: 3 problems\n\n\| Place \| Rule \| What \| Why \| Fix \|\n/);
  assert.match(text, /\| notes\/b\.md:2 \| \[email\]\(https:\/\/\S+#privacy\) \| an email address \| .+ \| .+ \|/);
  assert.match(text, /\| notes\/b\.md:3 \| \[private-mark\]\(\S+\) \| matches a word you added to your private marks \|/);
  assert.match(text, /\| notes\/b\.md:4 \| \[secret\]\(\S+\) \| a secret \(GitHub token\) \|/);
  // The positive control: the place is there, the matched text is not (core rule 11).
  for (const out of [result.stdout, text]) {
    assert.ok(!out.includes(token) && !out.includes(email) && !/mycity/i.test(out), 'no matched text');
    assert.ok(!out.includes(sandbox.home), 'the home folder is never shown');
  }
  // --json keeps stdout pure JSON; the summary is still written. The summary file grows.
  const json = await sandbox.call(['check', '--json'], { extra: actions });
  assert.equal(JSON.parse(json.stdout).ok, false);
  assert.equal(readFileSync(summary, 'utf8').split('### yokoten check: 3 problems').length, 3, 'appended, not replaced');
  // ok, with the mode in the heading.
  sandbox.git('rm', '-q', '--cached', 'notes/b.md');
  rmSync(join(sandbox.repo, 'notes'), { recursive: true });
  const ok = await sandbox.call(['check', '--staged'], { extra: actions });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'yokoten check: ok\n', 'no findings, no annotations');
  assert.match(readFileSync(summary, 'utf8'), /### yokoten check --staged: ok\n\n$/);
});

test('check outside GitHub Actions: the output is unchanged and no summary is written (#91)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', `me${at}gmail.com\n`);
  sandbox.git('add', '.');
  const summary = join(sandbox.home, 'summary.md');
  const plain = await sandbox.call(['check']);
  assert.equal(plain.status, 1);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /^yokoten check: 1 problem\(s\)\n- a\.md:1: an email address\. [^\n]+\.\n  docs: https:\/\/\S+#privacy\n$/);
  for (const extra of [{ GITHUB_STEP_SUMMARY: summary }, { GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: summary }] as Record<string, string>[]) {
    const r = await sandbox.call(['check'], { extra });
    assert.deepEqual([r.status, r.stdout, r.stderr], [plain.status, plain.stdout, plain.stderr], JSON.stringify(extra));
  }
  assert.ok(!existsSync(summary), 'no summary outside Actions');
});

test('check --pr: notes hard-to-read names on added code lines, and the exit code does not change (#111)', async () => {
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
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
  const r = await project.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: 2 hard-to-read name\(s\)\n- src\/cart\.js:1: "s" is used for 14 lines\. A reader must scroll back to learn what it holds\. Name what it is, e\.g\. "text"\.\n  docs: \S+#naming\n- src\/cart\.js:2: "loadTheWholeUserList" has 5 words, over 4\. /);
  assert.doesNotMatch(r.stdout, /"i"|old\.ts|renamed\.ts/, 'no note for `i` in a short loop, for unchanged lines, or for a moved file');
  assert.match(r.stdout, /check --pr: ok/);
  const json = JSON.parse((await project.call(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } })).stdout);
  assert.equal(json.ok, true, 'notes never fail the check');
  assert.deepEqual(json.notes.map((note: { id: string; file: string; line: number }) => `${note.id} ${note.file}:${note.line}`), ['name-short src/cart.js:1', 'name-long src/cart.js:2']);
});

test('check --pr in GitHub Actions: notes are warnings, in their own section (#91)', async () => {
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
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n', labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: null, base: { sha: base }, head: { sha: head } } }));
  const summary = join(sandbox.home, 'summary.md');
  const r = await sandbox.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.status, 1, 'no milestone');
  assert.match(r.stdout, /^::error title=yokoten pr-milestone::/m, 'a finding with no place has no file');
  assert.match(r.stdout, /^::warning file=README\.md,line=2,title=yokoten long-sentence::a sentence of 30 words\. /m);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check --pr: 1 problem\n/);
  assert.match(text, /\n#### Notes \(1\): these never fail the check\n\n\| Place \| Rule \| What \| Why \| Fix \|\n\|[-|]+\|\n\| README\.md:2 \| long-sentence \| a sentence of 30 words \|/);
});

// #299: Dependabot writes its own body, so its pull request gets the title check and the
// body rules as notes, in text, JSON and the job summary.
test('check --pr: a Dependabot pull request passes with notes; the same body from anyone else fails (#299)', async () => {
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
  let result = await sandbox.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]') } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --pr: note: 9 pull request rule\(s\) Dependabot does not meet\n- body: the first line is not a tier\. .*Dependabot opened this pull request, so it is a note\./);
  assert.match(result.stdout, /\n- milestone: none set\./);
  assert.match(result.stdout, /check --pr: ok\n$/);
  result = await sandbox.call(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]'), GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual([report.ok, report.findings, report.notes.map((note: { id: string }) => note.id)], [true, [], ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-made-with', 'pr-milestone', 'pr-labels', 'pr-labels']]);
  assert.match(readFileSync(summary, 'utf8'), /#### Notes \(9\): these never fail the check\n[^]*\| \[pr-tier\]\(\S+\) \| body: the first line is not a tier \|/);

  // The same body from anyone else fails as before.
  result = await sandbox.call(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event('someone') } });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-made-with', 'pr-milestone', 'pr-labels', 'pr-labels']);
  // A bad title from Dependabot still fails.
  result = await sandbox.call(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]', 'Bump the actions group with 1 update') } });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['pr-title']);
});

// #645: GitHub can start the runs of one pull request in any order, and each event file
// keeps the labels of its own moment. When the workflow asks (YOKOTEN_PR_LIVE), every run
// reads the pull request as it is now, so a late run for `opened` judges the labels added
// since, and a rerun judges it again. A draft is judged in full, like any pull request.
test('check --pr with YOKOTEN_PR_LIVE: judges the pull request as it is now, a draft in full; a failed read fails (#645)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('README.md', 'Short.\nMore.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
  // The event of `opened`: no labels and no milestone yet, as the bot opens it.
  const file = join(sandbox.home, 'event.json');
  writeFileSync(file, JSON.stringify({ number: 7, repository: { full_name: 'octo/app' }, pull_request: { number: 7, title: 'feat: a', body, labels: [], milestone: null, draft: false, base: { sha: base }, head: { sha: head } } }));
  const token = 'ghs_never_printed_645';
  let now: Record<string, unknown> = { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, draft: false, user: { login: 'someone' } };
  let status = 200;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${token}` ? 'token' : 'no token'}`);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(status === 200 ? now : { message: 'nope' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const summary = join(sandbox.home, 'summary.md');
  const ci = { GITHUB_EVENT_PATH: file, YOKOTEN_PR_LIVE: '1', GITHUB_TOKEN: token, YOKOTEN_GITHUB_API: api, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary };
  const outputs: string[] = [];
  const call = async (args: string[], extra: Record<string, string> = ci) => {
    const result = await sandbox.call(args, { extra });
    outputs.push(result.stdout, result.stderr);
    return result;
  };
  const ids = (stdout: string) => JSON.parse(stdout).findings.map((f: { id: string }) => f.id);
  try {
    // Without YOKOTEN_PR_LIVE, a token alone changes nothing: the event file is read, and
    // it has no labels and no milestone, so it fails. No request is made.
    let result = await call(['check', '--pr', '--json'], { GITHUB_EVENT_PATH: file, GITHUB_TOKEN: token, YOKOTEN_GITHUB_API: api });
    assert.equal(result.status, 1);
    assert.deepEqual(ids(result.stdout).sort(), ['pr-labels', 'pr-labels', 'pr-milestone']);
    assert.deepEqual(requests, [], 'no opt-in, no read');

    // With it, the labels and milestone the pull request has now win over the event's.
    result = await call(['check', '--pr']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /check --pr: ok\n$/);
    assert.deepEqual(requests, ['GET /repos/octo/app/pulls/7 token']);

    // A label taken off since: the same old event file now fails, as a rerun would.
    now = { ...now, labels: [{ name: 'feat' }] };
    result = await call(['check', '--pr', '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(ids(result.stdout), ['pr-labels']);

    // A draft is judged in full: missing a label it fails, with its labels it passes.
    now = { ...now, draft: true };
    result = await call(['check', '--pr', '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(ids(result.stdout), ['pr-labels']);
    now = { ...now, labels: [{ name: 'feat' }, { name: 'tier B' }] };
    result = await call(['check', '--pr']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /check --pr: ok\n$/);

    // A read that fails fails the check; the old event file is never the answer.
    status = 403;
    result = await call(['check', '--pr', '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string; what: string }) => [f.id, f.what]), [['pr-current', "pull request 7 can't be read as it is now: GitHub answered 403"]]);
    assert.match(readFileSync(summary, 'utf8'), /\| \[pr-current\]\(\S+\) \| pull request 7 can't be read as it is now: GitHub answered 403 \|/);
    // Asked for, with no token: it fails too, and asks for the token.
    status = 200;
    requests.length = 0;
    result = await call(['check', '--pr'], { ...ci, GITHUB_TOKEN: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /- GITHUB_TOKEN is not set, so the pull request as it is now can't be read\. .+GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.deepEqual(requests, []);
  } finally {
    server.close();
  }
  // The token is never printed: not in the output, not in the job summary.
  for (const text of [...outputs, readFileSync(summary, 'utf8')]) assert.ok(!text.includes(token), 'the token was printed');
  assert.ok(!outputs.join('').includes('127.0.0.1'), 'the API address is not printed');
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

test('redact: the six slips come out as placeholders (#390)', async () => {
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

test('redact: without a private-marks file, git name, email and private hosts are still hidden (#390)', async () => {
  const { wrapped } = ownerSandbox({ marks: false });
  const log = wrapped('git log -1; git remote -v');
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /Author: <owner> <<email>>/);
  assert.match(log.stdout, /origin\tssh:\/\/git@<host>:2222\//);
  assertHidden(log.stdout, [OWNER, HOST, EMAIL]);
});

// On run, not call: one real child keeps the redact entry point (exit code and output through the binary) tested (#475).
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

test('redact: fails open; a marks file it cannot read passes the output through, with one line (#390)', async () => {
  const { sandbox, wrapped } = ownerSandbox();
  // A folder where the file should be: reading it fails.
  const broken = join(sandbox.home, 'marks-folder');
  mkdirSync(broken);
  const result = await sandbox.call(['redact'], { input: `by ${OWNER}\n`, extra: { YOKOTEN_PRIVATE_MARKS: broken } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `by ${OWNER}\n`);
  assert.match(result.stderr, /^yokoten redact: output is not hidden, because [^\n]*\n$/);
  // In the wrapper, the command's own exit code still comes through.
  const pass = spawnSync('bash', ['-c', wrapForRedact('echo hi; exit 5', `node "${CLI}" redact`)], { cwd: sandbox.repo, env: { ...sandbox.env, YOKOTEN_PRIVATE_MARKS: broken }, encoding: 'utf8' });
  assert.deepEqual([pass.status, pass.stdout], [5, 'hi\n']);
  assert.equal(wrapped('true').status, 0);
});

test('redact: a long line is cut only at a space or tab, never inside a value (#390)', async () => {
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
test('check --pr <number>: reads the pull request through gh and checks it with the commits here (#377)', async () => {
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
  let result = await sandbox.call(['check', '--pr', '12'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten check --pr: ok$/m);
  // The control: a bad title fails, as in CI.
  answer('a', head);
  result = await sandbox.call(['check', '--pr', '12', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).findings.some((f: { id: string }) => f.id === 'pr-title'), result.stdout);
  // gh names Dependabot `app/dependabot`; it counts as dependabot[bot], as in CI, so its body rules are notes.
  const dependabotBody = async (author: object) => {
    // Dependabot writes its own body: no tier line, no sections.
    answer('ci: bump the actions group', head, author, 'Bumps the actions group.');
    const report = JSON.parse((await sandbox.call(['check', '--pr', '12', '--json'], { extra })).stdout);
    return report.notes.some((f: { why: string }) => /Dependabot opened this pull request/.test(f.why));
  };
  assert.equal(await dependabotBody({ login: 'app/dependabot', is_bot: true }), true);
  assert.equal(await dependabotBody({ login: 'octo', is_bot: false }), false, 'the control: a person is held to every rule');
  // A head commit this clone has not fetched: the fix names what to fetch.
  answer('feat: a', 'f'.repeat(40));
  result = await sandbox.call(['check', '--pr', '12'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the pull request's head commit is not in this checkout\. .+ Run `git fetch origin` and `git fetch origin pull\/12\/head`, then run it again\./);
  // gh can't read it: one finding, never a crash.
  result = await sandbox.call(['check', '--pr', '13', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string; what: string }) => [f.id, f.what]), [['pr-read', 'no pull request 13 in octo/app']]);
  result = await sandbox.call(['check', '--pr', '14', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).findings[0].what, /^pull request 14 can't be read: /, 'any other gh failure keeps its own reason');
  // A number goes with --pr only, and must be a number.
  result = await sandbox.call(['check', '12'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a number goes with --pr/);
  result = await sandbox.call(['check', '--pr', '--x'], { extra });
  assert.equal(result.status, 1);
  result = await sandbox.call(['check', '--pr', 'main', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).findings[0].what, /"main" is not a pull request number/);
});

// ---- yokoten marks: add, remove, off, on (#434) ----

// Samples are built from pieces, so this file passes its own privacy check.
const NAME = ['Ann', 'Sample'].join(' ');
const HAND_MARK = ['quiet', 'harbor'].join('');
const OTHER = ['far', 'meadow'].join('');
const VALUES = /ann|sample|quietharbor|farmeadow/i;

/** A sandbox with a git name, its marks file path, and a call that keeps every output to check for values. */
function marksSandbox() {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.name', NAME);
  const file = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  const said: string[] = [];
  const call = async (args: string[], input?: string) => {
    const result = await sandbox.call(args, { input });
    said.push(result.stdout, result.stderr);
    return result;
  };
  const marks = () => readFileSync(file, 'utf8');
  return { sandbox, file, said, call, marks };
}

test('marks add, marks and marks remove: one value from stdin, never in stdout or stderr (#434)', async () => {
  const { said, call, marks } = marksSandbox();
  // Not a terminal: the mark is read from stdin, and the file is made.
  const added = await call(['marks', 'add'], `${HAND_MARK}\n`);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.stdout, 'yokoten marks: added the mark to your private marks (not shown)\n');
  assert.ok(marks().endsWith(`\n${HAND_MARK}\n`));
  const again = await call(['marks', 'add'], HAND_MARK.toUpperCase());
  assert.match(again.stdout, /already in your private marks, so nothing changed/);
  // The counts by kind, never a value.
  const counts = await call(['marks']);
  assert.equal(counts.status, 0, counts.stderr);
  assert.match(counts.stdout, /^yokoten marks: 1 in ~\/\.config\/yokoten\/private-marks \(the values are never shown\)$/m);
  assert.match(counts.stdout, /^ {2}by hand: +1$/m);
  assert.match(counts.stdout, /^ {2}git name: +0$/m);
  // A mark is never a word on the command line, and is not repeated when it is.
  const worded = await call(['marks', 'add', OTHER]);
  assert.equal(worded.status, 1);
  assert.match(worded.stderr, /never a word on the command line/);
  // Nothing, two lines, or a comment: refused, nothing changed.
  const before = marks();
  for (const input of ['', `${HAND_MARK}\n${OTHER}\n`, `# ${OTHER}`]) assert.equal((await call(['marks', 'add'], input)).status, 1);
  assert.equal(marks(), before);
  // Remove: the same way in, and gone from the file.
  const removed = await call(['marks', 'remove'], `${HAND_MARK}\n`);
  assert.equal(removed.stdout, 'yokoten marks: removed the mark from your private marks\n');
  assert.ok(!marks().includes(HAND_MARK));
  assert.match((await call(['marks', 'remove'], HAND_MARK)).stdout, /not in your private marks, so nothing changed/);
  assert.ok(!said.some((text) => VALUES.test(text)), 'no output holds a mark');
});

test('marks add: a mark after one yokoten added goes under a header of its own, so it counts as the owner\'s (#434)', async () => {
  const { file, call, marks } = marksSandbox();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `# added by yokoten from this machine: git email\nann${'@'}sample-mail.dev\n`, { mode: 0o600 });
  assert.equal((await call(['marks', 'add'], OTHER)).status, 0);
  assert.equal(marks(), `# added by yokoten from this machine: git email\nann${'@'}sample-mail.dev\n# your own marks\n${OTHER}\n`);
  assert.match((await call(['marks'])).stdout, /^ {2}git email: +1\n(?:.*\n)* {2}by hand: +1$/m);
});

test('marks off git-name: removed, install no longer adds it, hand-added marks untouched; marks on git-name adds it back (#434)', async () => {
  const { sandbox, said, call, marks } = marksSandbox();
  assert.equal((await call(['install'])).status, 0);
  // A mark the owner added by hand, and the same name written by hand too.
  assert.equal((await call(['marks', 'add'], HAND_MARK)).status, 0);
  writeFileSync(join(sandbox.home, '.config', 'yokoten', 'private-marks'), `${marks()}# mine\n${OTHER}\n`);
  assert.match(marks(), new RegExp(`# added by yokoten from this machine: git name\\n${NAME}\\n`));
  const off = await call(['marks', 'off', 'git-name']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(
    off.stdout,
    'yokoten marks: install no longer adds your git name, and removed the 1 mark(s) it had added for it. Marks you added yourself are kept.\nTo go back to the default: yokoten marks on git-name\n',
  );
  assert.ok(!marks().includes(NAME) && !marks().includes('from this machine: git name'), 'the git name and its header are gone');
  assert.ok(marks().includes(`\n${HAND_MARK}\n`) && marks().includes(`\n${OTHER}\n`), 'hand-added marks are kept');
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.home, '.config', 'yokoten', 'machine.json'), 'utf8')).marksOff, ['git name']);
  // install respects it, and `yokoten marks` says the kind is off.
  const install = await call(['install']);
  assert.doesNotMatch(install.stdout, /added your git name/);
  assert.ok(!marks().includes(NAME));
  assert.match((await call(['marks'])).stdout, /^ {2}git name: +0 {2}off: install does not add it; `yokoten marks on git-name` adds it again$/m);
  // Back to the default: the name is added again, with no value shown.
  const on = await call(['marks', 'on', 'git-name']);
  assert.equal(on.stdout, 'yokoten marks: install adds your git name again, and it is in your private marks now (not shown)\n');
  assert.match(marks(), new RegExp(`# added by yokoten from this machine: git name\\n${NAME}\\n$`));
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.home, '.config', 'yokoten', 'machine.json'), 'utf8')).marksOff, []);
  assert.ok(marks().includes(`\n${HAND_MARK}\n`) && marks().includes(`\n${OTHER}\n`), 'still kept');
  assert.ok(!said.some((text) => VALUES.test(text)), 'no output holds a mark');
});

test('marks: an unknown kind or action is refused without repeating the word; allow keeps its own options (#434)', async () => {
  const { said, call } = marksSandbox();
  const kind = await call(['marks', 'off', HAND_MARK]);
  assert.equal(kind.status, 1);
  assert.match(kind.stderr, /name the kind: git-name, git-email, forge-login/);
  const action = await call(['marks', HAND_MARK]);
  assert.equal(action.status, 1);
  assert.match(action.stderr, /the action is add, remove, off, on or allow/);
  assert.match((await call(['marks', 'add', '--here'], HAND_MARK)).stderr, /--here and --remove go with allow only/);
  assert.ok(!said.some((text) => VALUES.test(text)), 'no output holds a mark');
});

// #523: a stopped line names the kind of mark from the marks file's headers, in text and
// --json, and the value is never printed.
test('check: a stopped line names the kind of private mark, never the mark (#523)', async () => {
  const sandbox = makeSandbox();
  const name = ['Rue', 'Sample'].join(' ');
  const email = `ruex${at}personal-mail.dev`;
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  mkdirSync(join(sandbox.home, '.config', 'yokoten'), { recursive: true });
  const header = (kind: string) => `# added by yokoten from this machine: ${kind}`;
  writeFileSync(marks, [header('git name'), name, header('git email'), email, header('forge login'), 'octo-ruex', header('private remote host'), 'build.rue-host.dev', '# my own', 'quietvale', ''].join('\n'));
  sandbox.write('notes.md', [`by ${name}`, `mail ${email}`, 'ask @octo-ruex', 'see build.rue-host.dev', 'from QuietVale', ''].join('\n'));
  sandbox.git('add', '.');
  const text = await sandbox.call(['check']);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /notes\.md:1: matches your git name \(a private mark yokoten added by itself\)/);
  assert.match(text.stderr, /notes\.md:2: matches your git email \(a private mark yokoten added by itself\)/);
  assert.match(text.stderr, /notes\.md:3: matches your forge login \(a private mark yokoten added by itself\)/);
  assert.match(text.stderr, /notes\.md:4: matches the name of a private server in your git remotes/);
  assert.match(text.stderr, /notes\.md:5: matches a word you added to your private marks/);
  assert.match(text.stderr, /`yokoten marks off git-name`/);
  const json = await sandbox.call(['check', '--json']);
  const stopped = (JSON.parse(json.stdout).findings as { id: string; line: number; what: string }[]).filter((found) => found.id === 'private-mark').map((found) => [found.line, found.what]);
  assert.equal(stopped.length, 5, json.stdout);
  assert.match(stopped[0][1] as string, /your git name/);
  const said = (text.stdout + text.stderr + json.stdout + json.stderr).toLowerCase();
  for (const part of ['sample', 'personal-mail', 'octo-ruex', 'rue-host', 'quietvale']) assert.ok(!said.includes(part), `check printed ${part.length} letters of a mark`);
});
