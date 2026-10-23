// The test command of each language (#546), in one table. doctor's tests step reads it for
// the commands that count as running the tests in CI, for whether a workflow runs them,
// and for the command its advice names; `yokoten adopt` reads it for the test command a
// project has, and whether it has tests (#551, #576). So both give one answer. `yokoten init`
// reads it for the tests job (#550).

import { type Dirent, readdirSync, readFileSync } from 'node:fs';
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
  /**
   * Whether the project has tests for this language: test files of that language, or a
   * test script. A folder named test, tests, spec or __tests__ is not enough (#576).
   * A project file alone (go.mod, Gemfile, ...) is not enough (#551). Runs on one scan
   * of the project. None means the files alone are enough: a Makefile with a test
   * target, found only with one.
   */
  hasTests?: (root: string, scan: TestScan) => boolean;
}

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const readJson = (path: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(readText(path) || 'null');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};
const listNames = (root: string): string[] => {
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
/** A program by name, or by a path to it, as a virtualenv runs it: `.venv/bin/python`. */
const program = (...names: string[]) => wordIf((w) => names.some((name) => w === name || w.endsWith(`/${name}`)));
// A Python module run as a program: python -m, coverage run -m.
const isPython = (w: string) => /^(?:.*\/)?python(?:3(?:\.\d+)?)?$/.test(w);
const PY_M = sequence(either(wordIf(isPython), sequence(program('coverage'), word('run'))), word('-m'));
// Ruby's tools, run alone or through Bundler: bundle exec rspec.
const BUNDLE = optional(word('bundle'), word('exec'));

const MAKEFILES = ['Makefile', 'makefile', 'GNUmakefile'];
const makeTarget = (root: string) => {
  const text = MAKEFILES.map((f) => readText(join(root, f))).join('\n');
  return /^test\s*:/m.test(text) ? 'test' : /^tests\s*:/m.test(text) ? 'tests' : '';
};
const composerTest = (root: string) => {
  const scripts = readJson(join(root, 'composer.json')).scripts;
  return Boolean(scripts && typeof scripts === 'object' && Object.hasOwn(scripts, 'test'));
};
// A Flutter app or package names the Flutter SDK as a dependency: `flutter: {sdk: flutter}`.
// Spaces and tabs only: `\s+` would cross blank lines, and the time would grow with their square.
const isFlutter = (root: string) => /^[ \t]+sdk:[ \t]*["']?flutter["']?[ \t]*(?:#.*)?$/m.test(readText(join(root, 'pubspec.yaml')));
const hasRspec = (root: string) => listNames(root).some((n) => n === '.rspec' || n === 'spec');

// ---- Finding the tests themselves (#551, #576). ----

/** Folders the test scan never enters: installs and build output (dot folders never hold tests either). */
const SCAN_SKIP = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', '_build', '__pycache__', '.dart_tool', 'Pods', 'DerivedData']);

/** What a scan of the project found: folder names in lowercase, and file paths with `/`. */
export interface TestScan {
  /** Lowercase folder names. Not used to decide that a language has tests (#576). */
  folders: string[];
  files: string[];
}

/** Every folder and file under the root, leaving out version control, installs, and build output. Links are not followed. */
export const scanTests = (root: string): TestScan => {
  const folders: string[] = [];
  const files: string[] = [];
  const visit = (dir: string, relative: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SCAN_SKIP.has(entry.name)) continue;
        folders.push(entry.name.toLowerCase());
        visit(join(dir, entry.name), `${relative}${entry.name}/`);
      } else if (entry.isFile()) {
        files.push(`${relative}${entry.name}`);
      }
    }
  };
  visit(root, '');
  return { folders, files };
};

/** The file name in a scanned path. */
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** Whether the scan found a file with a test name. */
const hasTestFile = (scan: TestScan, isTest: (name: string) => boolean) => scan.files.some((path) => isTest(baseName(path)));
/**
 * A test name in the suffix style (`FooTest.java`, `FooTests.cs`, `Foo.Test.csproj`): ends
 * with Test(s) after a word of its own, so `contest` and `latest` do not count.
 */
