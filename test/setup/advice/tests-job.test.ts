// Tests for src/setup/advice/tests-job.ts: init writes the tests job (#550, #653).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir, ROOT } from '../../repo/helpers.ts';
import { init } from '../../../src/setup/init.ts';
import { ROAD } from '../../../src/setup/road.ts';
import { TEST_LANGUAGES, testLanguages } from '../../../src/setup/advice/test-commands.ts';
import { addTestsNeeds, findOldTestsPins, KIT_NODE, nodeTestsFix, nodeVersion, refreshTestsPins, TESTS_JOBS, testsJobText, testsPinNote, unpinnedUses, writeTestsJob } from '../../../src/setup/advice/tests-job.ts';

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
  assert.deepEqual(TESTS_JOBS.map((job) => job.language), ['Go', 'Python', 'Rust', '.NET', 'Ruby', 'PHP', 'Node.js']);
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
  assert.ok(writeTestsJob(node, { ask: () => 'y' }).join('\n').includes(`no ${WORKFLOW}`), 'a Node project still needs the workflow file');
});

test('tests-job: a Node project with a test script gets a pinned job that runs npm test (#653)', () => {
  const node = TESTS_JOBS.find((job) => job.language === 'Node.js');
  assert.ok(node);
  assert.equal(node.action, 'actions/setup-node');
  assert.equal(node.version, 'v7.1.0');
  assert.equal(node.commit, '949feb2413d6458794dcd2491c4babbbce0c15c1');
  assert.equal(node.input, 'node-version');
  assert.equal(node.inputValue, '^22.23.4');
  assert.equal(node.install, 'npm install', 'the table command is the one used when no lockfile is known');
  const dir = project({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'package-lock.json': '{}\n', [WORKFLOW]: workflowFile() });
  const asked: string[] = [];
  const lines = writeTestsJob(dir, { ask: (question) => (asked.push(question), 'y') });
  assert.deepEqual(asked, [`Add a tests job for Node.js to ${WORKFLOW}? [Y/n]`]);
  assert.match(lines.join('\n'), /wrote the tests job for Node\.js in .* \(it runs `npm test`\)/);
  const after = readFileSync(join(dir, WORKFLOW), 'utf8');
  assert.ok(after.includes(`- uses: ${node.action}@${node.commit} # ${node.version}`));
  assert.match(after, /node-version: "\^22\.23\.4"/);
  assert.ok(after.includes('- run: npm ci') && after.includes('- run: npm test'));
  assert.equal(after.includes('vitest run'), false, 'the job runs npm test');
  assert.deepEqual(unpinnedUses(after), []);
  const tests = ROAD.find((step) => step.key === 'tests');
  assert.ok(tests);
  assert.equal(tests.check(dir, {}, undefined), true, 'the tests step is done');
  const silent = project({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), [WORKFLOW]: workflowFile() });
  const how = writeTestsJob(silent);
  assert.equal(readFileSync(join(silent, WORKFLOW), 'utf8'), workflowFile(), 'no terminal writes nothing');
  assert.match(how.join('\n'), /would add a tests job for Node\.js/);
  const engines = project({
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, engines: { node: '>=22.23.4' } }),
    [WORKFLOW]: workflowFile(),
  });
  writeTestsJob(engines, { ask: () => 'y' });
  assert.match(readFileSync(join(engines, WORKFLOW), 'utf8'), /node-version: ">=22\.23\.4"/);
  const fromFile = project({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    '.nvmrc': 'v22.14.0\n',
    [WORKFLOW]: workflowFile(),
  });
  writeTestsJob(fromFile, { ask: () => 'y' });
  const written = readFileSync(join(fromFile, WORKFLOW), 'utf8');
  assert.match(written, /node-version: "22\.14\.0"/);
  assert.equal(written.includes('v22.14.0'), false, 'one leading v is stripped');
  const loose = project({
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    [WORKFLOW]: workflowFile().replace(CHECKOUT, 'actions/checkout@v7.0.1'),
  });
  assert.match(writeTestsJob(loose, { ask: () => 'y' }).join('\n'), /not pinned to a commit \(actions\/checkout@v7\.0\.1\)/);
  assert.equal(readFileSync(join(loose, WORKFLOW), 'utf8').includes('setup-node'), false, 'an unpinned checkout is left unchanged');
});

