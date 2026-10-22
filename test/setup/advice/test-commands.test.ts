// Tests for src/setup/advice/test-commands.ts: one table of test commands, read by doctor and adopt (#546).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fixture, makeTempDir } from '../../repo/helpers.ts';
import { facts } from '../../../src/setup/advice/adopt.ts';
import { TEST_LANGUAGES, testLanguages } from '../../../src/setup/advice/test-commands.ts';
import { ROAD } from '../../../src/setup/road.ts';

const project = (files: Record<string, string>) => {
  const dir = makeTempDir('yokoten-test-commands-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const workflow = (run: string) => ({ '.github/workflows/ci.yml': `jobs:\n  t:\n    steps:\n      - run: ${run}\n` });
/** doctor's tests step on a project with these files: whether it is done, and what it says when not. */
const testsStep = (files: Record<string, string>) => {
  const dir = project(files);
  const tests = ROAD.find((s) => s.key === 'tests');
  assert.ok(tests);
  return { done: tests.check(dir, {}, undefined), what: tests.what(dir, {}, undefined) };
};
/** adopt's tests row on a repo with these files. */
const adoptTests = (files: Record<string, string>) => {
  const dir = fixture(files);
  return facts(dir, { HOME: dir }).find((r) => r.key === 'tests');
};

const FLUTTER_PUBSPEC = 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n';
const DART_PUBSPEC = 'name: tool\ndependencies:\n  args: ^2.0.0\n';
const COMPOSER_TEST = JSON.stringify({ scripts: { test: 'phpunit' } });

// Each case: the language, its files with tests, the command doctor and adopt name, and CI commands that run its tests.
const CASES: { language: string; files: Record<string, string>; runner: string; runs: string[] }[] = [
  { language: 'Go', files: { 'go.mod': 'module example.com/x\n', 'main_test.go': 'package x\n' }, runner: 'go test', runs: ['go test ./...'] },
  { language: 'Python', files: { 'setup.py': '', 'test_main.py': '' }, runner: 'pytest', runs: ['pytest', 'uv run pytest', 'python -m unittest', '.venv/bin/python -m pytest', 'venv/bin/pytest', '.venv/bin/python3 -m unittest', 'python3.12 -m pytest'] },
  { language: 'Rust', files: { 'Cargo.toml': '[package]\n', 'src/lib.rs': '#[test]\nfn has() {}\n' }, runner: 'cargo test', runs: ['cargo test --all'] },
  { language: 'Maven', files: { 'pom.xml': '<project/>\n', 'src/test/FooTest.java': '' }, runner: 'mvn test', runs: ['./mvnw -B test'] },
  { language: 'Gradle', files: { 'build.gradle.kts': '', 'src/test/FooTest.java': '' }, runner: 'gradle test', runs: ['./gradlew test'] },
  { language: 'Deno', files: { 'deno.json': '{}', 'main_test.ts': '' }, runner: 'deno test', runs: ['deno test -A'] },
  { language: '.NET', files: { 'App.csproj': '<Project/>\n', 'FooTests.cs': '' }, runner: 'dotnet test', runs: ['dotnet test', 'dotnet test --no-build'] },
  { language: '.NET', files: { 'App.sln': '', 'FooTests.cs': '' }, runner: 'dotnet test', runs: ['dotnet test'] },
  { language: '.NET', files: { 'Lib.fsproj': '', 'FooTests.fs': '' }, runner: 'dotnet test', runs: ['dotnet test'] },
  { language: '.NET', files: { 'Lib.vbproj': '', 'FooTests.vb': '' }, runner: 'dotnet test', runs: ['dotnet test'] },
  { language: '.NET', files: { 'App.slnx': '', 'tests/FooTests.cs': '' }, runner: 'dotnet test', runs: ['dotnet test'] },
  { language: 'Ruby', files: { Gemfile: '', 'spec/a_spec.rb': '' }, runner: 'bundle exec rspec', runs: ['bundle exec rspec', 'rspec', 'bin/rspec', './bin/rspec'] },
  { language: 'Ruby', files: { Gemfile: '', 'test/a_test.rb': '' }, runner: 'bundle exec rake test', runs: ['bundle exec rake test', 'bin/rails test', 'bundle exec rails test', './bin/rails test'] },
  { language: 'Ruby', files: { Rakefile: '', 'test/a_test.rb': '' }, runner: 'rake test', runs: ['rake test', 'rake spec'] },
  { language: 'PHP', files: { 'composer.json': '{}', 'FooTest.php': '' }, runner: 'vendor/bin/phpunit', runs: ['vendor/bin/phpunit', './vendor/bin/phpunit', 'phpunit', 'php vendor/bin/phpunit', 'php -d memory_limit=-1 vendor/bin/phpunit', 'vendor/bin/pest', 'php artisan test'] },
  { language: 'PHP', files: { 'composer.json': COMPOSER_TEST }, runner: 'composer test', runs: ['composer test', 'composer run test', 'composer run-script test'] },
  { language: 'PHP', files: { 'phpunit.xml.dist': '<phpunit/>\n', 'tests/FooTest.php': '' }, runner: 'vendor/bin/phpunit', runs: ['vendor/bin/phpunit'] },
  { language: 'Swift', files: { 'Package.swift': '', 'Tests/FooTests.swift': '' }, runner: 'swift test', runs: ['swift test', 'swift test --parallel'] },
  { language: 'Elixir', files: { 'mix.exs': '', 'test/x_test.exs': '' }, runner: 'mix test', runs: ['mix test', 'MIX_ENV=test mix test'] },
  { language: 'Flutter', files: { 'pubspec.yaml': FLUTTER_PUBSPEC, 'test/a_test.dart': '' }, runner: 'flutter test', runs: ['flutter test'] },
  { language: 'Dart', files: { 'pubspec.yaml': DART_PUBSPEC, 'test/a_test.dart': '' }, runner: 'dart test', runs: ['dart test', 'dart run test'] },
  { language: 'Makefile', files: { Makefile: 'test:\n\tgo vet\n' }, runner: 'make test', runs: ['make test', 'make -C app tests'] },
];

// Commands that look like a test run and are not one: a build, an install, a look-alike, a question.
const NOT_RUNS = ['dotnet build', 'dotnet tool install x', 'swift build', 'mix compile', 'mix deps.get', 'flutter build apk', 'flutter pub get', 'dart analyze', 'dart pub get', 'rake build',
  'bundle install', 'gem install rspec', 'composer install', 'phpunit --version', 'echo dotnet test', 'rspec-lint', 'swift-test', 'bin/pytest-watch', '.venv/bin/python -m pip install pytest', 'php artisan serve', 'python3x -m pytest'];

test('test commands: every language with files has a case here', () => {
  const covered = new Set(CASES.map((c) => c.language));
  for (const { language, files } of TEST_LANGUAGES) if (files.length) assert.ok(covered.has(language), language);
});

test('test commands: doctor names the runner of each language, and adopt names the same one (#546)', () => {
  for (const { language, files, runner } of CASES) {
    const name = `${language}: ${Object.keys(files).join(', ')}`;
    assert.deepEqual(testLanguages(project(files)), [{ language, runner }], name);
    assert.equal(testsStep(files).what, `this looks like a ${language} project, and no workflow runs its tests with \`${runner}\``, name);
    const adopt = adoptTests(files);
    assert.equal(adopt?.status, 'done', name);
    assert.equal(adopt?.evidence, `\`${runner}\` (${language})`, name);
  }
});

test('test commands: a workflow that runs the command of a language counts as running the tests (#546)', () => {
  for (const { language, files, runs } of CASES) {
    for (const run of runs) assert.equal(testsStep({ ...files, ...workflow(run) }).done, true, `${language}: ${run}`);
  }
});

test('test commands: a build, an install or a look-alike is no test run, in any project (#546)', () => {
  for (const { files } of [{ files: {} }, ...CASES]) {
    for (const run of NOT_RUNS) assert.equal(testsStep({ ...files, ...workflow(run) }).done, false, `${Object.keys(files).join(', ') || 'no files'}: ${run}`);
  }
});

test('test commands: a project with none of the files is not found, and gets the usual three (#546)', () => {
  const look = {
    'App.csproj.bak': '', 'Gemfile.lock': '', 'composer.lock': '', 'Package.resolved': '', 'mix.lock': '', 'pubspec.lock': '', '.csproj': '',
    // A Makefile with no test target is no test command.
    Makefile: 'build:\n\tcc main.c\n',
  };
  for (const files of [{}, look]) {
    assert.deepEqual(testLanguages(project(files)), []);
    assert.equal(testsStep(files).what, 'no workflow runs a test command such as `go test`, `pytest` or `cargo test`');
    assert.equal(adoptTests(files)?.status, 'missing');
  }
});

test('test commands: a pubspec.yaml is Flutter only when it depends on the Flutter SDK (#546)', () => {
  assert.deepEqual(testLanguages(project({ 'pubspec.yaml': FLUTTER_PUBSPEC })).map((l) => l.language), ['Flutter']);
  assert.deepEqual(testLanguages(project({ 'pubspec.yaml': DART_PUBSPEC })).map((l) => l.language), ['Dart']);
  // `flutter test` counts in any project; `dart test` too.
  assert.equal(testsStep({ 'pubspec.yaml': DART_PUBSPEC, ...workflow('flutter test') }).done, true);
});

test('test commands: a project in two languages gets both runners, in table order (#546)', () => {
  const files = { 'mix.exs': '', 'go.mod': '', 'x_test.go': 'package x\n', 'test/x_test.exs': '' };
  assert.equal(testsStep(files).what, 'this looks like a Go and Elixir project, and no workflow runs its tests with `go test` or `mix test`');
  assert.equal(adoptTests(files)?.status, 'done');
  assert.equal(adoptTests(files)?.evidence, '`go test` or `mix test` (Go, Elixir)');
});

test('test commands: a project file alone is no tests; adopt names the command for when tests exist (#551)', () => {
  const alone: { files: Record<string, string>; runner: string; language: string }[] = [
    { files: { 'go.mod': 'module example.com/x\n' }, runner: 'go test', language: 'Go' },
    { files: { 'requirements.txt': 'requests\n' }, runner: 'pytest', language: 'Python' },
    { files: { 'Cargo.toml': '[package]\n' }, runner: 'cargo test', language: 'Rust' },
    { files: { 'pom.xml': '<project/>\n' }, runner: 'mvn test', language: 'Maven' },
    { files: { 'build.gradle': '' }, runner: 'gradle test', language: 'Gradle' },
    { files: { 'deno.json': '{}' }, runner: 'deno test', language: 'Deno' },
    { files: { 'App.csproj': '<Project/>\n' }, runner: 'dotnet test', language: '.NET' },
    { files: { Gemfile: '' }, runner: 'bundle exec rake test', language: 'Ruby' },
    { files: { Rakefile: '' }, runner: 'rake test', language: 'Ruby' },
    { files: { 'composer.json': '{}' }, runner: 'vendor/bin/phpunit', language: 'PHP' },
    { files: { 'phpunit.xml.dist': '<phpunit/>\n' }, runner: 'vendor/bin/phpunit', language: 'PHP' },
    { files: { 'Package.swift': '' }, runner: 'swift test', language: 'Swift' },
    { files: { 'mix.exs': '' }, runner: 'mix test', language: 'Elixir' },
    { files: { 'pubspec.yaml': FLUTTER_PUBSPEC }, runner: 'flutter test', language: 'Flutter' },
    { files: { 'pubspec.yaml': DART_PUBSPEC }, runner: 'dart test', language: 'Dart' },
  ];
  for (const { files, runner, language } of alone) {
    const name = `${language}: ${Object.keys(files).join(', ')}`;
    assert.deepEqual(testLanguages(project(files)), [{ language, runner }], `${name}: still found`);
    const adopt = adoptTests(files);
    assert.equal(adopt?.status, 'missing', name);
    assert.equal(adopt?.evidence, `\`${runner}\` (${language}) once tests exist`, name);
  }
  // A Makefile with no test target is no test command at all.
  const bare = adoptTests({ Makefile: 'build:\n\tcc main.c\n' });
  assert.equal(bare?.status, 'missing');
  assert.equal(bare?.evidence, 'no test command found (package.json, Makefile or a project file such as go.mod)');
});

test('test commands: composer test counts only when composer.json has a test script, as npm test does (#546)', () => {
  assert.equal(testsStep({ 'composer.json': COMPOSER_TEST, ...workflow('composer test') }).done, true);
  assert.equal(testsStep({ 'composer.json': '{}', ...workflow('composer test') }).done, false);
  assert.equal(testsStep({ 'composer.json': JSON.stringify({ scripts: { lint: 'phpcs' } }), ...workflow('composer test') }).done, false);
  assert.equal(testsStep(workflow('composer test')).done, false);
});

test('test commands: a pubspec.yaml with many blank lines is read in linear time (#546)', () => {
  const pubspec = `name: app\n${'\n'.repeat(200_000)}x`;
  const started = performance.now();
  assert.deepEqual(testLanguages(project({ 'pubspec.yaml': pubspec })), [{ language: 'Dart', runner: 'dart test' }]);
  assert.ok(performance.now() - started < 500, 'a blank-line run must not make the Flutter check slow');
});
