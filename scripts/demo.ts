// The yokoten loop in about a second (#174): one incident becomes a check that every project
// gets. Run it: node scripts/demo.ts [--keep]
//
// It works in a temp folder and leaves nothing behind (`--keep` keeps the folder and prints
// where it is). It runs offline: a fake `gh` gives the incident issue.
//
//   yokoten/    a copy of this yokoten, with no lessons yet: the real kit here is never touched
//   project-b/  another project, with a test that has the same mistake
//
// The steps: `learn` previews a check draft from project A's incident, `--write` adds it,
// `--ship` refuses it while TODOs are left, a reviewer writes the check, `--ship` puts it in
// the kit, and `doctor` in project B shows the note.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = fileURLToPath(new URL('..', import.meta.url));
const COPIED_PARTS = ['bin', 'src', 'kit', 'package.json'];
const INCIDENT_URL = 'https://github.com/octo-org/project-a/issues/12';
const LESSON_ID = 'incident-12';
const LESSON_DIR = `lessons/${LESSON_ID}`;

// Project A's incident, as `gh issue view --json` gives it. The shape follows a real one
// (yokoten issue #138), with neutral text.
const INCIDENT = {
  number: 12,
  title: 'repo: a test fails when the shell uses a proxy',
  url: INCIDENT_URL,
  labels: [{ name: 'incident' }],
  body: [
    '## What happened',
    '',
    '`npm test` failed twice with one test, then passed on a rerun with nothing changed. The shell had `NODE_USE_ENV_PROXY=1` set. With that, Node sends even a call to 127.0.0.1 through the proxy, which closes it.',
    '',
    '## Why it matters',
    '',
    'A test that fails only on some machines costs a rerun each time, and teaches people to ignore a red test',
    '',
    '## Fix',
    '',
    'The test sets `NO_PROXY` and `no_proxy` to `127.0.0.1,localhost` while it runs, then puts them back.',
    '',
    '## Lesson',
    '',
    'A test that passes on a rerun is not random: find what was different, and reproduce it before fixing.',
    '',
  ].join('\n'),
};

// The fake gh: it knows one issue, and fails on every other call.
const FAKE_GH = [
  '#!/usr/bin/env node',
  `const issue = ${JSON.stringify(INCIDENT)};`,
  "const [command, action, reference] = process.argv.slice(2);",
  `if (command === 'issue' && action === 'view' && (reference === '12' || reference === ${JSON.stringify(INCIDENT_URL)})) console.log(JSON.stringify(issue));`,
  "else { console.error('the demo gh knows only issue 12'); process.exit(1); }",
  '',
].join('\n');

// Project B's test: it calls a server on this machine and never sets NO_PROXY.
const PROJECT_B_TEST = "import { test } from 'node:test';\n\ntest('health', async () => {\n  await fetch('http://127.0.0.1:8080/health');\n});\n";

// What the reviewer writes: a sharper `what` and `fix`, the check, and real cases for its test.
const REVIEWED_IMPORTS = "import { readdirSync, readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n\n/** The shape";
const REVIEWED_WHAT = "  what: 'a test calls a server on this machine and does not set NO_PROXY',";
const REVIEWED_FIX = "  fix: 'set NO_PROXY and no_proxy to 127.0.0.1,localhost while the test runs, then put the old values back',";
const REVIEWED_CHECK = [
  '  let testFiles: string[];',
  "  try {",
  "    testFiles = readdirSync(join(root, 'test'), { recursive: true, encoding: 'utf8' }).filter((path) => /\\.test\\.[cm]?[jt]s$/.test(path));",
  '  } catch {',
  "    return []; // no test folder",
  '  }',
  '  return testFiles',
  "    .filter((path) => /https?:\\/\\/(127\\.0\\.0\\.1|localhost)\\b/.test(readFileSync(join(root, 'test', path), 'utf8')))",
  "    .filter((path) => !/no_proxy/i.test(readFileSync(join(root, 'test', path), 'utf8')))",
  '    .map((path) => ({ ...lesson, what: `test/${path}: ${lesson.what}` }));',
].join('\n');
const REVIEWED_KNOWN_BAD = "  const knownBad = makeRepo({ 'test/api.test.js': \"await fetch('http://127.0.0.1:8080/health');\\n\" });";
const REVIEWED_KNOWN_GOOD = "  const knownGood = makeRepo({ 'test/api.test.js': \"process.env.NO_PROXY = '127.0.0.1';\\nawait fetch('http://127.0.0.1:8080/health');\\n\" });";

interface CommandResult {
  status: number | null;
  output: string;
}

/** Replace `pattern` in the file at `path`; throws when it is not there, so a changed draft stops the demo. */
function replaceInFile(path: string, pattern: string | RegExp, replacement: string): void {
  const text = readFileSync(path, 'utf8');
  const changed = text.replace(pattern, replacement);
  if (changed === text) throw new Error(`the draft has changed: ${String(pattern)} is not in ${path}`);
  writeFileSync(path, changed);
}

/** A long output, cut to its first lines and the lines from `keepFrom` to `keepTo`. */
function shortenOutput(output: string, keepFrom: RegExp, keepTo: RegExp): string {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => keepFrom.test(line));
  const end = lines.findIndex((line, index) => index > start && keepTo.test(line));
  if (start < 0 || end < 0) return output;
  const head = lines.slice(0, lines.indexOf(''));
  return [...head, '  ...', ...lines.slice(start, end + 1), '  ...', lines.at(-1) ?? ''].join('\n');
}