test('tests-job: Go wins over a Node test script, and a placeholder or a workspaces root stays quiet (#653)', () => {
  const mixed = project({
    'go.mod': 'module example.com/demo\n',
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    [WORKFLOW]: workflowFile(),
  });
  assert.equal(nodeTestsFix(mixed), null, 'Go: doctor does not paste a Node job');
  const tests = ROAD.find((step) => step.key === 'tests');
  assert.ok(tests);
  const goAdvice = tests.fix(mixed, {}, undefined);
  assert.equal(goAdvice.includes('setup-node'), false, 'Go: the tests step does not name setup-node');
  assert.equal(goAdvice.includes('npm'), false, 'Go: the tests step does not name npm');
  assert.match(writeTestsJob(mixed, { ask: () => 'y' }).join('\n'), /wrote the tests job for Go/);
  const text = readFileSync(join(mixed, WORKFLOW), 'utf8');
  assert.ok(text.includes('- run: go test') && text.includes('go-version: stable'));
  assert.equal(text.includes('setup-node'), false);
  const placeholder = project({
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    [WORKFLOW]: workflowFile(),
  });
  assert.deepEqual(writeTestsJob(placeholder, { ask: () => 'y' }), []);
  const workspaces = project({ 'package.json': JSON.stringify({ workspaces: ['packages/*'] }), [WORKFLOW]: workflowFile() });
  assert.deepEqual(writeTestsJob(workspaces, { ask: () => 'y' }), []);
});

const nodePin = (commit: string, version: string) => `actions/setup-node@${commit} # ${version}`;
const OLD_SHA = 'a'.repeat(40);

/** The sample workflow with a `tests` job that has a setup-node step, as init would have left it. */
const testsJobFile = (setup: string) =>
  workflowFile().replace(
    '  # The one required check.\n  ci:',
    ['  tests:', '    runs-on: ubuntu-latest', '    steps:', `      - uses: ${CHECKOUT}`, '      - uses: ' + setup, '        with:', '          node-version: "^22.23.4"', '      - run: npm test', '  # The one required check.', '  ci:'].join('\n'),
  );

test('tests-job: a pin the kit has moved on from is found, and only inside the tests job (#584)', () => {
  const node = TESTS_JOBS.find((job) => job.language === 'Node.js');
  assert.ok(node);
  const old = nodePin(OLD_SHA, 'v6.1.0');
  // The positive control: an old pin of an action the kit ships is caught.
  assert.deepEqual(findOldTestsPins(testsJobFile(old)), [{ action: 'actions/setup-node', commit: OLD_SHA, version: 'v6.1.0', kitCommit: node.commit, kitVersion: 'v7.1.0' }]);
  // The control: the kit's own pin, an action the kit does not ship, and a workflow with no tests job pass.
  assert.deepEqual(findOldTestsPins(testsJobFile(nodePin(node.commit, node.version))), []);
  assert.deepEqual(findOldTestsPins(testsJobFile(`docker/login-action@${OLD_SHA} # v3.0.0`)), []);
  assert.deepEqual(findOldTestsPins(workflowFile()), []);
  // A pin outside the tests job is another job's business.
  assert.deepEqual(findOldTestsPins(workflowFile().replace(`- uses: ${CHECKOUT}`, `- uses: ${old}`)), []);
  // Refreshing rewrites that line and touches nothing else.
  const fresh = refreshTestsPins(testsJobFile(old));
  assert.ok(fresh);
  assert.ok(fresh.includes(`- uses: ${nodePin(node.commit, node.version)}`));
  assert.equal(fresh.replace(nodePin(node.commit, node.version), old), testsJobFile(old), 'the rest is byte for byte');
  assert.equal(refreshTestsPins(testsJobFile(nodePin(node.commit, node.version))), null, 'nothing old: null');
  // A file with Windows line ends keeps them.
  assert.equal(refreshTestsPins(testsJobFile(old).replaceAll('\n', '\r\n')), testsJobFile(nodePin(node.commit, node.version)).replaceAll('\n', '\r\n'));
});

