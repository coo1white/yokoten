// The shape of the code, checked. A rule about structure that no test holds drifts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findDeclarations, findNameProblems, splitWords, tokenize } from '../src/run/names.ts';
import { HOME_DIR, homeDirOf } from '../src/setup/files.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// Lowest first. A module may import from its own layer or a lower one, never a higher.
// rules: what is allowed, as pure functions. run: the checks at work (hook, commit, CI).
// agents: one adapter per AI runtime, and llama.ts, the model API that adopt calls.
// host: one adapter per code host (the bot, a CI run's pull request). setup: writing
// yokoten into a machine or a project.
const LAYERS = ['rules', 'run', 'agents', 'host', 'setup'];

test('layers: no module imports from a layer above its own', () => {
  const found = new Set<string>();
  for (const layer of readdirSync(SRC)) {
    assert.ok(LAYERS.includes(layer), `src/${layer}/ is not in LAYERS: add it, in order`);
    // A layer may have folders of its own (src/setup/advice/); their files belong to it.
    const files = readdirSync(join(SRC, layer), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    for (const entry of files) {
      const file = relative(join(SRC, layer), join(entry.parentPath, entry.name));
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      for (const [, spec] of text.matchAll(/from '(\.[^']+)'/g)) {
        const target = relative(SRC, join(entry.parentPath, spec)).split(/[\\/]/)[0];
        found.add(`${layer}->${target}`);
        assert.ok(LAYERS.indexOf(target) <= LAYERS.indexOf(layer), `src/${layer}/${file} imports ${spec}, from the higher layer ${target}`);
      }
    }
  }
  assert.ok(found.size > 0, 'the import scan found nothing; the pattern is broken');
});

// A step names what it needs in host-neutral words; only src/host/ talks to a host's API
// (record 0004). Then adding a host (Gitea) means one new adapter, not a change in each step.
const HOST_API = /api\.github\.com|\bgh api\b|GITHUB_EVENT_PATH/;
const namesHostApi = (files: Record<string, string>) => Object.keys(files).filter((p) => !p.startsWith('src/host/') && HOST_API.test(files[p]));

test('host: nothing outside src/host/ names a GitHub API (#33)', () => {
  assert.deepEqual(namesHostApi({ 'src/setup/a.ts': 'run gh api repos/x', 'src/rules/b.ts': 'env.GITHUB_EVENT_PATH', 'bin/c.ts': 'https://api.github.com', 'src/host/github.ts': 'https://api.github.com', 'src/run/d.ts': 'gh pr view' }), ['src/setup/a.ts', 'src/rules/b.ts', 'bin/c.ts']);
  const files: Record<string, string> = {};
  for (const path of execFileSync('git', ['ls-files', 'bin', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)) files[path] = readFileSync(join(ROOT, path), 'utf8');
  assert.ok(Object.keys(files).some((p) => p.startsWith('src/host/') && HOST_API.test(files[p])), 'src/host/ names no API; the scan is broken');
  assert.deepEqual(namesHostApi(files), [], 'move the host call into an adapter in src/host/');
});

test('AGENTS.md: the core rules here are the kit\'s, word for word', () => {
  const core = (path: string) => readFileSync(join(ROOT, path), 'utf8').split('\n## This project')[0];
  assert.equal(core('AGENTS.md'), core('kit/project/AGENTS.md'), 'change kit/project/AGENTS.md and copy it here, or the other way round');
});

// A tag can be moved to other code; a commit can't. Every action is pinned to a full
// commit, with the version it is in a comment for people and Dependabot. A local
// action (`./path`) is code in the repo and needs no pin.
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/;
const unpinned = (text: string) =>
  [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/gm)].map((m) => m[1]).filter((ref) => !ref.startsWith('./') && !PINNED.test(ref));

test('workflows: every action is pinned to a commit, the version in a comment', () => {
  assert.deepEqual(unpinned('      - uses: actions/checkout@v4\n        uses: a/b@main\n      - uses: ./local\n'), ['actions/checkout@v4', 'a/b@main']);
  assert.deepEqual(unpinned(`      - uses: a/b@${'0'.repeat(40)}\n`), [`a/b@${'0'.repeat(40)}`], 'a pin with no version comment');
  let seen = 0;
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(ROOT, dir, file), 'utf8');
      seen += [...text.matchAll(/uses:/g)].length;
      assert.deepEqual(unpinned(text), [], `${dir}/${file}: pin each action to a commit, as \`owner/repo@<40 hex> # vX.Y.Z\``);
    }
  }
  // The action other repos run (#106) pins what it uses the same way.
  const action = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  assert.ok(/uses:/.test(action), 'action.yml: no `uses:` found; the scan is broken');
  assert.deepEqual(unpinned(action), [], 'action.yml: pin each action to a commit, as `owner/repo@<40 hex> # vX.Y.Z`');
  assert.ok(seen > 0, 'no `uses:` found; the scan is broken');
});