const isSuffixTest = (name: string) => /(?:^|[._-]|\p{Ll})Tests?\.[^.]+$/u.test(name);
/** Extensions of a `Test*` file under `src/test`: Java, and Kotlin on the JVM. */
const JVM_TEST_EXTENSION = /\.(?:java|kt)$/;
/**
 * A Java or JVM test file Maven Surefire or the Gradle test task runs by name.
 * `*Test`, `*Tests`, `*TestCase.java` and `*IT.java` count wherever they sit.
 * A `Test` prefix (`TestFoo.java`, `TestFoo.kt`) counts under `src/test` only.
 * `src/main` stays production code, so `TestUtils.java` there does not count (#576).
 */
const isJavaBuildTest = (path: string): boolean => {
  const name = baseName(path);
  if (isSuffixTest(name) || name.endsWith('IT.java') || name.endsWith('TestCase.java')) return true;
  return name.startsWith('Test') && JVM_TEST_EXTENSION.test(name) && /(?:^|\/)src\/test\//.test(path);
};
/**
 * The attribute names the .NET test runners find: xUnit, NUnit and MSTest.
 * `Attribute` on the end is the same attribute written out. A longer word
 * (`TestInitialize`, `Testing`) does not count.
 */
const DOTNET_ATTRIBUTE_NAME = String.raw`(?:[A-Za-z_][\w]{0,40}\.){0,3}(?:Fact|Theory|DataTestMethod|TestMethod|TestCase|TestFixture|TestClass|Test)(?:Attribute)?(?![A-Za-z0-9_])`;
/** C# `[Fact]` and F# `[<Fact>]`. A generic such as `List<Test>` has no square bracket, so it does not count. */
const CSHARP_TEST_ATTRIBUTE = new RegExp(String.raw`\[<?${DOTNET_ATTRIBUTE_NAME}`);
/** VB writes the same attributes with angle brackets: `<Fact>` or `<TestMethod()>`. */
const VB_TEST_ATTRIBUTE = new RegExp(`<${DOTNET_ATTRIBUTE_NAME}`);
/** A .NET source file. `bin/` and `obj/` are build output, not a test the project keeps. */
const isDotnetSource = (path: string): boolean => /\.(?:cs|fs|vb)$/.test(path) && !/(?:^|\/)(?:bin|obj)\//.test(path);

// Comments and string text are not attributes. The scan drops them first, the way the
// C#, F# and VB compilers skip them, then the attribute check reads what remains (#576).

/** C#, F# or VB. */
type DotnetKind = 'cs' | 'fs' | 'vb';
/** Code kept from one stretch of source, and where to read on from. */
interface DotnetWalk {
  code: string;
  at: number;
}
/**
 * How one string is read. `doubles` means `""` is one quote.
 * `backslash` means a backslash escapes the next character.
 * `endOnNewline` means a newline ends the string.
 */
interface StringMode {
  closer: string;
  dollars: number;
  doubles: boolean;
  backslash: boolean;
  endOnNewline: boolean;
}

/** Code with comments and string text removed, so an attribute in either does not count. */
const dotnetCode = (text: string, source: DotnetKind): string => scanDotnet(text, 0, 0, source).code;

/** Whether `Rem` at `at` is a VB comment: a whole word after a space, a colon or a new line. */
const isVbRem = (text: string, at: number): boolean => {
  if (!/^rem(?![A-Za-z0-9_])/i.test(text.slice(at, at + 4))) return false;
  const before = at === 0 ? '\n' : text[at - 1];
  return before === '\n' || before === '\r' || before === ' ' || before === '\t' || before === ':';
};