/** Run the demo. Prints each step; returns 0 when every step did what it should. */
export function runDemo({ isKept = false, print = (line: string) => console.log(line) } = {}): number {
  const started = Date.now();
  const base = mkdtempSync(join(tmpdir(), 'yokoten-demo-'));
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  const yokoten = join(base, 'yokoten');
  const projectB = join(base, 'project-b');
  // A clean environment: no real HOME or git config, and the fake gh first on PATH.
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') };
  const run = (command: string, args: string[], cwd: string): CommandResult => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}`.trimEnd() };
  };
  const runYokoten = (args: string[], cwd: string) => run(process.execPath, [join(yokoten, 'bin', 'yokoten.ts'), ...args], cwd);
  const showStep = (number: number, heading: string, command?: string) => {
    print(`\n[${((Date.now() - started) / 1000).toFixed(1)}s] ${number}. ${heading}`);
    if (command) print(`$ ${command}`);
  };
  const expect = (result: CommandResult, status: number, step: string) => {
    if (result.status !== status) throw new Error(`${step} exited ${result.status}, not ${status}:\n${result.output}`);
  };

  try {
    // A copy of yokoten as it was before any lesson shipped.
    for (const part of COPIED_PARTS) cpSync(join(SOURCE_DIR, part), join(yokoten, part), { recursive: true });
    rmSync(join(yokoten, 'kit', 'lessons'), { recursive: true, force: true });
    for (const dir of [home, bin, join(projectB, 'test')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(projectB, 'test', 'api.test.js'), PROJECT_B_TEST);
    for (const dir of [yokoten, projectB]) expect(run('git', ['init', '-q'], dir), 0, 'git init');

    print('yokoten demo: one incident in project A becomes a check that project B gets.');

    showStep(1, 'Project A had an incident. yokoten drafts a check from the issue.', `yokoten learn ${INCIDENT_URL}`);
    let result = runYokoten(['learn', INCIDENT_URL], yokoten);
    expect(result, 0, 'learn');
    print(shortenOutput(result.output, /^export const lesson/, /^\};$/));

    showStep(2, 'Write the draft, for a person to review.', `yokoten learn ${INCIDENT_URL} --write`);
    result = runYokoten(['learn', INCIDENT_URL, '--write'], yokoten);
    expect(result, 0, 'learn --write');
    print(result.output);
    expect(run('git', ['add', 'lessons'], yokoten), 0, 'git add');

    showStep(3, 'Nothing ships without review: the check is still a TODO.', `yokoten learn --ship ${LESSON_ID}`);
    result = runYokoten(['learn', '--ship', LESSON_ID], yokoten);
    expect(result, 1, 'learn --ship before review');
    print(result.output);

    showStep(4, 'A reviewer writes the check and its test.', `git diff ${LESSON_DIR}`);
    const lessonFile = join(yokoten, LESSON_DIR, 'lesson.ts');
    const testFile = join(yokoten, LESSON_DIR, 'lesson.test.ts');
    replaceInFile(lessonFile, '/** The shape', REVIEWED_IMPORTS);
    replaceInFile(lessonFile, /^ {2}what: '.*$/m, REVIEWED_WHAT);
    replaceInFile(lessonFile, /^ {2}fix: '.*$/m, REVIEWED_FIX);
    replaceInFile(lessonFile, / {2}\/\/ TODO\(reviewer\)[^\n]*\n {2}void root;\n {2}return \[\];/, REVIEWED_CHECK);
    replaceInFile(testFile, / {2}\/\/ TODO\(reviewer\): replace with files that show the incident\.\n {2}const knownBad = .*/, REVIEWED_KNOWN_BAD);
    replaceInFile(testFile, / {2}\/\/ TODO\(reviewer\): replace with files where all is well\.\n {2}const knownGood = .*/, REVIEWED_KNOWN_GOOD);
    for (const file of [lessonFile, testFile]) {
      result = run('git', ['diff', '--no-color', '-U0', '--', file], yokoten);
      expect(result, 0, 'git diff');
      print(result.output.split('\n').filter((line) => !/^(diff --git|index |@@)/.test(line)).join('\n'));
    }

    showStep(5, 'The test passes and no TODO is left: the lesson ships in the kit.', `yokoten learn --ship ${LESSON_ID}`);
    result = runYokoten(['learn', '--ship', LESSON_ID], yokoten);
    expect(result, 0, 'learn --ship after review');
    print(result.output);

    showStep(6, 'Project B has a test with the same mistake.', 'cat test/api.test.js');
    print(PROJECT_B_TEST.trimEnd());
    print(`$ yokoten doctor | grep lesson`);
    result = runYokoten(['doctor'], projectB);
    const notes = result.output.split('\n').filter((line) => line.includes(`lesson ${LESSON_ID}`));
    if (!notes.length) throw new Error(`doctor in project B shows no note from ${LESSON_ID}:\n${result.output}`);
    print(notes.join('\n'));

    print(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s: one incident, one review, and every project gets the check.`);
    return 0;
  } catch (err) {
    print(`\nyokoten demo: stopped. ${(err as Error).message}`);
    return 1;
  } finally {
    if (isKept) print(`Kept the demo folder: ${base}`);
    else rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--keep');
  if (unknown.length) {
    console.error(`usage: node scripts/demo.ts [--keep]   (unknown: ${unknown.join(' ')})`);
    process.exitCode = 2;
  } else process.exitCode = runDemo({ isKept: process.argv.includes('--keep') });
}
