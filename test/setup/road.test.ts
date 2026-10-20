// Tests for src/setup/road.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { fixture, makeSandbox, makeTempDir } from '../repo/helpers.ts';
import { codeOwnersText, withGitReads } from '../../src/setup/init.ts';
import {
  catchLongLines,
  type Found,
  gitConfig,
  isLicenseName,
  onPullRequest,
  ROAD,
  runsTests,
  securityLacking,
  STAGES,
  type Step,
  walk,
  yokotenActions,
} from '../../src/setup/road.ts';
import { assertLinear } from '../../scripts/linear.ts';

const step = (stage: number, key: string): Step => ({ stage, key, check: () => false, what: () => key, fix: () => key, why: key, how: key });

const steps = [step(1, 'a'), step(1, 'b'), step(2, 'c'), step(3, 'd')];

const at = (found: Found[], notNow: Record<string, string> = {}) => walk(steps.map((s, i) => ({ step: s, found: found[i] })), notNow);

const marks = (found: Found[], notNow: Record<string, string> = {}) => at(found, notNow).steps.map((w) => w.mark);

// ---- The tests step (#257): the common test commands in a workflow count, in any kind of project. ----

/** The tests step on a scratch repo with these files: whether it is done, and what it says when not. */
const testsStep = (files: Record<string, string>) => {
  const dir = makeTempDir('yokoten-tests-step-');
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const tests = ROAD.find((s) => s.key === 'tests');
    assert.ok(tests);
    return { done: tests.check(dir, {}, undefined), what: tests.what(dir, {}, undefined) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const workflow = (run: string) => ({ '.github/workflows/ci.yml': `jobs:\n  t:\n    steps:\n      - run: ${run}\n` });

// Each case: the workflow (a `- run:` value, or a whole workflow when it has a newline), the project, and whether the step is done.
const PLAIN = {};

const SCRIPT = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) };