// Node runs .ts as it is, so no other code file is needed; one appearing means someone
// reached for a build-era habit (AGENTS.md, "This project").
const strayCode = (paths: string[]) => paths.filter((p) => /^(bin|src|test)\//.test(p) && /\.(js|mjs|cjs|jsx|tsx|mts|cts)$/.test(p));

test('code is .ts only: no .js, .mjs, .cjs or .tsx under bin, src or test (#43)', () => {
  assert.deepEqual(strayCode(['src/a.ts', 'src/b.mjs', 'test/c.tsx', 'bin/d.js', 'kit/e.js', 'docs/f.md']), ['src/b.mjs', 'test/c.tsx', 'bin/d.js']);
  const files = execFileSync('git', ['ls-files', 'bin', 'src', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.some((f) => f.endsWith('.ts')), 'no .ts found; the scan is broken');
  assert.deepEqual(strayCode(files), [], 'write it as .ts: Node runs it with no build');
});

// ---- The npm package (#31) ----
//
// The hooks run on a fresh machine with nothing but Node, and `npx yokoten` installs one
// package, never a tree. So there are no runtime dependencies; dev ones are for tsc only.
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const runtimeDependencies = (pkg: Record<string, unknown>): string[] =>
  DEPENDENCY_FIELDS.flatMap((field) => {
    const value = pkg[field];
    if (Array.isArray(value)) return value.map((name) => `${field}: ${name}`);
    if (value && typeof value === 'object') return Object.keys(value).map((name) => `${field}: ${name}`);
    return value ? [`${field}: ${String(value)}`] : [];
  });

test('package: zero runtime dependencies (#31)', () => {
  assert.deepEqual(runtimeDependencies({ dependencies: { chalk: '^5' }, peerDependencies: {}, bundleDependencies: ['a'], devDependencies: { typescript: '^7' } }), ['dependencies: chalk', 'bundleDependencies: a']);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.devDependencies?.typescript, 'no typescript in devDependencies; the read is broken');
  assert.deepEqual(runtimeDependencies(pkg), [], 'yokoten uses Node\'s standard library only (AGENTS.md, "This project")');
});

// Node does not strip types under node_modules, so the package runs the built .js in dist/.
// dist/ is made at pack time and never committed; the repo runs the .ts files.
test('package: the bin is the build, made at pack time and git-ignored (#31)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.yokoten, 'dist/bin/yokoten.js');
  for (const part of ['bin', 'src', 'kit', 'dist']) assert.ok(pkg.files.includes(part), `package.json files has no ${part}`);
  assert.match(pkg.scripts.prepack, /scripts\/build\.ts/);
  assert.equal(execFileSync('git', ['check-ignore', 'dist/bin/yokoten.js'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'dist/bin/yokoten.js');
});

test('package: the runtime finds its home from the .ts and from the built .js (#31)', () => {
  assert.equal(homeDirOf(join('/pkg', 'src', 'setup', 'files.ts')), join('/pkg'));
  assert.equal(homeDirOf(join('/pkg', 'dist', 'src', 'setup', 'files.js')), join('/pkg'));
  assert.equal(HOME_DIR, ROOT);
});

// The ruleset on main names one check, `ci`. So `ci` must wait for every other job in
// its workflow, and run even when one of them failed. Then a red job turns `ci` red (#36).
// The jobs are read from the text: a job is a key two spaces in under `jobs:`.
const jobs = (text: string) => {
  const body = text.split(/^jobs:\n/m)[1] ?? '';
  return body.split(/^ {2}(?=[\w-]+:\n)/m).slice(1).map((block) => ({
    name: block.slice(0, block.indexOf(':')),
    block,
  }));
};
const ciProblems = (text: string) => {
  const all = jobs(text);
  const ci = all.find((j) => j.name === 'ci');
  if (!ci) return ['no `ci` job'];
  const problems: string[] = [];
  if (!/^ {4}if: always\(\)$/m.test(ci.block)) problems.push('`ci` has no `if: always()`');
  const needs = (ci.block.match(/^ {4}needs: \[(.*)\]$/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const j of all) if (j.name !== 'ci' && !needs.includes(j.name)) problems.push(`\`ci\` does not need \`${j.name}\``);
  for (const j of all) if (!/^ {4}timeout-minutes: \d+$/m.test(j.block)) problems.push(`\`${j.name}\` has no time limit`);
  if (!/^permissions: \{\}$/m.test(text)) problems.push('the workflow does not start from no permissions');
  return problems;
};

test('workflows: the one required check, `ci`, waits for every job (#36)', () => {
  const good = 'permissions: {}\njobs:\n  a:\n    timeout-minutes: 10\n  ci:\n    if: always()\n    needs: [a]\n    timeout-minutes: 10\n';
  assert.deepEqual(ciProblems(good), []);
  assert.deepEqual(ciProblems(good.replace('jobs:\n', 'jobs:\n  b:\n    timeout-minutes: 5\n')), ['`ci` does not need `b`']);
  assert.deepEqual(ciProblems(good.replace('    if: always()\n', '')), ['`ci` has no `if: always()`']);
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    const text = readFileSync(join(ROOT, dir, 'yokoten.yml'), 'utf8');
    assert.ok(jobs(text).length > 1, `${dir}/yokoten.yml: no jobs found; the scan is broken`);
    assert.deepEqual(ciProblems(text), [], `${dir}/yokoten.yml`);
  }
});

test('workflows: checkout keeps no token (#36)', () => {
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(ROOT, dir, file), 'utf8');
      const checkouts = [...text.matchAll(/uses: actions\/checkout@.*\n((?: {8,}.*\n)*)/g)];
      for (const c of checkouts) assert.match(c[1], /persist-credentials: false/, `${dir}/${file}: add \`persist-credentials: false\` to checkout`);
    }
  }
});

