// The test command of each language (#546), in one table. doctor's tests step reads it for
// the commands that count as running the tests in CI, and for the command its advice names;
// `yokoten adopt` reads it for the test command a project has. So both give one answer.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Command patterns. road.ts builds its npm and workspaces patterns from these too. ----

/**
 * A command pattern, matched one word at a time (#322): from the word indexes a match can
 * be at, the indexes it can be at after this part. A regex that repeats a group over a long
 * line backtracks once per repeat, and V8 throws a RangeError on a big enough line.
 */
export type Pattern = (words: string[], at: number[]) => number[];
/** One word, by a test on it. */
export const wordIf =
  (isMatch: (word: string) => boolean): Pattern =>
  (words, at) =>
    at.filter((i) => i < words.length && isMatch(words[i])).map((i) => i + 1);
/** One of these words, whole: "make test-deps" and "jest-preview" are not runs. */
export const word = (...names: string[]) => wordIf((w) => names.includes(w));
export const anyWord = wordIf(() => true);
export const sequence =
  (...parts: Pattern[]): Pattern =>
  (words, at) =>
    parts.reduce((from, part) => part(words, from), at);
/** Any of the parts. The indexes stay in order with no repeats, merged in one pass. */
export const either =
  (...parts: Pattern[]): Pattern =>
  (words, at) => {
    const results = parts.map((part) => part(words, at)).filter((result) => result.length > 0);
    if (results.length < 2) return results[0] ?? [];
    const isFound = new Uint8Array(words.length + 1);
    for (const result of results) for (const i of result) isFound[i] = 1;
    const found: number[] = [];
    for (let i = 0; i <= words.length; i++) if (isFound[i]) found.push(i);
    return found;
  };
export const optional = (...parts: Pattern[]) => either(sequence(), sequence(...parts));
/**
 * Zero or more steps. `step` names the indexes one step reaches from index `i`, each past `i`.
 * One pass from the first index to the last one reached, so the time is linear.
 */
const repeated =
  (step: (words: string[], i: number, reach: (after: number) => void) => void): Pattern =>
  (words, at) => {
    if (at.length === 0) return at;
    const isReached = new Uint8Array(words.length + 1);
    for (const i of at) isReached[i] = 1;
    let last = at[at.length - 1];
    const reach = (after: number) => {
      isReached[after] = 1;
      last = Math.max(last, after);
    };
    const found: number[] = [];
    for (let i = at[0]; i <= last; i++) {
      if (!isReached[i]) continue;
      found.push(i);
      step(words, i, reach);
    }
    return found;
  };
const isFlag = (word: string | undefined) => word !== undefined && word.length > 1 && word.startsWith('-');
// Flags with no value, as tools take them before the command: npx --yes, node --experimental-strip-types.
const FLAGS = repeated((words, i, reach) => {
  if (isFlag(words[i])) reach(i + 1);
});
// Flags that may take a value: npm -w app, pnpm --filter app.
export const VALUED = repeated((words, i, reach) => {
  if (!isFlag(words[i])) return;
  reach(i + 1);
  if (i + 1 < words.length && !words[i + 1].startsWith('-')) reach(i + 2);
});
// make's flags, and `-C dir` with its folder as the next word.
const MAKE_FLAGS = repeated((words, i, reach) => {
  if (isFlag(words[i])) reach(i + 1);
  if (words[i] === '-C' && i + 1 < words.length) reach(i + 2);
});
/** Whether `pattern` matches at the start of a command, split into its words at whitespace, as `\s` does. */
export const matches = (pattern: Pattern, words: string[]) => pattern(words, [0]).length > 0;

// ---- The table. ----