test('tests-job: a pin newer than the kit\'s is kept, and so is one with no version (#584)', () => {
  const node = TESTS_JOBS.find((job) => job.language === 'Node.js');
  assert.ok(node);
  // A project ahead of the kit: a newer commit and a newer version comment.
  const newer = nodePin('f'.repeat(40), 'v9.9.9');
  assert.deepEqual(findOldTestsPins(testsJobFile(newer)), [], 'a newer pin is not old');
  assert.equal(refreshTestsPins(testsJobFile(newer)), null, 'a newer pin is not rewritten');
  // A pin without a version comment: the commit alone cannot say which one is newer.
  assert.deepEqual(findOldTestsPins(testsJobFile(nodePin('f'.repeat(40), ''))), [], 'no comment: left alone');
  // A version comment the kit also names, on another commit, is the project's own choice.
  assert.deepEqual(findOldTestsPins(testsJobFile(nodePin('f'.repeat(40), node.version))), [], 'the same version is not old');
  // The positive control still holds beside it: a pin naming an older version is old.
  assert.deepEqual(findOldTestsPins(testsJobFile(nodePin(OLD_SHA, 'v6.1.0'))).map((pin) => pin.version), ['v6.1.0']);
  // doctor says nothing about a pin that is ahead of the kit.
  assert.equal(testsPinNote(project({ [WORKFLOW]: testsJobFile(newer) })), null);
});

test('tests-job: init offers the kit pin, and a no or no terminal leaves the old one (#584)', () => {
  const node = TESTS_JOBS.find((job) => job.language === 'Node.js');
  assert.ok(node);
  const old = nodePin(OLD_SHA, 'v6.1.0');
  const files = { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) };
  const silent = project({ ...files, [WORKFLOW]: testsJobFile(old) });
  assert.match(writeTestsJob(silent).join('\n'), /would refresh the tests job pins in .* \(actions\/setup-node v6\.1\.0 to v7\.1\.0\).*on a terminal to be asked/);
  assert.equal(readFileSync(join(silent, WORKFLOW), 'utf8'), testsJobFile(old), 'no terminal writes nothing');
  const declined = project({ ...files, [WORKFLOW]: testsJobFile(old) });
  assert.match(writeTestsJob(declined, { ask: () => 'n' }).join('\n'), /left the tests job pins .* unchanged/);
  assert.equal(readFileSync(join(declined, WORKFLOW), 'utf8'), testsJobFile(old), 'a no writes nothing');
  const asked: string[] = [];
  const dir = project({ ...files, [WORKFLOW]: testsJobFile(old) });
  const lines = writeTestsJob(dir, { ask: (question) => (asked.push(question), 'y') });
  assert.deepEqual(asked, [`Refresh the tests job pins in ${WORKFLOW} (actions/setup-node v6.1.0 to v7.1.0)? [Y/n]`]);
  assert.match(lines.join('\n'), /refreshed the tests job pins in .*to undo, put the old pins back/);
  const after = readFileSync(join(dir, WORKFLOW), 'utf8');
  assert.ok(after.includes(`- uses: ${nodePin(node.commit, node.version)}`));
  assert.equal(after.includes('v6.1.0'), false, 'the old pin is gone');
  assert.deepEqual(unpinnedUses(after), [], 'the refreshed line stays pinned');
  assert.deepEqual(findOldTestsPins(after), [], 'nothing left to refresh');
});