/** The index after an F# `(* *)` comment. Nested comments count. */
const skipFsComment = (text: string, at: number): number => {
  let depth = 1;
  let cursor = at + 2;
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === '(' && text[cursor + 1] === '*') {
      depth++;
      cursor += 2;
    } else if (text[cursor] === '*' && text[cursor + 1] === ')') {
      depth--;
      cursor += 2;
    } else cursor++;
  }
  return cursor;
};

/** The index after a comment that starts at `at`, or `at` when none does. */
const skipDotnetComment = (text: string, at: number, source: DotnetKind): number => {
  const next = text[at + 1] ?? '';
  if (source !== 'vb' && text[at] === '/' && next === '/') {
    let cursor = at + 2;
    while (cursor < text.length && text[cursor] !== '\n') cursor++;
    return cursor;
  }
  if (source === 'cs' && text[at] === '/' && next === '*') {
    const close = text.indexOf('*/', at + 2);
    return close < 0 ? text.length : close + 2;
  }
  if (source === 'fs' && text[at] === '(' && next === '*') return skipFsComment(text, at);
  if (source === 'vb' && (text[at] === "'" || isVbRem(text, at))) {
    let cursor = text[at] === "'" ? at + 1 : at + 3;
    while (cursor < text.length && text[cursor] !== '\n') cursor++;
    return cursor;
  }
  return at;
};

/** A C# or F# character literal: `'a'`, `'\n'`, `'\u0041'`. Not an F# type such as `'a`. */
const CHAR_LITERAL = /^'(?:\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\\x[0-9a-fA-F]{1,4}|\\.|[^'\\\r\n])'/;
/** The index after a character literal at `at`, or `at` when there is none. */
const charLiteralEnd = (text: string, at: number): number => {
  if (text[at] !== "'") return at;
  const match = CHAR_LITERAL.exec(text.slice(at, at + 14));
  return match ? at + match[0].length : at;
};

/**
 * The code inside an interpolation hole at `{`, or nothing when the braces are literal.
 * One `$` makes `{{` a brace and `{` a hole. Each added `$` adds one brace to both.
 */
function readDotnetHole(text: string, at: number, dollars: number, source: DotnetKind): DotnetWalk {
  let run = 0;
  while (text[at + run] === '{') run++;
  if (run < dollars || run >= dollars * 2) {
    const width = run >= dollars * 2 ? dollars * 2 : run;
    return { code: '', at: at + width };
  }
  return scanDotnet(text, at + dollars, dollars, source);
}

/** The hole code inside the string that starts at `start`, and the index after the string. */
function readDotnetString(text: string, start: number, source: DotnetKind, mode: StringMode): DotnetWalk {
  const parts: string[] = [];
  let at = start;
  while (at < text.length) {
    const char = text[at];
    if (mode.endOnNewline && (char === '\n' || char === '\r')) return { code: parts.join(''), at };
    if (mode.backslash && char === '\\' && text[at + 1] !== '\n' && text[at + 1] !== '\r') {
      at += at + 1 < text.length ? 2 : 1;
      continue;
    }
    if (mode.dollars > 0 && char === '{') {
      const hole = readDotnetHole(text, at, mode.dollars, source);
      // A hole that does not move would loop on this same brace.
      if (hole.at <= at) return { code: parts.join(''), at };
      parts.push(hole.code);
      at = hole.at;
      continue;
    }
    if (text.startsWith(mode.closer, at)) {
      if (mode.doubles && mode.closer === '"' && text[at + 1] === '"') {
        at += 2;
        continue;
      }
      return { code: parts.join(''), at: at + mode.closer.length };
    }
    at++;
  }
  return { code: parts.join(''), at };
}