/** One language: how to tell a project is in it, the command to suggest, and the commands that run its tests. */
export interface TestLanguage {
  language: string;
  /** Names at the project root that show the language. `*.csproj` is any name with that ending. Empty: never found by file. */
  files: string[];
  /** A further test, when a file alone does not tell (a Flutter pubspec.yaml, a Makefile with a test target). */
  is?: (root: string) => boolean;
  /** The command to suggest for a project found by its files. */
  runner: string | ((root: string) => string);
  /** Commands that run the tests, each matched at the start of a command. They count in any project. */
  runs: Pattern[];
  /** Commands that count only when the project defines them, as a package.json script does for npm. */
  scripted?: { has: (root: string) => boolean; runs: Pattern[] };
}

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const json = (path: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(read(path) || 'null');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};
const names = (root: string): string[] => {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
};
const hasFile = (found: string[], file: string) => (file.startsWith('*') ? found.some((n) => n.length > file.length - 1 && n.endsWith(file.slice(1))) : found.includes(file));

// Tools that start a Node runner: npx, bunx, npm exec, pnpm (exec, dlx), yarn (run).
const NODE_EXEC = optional(either(sequence(word('npx', 'bunx'), FLAGS), sequence(word('npm'), word('exec'), FLAGS, optional(word('--'))), sequence(word('pnpm', 'yarn'), optional(word('exec', 'dlx', 'run')))));
// Tools that start a Python runner: uv run, uvx, pipx run, poetry run, pipenv run.
const PY_EXEC = optional(either(word('uvx'), sequence(word('uv', 'pipx', 'poetry', 'pipenv'), word('run'))), FLAGS);
// A Python module run as a program: python -m, coverage run -m.
const PY_M = sequence(either(word('python', 'python3'), sequence(word('coverage'), word('run'))), word('-m'));
// Ruby's tools, run alone or through Bundler: bundle exec rspec.
const BUNDLE = optional(word('bundle'), word('exec'));

