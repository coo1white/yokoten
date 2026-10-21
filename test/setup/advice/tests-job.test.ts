// Tests for src/setup/advice/tests-job.ts: init writes the tests job for six languages (#550).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { init } from '../../../src/setup/init.ts';
import { ROAD } from '../../../src/setup/road.ts';
import { testLanguages } from '../../../src/setup/advice/test-commands.ts';
import { addTestsNeeds, TESTS_JOBS, testsJobText, unpinnedUses, writeTestsJob } from '../../../src/setup/advice/tests-job.ts';

const WORKFLOW = '.github/workflows/yokoten.yml';

const project = (files: Record<string, string>) => {
  const dir = makeTempDir('yokoten-tests-job-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

// One sample project per covered language: its marker files, the runner the language
// table names, and the install step the written job runs first.
const SHAPES: { language: string; files: Record<string, string>; runner: string; install: string }[] = [
  { language: 'Go', files: { 'go.mod': 'module example.com/demo\n' }, runner: 'go test', install: 'go mod download' },
  { language: 'Python', files: { 'pyproject.toml': '[project]\nname = "demo"\n' }, runner: 'pytest', install: 'pip install pytest' },
  { language: 'Rust', files: { 'Cargo.toml': '[package]\nname = "demo"\n' }, runner: 'cargo test', install: 'cargo fetch' },
  { language: '.NET', files: { 'app.csproj': '<Project />\n' }, runner: 'dotnet test', install: 'dotnet restore' },
  { language: 'Ruby', files: { Gemfile: 'source "https://rubygems.org"\n', 'spec/.keep': '' }, runner: 'bundle exec rspec', install: 'bundle install' },
  { language: 'PHP', files: { 'composer.json': '{}' }, runner: 'vendor/bin/phpunit', install: 'composer install' },
];

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

const workflowFile = (needs = 'needs: [changes, check]') =>
  ['name: yokoten', 'on:', '  pull_request:', 'jobs:', '  changes:', '    runs-on: ubuntu-latest', '    steps:', `      - uses: ${CHECKOUT}`, '        with:', '          persist-credentials: false', '  # The one required check.', '  ci:', '    if: always()', `    ${needs}`, '    runs-on: ubuntu-latest', '    steps:', '      - run: echo ci', ''].join('\n');

test('tests-job: each job pins its setup action, and runs the install step and the table runner (#550)', () => {
  assert.deepEqual(TESTS_JOBS.map((job) => job.language), ['Go', 'Python', 'Rust', '.NET', 'Ruby', 'PHP']);
  for (const shape of SHAPES) {
    const dir = project(shape.files);
    const runner = testLanguages(dir).find((named) => named.language === shape.language)?.runner;
    assert.equal(runner, shape.runner, `${shape.language}: the runner comes from the language table`);
    const job = TESTS_JOBS.find((named) => named.language === shape.language);
    assert.ok(job);
    assert.match(job.commit, /^[0-9a-f]{40}$/, `${shape.language}: the pin is a full commit SHA`);
    const text = testsJobText(job, runner ?? '', { uses: `actions/checkout@${'0'.repeat(40)}`, note: '# v9.9.9' });
    assert.ok(text.includes(`- uses: ${job.action}@${job.commit} # ${job.version}`), `${shape.language}: the setup action is pinned with its version`);
    assert.ok(text.includes(`- run: ${shape.install}`), `${shape.language}: the install step`);
    assert.ok(text.includes(`- run: ${shape.runner}`), `${shape.language}: the runner`);
    assert.ok(text.includes('runs-on: ubuntu-latest'), `${shape.language}: the runner host`);
    assert.deepEqual(unpinnedUses(text), [], `${shape.language}: nothing written is unpinned`);
  }
});

test('tests-job: an action that is not pinned to a commit is caught (#550)', () => {
  const uses = (value: string) => `steps:\n      - uses: ${value}\n`;
  // The positive control: a tag, a branch, and a bare name are all caught.
  assert.deepEqual(unpinnedUses(uses('actions/setup-python@v7.0.0')), ['actions/setup-python@v7.0.0']);
  assert.deepEqual(unpinnedUses(uses('actions/checkout@main')), ['actions/checkout@main']);
  assert.deepEqual(unpinnedUses(uses('actions/checkout')), ['actions/checkout']);
  // The control: a full SHA, quoted or with a version comment, and a local action pass.
  assert.deepEqual(unpinnedUses(uses(`${CHECKOUT}`)), []);
  assert.deepEqual(unpinnedUses(uses(`"actions/setup-go@${'1'.repeat(40)}"`)), []);
  assert.deepEqual(unpinnedUses(uses('./')), []);
});

test('tests-job: needs gains tests once, and only in the ci job (#550)', () => {
  assert.match(addTestsNeeds(workflowFile()) ?? '', /needs: \[changes, check, tests\]/);
  assert.equal(addTestsNeeds(workflowFile('needs: [changes, tests, check]')), workflowFile('needs: [changes, tests, check]'), 'already there: unchanged');
  assert.match(addTestsNeeds(workflowFile('needs: [changes, tests-e2e]')) ?? '', /needs: \[changes, tests-e2e, tests\]/, 'tests-e2e is another job');
  assert.equal(addTestsNeeds('jobs:\n  build:\n    needs: [lint]\n'), null, 'no ci job: null');
  assert.equal(addTestsNeeds('jobs:\n  ci:\n    runs-on: ubuntu-latest\n'), null, 'no needs list: null');
});

test('tests-job: a yes writes the job and updates needs; the tests step is then done (#550)', () => {
  for (const shape of SHAPES) {
    const dir = project({ ...shape.files, [WORKFLOW]: workflowFile() });
    const before = readFileSync(join(dir, WORKFLOW), 'utf8');
    const lines = writeTestsJob(dir, { ask: () => 'y' });
    assert.ok(lines.join('\n').includes(`wrote the tests job for ${shape.language} in ${WORKFLOW} (it runs \`${shape.runner}\`)`));
    assert.match(lines.join('\n'), /to undo, remove the `tests` job and remove `tests` from the `needs` list of `ci`/);
    const after = readFileSync(join(dir, WORKFLOW), 'utf8');
    assert.ok(after.includes(`- run: ${shape.install}`) && after.includes(`- run: ${shape.runner}`), `${shape.language}: the job is in the file`);
    assert.match(after, /needs: \[changes, check, tests\]/, `${shape.language}: needs updated`);
    assert.ok(after.indexOf('  tests:') < after.indexOf('  ci:'), `${shape.language}: the job sits before ci`);
    assert.ok(after.includes('  # The one required check.\n  ci:'), `${shape.language}: the ci comment stays with ci`);
    assert.ok(after.includes(before.split('\n')[7]), `${shape.language}: the checkout pin is the file's own`);
    assert.deepEqual(unpinnedUses(after), [], `${shape.language}: the file stays fully pinned`);
    const tests = ROAD.find((step) => step.key === 'tests');
    assert.ok(tests);
    assert.equal(tests.check(dir, {}, undefined), true, `${shape.language}: the tests step is done`);
  }
});

test('tests-job: it asks first: a no and no terminal leave the file alone (#550)', () => {
  const asked: string[] = [];
  const declined = project({ 'go.mod': 'module example.com/demo\n', [WORKFLOW]: workflowFile() });
  const no = writeTestsJob(declined, { ask: (question) => (asked.push(question), 'n') });
  assert.deepEqual(asked, [`Add a tests job for Go to ${WORKFLOW}? [Y/n]`]);
  assert.equal(readFileSync(join(declined, WORKFLOW), 'utf8'), workflowFile(), 'a no writes nothing');
  assert.ok(no.join('\n').includes(`left ${WORKFLOW} unchanged`));
  const silent = project({ 'go.mod': 'module example.com/demo\n', [WORKFLOW]: workflowFile() });
  const how = writeTestsJob(silent);
  assert.equal(readFileSync(join(silent, WORKFLOW), 'utf8'), workflowFile(), 'no terminal writes nothing');
  assert.match(how.join('\n'), /would add a tests job for Go.*to be asked, or add the job by hand/);
});

test('tests-job: an unpinned checkout stops the write and says so (#550)', () => {
  const dir = project({ 'go.mod': 'module example.com/demo\n', [WORKFLOW]: workflowFile().replace(CHECKOUT, 'actions/checkout@v7.0.1') });
  const lines = writeTestsJob(dir, { ask: () => 'y' });
  assert.match(lines.join('\n'), /not pinned to a commit \(actions\/checkout@v7\.0\.1\)/);
  assert.equal(readFileSync(join(dir, WORKFLOW), 'utf8'), workflowFile().replace(CHECKOUT, 'actions/checkout@v7.0.1'), 'nothing written');
});

test('tests-job: kept when the tests already run or the job is there; guidance with no file (#550)', () => {
  const running = project({ 'go.mod': 'module example.com/demo\n', [WORKFLOW]: workflowFile().replace('- run: echo ci', '- run: go test ./...') });
  assert.ok(writeTestsJob(running, { ask: () => 'y' }).join('\n').includes(`kept ${WORKFLOW} (it already runs the tests)`));
  const own = project({ 'go.mod': 'module example.com/demo\n', [WORKFLOW]: workflowFile().replace('  ci:', '  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo mine\n  ci:') });
  assert.match(writeTestsJob(own, { ask: () => 'y' }).join('\n'), /has a tests job of its own/);
  const missing = project({ 'go.mod': 'module example.com/demo\n' });
  assert.ok(writeTestsJob(missing, { ask: () => 'y' }).join('\n').includes(`no ${WORKFLOW}; run \`yokoten init\` to add it`));
});

test('tests-job: the first covered language wins, and other stacks stay quiet (#550)', () => {
  const mixed = project({ 'go.mod': 'module example.com/demo\n', 'pyproject.toml': '[project]\nname = "demo"\n', [WORKFLOW]: workflowFile() });
  assert.match(writeTestsJob(mixed, { ask: () => 'y' }).join('\n'), /wrote the tests job for Go/);
  const node = project({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
  assert.deepEqual(writeTestsJob(node, { ask: () => 'y' }), [], 'no covered language: quiet');
});

test('tests-job: init asks and writes the job on a yes (#550)', () => {
  const sandbox = makeSandbox();
  sandbox.write('go.mod', 'module example.com/demo\n');
  const asked: string[] = [];
  const done = init(sandbox.repo, sandbox.env, () => '', { ask: (question) => (asked.push(question), 'y') });
  assert.deepEqual(asked, [`Add a tests job for Go to ${WORKFLOW}? [Y/n]`]);
  assert.match(done.lines.join('\n'), /wrote the tests job for Go/);
  const text = readFileSync(join(sandbox.repo, WORKFLOW), 'utf8');
  assert.ok(text.includes('- run: go test') && text.includes('- run: go mod download'));
  assert.match(text, /needs: \[changes, check, lint, tests\]/);
  assert.deepEqual(unpinnedUses(text), []);
});