/** The string at `at`, or null when none starts there. Hole code is kept. String text is not. */
function skipDotnetString(text: string, at: number, source: DotnetKind): DotnetWalk | null {
  let cursor = at;
  let dollars = 0;
  let isVerbatim = false;
  if (source !== 'vb' && text[cursor] === '@') {
    isVerbatim = true;
    cursor++;
    if (text[cursor] === '$') {
      dollars = 1;
      cursor++;
    }
  } else if (text[cursor] === '$') {
    while (text[cursor] === '$') {
      dollars++;
      cursor++;
    }
    if (source !== 'vb' && text[cursor] === '@') {
      isVerbatim = true;
      cursor++;
    }
  }
  if (text[cursor] !== '"') return null;
  let quotes = 0;
  while (text[cursor + quotes] === '"') quotes++;
  // A raw C# string and an F# triple quote hide their text. `@"` stays a verbatim string.
  if (quotes >= 3 && !isVerbatim) {
    const width = source === 'fs' ? 3 : quotes;
    return readDotnetString(text, cursor + width, source, { closer: '"'.repeat(width), dollars, doubles: false, backslash: false, endOnNewline: false });
  }
  // Plain strings use a backslash. VB and verbatim strings use doubled quotes.
  const isPlain = !isVerbatim && source !== 'vb';
  return readDotnetString(text, cursor + 1, source, {
    closer: '"',
    dollars,
    doubles: !isPlain,
    backslash: isPlain,
    endOnNewline: isPlain || source === 'vb',
  });
}

/** One pass over `text`. `holeDollars` is 0 in the file, and the `$` count inside a hole. */
function scanDotnet(text: string, start: number, holeDollars: number, source: DotnetKind): DotnetWalk {
  const parts: string[] = [];
  let at = start;
  let depth = 0;
  while (at < text.length) {
    if (holeDollars > 0 && depth === 0 && text[at] === '}') {
      let run = 0;
      while (text[at + run] === '}') run++;
      if (run >= holeDollars) return { code: parts.join(''), at: at + holeDollars };
    }
    const comment = skipDotnetComment(text, at, source);
    if (comment > at) {
      at = comment;
      continue;
    }
    if (source !== 'vb') {
      const charEnd = charLiteralEnd(text, at);
      if (charEnd > at) {
        at = charEnd;
        continue;
      }
    }
    const literal = skipDotnetString(text, at, source);
    if (literal) {
      // A string that does not move would loop on this same quote.
      if (literal.at <= at) return { code: parts.join(''), at };
      parts.push(literal.code);
      at = literal.at;
      continue;
    }
    const char = text[at];
    if (char === '{') depth++;
    else if (char === '}' && depth > 0) depth--;
    parts.push(char);
    at++;
  }
  return { code: parts.join(''), at };
}

/** Whether the scan holds a .NET test attribute in code. A comment or a string does not count. */
const hasDotnetTestAttribute = (root: string, scan: TestScan): boolean =>
  scan.files.some((path) => {
    if (!isDotnetSource(path)) return false;
    const source = path.endsWith('.vb') ? 'vb' : path.endsWith('.fs') ? 'fs' : 'cs';
    const text = dotnetCode(readText(join(root, path)), source);
    return (source === 'vb' ? VB_TEST_ATTRIBUTE : CSHARP_TEST_ATTRIBUTE).test(text);
  });

/**
 * The languages, in the order doctor names them. The first three are its suggestion when
 * no file is found. A project found in more than one language gets each runner.
 */