const MAKEFILES = ['Makefile', 'makefile', 'GNUmakefile'];
const makeTarget = (root: string) => {
  const text = MAKEFILES.map((f) => read(join(root, f))).join('\n');
  return /^test\s*:/m.test(text) ? 'test' : /^tests\s*:/m.test(text) ? 'tests' : '';
};
const composerTest = (root: string) => {
  const scripts = json(join(root, 'composer.json')).scripts;
  return Boolean(scripts && typeof scripts === 'object' && Object.hasOwn(scripts, 'test'));
};
// A Flutter app or package names the Flutter SDK as a dependency: `flutter: {sdk: flutter}`.
const isFlutter = (root: string) => /^\s+sdk:\s*["']?flutter["']?\s*(?:#.*)?$/m.test(read(join(root, 'pubspec.yaml')));
const hasRspec = (root: string) => names(root).some((n) => n === '.rspec' || n === 'spec');

/**
 * The languages, in the order doctor names them. The first three are its suggestion when
 * no file is found. A project found in more than one language gets each runner.
 */
export const TEST_LANGUAGES: TestLanguage[] = [
  { language: 'Go', files: ['go.mod'], runner: 'go test', runs: [sequence(word('go'), word('test'))] },
  {
    language: 'Python',
    files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'requirements.txt'],
    runner: 'pytest',
    runs: [sequence(PY_EXEC, optional(PY_M), word('pytest', 'tox', 'nox')), sequence(PY_EXEC, PY_M, word('unittest'))],
  },
  { language: 'Rust', files: ['Cargo.toml'], runner: 'cargo test', runs: [sequence(word('cargo'), word('test'))] },
  { language: 'Maven', files: ['pom.xml'], runner: 'mvn test', runs: [sequence(word('mvn', 'mvnw', './mvn', './mvnw'), FLAGS, word('test'))] },
  { language: 'Gradle', files: ['build.gradle', 'build.gradle.kts'], runner: 'gradle test', runs: [sequence(word('gradle', 'gradlew', './gradle', './gradlew'), FLAGS, word('test'))] },
  { language: 'Deno', files: ['deno.json', 'deno.jsonc'], runner: 'deno test', runs: [sequence(word('deno'), word('test'))] },
  { language: '.NET', files: ['*.csproj', '*.fsproj', '*.vbproj', '*.sln', '*.slnx'], runner: 'dotnet test', runs: [sequence(word('dotnet'), word('test'))] },
  {
    language: 'Ruby',
    files: ['Gemfile', 'Rakefile'],
    runner: (root) => {
      const bundled = names(root).includes('Gemfile') ? 'bundle exec ' : '';
      return `${bundled}${hasRspec(root) ? 'rspec' : 'rake test'}`;
    },
    // rspec, rake test or spec, rails test; each also as bin/ binstubs and through bundle exec.
    runs: [sequence(BUNDLE, either(word('rspec', 'bin/rspec'), sequence(word('rake', 'bin/rake'), word('test', 'spec')), sequence(word('rails', 'bin/rails'), word('test'))))],
  },
  {
    language: 'PHP',
    files: ['composer.json', 'phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml'],
    runner: (root) => (composerTest(root) ? 'composer test' : 'vendor/bin/phpunit'),
    runs: [sequence(optional(word('php')), word('phpunit', 'vendor/bin/phpunit', './vendor/bin/phpunit'))],
    // composer test runs the test script of composer.json, and fails with none.
    scripted: { has: composerTest, runs: [sequence(word('composer'), optional(word('run', 'run-script')), word('test'))] },
  },
  { language: 'Swift', files: ['Package.swift'], runner: 'swift test', runs: [sequence(word('swift'), word('test'))] },
  { language: 'Elixir', files: ['mix.exs'], runner: 'mix test', runs: [sequence(word('mix'), word('test'))] },
  { language: 'Flutter', files: ['pubspec.yaml'], is: isFlutter, runner: 'flutter test', runs: [sequence(word('flutter'), word('test'))] },
  { language: 'Dart', files: ['pubspec.yaml'], is: (root) => !isFlutter(root), runner: 'dart test', runs: [sequence(word('dart'), optional(word('run')), word('test'))] },
  { language: 'Makefile', files: MAKEFILES, is: (root) => makeTarget(root) !== '', runner: (root) => `make ${makeTarget(root)}`, runs: [sequence(word('make'), MAKE_FLAGS, word('test', 'tests'))] },
  // Node runners that need no package.json script. A Node project is found by its script, not here.
  { language: 'Node.js', files: [], runner: '', runs: [sequence(word('node'), FLAGS, word('--test')), sequence(NODE_EXEC, word('vitest', 'jest'))] },
];

/** Every command that runs the tests, whatever the project. */
export const TEST_RUNS: Pattern[] = TEST_LANGUAGES.flatMap((l) => l.runs);

/** The commands that count in this project only, because it defines them. */
export const scriptedRuns = (root: string): Pattern[] => TEST_LANGUAGES.flatMap((l) => (l.scripted?.has(root) ? l.scripted.runs : []));

const runnerOf = (l: TestLanguage, root: string) => (typeof l.runner === 'string' ? l.runner : l.runner(root));

/** The languages this project is in, by the files at its root, each with the command to suggest. */
export const testLanguages = (root: string): { language: string; runner: string }[] => {
  const found = names(root);
  return TEST_LANGUAGES.filter((l) => l.files.some((f) => hasFile(found, f)) && (l.is?.(root) ?? true)).map((l) => ({ language: l.language, runner: runnerOf(l, root) }));
};

/** The suggestion when no file is found: the first three runners. */
export const FALLBACK_RUNNERS = TEST_LANGUAGES.slice(0, 3).map((l) => runnerOf(l, ''));

/** Commands as code, joined by commas and a last "or": `go test`, `pytest` or `cargo test`. */
export const orList = (runners: string[]) => {
  const named = runners.map((r) => `\`${r}\``);
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named.at(-1)}` : (named[0] ?? '');
};