// ---- Names (#109, record 0006) ----
//
// The names we declare in src/, bin/ and test/ follow the rule in AGENTS.md. The reader lives
// in src/run/names.ts, where `check --pr` uses it too. A test may still use a one-letter name
// inside a short block (10 lines or fewer).

test('names: words are counted from camelCase, PascalCase and CONSTANT_CASE (#109)', () => {
  assert.deepEqual(splitWords('loadHttpUrl'), ['load', 'Http', 'Url']);
  assert.deepEqual(splitWords('loadHTTPUrl'), ['load', 'HTTP', 'Url']);
  assert.deepEqual(splitWords('CODEOWNERS_PLACES'), ['CODEOWNERS', 'PLACES']);
  assert.deepEqual(splitWords('sha256Hex'), ['sha256', 'Hex']);
  assert.deepEqual(splitWords('_'), []);
});

test('names: the reader catches each kind of bad name (#109)', () => {
  const bad = [
    'export const x = 1;',
    'function load(_unused: string, value_: number, _: boolean) {',
    '  const MAX_TRIES = 3;',
    '  let i = 0;',
    ...Array(10).fill('  i++;'),
    '  return MAX_TRIES + i;',
    '}',
    'const processTheUserInputDataNow = () => 1;',
    'interface Shape { q: number; size: number }',
    'const [_, second] = pair;',
  ].join('\n');
  assert.deepEqual(findNameProblems(bad).map((problem) => `${problem.line}: ${problem.kind}: ${problem.what}`), [
    '1: one-letter: "x" is one letter, and exported',
    '2: underscore: "_unused" starts or ends with "_"',
    '2: underscore: "value_" starts or ends with "_"',
    '3: constant-case: "MAX_TRIES" is CONSTANT_CASE inside a function',
    '4: one-letter: "i" is used for 11 lines',
    '17: too-many-words: "processTheUserInputDataNow" has 6 words, over 4',
    '18: one-letter: "q" is one letter, and a property',
    '19: underscore: "_" names something that is not a parameter',
  ]);
  const fixes = findNameProblems(bad).map((problem) => problem.fix);
  assert.match(fixes[3], /"maxTries"/);
  assert.match(fixes[4], /"index"/);
});

test('names: strings, comments, templates and regular expressions are not read as code (#109)', () => {
  const good = [
    "const text = 'const _bad = 1; let VERY_LONG_NAME_IS_BAD';",
    'const shown = `${ { _key: 1 }._key } and ${`nested ${text}`} let _x`;',
    'const pattern = /const _x = [/]+/g; // const _comment',
    '/* let _block = 2; */',
    'const half = shown.length / 2 / 1;',
    'export function sum(list: number[]): number {',
    '  let total = 0;',
    '  for (const n of list) total += n;',
    '  return list.reduce((a, b) => a + b, total);',
    '}',
    'const ROOT_DIR = "x";',
    'const handler = { run(value: string) { return value; } };',
    'const ignore = (_: unknown, item: string) => item;',
  ].join('\n');
  assert.deepEqual(findNameProblems(good), []);
  const names = findDeclarations(tokenize(good)).map((declaration) => declaration.name);
  assert.deepEqual(names, ['text', 'shown', 'pattern', 'half', 'sum', 'list', 'total', 'n', 'a', 'b', 'ROOT_DIR', 'handler', 'run', 'value', 'ignore', '_', 'item']);
});

test('names: src/, bin/ and test/ use whole, short names (#109, #113)', () => {
  const found: string[] = [];
  const kinds = new Set<string>();
  let declared = 0;
  for (const path of execFileSync('git', ['ls-files', 'bin', 'src', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((file) => file.endsWith('.ts'))) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    const declarations = findDeclarations(tokenize(text));
    declared += declarations.length;
    for (const declaration of declarations) kinds.add(declaration.kind);
    for (const problem of findNameProblems(text)) found.push(`${path}:${problem.line}: ${problem.what}. ${problem.why}. ${problem.fix}.`);
  }
  assert.ok(declared > 500, `only ${declared} names found in src/, bin/ and test/; the reader is broken`);
  assert.deepEqual([...kinds].sort(), ['function', 'parameter', 'property', 'type', 'variable'], 'a kind of declaration was not found; the reader is broken');
  assert.deepEqual(found, [], 'rename each one; the rule and its reasons are in AGENTS.md ("Names") and docs/records/0006-names.md');
});