export const TEST_LANGUAGES: TestLanguage[] = [
  {
    language: 'Go', files: ['go.mod'], runner: 'go test', runs: [sequence(word('go'), word('test'))],
    hasTests: (_, scan) => hasTestFile(scan, (name) => name.endsWith('_test.go')),
  },
  {
    language: 'Python',
    files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'requirements.txt'],
    runner: 'pytest',
    runs: [sequence(PY_EXEC, optional(PY_M), program('pytest', 'tox', 'nox')), sequence(PY_EXEC, PY_M, word('unittest'))],
    hasTests: (_, scan) => hasTestFile(scan, (name) => /(?:^test_.*|.*_test|conftest)\.py$/.test(name)),
  },
  {
    language: 'Rust', files: ['Cargo.toml'], runner: 'cargo test', runs: [sequence(word('cargo'), word('test'))],
    // Unit tests live in the sources, so a `#[test]` in any Rust file counts too.
    hasTests: (root, scan) => hasTestFile(scan, (name) => name.endsWith('_test.rs')) || scan.files.some((path) => path.endsWith('.rs') && readText(join(root, path)).includes('#[test]')),
  },
  {
    language: 'Maven', files: ['pom.xml'], runner: 'mvn test', runs: [sequence(word('mvn', 'mvnw', './mvn', './mvnw'), FLAGS, word('test'))],
    hasTests: (_, scan) => scan.files.some(isJavaBuildTest),
  },
  {
    language: 'Gradle', files: ['build.gradle', 'build.gradle.kts'], runner: 'gradle test', runs: [sequence(word('gradle', 'gradlew', './gradle', './gradlew'), FLAGS, word('test'))],
    hasTests: (_, scan) => scan.files.some(isJavaBuildTest),
  },
  {
    language: 'Deno', files: ['deno.json', 'deno.jsonc'], runner: 'deno test', runs: [sequence(word('deno'), word('test'))],
    hasTests: (_, scan) => hasTestFile(scan, (name) => /^(?:test|tests|.*[._]test)\.(?:mts|cts|ts|tsx|mjs|cjs|js|jsx)$/.test(name)),
  },
  {
    language: '.NET', files: ['*.csproj', '*.fsproj', '*.vbproj', '*.sln', '*.slnx'], runner: 'dotnet test', runs: [sequence(word('dotnet'), word('test'))],
    // A suffix name, or a test attribute in source. A comment or a string does not count (#576).
    hasTests: (root, scan) => hasTestFile(scan, isSuffixTest) || hasDotnetTestAttribute(root, scan),
  },
  {
    language: 'Ruby',
    files: ['Gemfile', 'Rakefile'],
    runner: (root) => {
      const bundled = listNames(root).includes('Gemfile') ? 'bundle exec ' : '';
      return `${bundled}${hasRspec(root) ? 'rspec' : 'rake test'}`;
    },
    // rspec, rake test or spec, rails test; each also as bin/ binstubs and through bundle exec.
    runs: [sequence(BUNDLE, either(word('rspec', 'bin/rspec', './bin/rspec'), sequence(word('rake', 'bin/rake', './bin/rake'), word('test', 'spec')), sequence(word('rails', 'bin/rails', './bin/rails'), word('test'))))],
    hasTests: (_, scan) => hasTestFile(scan, (name) => /(?:_spec|_test)\.rb$/.test(name)),
  },
  {
    language: 'PHP',
    files: ['composer.json', 'phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml'],
    runner: (root) => (composerTest(root) ? 'composer test' : 'vendor/bin/phpunit'),
    // phpunit or Pest, alone or through php with its flags (php -d memory_limit=-1); Laravel's artisan test.
    runs: [
      sequence(optional(word('php'), VALUED), word('phpunit', 'vendor/bin/phpunit', './vendor/bin/phpunit', 'pest', 'vendor/bin/pest', './vendor/bin/pest')),
      sequence(word('php'), word('artisan'), word('test')),
    ],
    // composer test runs the test script of composer.json, and fails with none.
    scripted: { has: composerTest, runs: [sequence(word('composer'), optional(word('run', 'run-script')), word('test'))] },
    // A composer test script is a test script, and counts with no test files (#551).
    hasTests: (root, scan) => composerTest(root) || hasTestFile(scan, isSuffixTest),
  },
  {
    language: 'Swift', files: ['Package.swift'], runner: 'swift test', runs: [sequence(word('swift'), word('test'))],
    hasTests: (_, scan) => hasTestFile(scan, isSuffixTest),
  },
  {
    language: 'Elixir', files: ['mix.exs'], runner: 'mix test', runs: [sequence(word('mix'), word('test'))],
    hasTests: (_, scan) => hasTestFile(scan, (name) => name.endsWith('_test.exs')),
  },
  {
    language: 'Flutter', files: ['pubspec.yaml'], is: isFlutter, runner: 'flutter test', runs: [sequence(word('flutter'), word('test'))],
    hasTests: (_, scan) => hasTestFile(scan, (name) => name.endsWith('_test.dart')),
  },
  {
    language: 'Dart', files: ['pubspec.yaml'], is: (root) => !isFlutter(root), runner: 'dart test', runs: [sequence(word('dart'), optional(word('run')), word('test'))],
    hasTests: (_, scan) => hasTestFile(scan, (name) => name.endsWith('_test.dart')),
  },
  { language: 'Makefile', files: MAKEFILES, is: (root) => makeTarget(root) !== '', runner: (root) => `make ${makeTarget(root)}`, runs: [sequence(word('make'), MAKE_FLAGS, word('test', 'tests'))] },
  // Node runners that need no package.json script. A Node project is found by its script, not here.
  { language: 'Node.js', files: [], runner: '', runs: [sequence(word('node'), FLAGS, word('--test')), sequence(NODE_EXEC, word('vitest', 'jest'))] },
];