const NPM_WS = { 'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }) };

const PNPM_WS = { 'package.json': JSON.stringify({ private: true }), 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' };

const NO_SCRIPT = { 'package.json': JSON.stringify({ private: true }) };

const TESTS_CASES: [string, Record<string, string>, boolean][] = [
  // The common runners.
  ...['python -m unittest discover', 'python -m pytest', 'tox', 'nox', 'make test', 'npx vitest run', 'npx jest', 'pnpm exec vitest run', 'pnpm exec jest', 'yarn vitest run', 'yarn jest',
    'uv run pytest', 'go test ./...', 'node --test', 'pytest'].map((run): [string, Record<string, string>, boolean] => [run, PLAIN, true]),
  ['jobs:\n  t:\n    steps:\n      - run: |\n          pip install tox\n          tox -e py\n', PLAIN, true],
  ['jobs:\n  t:\n    steps:\n      - name: test\n        run: >-\n          go test ./...\n', PLAIN, true],
  ['npm ci && npx jest --ci', PLAIN, true],
  // Easy wins (#257 review): more ways to start a runner.
  ...['pnpm vitest', 'pnpm jest', 'npx --yes jest', 'npm exec vitest', 'npm exec -- vitest run', 'poetry run pytest', 'pipenv run pytest', 'coverage run -m pytest', 'poetry run python -m unittest',
    'CI=true npx vitest run', 'FOO="a b" pytest', 'env CI=1 pytest', 'time go test ./...', 'make tests', 'make -C backend test', '"tox -e py"', "'go test ./...'", '(cd app && go test ./...)',
    'node --experimental-strip-types --test'].map((run): [string, Record<string, string>, boolean] => [run, PLAIN, true]),
  // Not a test run: installing a runner, a name that only starts like one, asking a runner its version.
  ...['pip install tox nox', 'pip install pytest', 'make test-deps', 'yarn jest-junit', 'npm install && jest-preview', 'npx jest --version', 'pytest --help', '# python -m unittest', 'unittest',
    'echo tox'].map((run): [string, Record<string, string>, boolean] => [run, PLAIN, false]),
  // Not a run step at all: a job id, a matrix item, a setting, a broken key, a comment.
  ['jobs:\n  jest:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n', PLAIN, false],
  ['jobs:\n  tox:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n', PLAIN, false],
  ['jobs:\n  t:\n    strategy:\n      matrix:\n        runner:\n          - jest\n          - tox\n    steps:\n      - run: npm ci\n', PLAIN, false],
  ['jobs:\n  t:\n    with:\n      tox-version: 4\n    steps:\n      - run: echo hi\n', PLAIN, false],
  ['jobs:\n  t:\n    steps:\n      -run: tox\n', PLAIN, false],
  ['jobs:\n  t:\n    steps:\n      - run: |\n          # python -m unittest\n          echo skipped\n', PLAIN, false],
  ['jobs:\n  t:\n    steps:\n      - run: |\n          echo one\n      - name: tox\n        uses: some/action@v1\n', PLAIN, false],
  // The package.json script.
  ['npm test', SCRIPT, true],
  ['npm run test', SCRIPT, true],
  ['pnpm t', SCRIPT, true],
  ['npm test', NO_SCRIPT, false],
  ['npm run test:lint', SCRIPT, false],
  // Workspaces with no root script: only a command that runs each package's tests.
  ...['npm test --workspaces', 'npm run test -ws', 'npm test --workspace=app', 'npm -w app test', 'npm run test -w app', 'pnpm -r test', 'pnpm --recursive run test', 'pnpm --filter app test',
    'pnpm -r --parallel test', 'yarn workspaces run test', 'yarn workspaces foreach -A run test', 'yarn workspaces foreach --all --topological run test']
    .flatMap((run): [string, Record<string, string>, boolean][] => [[run, NPM_WS, true], [run, PNPM_WS, true]]),
  ...['npm test', 'pnpm test', 'npm run test:lint', 'npm run test:lint -ws', 'pnpm -r test:lint', 'npm run lint', 'yarn workspaces run test:e2e']
    .flatMap((run): [string, Record<string, string>, boolean][] => [[run, NPM_WS, false], [run, PNPM_WS, false]]),
];

// ---- The ci and titles steps (#298): the yokoten Action and `npx yokoten check` count. ----

// The guide's "Use it as a GitHub Action" example, as it stands.
const GUIDE_ACTION = `# .github/workflows/yokoten.yml
name: yokoten
on:
  pull_request:
    # \`edited\`, \`labeled\` and \`milestoned\` run \`check --pr\` again after a fix.
    types: [opened, edited, synchronize, reopened, labeled, unlabeled, milestoned, demilestoned]
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  yokoten:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: yokoten-labs/yokoten@<full commit SHA>
`;

/** Whether the ci and titles steps are done on a scratch repo with this one workflow. */
const ciSteps = (workflowText: string) => {
  const dir = makeTempDir('yokoten-ci-step-');
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'yokoten.yml'), workflowText);
    const done = (key: string) => ROAD.find((s) => s.key === key)!.check(dir, {}, undefined);
    return { ci: done('ci'), titles: done('titles') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const withAction = (step: string, on = 'pull_request') => `on: ${on}\njobs:\n  y:\n    runs-on: ubuntu-latest\n    steps:\n${step}`;

const CI_CASES: [string, string, { ci: boolean; titles: boolean }][] = [
  ['the guide example', GUIDE_ACTION, { ci: true, titles: true }],
  ['pr-check: false', GUIDE_ACTION.replace('yokoten@<full commit SHA>\n', 'yokoten@<full commit SHA>\n        with:\n          pr-check: false\n'), { ci: true, titles: false }],
  ["pr-check: 'false' before uses", withAction("      - name: yokoten\n        with:\n          pr-check: 'false' # not yet\n        uses: yokoten-labs/yokoten@v1\n"), { ci: true, titles: false }],
  ['pr-check: true, quoted ref and a comment', withAction('      - uses: "yokoten-labs/yokoten@0123abc" # v0.1\n        with:\n          pr-check: true\n'), { ci: true, titles: true }],
  ['push only', withAction('      - uses: yokoten-labs/yokoten@v1\n', '[push]'), { ci: true, titles: false }],
  ['pull_request_target in a list', withAction('      - uses: yokoten-labs/yokoten@v1\n', '[push, pull_request_target]'), { ci: true, titles: true }],
  ['npx yokoten check', withAction('      - run: npx yokoten check\n'), { ci: true, titles: false }],
  ['npx --yes yokoten check --pr', withAction('      - run: npx --yes yokoten@latest check --pr\n'), { ci: false, titles: true }],
  ['a run block with bunx and pnpm dlx', withAction('      - run: |\n          bunx yokoten check\n          pnpm dlx yokoten check --pr\n'), { ci: true, titles: true }],
  // Look-alikes: another action, a package with a longer name, an echo, a comment, a commented-out step.
  ['another action', withAction('      - uses: yokoten-labs/yokoten-extra@v1\n'), { ci: false, titles: false }],
  ['npx yokoten-check', withAction('      - run: npx yokoten-check check\n'), { ci: false, titles: false }],
  ['echo yokoten check', withAction('      - run: echo yokoten check && echo npx yokoten check\n'), { ci: false, titles: false }],
  ['a comment', withAction('      - run: |\n          # npx yokoten check\n          echo hi\n'), { ci: false, titles: false }],
  ['a commented-out step', withAction('      # - uses: yokoten-labs/yokoten@v1\n      - run: echo hi\n'), { ci: false, titles: false }],
];

test('road: the stage is the first one with a step neither done nor not now', () => {
  assert.equal(at([false, false, false, false]).stage, 1);
  assert.equal(at([true, true, false, false]).stage, 2);
  assert.equal(at([true, true, true, false]).stage, 3);
  assert.deepEqual(marks([true, false, false, false]), ['done', 'next', 'to do', 'to do']);
  assert.equal(at([true, false, false, false]).next?.key, 'b');
});

test('road: a later step done early counts as done', () => {
  assert.deepEqual(marks([false, true, true, true]), ['next', 'done', 'done', 'done']);
  assert.equal(at([false, true, true, true]).stage, 1);
});

test('road: not now skips a step, and done wins over not now', () => {
  assert.equal(at([true, false, false, false], { b: 'later' }).stage, 2);
  assert.deepEqual(marks([true, false, false, false], { a: 'x', b: 'later' }), ['done', 'not now', 'next', 'to do']);
});

test("road: a step yokoten can't check shows so, and never holds the stage", () => {
  assert.deepEqual(marks([true, null, false, true]), ['done', "can't check", 'next', 'done']);
  assert.equal(at([true, null, false, true]).stage, 2);
});

test('road: nothing left means no stage and no next step', () => {
  const end = at([true, null, true, false], { d: 'not public yet' });
  assert.equal(end.stage, null);
  assert.equal(end.next, null);
});

test('road: five stages, each step in one of them, each key once, each why a sentence', () => {
  assert.equal(STAGES.length, 5);
  assert.deepEqual(ROAD.map((s) => s.stage), [...ROAD.map((s) => s.stage)].sort(), 'the table is in stage order');
  assert.ok(ROAD.every((s) => s.stage >= 1 && s.stage <= STAGES.length));
  assert.equal(new Set(ROAD.map((s) => s.key)).size, ROAD.length);
  // The keys a project may already have in yokoten.json "notNow" keep working.
  for (const key of ['rules', 'commit-check', 'tool-hook', 'ci', 'runtime', 'issues']) assert.ok(ROAD.some((s) => s.key === key), key);
  for (const s of ROAD) assert.ok(!/[.]$/.test(s.why) && s.why.split(' ').length <= 25, `${s.key}: a why has no full stop and at most 25 words`);
  for (const s of ROAD) assert.ok(s.how && !/[.]$/.test(s.how), `${s.key}: says how it is checked, with no full stop`);
});

test('road: every outside standard has the form "<standard>: <item>" or an item id, joined by " · " (#58)', () => {
  const named = ROAD.filter((s) => s.standard);
  assert.ok(named.length >= 10, 'most steps name a standard');
  for (const { key, standard } of named) {
    for (const part of (standard ?? '').split(' · ')) {
      assert.match(part, /^[A-Za-z][\w .-]*(?:: \S(?:.*\S)?)?$/, `${key}: "${part}"`);
      if (part.startsWith('OSPS')) assert.match(part, /^OSPS-[A-Z]{2}-\d{2}\.\d{2}$/, `${key}: an OSPS Baseline id`);
    }
  }
});

test('road: the tests step counts a test command only in a run step, and not a look-alike (#257)', () => {
  for (const [run, project, done] of TESTS_CASES) {
    const ci = run.includes('\n') ? { '.github/workflows/ci.yml': run } : workflow(run);
    assert.equal(testsStep({ ...project, ...ci }).done, done, `${done ? 'done' : 'next'}: ${JSON.stringify(run)} with ${Object.keys(project).join(', ') || 'no package.json'}`);
  }
});

test('road: the tests step reads a big workflow in linear time (#257)', () => {
  // Each input is about n characters.
  const inputs: [string, (n: number) => string][] = [
    ['newlines', (n) => '\n'.repeat(n)],
    ['run: and spaces', (n) => `run: ${' '.repeat(n)}`],
    ['blank indented lines', (n) => '    \n'.repeat(n / 5)],
    ['a run block of blank lines', (n) => `      - run: |\n${'\n'.repeat(n)}`],
    ['semicolons', (n) => `- run: ${';'.repeat(n)}`],
    ['flags', (n) => `- run: npm ${'-a '.repeat(n / 3)}`],
    ['flags with values', (n) => `- run: pnpm ${'-a b '.repeat(n / 5)}`],
    ['variables', (n) => `- run: ${'A=b '.repeat(n / 4)}`],
    // Each pattern that repeats over a line (#322): a make -C folder, npm workspaces flags with values.
    ['make -C flags', (n) => `- run: make ${'-Cx '.repeat(n / 4)}`],
    ['npm workspaces flags', (n) => `- run: npm -w ${'-a b '.repeat(n / 5)}`],
  ];
  for (const [name, make] of inputs) {
    for (const workspaces of [false, true]) {
      assertLinear(`${name}, workspaces ${workspaces}`, make, (ci) => assert.equal(runsTests(ci, 'vitest run x', workspaces), false, name));
    }
  }
});

// Each pattern that repeats over a line, as one `run:` line of about n characters (#322).
const LONG_LINES: [string, (n: number) => string][] = Object.entries({
  parentheses: '( ',
  variables: 'A=b ',
  'quoted variables': 'A="b c" ',
  'env flags': 'env -i ',
  time: 'time ',
}).map(([name, repeat]) => [name, (n) => repeat.repeat(n / repeat.length)]);
for (const [name, start, repeat] of [
  ['node flags', 'node', ' -a'],
  ['mvn flags', './mvnw', ' -a'],
  ['gradle flags', 'gradle', ' -a'],
  ['uv run flags', 'uv run', ' -a'],
  ['make flags', 'make', ' -k'],
  ['make -C folders', 'make', ' -C x'],
  ['npx flags, and npx yokoten', 'npx', ' -y'],
  ['npm exec flags', 'npm exec', ' -y'],
  ['npm workspaces flags', 'npm -w', ' -a b'],
  ['pnpm flags', 'pnpm -r', ' -a b'],
  ['pnpm filters', 'pnpm', ' --filter a'],
  ['yarn foreach flags', 'yarn workspaces foreach', ' -a b'],
]) {
  LONG_LINES.push([name, (n) => `${start}${repeat.repeat(n / repeat.length)}`]);
}
// The big input of assertLinear is 8x this: 500,000 characters.
const LONG_LINE_SIZE = 500_000 / 8;

test('road: a run line of 500,000 characters reads in linear time, with no RangeError (#322)', () => {
  for (const [name, make] of LONG_LINES) {
    assertLinear(
      name,
      (n) => `- run: ${make(n)}`,
      (ci) => {
        for (const workspaces of [false, true]) assert.equal(runsTests(ci, 'vitest run x', workspaces), false, name);
        assert.equal(ciSteps(ci).ci, false, name);
      },
      LONG_LINE_SIZE,
    );
  }
  // The same line still counts when the runner comes at its end.
  assert.equal(runsTests(`- run: node${' -a'.repeat(150_000)} --test`, '', false), true);
  assert.equal(runsTests(`- run: pnpm${' -a b'.repeat(100_000)} -r test`, '', true), true);
  assert.equal(runsTests(`- run: ${'A=b '.repeat(125_000)}go test`, '', false), true);
  // A uses line whose ref has up to 250,000 words.
  assertLinear('a uses ref of words', (n) => `- uses: yokoten-labs/yokoten@${'a '.repeat(n / 2)}"`, (ci) => assert.deepEqual(yokotenActions(ci), []), LONG_LINE_SIZE);
  assertLinear('a uses ref of words and a comment', (n) => `- uses: yokoten-labs/yokoten@${'a '.repeat(n / 2)}# v1`, (ci) => assert.deepEqual(yokotenActions(ci), [{ prCheck: true }]), LONG_LINE_SIZE);
});

test('road: a workflow check that throws a RangeError is "can\'t check", and other errors still throw (#322)', () => {
  assert.equal(catchLongLines(() => { throw new RangeError('Maximum call stack size exceeded'); })('.'), null);
  assert.equal(catchLongLines(() => true)('.'), true);
  assert.throws(() => catchLongLines(() => { throw new TypeError('x'); })('.'), TypeError);
  for (const key of ['tests', 'ci', 'titles']) assert.match(ROAD.find((s) => s.key === key)?.unchecked?.(undefined) ?? '', /too long to read/, key);
});

test('road: the tests step stays next with only a lint step, and says what is missing by project type (#257)', () => {
  const lint = testsStep({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }), ...workflow('npm run lint') });
  assert.deepEqual(lint, { done: false, what: 'no test command: no "test" script in package.json, and no workflow runs a test runner' });
  const go = testsStep({ 'go.mod': 'module example.com/x\n' });
  assert.deepEqual(go, { done: false, what: 'no workflow runs a test command such as `go test`' });
  assert.equal(testsStep({ 'pyproject.toml': '[project]\nname = "x"\n' }).what, 'no workflow runs a test command such as `pytest`');
  assert.equal(testsStep({}).what, 'no workflow runs a test command such as `go test`, `pytest` or `cargo test`');
  for (const files of [{ 'go.mod': '' }, { 'pyproject.toml': '' }, {}] as Record<string, string>[]) assert.doesNotMatch(testsStep(files).what, /package\.json/);
  // A workspaces root with no script: each package's tests, not a root script.
  assert.equal(testsStep(NPM_WS).what, "no workflow runs each package's tests (e.g. `npm test --workspaces`)");
  assert.equal(testsStep(PNPM_WS).what, "no workflow runs each package's tests (e.g. `pnpm -r test`)");
  const tests = ROAD.find((s) => s.key === 'tests');
  const dir = makeTempDir('yokoten-tests-fix-');
  try {
    writeFileSync(join(dir, 'package.json'), NPM_WS['package.json']);
    assert.equal(tests?.fix(dir, {}, undefined), 'add a step that runs `npm test --workspaces` to a workflow in .github/workflows');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('road: the ci and titles steps count the yokoten Action and npx yokoten, and not a look-alike (#298)', () => {
  for (const [name, text, want] of CI_CASES) assert.deepEqual(ciSteps(text), want, name);
});

test('road: the Action and its trigger read a big workflow in linear time (#298)', () => {
  // Each input is about n characters.
  const inputs: [string, (n: number) => string][] = [
    ['newlines', (n) => '\n'.repeat(n)],
    ['list items', (n) => '- a\n'.repeat(n / 4)],
    ['nested dashes', (n) => `- ${'- '.repeat(n / 2)}`],
    ['one item of key lines', (n) => `- uses: x/y@v1\n${'  a: b\n'.repeat(n / 7)}`],
    ['on: and indented lines', (n) => `on:\n${'  push:\n'.repeat(n / 8)}`],
    ['npx flags', (n) => `- run: npx ${'-y '.repeat(n / 3)}`],
    ['a uses ref of words', (n) => `- uses: yokoten-labs/yokoten@${'a '.repeat(n / 2)}"`],
  ];
  for (const [name, make] of inputs) {
    assertLinear(name, make, (ci) => {
      assert.deepEqual(yokotenActions(ci), [], name);
      assert.equal(onPullRequest(ci), false, name);
      assert.equal(ciSteps(ci).ci, false, name);
    });
  }
});

test("road: init's CODEOWNERS with the placeholder owner is to do; with a real owner, or a project's own file, it is done (#304)", () => {
  const codeowners = ROAD.find((s) => s.key === 'codeowners')!;
  const placeholder = fixture({ '.github/CODEOWNERS': codeOwnersText(null) });
  assert.equal(codeowners.check(placeholder, {}, undefined), false);
  assert.equal(codeowners.what(placeholder, {}, undefined), '.github/CODEOWNERS names no owner yet (@YOUR_GITHUB_HANDLE)');
  assert.equal(codeowners.fix(placeholder, {}, undefined), 'put your GitHub handle in .github/CODEOWNERS');
  assert.equal(codeowners.check(fixture({ '.github/CODEOWNERS': codeOwnersText('octo') }), {}, undefined), true);
  assert.equal(codeowners.check(fixture({ 'docs/CODEOWNERS': '* @octo\n' }), {}, undefined), true);
  // The owner put in on every rule line, with init's comment that names the placeholder left as it was.
  const filled = codeOwnersText(null).split('\n').map((line) => (line.startsWith('#') ? line : line.split('@YOUR_GITHUB_HANDLE').join('@octo'))).join('\n');
  assert.match(filled, /^#.*@YOUR_GITHUB_HANDLE/m, 'the comment still names the placeholder');
  assert.equal(codeowners.check(fixture({ '.github/CODEOWNERS': filled }), {}, undefined), true);
  const none = fixture({});
  assert.equal(codeowners.check(none, {}, undefined), false);
  assert.equal(codeowners.what(none, {}, undefined), 'no CODEOWNERS file');
});

// #408: a session start asked git for core.hooksPath four times. In one doctor run the
// answer is kept; the next run asks again, so a change in between is seen.
test('road: inside one doctor run each git answer is kept; the next run asks git again (#408)', () => {
  const sandbox = makeSandbox();
  const set = (value: string) => execFileSync('git', ['config', 'core.hooksPath', value], { cwd: sandbox.repo, env: sandbox.env });
  set('one');
  const seen = withGitReads(() => {
    const first = gitConfig(sandbox.repo, 'core.hooksPath');
    set('two');
    return [first, gitConfig(sandbox.repo, 'core.hooksPath')];
  });
  assert.deepEqual(seen, ['one', 'one'], 'kept within the run');
  assert.equal(gitConfig(sandbox.repo, 'core.hooksPath'), 'two', 'asked again outside it');
  assert.deepEqual(withGitReads(() => gitConfig(sandbox.repo, 'core.hooksPath')), 'two', 'a new run asks again');
});

// ---- The license file (#376): LICENSE, LICENCE and COPYING in any case, with any suffix. ----

test('road: a license file counts in each form, the Rust dual layout too', () => {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'License.md', 'LICENCE', 'licence.txt', 'COPYING', 'COPYING.LESSER', 'copying.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE-APACHE-2.0', 'license-mit.md', 'UNLICENSE', 'unlicense.txt']) {
    assert.ok(isLicenseName(name), name);
  }
  for (const name of ['LICENSES.md', 'LICENSING.md', 'LICENSES', 'UNLICENSED', 'licenseinfo', 'COPYRIGHT', 'README.md']) {
    assert.ok(!isLicenseName(name), name);
  }
  const root = makeTempDir('yokoten-license-');
  try {
    const license = () => securityLacking(root).includes('license file');
    writeFileSync(join(root, 'LICENSING.md'), 'which license applies where\n');
    mkdirSync(join(root, 'LICENSE'));
    assert.ok(license(), 'LICENSING.md and a LICENSE folder are no license');
    writeFileSync(join(root, 'LICENSE-MIT'), 'MIT\n');
    writeFileSync(join(root, 'LICENSE-APACHE'), 'Apache-2.0\n');
    assert.ok(!license(), 'LICENSE-MIT and LICENSE-APACHE are a license');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