test('tests-job: doctor names an old pin, and says nothing when it is the kit\'s (#584)', () => {
  const node = TESTS_JOBS.find((job) => job.language === 'Node.js');
  assert.ok(node);
  const old = project({ [WORKFLOW]: testsJobFile(nodePin(OLD_SHA, 'v6.1.0')) });
  const note = testsPinNote(old);
  assert.ok(note);
  assert.equal(note.id, 'kit-workflows');
  assert.equal(note.what, `the tests job in ${WORKFLOW} pins actions/setup-node v6.1.0; the kit pins actions/setup-node v7.1.0`);
  assert.match(note.fix, /run `yokoten init` to refresh the pin/);
  const current = project({ [WORKFLOW]: testsJobFile(nodePin(node.commit, node.version)) });
  assert.equal(testsPinNote(current), null);
  assert.equal(testsPinNote(project({})), null, 'no workflow: nothing to say');
});

test('tests-job: the Node pin the kit ships is the one action.yml sets up (#584)', () => {
  const node = TESTS_JOBS.find((job) => job.language === 'Node.js');
  assert.ok(node);
  const action = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  const pinned = /- uses: (actions\/setup-node@[0-9a-f]{40}) # (\S+)/.exec(action);
  assert.ok(pinned, 'action.yml: no pinned setup-node step found; the scan is broken');
  assert.equal(pinned[1], `${node.action}@${node.commit}`, 'the tests job pins the commit action.yml pins');
  assert.equal(pinned[2], node.version, 'the version comment matches too');
  assert.equal(node.inputValue, KIT_NODE);
  assert.ok(action.includes(`default: '${KIT_NODE}'`), 'action.yml sets up the version the tests job asks for');
});

// A marker for each language the table detects and TESTS_JOBS does not write.
// Flutter and Dart share pubspec.yaml; the sdk line is what tells them apart.
const FLUTTER_PUBSPEC = 'name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n';
const UNSUPPORTED_MARKERS: Record<string, Record<string, string>> = {
  Maven: { 'pom.xml': '<project/>\n' },
  Gradle: { 'build.gradle': '' },
  Deno: { 'deno.json': '{}\n' },
  Swift: { 'Package.swift': '' },
  Elixir: { 'mix.exs': '' },
  Flutter: { 'pubspec.yaml': FLUTTER_PUBSPEC },
  Dart: { 'pubspec.yaml': 'name: demo\n' },
  Makefile: { Makefile: 'test:\n\ttrue\n' },
};

test('tests-job: a detected language with no job is not given the Node job (#653)', () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest run' } });
  const tests = ROAD.find((step) => step.key === 'tests');
  assert.ok(tests);
  const unsupported = TEST_LANGUAGES.filter((language) => language.files.length > 0 && !TESTS_JOBS.some((job) => job.language === language.language));
  assert.ok(unsupported.length >= 4);
  for (const language of unsupported) {
    const marker = UNSUPPORTED_MARKERS[language.language];
    assert.ok(marker, `${language.language}: the test has a marker`);
    const dir = project({ ...marker, 'package.json': pkg, [WORKFLOW]: workflowFile() });
    const found = testLanguages(dir).map((named) => named.language);
    assert.deepEqual(found, [language.language], `${language.language}: the marker is that language`);
    const before = readFileSync(join(dir, WORKFLOW), 'utf8');
    assert.deepEqual(writeTestsJob(dir, { ask: () => 'y' }), [], `${language.language}: init writes nothing`);
    assert.equal(readFileSync(join(dir, WORKFLOW), 'utf8'), before, `${language.language}: the workflow stays`);
    assert.equal(nodeTestsFix(dir), null, `${language.language}: doctor does not paste a Node job`);
    const advice = tests.fix(dir, {}, undefined);
    assert.equal(advice.includes('setup-node'), false, `${language.language}: the tests step does not name setup-node`);
    assert.equal(advice.includes('npm'), false, `${language.language}: the tests step does not name npm`);
  }
});

