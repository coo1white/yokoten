// Tests for src/commands/learn.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  CLI,
  makeSandbox,
} from '../repo/helpers.ts';

test('changelog: previews the change files, and --write moves them into CHANGELOG.md (#132)', () => {
  const sandbox = makeSandbox();
  let result = sandbox.run(['changelog']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no change files in changes\//);
  sandbox.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-18\n\n### Added\n\n- The first release.\n');
  sandbox.write('changes/README.md', '# Change files\n');
  sandbox.write('changes/2-b.md', 'Fixed\n\nA fix.\n');
  sandbox.write('changes/1-a.md', 'Added\n\nA thing.\n');
  result = sandbox.run(['changelog']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 change\(s\); `--write` adds these under \[Unreleased\] in CHANGELOG\.md:\n\n### Added\n\n- A thing\.\n\n### Fixed\n\n- A fix\.\n$/);
  assert.ok(existsSync(join(sandbox.repo, 'changes/1-a.md')), 'a preview writes nothing');
  // A bad file stops the write, and says so on stderr.
  sandbox.write('changes/3-c.md', 'Added\n');
  result = sandbox.run(['changelog', '--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 problem\(s\); nothing was written:\n- changes\/3-c\.md:1: no entry after the section/);
  rmSync(join(sandbox.repo, 'changes/3-c.md'));
  result = sandbox.run(['changelog', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote 2 change\(s\) under \[Unreleased\] in CHANGELOG\.md, and deleted:\n- changes\/1-a\.md\n- changes\/2-b\.md/);
  assert.equal(readFileSync(join(sandbox.repo, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n### Fixed\n\n- A fix.\n\n## [0.1.0] - 2026-10-18\n\n### Added\n\n- The first release.\n');
  assert.deepEqual(readdirSync(join(sandbox.repo, 'changes')), ['README.md']);
  assert.equal(sandbox.run(['changelog', '--wrote']).status, 1, 'an unknown option is refused');
});

// #77: `learn` turns an incident issue into a check draft. A fake gh first on PATH gives the
// issue; the real gh and GitHub are never reached.
test('learn: previews a check draft from an incident, writes it with --write, and never overwrites', () => {
  const sandbox = makeSandbox();
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const issue = { number: 7, title: 'repo: a test fails behind a proxy', body: '## What happened\n\nA test failed.\n\n## Fix\n\nThe test sets NO_PROXY.\n', url: 'https://example.com/issues/7', labels: [{ name: 'incident' }] };
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nif (process.argv[4] !== '7') { console.error('no such issue'); process.exit(1); }\nconsole.log(${JSON.stringify(JSON.stringify(issue))});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  let result = sandbox.run(['learn', '7'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten learn: a check draft from issue #7, "repo: a test fails behind a proxy"\.\nThe issue left 1 field\(s\) open, each a TODO\(reviewer\):\n- why: the issue has no "Why it matters" section\nThe reviewer also writes the check \(findProblems\) and the cases in its test, each a TODO\(reviewer\) too\.\n/);
  assert.match(result.stdout, /\n--- lessons\/incident-7\/lesson\.ts\n[^]*fix: 'the test sets NO_PROXY',[^]*\n--- lessons\/incident-7\/lesson\.test\.ts\n/);
  assert.match(result.stdout, /Nothing was written\. `yokoten learn 7 --write` adds these files for review\.\n$/);
  assert.ok(!existsSync(join(sandbox.repo, 'lessons')), 'a preview writes nothing');
  result = sandbox.run(['learn', '7', '--write'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote:\n- lessons\/incident-7\/lesson\.ts\n- lessons\/incident-7\/lesson\.test\.ts\nReview the draft/);
  assert.ok(!/--- lessons/.test(result.stdout), '--write lists the files, not their text');
  assert.match(readFileSync(join(sandbox.repo, 'lessons/incident-7/lesson.ts'), 'utf8'), /id: 'incident-7',/);
  result = sandbox.run(['learn', '7', '--write'], { extra });
  assert.match(result.stdout, /Kept, already there:\n- lessons\/incident-7\/lesson\.ts\n/);
  result = sandbox.run(['learn', '8'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten learn: gh can't read issue 8 \(no such issue\)/);
  result = sandbox.run(['learn'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /name an incident issue/);
});

// #147, the whole loop: an incident becomes a lesson in a copy of yokoten, a person writes the
// check, the lesson ships in the kit, and doctor in another project shows it as a note. A
// fake gh gives the issue; nothing reaches the network.
test('lessons: learn, write the check, ship, then doctor in a second repo shows the note', () => {
  const sandbox = makeSandbox();
  // The first repo: a copy of yokoten, where the kit lives.
  const yokoten = join(sandbox.home, 'yokoten');
  for (const part of ['bin', 'src', 'kit', 'package.json']) cpSync(join(dirname(CLI), '..', part), join(yokoten, part), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: yokoten });
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const issue = { number: 9, title: 'repo: a .env file was committed', body: '## What happened\n\nA .env file reached main.\n\n## Why it matters\n\nA .env file can hold a secret.\n\n## Fix\n\nRemove it, and add it to .gitignore.\n', url: 'https://example.com/issues/9', labels: [{ name: 'incident' }] };
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(issue))});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const cli = join(yokoten, 'bin', 'yokoten.ts');
  const runCopy = (args: string[], cwd: string, extra: Record<string, string> = {}) => spawnSync('node', [cli, ...args], { cwd, env: { ...sandbox.env, PATH: `${bin}:${process.env.PATH}`, ...extra }, encoding: 'utf8' });

  // The second repo uses yokoten from before the lesson: its .yokoten/ copy has no incident-9.
  const vendored = (args: string[]) => spawnSync('node', [join(sandbox.repo, '.yokoten', 'bin', 'yokoten.ts'), ...args], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(runCopy(['init'], sandbox.repo).status, 0);

  let result = runCopy(['learn', '9', '--write'], yokoten);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /The issue answers every field\./);
  // Not reviewed yet: shipping is refused.
  result = runCopy(['learn', '--ship', 'incident-9'], yokoten);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten learn --ship: 2 problem\(s\); nothing was moved:\n- lessons\/incident-9\/lesson\.ts still has 1 TODO\(reviewer\)/);
  // The reviewer writes the check and its positive control.
  const lessonFile = join(yokoten, 'lessons/incident-9/lesson.ts');
  writeFileSync(lessonFile, readFileSync(lessonFile, 'utf8')
    .replace('/** The shape', "import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\n\n/** The shape")
    .replace(/ {2}\/\/ TODO\(reviewer\)[^\n]*\n {2}void root;\n {2}return \[\];/, "  return existsSync(join(root, '.env')) ? [{ ...lesson, what: '.env is in the repo' }] : [];"));
  const testFile = join(yokoten, 'lessons/incident-9/lesson.test.ts');
  writeFileSync(testFile, readFileSync(testFile, 'utf8')
    .replace(/ {2}\/\/ TODO\(reviewer\): replace with files that show the incident\.\n {2}const knownBad = makeRepo\(\{ 'TODO\(reviewer\)': '' \}\);/, "  const knownBad = makeRepo({ '.env': 'KEY=1' });")
    .replace(/ {2}\/\/ TODO\(reviewer\): replace with files where all is well\.\n/, ''));
  result = runCopy(['learn', '--ship', 'incident-9'], yokoten);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten learn --ship: incident-9 is in kit\/lessons\/1\/incident-9\/, with a row in kit\/lessons\/README\.md \(from https:\/\/example\.com\/issues\/9, yokoten \d+\.\d+\.\d+\)\./);

  // The message says how other projects get the lesson, not only "after it merges" (#77).
  assert.match(result.stdout, /\nCommit it in a pull request\. Other projects get it from the yokoten that runs their doctor:\n- now: [^\n]*\n- this machine: run install from this copy[^\n]*\n- a project's \.yokoten\/: run init again from this copy, then commit \.yokoten\/\n- everyone else: the next yokoten release\n$/);

  // The second repo: a project with the problem. Doctor shows the note, and it fails nothing.
  sandbox.write('.env', 'KEY=1\n');
  // The project's own .yokoten/ copy is from before the ship: it has no incident-9 until init runs again (#77).
  assert.ok(!/lesson incident-9/.test(vendored(['doctor']).stdout), 'the old copy has no incident-9');
  assert.equal(runCopy(['init'], sandbox.repo).status, 0);
  assert.match(vendored(['doctor']).stdout, /\n {2}note {4}new lesson: incident-9 [^\n]*\n {2}note {4}lesson incident-9: \.env is in the repo; /);
  result = runCopy(['doctor'], sandbox.repo);
  assert.match(result.stdout, /\n {2}note {4}lesson incident-9: \.env is in the repo; remove it, and add it to \.gitignore\n/);
  const report = JSON.parse(runCopy(['doctor', '--json'], sandbox.repo).stdout);
  assert.deepEqual(report.lessons.find((lesson: { id: string }) => lesson.id === 'incident-9'), { id: 'incident-9', mark: 'note' });
  assert.ok(report.notes.some((note: { id: string }) => note.id === 'incident-9') && !report.findings.some((f: { id: string }) => f.id === 'incident-9'), 'a note, never a finding');
  // Not now, with the reason.
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { 'incident-9': 'a sample file, no secret in it' } }));
  result = runCopy(['doctor'], sandbox.repo);
  assert.match(result.stdout, /\n {2}not now lesson incident-9: a sample file, no secret in it\n/);
});

// #392: `learn --upstream` from a project, run as a person would. The note names neither
// the project nor the home folder; a token is refused; --list and --done read the inbox.
test('learn --upstream: keeps a note with the project hidden, refuses a token, and lists and removes notes', () => {
  const sandbox = makeSandbox();
  const project = join(sandbox.home, 'work', 'acme-app');
  mkdirSync(project, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: project, env: sandbox.env });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: '@octo/acme-app' }));
  const run = (args: string[]) => sandbox.run(['learn', '--upstream', ...args], { cwd: project });
  const inbox = join(sandbox.home, '.config', 'yokoten', 'upstream');
  // An empty home: nothing waits, and the inbox is made on the first note.
  let result = run(['--list']);
  assert.deepEqual([result.status, result.stdout], [0, 'yokoten learn --upstream: no lessons wait; the inbox is empty.\n']);
  result = run([`In ${project}/src/a.ts the hook for acme-app missed a case; log in ${join(sandbox.home, 'log.txt')}`, '--area', 'hook', '--fix', 'match acme-app flags too']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten learn --upstream: kept note (\d{8}-\d{6}-[0-9a-f]{4}) in ~\/\.config\/yokoten\/upstream, outside every repo\. It reads:\n  In <project>\/src\/a\.ts the hook for <project> missed a case; log in ~\/log\.txt\n  fix idea: match <project> flags too\n/);
  const [file] = readdirSync(inbox);
  const id = file.replace(/\.md$/, '');
  const text = readFileSync(join(inbox, file), 'utf8');
  assert.match(text, /^when: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\npart: hook\nwhat: In <project>\/src\/a\.ts the hook for <project> missed a case; log in ~\/log\.txt\nfix: match <project> flags too\n$/);
  assert.ok(!text.includes('acme') && !text.includes(sandbox.home), 'neither the name nor the path is kept');
  // A token: refused by kind, the value never printed, nothing written.
  const token = `ghp_${'b'.repeat(36)}`;
  result = run([`the guard printed ${token}`]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'yokoten learn --upstream: the note was not kept, because it holds a secret (GitHub token). Say what happened without it, and try again.\n');
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
  assert.equal(readdirSync(inbox).length, 1);
  // --area takes a known area; a note needs words.
  assert.match(run(['x', '--area', 'nope']).stderr, /--area is one of: doctor, check, hook/);
  assert.match(run([]).stderr, /say what happened, in a few words/);
  assert.match(sandbox.run(['learn', '--list'], { cwd: project }).stderr, /--list goes with --upstream/);
  result = run(['--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^yokoten learn --upstream: 1 lesson waits to become an issue in the yokoten repo:\\n- ${id} \\(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC, part: hook\\): In <project>/src/a\\.ts [^\\n]*\\n  fix idea: match <project> flags too\\nOpen an issue for each, then remove its note: yokoten learn --upstream --done <id>\\n$`));
  result = run(['--done', id]);
  assert.deepEqual([result.status, result.stdout], [0, `yokoten learn --upstream: removed note ${id}.\n`]);
  result = run(['--done', id]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /there is no note/);
  assert.deepEqual(readdirSync(inbox), []);
});