/** Every command that runs the tests, whatever the project. */
export const TEST_RUNS: Pattern[] = TEST_LANGUAGES.flatMap((l) => l.runs);

/** The commands that count in this project only, because it defines them. */
export const scriptedRuns = (root: string): Pattern[] => TEST_LANGUAGES.flatMap((l) => (l.scripted?.has(root) ? l.scripted.runs : []));

/**
 * The shell lines that the workflows run: each `run:` value, one line, or each line of a
 * `run: |` block. A job id, a matrix item or a comment is never a command. Each line is
 * matched on its own, so no pattern can run across a newline.
 */
export const runLines = (ci: string): string[] => {
  const lines: string[] = [];
  const text = ci.split(/\r?\n/);
  for (let i = 0; i < text.length; i++) {
    const key = /^([ \t]*(?:-[ \t]+)?)run:(?:[ \t]+(.*))?$/.exec(text[i]);
    if (!key) continue;
    const value = (key[2] ?? '').trim();
    if (/^[|>][-+0-9]*(?:[ \t]+#.*)?$/.test(value)) {
      // A block: the lines indented more than the `run` key, with `\` continuations joined.
      let line = '';
      for (; i + 1 < text.length && (text[i + 1].trim() === '' || /^[ \t]*/.exec(text[i + 1])![0].length > key[1].length); i++) {
        const next = text[i + 1].trim();
        if (!next) continue;
        line = line ? `${line} ${next}` : next;
        if (!line.endsWith('\\')) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
    } else if (!value.startsWith('#')) lines.push(value.replace(/^(["'])(.*)\1$/, '$2'));
  }
  return lines;
};
// What a command may start with before its name: an opening "(", a `VAR=value`, `env`, `time`.
// One is matched at a time, from where the last one ended (#322).
const PREFIX = /\(\s*|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+|(env\s+)|time\s+/y;
const ENV_FLAG = /-\S+\s+/y;
/** Where the command name starts: past the prefixes, each matched in a loop, so the time is linear in the line. */
const prefixEnd = (command: string) => {
  let at = 0;
  for (;;) {
    PREFIX.lastIndex = at;
    const prefix = PREFIX.exec(command);
    if (!prefix) return at;
    at = PREFIX.lastIndex;
    // `env` may take flags before the command: env -i node --test.
    for (ENV_FLAG.lastIndex = at; prefix[1] && ENV_FLAG.exec(command); ) at = ENV_FLAG.lastIndex;
  }
};
/**
 * The simple commands in a shell line: split at ;, &, |, with an opening "(" and any
 * `VAR=value`, `env` or `time` before the command taken off. Comments go.
 */
export const commands = (line: string): string[] =>
  line
    .split(/[;&|]+/)
    .map((c) => c.trim())
    .map((c) => c.slice(prefixEnd(c)))
    .filter((c) => c && !c.startsWith('#'));
/** A command that only asks a tool about itself. */
const ASKS = /\s--(?:version|help)(?=\s|$)/;
/** The package.json "test" script, run by its package manager. */
const RUNS_SCRIPT = sequence(word('npm', 'pnpm', 'yarn', 'bun'), optional(word('run')), word('test', 't'));
const WORKSPACES_FLAGS = ['--workspace', '--workspaces', '-ws', '-w'];
const isWorkspacesFlag = (w: string) => WORKSPACES_FLAGS.some((flag) => w === flag || w.startsWith(`${flag}=`));
/** Only when a later word is a workspaces flag. */
const NPM_WORKSPACES: Pattern = (words, at) => (words.slice(1).some(isWorkspacesFlag) ? at : []);
/** In a workspaces repo, commands that run each package's "test" script; the root may have none. */
const RUNS_WORKSPACES: Pattern[] = [
  // npm takes its flags anywhere: npm test --workspaces, npm -w app test, npm run test -ws.
  sequence(word('npm'), NPM_WORKSPACES, VALUED, optional(word('run')), word('test', 't')),
  sequence(word('pnpm'), VALUED, either(word('-r', '--recursive'), wordIf((w) => w.startsWith('--filter=') && w.length > '--filter='.length), sequence(word('--filter', '-F'), anyWord)), VALUED, optional(word('run')), word('test')),
  sequence(word('yarn'), word('workspaces'), optional(word('foreach'), VALUED), word('run'), word('test')),
];
/**
 * Whether the workflow text runs the tests: the package.json "test" script (`script`, or
 * empty), each package's script in a workspaces repo, or a test runner named outright.
 * `scripted` adds the commands that count in this project only, such as `composer test`.
 */
export const runsTests = (ci: string, script: string, workspaces: boolean, scripted: Pattern[] = []) => {
  const lines = runLines(ci);
  const run = lines
    .flatMap(commands)
    .filter((c) => !ASKS.test(c))
    .map((c) => c.split(/\s+/));
  const runners = scripted.length ? [...TEST_RUNS, ...scripted] : TEST_RUNS;
  if (run.some((words) => runners.some((r) => matches(r, words)))) return true;
  if (script !== '' && (run.some((words) => matches(RUNS_SCRIPT, words)) || lines.some((l) => l.includes(script)))) return true;
  return workspaces && run.some((words) => RUNS_WORKSPACES.some((r) => matches(r, words)));
};

const runnerOf = (l: TestLanguage, root: string) => (typeof l.runner === 'string' ? l.runner : l.runner(root));

/** The languages this project is in, by the files at its root. */
const detectedLanguages = (root: string, found: string[]): TestLanguage[] =>
  TEST_LANGUAGES.filter((l) => l.files.some((f) => hasFile(found, f)) && (l.is?.(root) ?? true));

/** The languages this project is in, by the files at its root, each with the command to suggest. */
export const testLanguages = (root: string): { language: string; runner: string }[] =>
  detectedLanguages(root, listNames(root)).map((l) => ({ language: l.language, runner: runnerOf(l, root) }));

/**
 * The languages this project is in that have tests: test files of that language, or a
 * test script (#551, #576). Reads the project once, and only when a language is found.
 */
export const languagesWithTests = (root: string): { language: string; runner: string }[] => {
  const found = detectedLanguages(root, listNames(root));
  if (!found.length) return [];
  const scan = scanTests(root);
  return found.filter((l) => l.hasTests?.(root, scan) ?? true).map((l) => ({ language: l.language, runner: runnerOf(l, root) }));
};

/** The suggestion when no file is found: the first three runners. */
export const FALLBACK_RUNNERS = TEST_LANGUAGES.slice(0, 3).map((l) => runnerOf(l, ''));

/** Commands as code, joined by commas and a last "or": `go test`, `pytest` or `cargo test`. */
export const orList = (runners: string[]) => {
  const named = runners.map((r) => `\`${r}\``);
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named.at(-1)}` : (named[0] ?? '');
};