test('tests-job: a Node job installs with the lockfile it finds, and runs that manager\'s test command (#653)', () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest run' } });
  const berry = '# This file is generated by running "yarn install" inside your project.\n\n__metadata:\n  version: 8\n';
  const cases: { name: string; extra: Record<string, string>; install: string; runner: string }[] = [
    { name: 'no lockfile', extra: {}, install: 'npm install', runner: 'npm test' },
    { name: 'pnpm', extra: { 'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'\n' }, install: 'pnpm install --frozen-lockfile', runner: 'pnpm test' },
    { name: 'yarn', extra: { 'yarn.lock': '# yarn lockfile v1\n' }, install: 'yarn install --frozen-lockfile', runner: 'yarn test' },
    { name: 'yarn berry', extra: { 'yarn.lock': berry }, install: 'yarn install --immutable', runner: 'yarn test' },
    { name: 'yarnrc', extra: { 'yarn.lock': '# yarn lockfile v1\n', '.yarnrc.yml': 'nodeLinker: node-modules\n' }, install: 'yarn install --immutable', runner: 'yarn test' },
    {
      name: 'yarn packageManager',
      extra: { 'yarn.lock': '# yarn lockfile v1\n', 'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, packageManager: 'yarn@4.1.0' }) },
      install: 'yarn install --immutable',
      runner: 'yarn test',
    },
    { name: 'bun', extra: { 'bun.lock': '{}\n' }, install: 'bun install --frozen-lockfile', runner: 'bun run test' },
    { name: 'bun binary lock', extra: { 'bun.lockb': '' }, install: 'bun install --frozen-lockfile', runner: 'bun run test' },
    { name: 'npm shrinkwrap', extra: { 'npm-shrinkwrap.json': '{}\n' }, install: 'npm ci', runner: 'npm test' },
  ];
  const tests = ROAD.find((step) => step.key === 'tests');
  assert.ok(tests);
  for (const shape of cases) {
    const dir = project({ 'package.json': pkg, ...shape.extra, [WORKFLOW]: workflowFile() });
    const lines = writeTestsJob(dir, { ask: () => 'y' }).join('\n');
    assert.match(lines, new RegExp(`wrote the tests job for Node\\.js in .* \\(it runs \`${shape.runner}\`\\)`), shape.name);
    const after = readFileSync(join(dir, WORKFLOW), 'utf8');
    assert.ok(after.includes(`- run: ${shape.install}`), `${shape.name}: install`);
    assert.ok(after.includes(`- run: ${shape.runner}`), `${shape.name}: test`);
    assert.equal(after.includes('- run: npm ci'), shape.install === 'npm ci', `${shape.name}: npm ci only with an npm lockfile`);
    assert.equal(tests.check(dir, {}, undefined), true, `${shape.name}: the tests step is done`);
    const advice = nodeTestsFix(dir) ?? '';
    assert.ok(advice.includes(`{run: ${shape.install}}`) && advice.includes(`{run: ${shape.runner}}`), `${shape.name}: doctor names the same commands`);
  }
  // A pnpm lockfile wins over package-lock.json: npm ci cannot install from it.
  const both = project({
    'package.json': pkg,
    'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'\n',
    'package-lock.json': '{}\n',
    [WORKFLOW]: workflowFile(),
  });
  writeTestsJob(both, { ask: () => 'y' });
  const text = readFileSync(join(both, WORKFLOW), 'utf8');
  assert.ok(text.includes('- run: pnpm install --frozen-lockfile') && text.includes('- run: pnpm test'));
  assert.equal(text.includes('- run: npm ci'), false);
});

test('tests-job: a missing workflow or a missing checkout is not described as an unpinned checkout (#653)', () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest run' } });
  const tests = ROAD.find((step) => step.key === 'tests');
  assert.ok(tests);
  const missing = project({ 'package.json': pkg });
  assert.equal(nodeTestsFix(missing), null);
  const advice = tests.fix(missing, {}, undefined);
  assert.match(advice, /run `yokoten init` to add \.github\/workflows\/yokoten\.yml/);
  assert.equal(advice.includes('not pinned'), false);
  const bare = project({
    'package.json': pkg,
    [WORKFLOW]: 'name: yokoten\non:\n  pull_request:\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ci\n',
  });
  const noStep = nodeTestsFix(bare);
  assert.ok(noStep);
  assert.match(noStep, /add a checkout step pinned to a commit, then run `yokoten init`/);
  assert.equal(noStep.includes('not pinned'), false);
  assert.equal(noStep.includes('\n'), false);
  assert.equal(noStep.includes('<'), false);
  const loose = project({ 'package.json': pkg, [WORKFLOW]: workflowFile().replace(CHECKOUT, 'actions/checkout@v7.0.1') });
  const unpinned = nodeTestsFix(loose) ?? '';
  assert.match(unpinned, /checkout step is not pinned/);
  assert.match(unpinned, /Pin it, then run `yokoten init`/);
  assert.equal(unpinned.includes('\n'), false);
});

test('tests-job: node-version comes from engines, then a version file, then the kit default (#653)', () => {
  const version = (files: Record<string, string>) => nodeVersion(project(files));
  const forty = `>=${'1'.repeat(38)}`;
  assert.equal(forty.length, 40);
  assert.equal(version({ 'package.json': JSON.stringify({ engines: { node: '>=22.23.4' } }), '.nvmrc': 'v20.11.1\n' }), '>=22.23.4');
  assert.equal(version({ 'package.json': JSON.stringify({ engines: { node: forty } }) }), forty, '40 characters still counts');
  assert.equal(version({ 'package.json': JSON.stringify({ engines: { node: '1'.repeat(41) } }), '.nvmrc': 'v20.11.1\n' }), '20.11.1', '41 characters does not count');
  assert.equal(version({ 'package.json': JSON.stringify({ engines: { node: 'lts/*' } }), '.nvmrc': '20.11.1\n' }), '20.11.1');
  assert.equal(version({ 'package.json': JSON.stringify({ engines: { node: 22 } }), '.node-version': '24.11.1\n' }), '24.11.1');
  assert.equal(version({ '.nvmrc': 'v22.14.0\n' }), '22.14.0');
  assert.equal(version({ '.nvmrc': '22.14\n' }), '22.14');
  assert.equal(version({ '.nvmrc': 'latest\n', '.node-version': 'v24.11.1\n' }), '24.11.1');
  assert.equal(version({ '.node-version': 'v24.11.1\n' }), '24.11.1');
  assert.equal(version({}), '^22.23.4');
  assert.equal(version({ 'package.json': '{' }), '^22.23.4');
});

// A project that pins Node 20, or an lts alias, must not get the kit's Node 22 with no warning.
test('tests-job: .nvmrc and .node-version may be a major or an lts alias (#653)', () => {
  const version = (files: Record<string, string>) => nodeVersion(project(files));
  assert.equal(version({ '.nvmrc': '20\n' }), '20');
  assert.equal(version({ '.nvmrc': 'v20\n' }), '20');
  assert.equal(version({ '.nvmrc': 'lts/*\n' }), 'lts/*');
  assert.equal(version({ '.nvmrc': '22.14\n' }), '22.14');
  assert.equal(version({ '.node-version': '20\n' }), '20');
  assert.equal(version({ '.node-version': 'v20\n' }), '20');
  assert.equal(version({ '.node-version': 'lts/*\n' }), 'lts/*');
  assert.equal(version({ '.nvmrc': 'lts/Hydrogen\n' }), 'lts/Hydrogen');
  assert.equal(version({ '.nvmrc': 'lts/*\n', '.node-version': '24.11.1\n' }), 'lts/*');
  assert.equal(version({ '.nvmrc': 'latest\n' }), '^22.23.4');
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
