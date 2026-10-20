// The shape of the code, checked. A rule about structure that no test holds drifts.
import './home.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { test } from 'node:test';
import { killedLine, makeSandbox, makeTempDir, runChild } from './helpers.ts';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../../src/run/cli.ts';
import { findDeclarations, findNameProblems, splitWords, type Token, tokenize } from '../../src/run/names.ts';
import { HOME_DIR, homeDirOf } from '../../src/setup/files.ts';
import { assertLinear } from '../../scripts/linear.ts';
import { TEST_HOME } from './home.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');

// Lowest first. A module may import from its own layer or a lower one, never a higher.
// rules: what is allowed, as pure functions. run: the checks at work (hook, commit, CI).
// agents: one adapter per AI runtime, and llama.ts, the model API that adopt calls.
// host: one adapter per code host (the bot, a CI run's pull request). setup: writing
// yokoten into a machine or a project. commands: one module per command or small group,
// which bin/main.ts calls (#330).
const LAYERS = ['rules', 'run', 'agents', 'host', 'setup', 'commands'];

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

// One test file per src module, at the module's own path: src/run/check.ts is tested in
// test/run/check.test.ts (#152). A branch that changes a module adds its tests, and their
// imports, to that module's file, so parallel branches do not meet in one import block.
// Next to the layer folders, test/ holds repo/: this file and the shared helpers, which
// check the repo as a whole, not one src module.
const TEST_TOP = ['repo/architecture.test.ts', 'repo/helpers.ts', 'repo/home.ts'];
// Modules with no test file of their own. Keep it short: a new module gets its test file.
const NO_TEST_FILE = [
  'agents/agent-skills.ts', // no tests yet (#152)
  'agents/hooks-file.ts', // no tests yet (#152); the install and init tests use it
  'setup/files.ts', // no tests yet (#152); the install tests and this file use it
];

const filesUnder = (folder: string) =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(/[\\/]/).join('/'));

// What is wrong with test/, given the src modules and the test files, each by its path
// inside its folder.
function testFileProblems(modules: string[], tests: string[]): string[] {
  const problems: string[] = [];
  for (const path of tests) {
    if (TEST_TOP.includes(path)) continue;
    const module = path.replace(/\.test\.ts$/, '.ts');
    if (module === path || !modules.includes(module)) problems.push(`test/${path} is not the test file of a src module (src/${module})`);
  }
  for (const module of modules) {
    const hasFile = tests.includes(module.replace(/\.ts$/, '.test.ts'));
    if (!hasFile && !NO_TEST_FILE.includes(module)) problems.push(`src/${module} has no test/${module.replace(/\.ts$/, '.test.ts')}`);
    if (hasFile && NO_TEST_FILE.includes(module)) problems.push(`src/${module} has a test file now: take it off NO_TEST_FILE`);
  }
  for (const module of NO_TEST_FILE) if (!modules.includes(module)) problems.push(`NO_TEST_FILE names src/${module}, which is not there`);
  return problems;
}

test('test files: each one is the test file of a src module, at the same path (#152)', () => {
  const modules = ['run/check.ts', 'setup/advice/adopt.ts', ...NO_TEST_FILE];
  assert.deepEqual(testFileProblems(modules, ['repo/architecture.test.ts', 'repo/helpers.ts', 'run/check.test.ts', 'setup/advice/adopt.test.ts']), []);
  assert.deepEqual(testFileProblems(modules, ['run/check.test.ts', 'setup/advice/adopt.test.ts', 'run/gone.test.ts', 'run/check/pr.test.ts', 'run/util.ts', 'top.test.ts']), [
    'test/run/gone.test.ts is not the test file of a src module (src/run/gone.ts)',
    'test/run/check/pr.test.ts is not the test file of a src module (src/run/check/pr.ts)',
    'test/run/util.ts is not the test file of a src module (src/run/util.ts)',
    'test/top.test.ts is not the test file of a src module (src/top.ts)',
  ]);
  const tests = filesUnder(join(ROOT, 'test'));
  assert.ok(tests.includes('run/check.test.ts'), 'test/run/check.test.ts not found; the scan is broken');
  assert.deepEqual(
    testFileProblems(filesUnder(SRC), tests).filter((problem) => problem.startsWith('test/')),
    [],
    'name each test file after its src module, or put shared code in test/repo/helpers.ts',
  );
});

test('test files: every src module has one, but the few on NO_TEST_FILE (#152)', () => {
  assert.deepEqual(testFileProblems(['run/check.ts', 'run/new.ts', ...NO_TEST_FILE], ['run/check.test.ts', 'setup/files.test.ts']), [
    'src/run/new.ts has no test/run/new.test.ts',
    'src/setup/files.ts has a test file now: take it off NO_TEST_FILE',
  ]);
  assert.deepEqual(testFileProblems(['run/check.ts'], ['run/check.test.ts']), NO_TEST_FILE.map((module) => `NO_TEST_FILE names src/${module}, which is not there`));
  assert.deepEqual(
    testFileProblems(filesUnder(SRC), filesUnder(join(ROOT, 'test'))).filter((problem) => !problem.startsWith('test/')),
    [],
    'a new src module gets its test file next to the others',
  );
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

// This repo files issues from the kit's own templates (#169). A copy here that drifts
// from the kit means `learn` reads one set of fields here and another in every project.
// A `{{...}}` in the kit's file stands for any text in the copy.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, (mark) => `\\${mark}`);
const matchesKit = (copy: string, kit: string) => new RegExp(`^${kit.split(/\{\{[^}]*\}\}/).map(escape).join('.+?')}$`, 's').test(copy);

test('issue templates: each one here is the kit\'s, word for word; a changed copy is caught (#169)', () => {
  const kitDir = join(ROOT, 'kit/project/.github/ISSUE_TEMPLATE');
  const hereDir = join(ROOT, '.github/ISSUE_TEMPLATE');
  const kitFiles = readdirSync(kitDir);
  const shared = readdirSync(hereDir).filter((file) => kitFiles.includes(file));
  assert.ok(shared.includes('incident.yml'), 'the incident template is in both places');
  for (const file of shared) {
    const kit = readFileSync(join(kitDir, file), 'utf8');
    assert.ok(matchesKit(readFileSync(join(hereDir, file), 'utf8'), kit), `.github/ISSUE_TEMPLATE/${file}: copy kit/project/.github/ISSUE_TEMPLATE/${file} here, or the other way round`);
    // Positive control: a copy with a word changed, or a line left out, is caught.
    assert.ok(matchesKit(kit, kit));
    assert.ok(!matchesKit(kit.replace(/label: \S+/, 'label: Changed'), kit), `${file}: a changed label must be caught`);
    assert.ok(!matchesKit(kit.split('\n').slice(1).join('\n'), kit), `${file}: a missing line must be caught`);
  }
  // A placeholder in the kit matches any text there, and nowhere else.
  assert.ok(matchesKit('name: Acme (a.b)\n', 'name: {{project}}\n'));
  assert.ok(!matchesKit('title: Acme\n', 'name: {{project}}\n'));
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

// The action handles the events people run it on (#269): `check --issue` on issues, and
// on pull_request_target a notice instead of `check --pr` on the wrong commits.
const actionStep = (text: string, name: string) => text.split(/\n(?=    - )/).find((step) => step.includes(`- name: ${name}\n`)) ?? '';

test('action.yml: check --issue on issues; a notice, not check --pr, on pull_request_target (#269)', () => {
  const action = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  assert.match(action, /\n  issue-check:\n(?:    .*\n)*?    default: 'true'\n/, 'action.yml: no `issue-check` input defaulting to true');
  const issue = actionStep(action, 'yokoten check --issue');
  assert.match(issue, /if: \$\{\{ !cancelled\(\) && inputs\.issue-check == 'true' && github\.event_name == 'issues' \}\}/, 'action.yml: the `check --issue` step runs on issues when issue-check is true');
  assert.match(issue, /run: node "\$GITHUB_ACTION_PATH\/bin\/yokoten\.ts" check --issue\n/);
  const pr = actionStep(action, 'yokoten check --pr');
  assert.match(pr, /github\.event_name == 'pull_request' \}\}/, 'action.yml: `check --pr` runs on pull_request only');
  const target = action.split(/\n(?=    - )/).find((step) => step.includes("github.event_name == 'pull_request_target'")) ?? '';
  assert.match(target, /run: \|\n +echo "::notice::[^"\n]*runs on pull_request, not pull_request_target[^"\n]*"\n/, 'action.yml: on pull_request_target, a notice says the check runs on pull_request');
  assert.ok(!target.includes('check --pr"') && !/yokoten\.ts" check/.test(target), 'action.yml: the pull_request_target step must not run yokoten');
});

// Node runs .ts as it is, so no other code file is needed; one appearing means someone
// reached for a build-era habit (AGENTS.md, "This project").
// One exception: bin/yokoten.mjs, the entry the agent hooks run. A .ts entry makes Node load
// its type stripper before the compile cache is on, on every hook call (record 0013).
const ENTRY = 'bin/yokoten.mjs';
const strayCode = (paths: string[]) => paths.filter((p) => p !== ENTRY && /^(bin|src|test)\//.test(p) && /\.(js|mjs|cjs|jsx|tsx|mts|cts)$/.test(p));

test('code is .ts only: no .js, .mjs, .cjs or .tsx under bin, src or test (#43)', () => {
  assert.deepEqual(strayCode(['src/a.ts', 'src/b.mjs', 'test/c.tsx', 'bin/d.js', 'bin/main.mjs', 'kit/e.js', 'docs/f.md', ENTRY]), ['src/b.mjs', 'test/c.tsx', 'bin/d.js', 'bin/main.mjs']);
  const files = execFileSync('git', ['ls-files', 'bin', 'src', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.some((f) => f.endsWith('.ts')), 'no .ts found; the scan is broken');
  assert.deepEqual(strayCode(files), [], 'write it as .ts: Node runs it with no build');
});

// #400: a test made its folder with a bare mkdtempSync and never removed it; one machine
// held 4,000 of them. makeTempDir (test/repo/helpers.ts) removes each one when its test
// ends. A line that starts with a quote is text a test writes out, not code that runs here.
// The [d] keeps this pattern from matching its own line. test/repo/home.ts makes the test
// home folder before any test runs and removes it when the process exits (#356).
const TEMP_HELPER = 'test/repo/helpers.ts';
const TEMP_MAKERS = new Set([TEMP_HELPER, 'test/repo/home.ts']);
const findBareTempDirs = (files: Record<string, string>) =>
  Object.entries(files).flatMap(([path, text]) =>
    TEMP_MAKERS.has(path)
      ? []
      : text.split('\n').flatMap((line, index) => (!/^\s*["'`]/.test(line) && /\bmk[d]temp(Sync)?\s*\(/.test(line) ? [`${path}:${index + 1}`] : [])));

test('temp folders: tests make them with makeTempDir, not with mkdtempSync alone (#400)', () => {
  assert.deepEqual(findBareTempDirs({
    'test/a.test.ts': "const dir = mkdtempSync(join(tmpdir(), 'x-'));\nconst ok = makeTempDir('x-');\n",
    'test/b.test.ts': "  \"const root = mkdtempSync(join(tmpdir(), 'lesson-'));\",\nawait mkdtemp(prefix);\n",
    [TEMP_HELPER]:
      "const parent = mkdtempSync(join(tmpdir(), 'yokoten-test-'));\n",
  }), ['test/a.test.ts:1', 'test/b.test.ts:2']);
  const paths = execFileSync('git', ['ls-files', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((p) => p.endsWith('.ts'));
  assert.ok(paths.includes(TEMP_HELPER), 'the helper is not found; the scan is broken');
  const files = Object.fromEntries(paths.map((p) => [p, readFileSync(join(ROOT, p), 'utf8')]));
  assert.deepEqual(findBareTempDirs(files), [], `make the folder with makeTempDir from ${TEMP_HELPER}: it is removed when the test ends`);
});

// #436: a child killed by its timeout showed only `actual: null`, and a file that died later
// named no test. runChild prints the kill with the running test's name.
test('child processes: a killed child names the test that ran it (#436)', () => {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((text: string | Uint8Array) => written.push(String(text)) > 0) as typeof process.stderr.write;
  let result;
  try {
    result = runChild('node', ['-e', 'setTimeout(() => {}, 60_000)'], { timeout: 100 });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(result.signal, 'SIGTERM');
  assert.deepEqual(written, ['test "child processes: a killed child names the test that ran it (#436)": its child `node` was killed after 100 ms\n']);
  assert.equal(killedLine('a', 'git', 5, { signal: 'SIGKILL' }), 'test "a": its child `git` was killed by SIGKILL\n');
  assert.equal(killedLine('a', 'git', 5, { signal: null }), null, 'a child that ended by itself');
  const tooMuch = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
  assert.equal(killedLine('a', 'git', 5, { signal: 'SIGTERM', error: tooMuch }), 'test "a": its child `git` was killed for printing more than maxBuffer\n');
  assert.equal(runChild('node', ['-e', "process.stdout.write('x'.repeat(2 ** 21))"]).stdout.length, 2 ** 21, 'more than Node\'s 1 MB default');
  assert.equal(runChild('node', ['-e', '']).status, 0);
});

// #436: one gh call in 100 left a telemetry sender running, which wrote its device id into
// the sandbox's home after the test removed it, so removing the sandbox failed. Git's
// background maintenance can race a test the same way (#442).
test('child processes: no gh telemetry or git maintenance runs on after a test (#436)', () => {
  assert.equal((makeSandbox().env as Record<string, string>).GH_TELEMETRY, '0');
  assert.equal(process.env.GH_TELEMETRY, '0');
  assert.equal(execFileSync('git', ['config', 'maintenance.auto'], { encoding: 'utf8' }).trim(), 'false', 'no background git maintenance either');
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

// What a project gets from `init` meets the standard this repo keeps (#36), in every
// workflow file, not only yokoten.yml: pinned actions, a time limit on each job, no
// token kept by checkout, and a `ci` job (where there is one) that needs every job.
const workflowProblems = (text: string) => {
  const problems = unpinned(text).map((ref) => `\`${ref}\` is not pinned to a commit with a version comment`);
  const all = jobs(text);
  if (all.length === 0) problems.push('no jobs found');
  for (const j of all) if (!/^ {4}timeout-minutes: \d+$/m.test(j.block)) problems.push(`\`${j.name}\` has no time limit`);
  for (const c of text.matchAll(/uses: actions\/checkout@.*\n((?: {8,}.*\n)*)/g)) {
    if (!/persist-credentials: false/.test(c[1])) problems.push('a checkout keeps its token');
  }
  if (all.some((j) => j.name === 'ci')) problems.push(...ciProblems(text).filter((p) => p.startsWith('`ci`')));
  return problems;
};

test('workflows: every workflow, in the kit and here, meets the standard; a bad one is caught (#36)', () => {
  const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
  const good = `permissions: {}\njobs:\n  a:\n    timeout-minutes: 10\n    steps:\n      - uses: ${checkout}\n        with:\n          persist-credentials: false\n  ci:\n    if: always()\n    needs: [a]\n    timeout-minutes: 10\n`;
  assert.deepEqual(workflowProblems(good), []);
  const bad = 'permissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n  b:\n    timeout-minutes: 5\n  ci:\n    if: always()\n    needs: [a]\n    timeout-minutes: 10\n';
  assert.deepEqual(workflowProblems(bad), [
    '`actions/checkout@v4` is not pinned to a commit with a version comment',
    '`a` has no time limit',
    'a checkout keeps its token',
    '`ci` does not need `b`',
  ]);
  // This repo's own workflows too, so the two never drift apart.
  for (const folder of ['.github/workflows', 'kit/project/.github/workflows']) {
    const files = readdirSync(join(ROOT, folder)).filter((f) => /\.ya?ml$/.test(f));
    assert.ok(files.includes('yokoten.yml'), `${folder}: no yokoten.yml; the scan is broken`);
    for (const file of files) assert.deepEqual(workflowProblems(readFileSync(join(ROOT, folder, file), 'utf8')), [], `${folder}/${file}`);
  }
  const dir = 'kit/project/.github/workflows';
  // The workflows lint themselves, and Dependabot keeps the pinned actions current.
  const kitWorkflow = readFileSync(join(ROOT, dir, 'yokoten.yml'), 'utf8');
  assert.ok(jobs(kitWorkflow).some((j) => j.name === 'lint' && /actionlint/.test(j.block)), `${dir}/yokoten.yml: no \`lint\` job that runs actionlint`);
  const dependabot = readFileSync(join(ROOT, 'kit/project/.github/dependabot.yml'), 'utf8');
  assert.match(dependabot, /package-ecosystem: github-actions/, 'kit/project/.github/dependabot.yml: Dependabot must keep the actions bumped');
});

// ---- A short CI for a docs-only pull request (#438) ----
//
// The `changes` job's script runs here as CI runs it, in a real git repo. The `if:` and
// matrix expressions are read from the file and evaluated in JS: `&&`, `||`, `==`, `!=`
// and quoted strings mean the same in both. An unknown function throws, so the read can't
// pass by accident.
const WORKFLOWS = ['.github/workflows/yokoten.yml', 'kit/project/.github/workflows/yokoten.yml'];
const jobBlock = (text: string, name: string) => jobs(text).find((job) => job.name === name)?.block ?? '';
const changesScript = (text: string) => (jobBlock(text, 'changes').match(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/m)?.[1] ?? '').replace(/^ {10}/gm, '');
type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;
const evaluate = (expression: string, needs: Needs): unknown => {
  const code = expression
    .replace(/contains\(needs\.\*\.result, '(\w+)'\)/g, "contains('$1')")
    .replace(/needs\.([\w-]+)\.outputs\.([\w-]+)/g, "(needs['$1'].outputs?.['$2'] ?? '')")
    .replace(/needs\.([\w-]+)\.result/g, "needs['$1'].result");
  const contains = (value: string) => Object.values(needs).some((job) => job.result === value);
  return new Function('needs', 'contains', 'fromJSON', 'cancelled', `return (${code});`)(needs, contains, JSON.parse, () => false);
};
const inBraces = (block: string, pattern: RegExp) => {
  const found = block.match(pattern)?.[1];
  assert.ok(found, `no match for ${pattern}; the read is broken`);
  return found;
};
const jobCondition = (block: string) => inBraces(block, /^ {4}if: \$\{\{ (.+) \}\}$/m);
const ciRule = (text: string) => inBraces(jobBlock(text, 'ci'), /^ {6}- if: >-\n((?: {10}.*\n)+)/m).replace(/\s*\n\s*/g, ' ').trim();
// The results `ci` sees: `changes` with its output, then each job's result.
const results = (docsOnly: string, jobResults: Record<string, string>): Needs => ({
  changes: { result: docsOnly === '' ? 'failure' : 'success', outputs: docsOnly === '' ? {} : { docs_only: docsOnly } },
  ...Object.fromEntries(Object.entries(jobResults).map(([name, result]) => [name, { result }])),
});

test('ci: `changes` finds a docs-only pull request; other files, a push, or an unread list run in full (#438)', { skip: process.platform === 'win32' && 'the script is bash' }, () => {
  const [ours, kit] = WORKFLOWS.map((path) => readFileSync(join(ROOT, path), 'utf8'));
  const script = changesScript(ours);
  assert.match(script, /docs_only=/, 'no `changes` script found; the read is broken');
  assert.equal(changesScript(kit), script, 'the kit and this repo run the same `changes` script');
  for (const text of [ours, kit]) {
    const block = jobBlock(text, 'changes');
    assert.match(block, /^ {4}permissions:\n {6}contents: read\n {4}outputs:/m, '`changes` reads the repo and nothing else');
    assert.match(block, /continue-on-error: true\n/, 'a failed checkout makes a full run, not a red `changes`');
  }
  const sandbox = makeSandbox();
  sandbox.write('README.md', '# demo\n');
  sandbox.write('src/a.ts', 'export {};\n');
  sandbox.git('add', '-A');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // A pull request from `base` that changes these files; its head commit.
  const pullRequest = (paths: string[]) => {
    sandbox.git('checkout', '-qB', 'topic', base);
    for (const path of paths) sandbox.write(path, `${path} changed\n`);
    sandbox.git('add', '-A');
    sandbox.git('commit', '-qm', 'change');
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  const runChanges = (env: Record<string, string>) => {
    const output = join(sandbox.home, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], { cwd: sandbox.repo, env: { ...sandbox.env, GITHUB_OUTPUT: output, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { output: readFileSync(output, 'utf8'), stdout: result.stdout };
  };
  const onPullRequest = (paths: string[]) => runChanges({ EVENT: 'pull_request', BASE_SHA: base, HEAD_SHA: pullRequest(paths) }).output;
  // Docs-only: the short run.
  assert.equal(onPullRequest(['docs/guide.md', 'changes/1-a.md', 'README.md', 'docs/i18n/README.md', 'CHANGELOG.md', 'src/CHANGELOG.md']), 'docs_only=true\n');
  // One file that is not docs: the full run.
  assert.equal(onPullRequest(['docs/guide.md', 'src/a.ts']), 'docs_only=false\n');
  assert.equal(onPullRequest(['kit/project/README.md']), 'docs_only=false\n', 'kit/ is what other projects get');
  assert.equal(onPullRequest(['AGENTS.md']), 'docs_only=false\n');
  assert.equal(onPullRequest(['.github/workflows/yokoten.yml']), 'docs_only=false\n');
  assert.equal(onPullRequest(['package.json']), 'docs_only=false\n');
  // A push to main: the full run.
  assert.equal(runChanges({ EVENT: 'push', BASE_SHA: '', HEAD_SHA: '' }).output, 'docs_only=false\n');
  // The file list can't be read: the full run, and a warning says why.
  const head = pullRequest(['docs/guide.md']);
  for (const [baseSha, headSha] of [['0'.repeat(40), head], ['', head], [base, ''], [head, head]]) {
    const run = runChanges({ EVENT: 'pull_request', BASE_SHA: baseSha, HEAD_SHA: headSha });
    assert.equal(run.output, 'docs_only=false\n', `base ${baseSha || '(none)'}, head ${headSha || '(none)'}`);
    assert.match(run.stdout, /^::warning::The pull request's changed files could not be read, so every job runs\.$/m);
  }
});

test('ci: a docs-only pull request runs one test job, skips typecheck and action, and `ci` is green (#438)', () => {
  const text = readFileSync(join(ROOT, WORKFLOWS[0]), 'utf8');
  const testJob = jobBlock(text, 'test');
  const matrix = (docsOnly: string) => {
    const needs = results(docsOnly, {});
    const nodes = evaluate(inBraces(testJob, /^ {8}node: \$\{\{ (.+) \}\}$/m), needs) as string[];
    const extra = evaluate(inBraces(testJob, /^ {8}include: \$\{\{ (.+) \}\}$/m), needs) as { os: string; node: string }[];
    return [...nodes.map((node) => `ubuntu-latest ${node}`), ...extra.map((entry) => `${entry.os} ${entry.node}`)];
  };
  assert.deepEqual(matrix('true'), ['ubuntu-latest 24']);
  const full = ['ubuntu-latest 22.18.0', 'ubuntu-latest 24', 'macos-latest 24'];
  assert.deepEqual(matrix('false'), full);
  assert.deepEqual(matrix(''), full, '`changes` failed: the full run');
  assert.equal(evaluate(jobCondition(testJob), results('true', {})), true, 'test runs on every pull request');
  for (const name of ['typecheck', 'action']) {
    const condition = jobCondition(jobBlock(text, name));
    assert.equal(evaluate(condition, results('true', {})), false, `${name} is skipped on a docs-only pull request`);
    assert.equal(evaluate(condition, results('false', {})), true, `${name} runs in full`);
    assert.equal(evaluate(condition, results('', {})), true, `${name} runs when \`changes\` failed`);
  }
  for (const name of ['check', 'lint']) assert.doesNotMatch(jobBlock(text, name), /^ {4}(?:if|needs):/m, `${name} runs as before, on every pull request`);
  // `ci` is red when this is true.
  const isRed = (docsOnly: string, jobResults: Record<string, string>) => evaluate(ciRule(text), results(docsOnly, jobResults));
  const green = { test: 'success', typecheck: 'success', check: 'success', lint: 'success', action: 'success' };
  const docsRun = { ...green, typecheck: 'skipped', action: 'skipped' };
  assert.equal(isRed('true', docsRun), false, 'docs-only: typecheck and action skipped on purpose');
  assert.equal(isRed('false', green), false);
  assert.equal(isRed('false', docsRun), true, 'skipped on a full run is red');
  assert.equal(isRed('true', { ...docsRun, test: 'skipped' }), true, 'test always runs');
  assert.equal(isRed('true', { ...docsRun, lint: 'skipped' }), true, 'lint always runs');
  assert.equal(isRed('true', { ...docsRun, check: 'failure' }), true);
  assert.equal(isRed('true', { ...docsRun, test: 'cancelled' }), true);
  assert.equal(isRed('', green), true, '`changes` failed: red, though the rest ran in full');
});

test('ci: the kit lets a project skip its own jobs on a docs-only pull request; check and lint always run (#438)', () => {
  const text = readFileSync(join(ROOT, WORKFLOWS[1]), 'utf8');
  // The lines the kit tells a project to give its own jobs.
  const example = inBraces(text, /^ {2}# {3}if: \$\{\{ (.+) \}\}$/m);
  assert.match(text, /^ {2}# {3}needs: changes$/m);
  assert.equal(evaluate(example, results('true', {})), false);
  assert.equal(evaluate(example, results('false', {})), true);
  assert.equal(evaluate(example, results('', {})), true, 'runs when `changes` failed');
  const isRed = (docsOnly: string, jobResults: Record<string, string>) => evaluate(ciRule(text), results(docsOnly, jobResults));
  const green = { check: 'success', lint: 'success', build: 'success' };
  assert.equal(isRed('false', green), false);
  assert.equal(isRed('true', { ...green, build: 'skipped' }), false, 'a project job skipped on a docs-only pull request');
  assert.equal(isRed('false', { ...green, build: 'skipped' }), true);
  assert.equal(isRed('true', { ...green, check: 'skipped' }), true, 'check always runs');
  assert.equal(isRed('true', { ...green, lint: 'skipped' }), true, 'lint always runs');
  assert.equal(isRed('true', { ...green, build: 'failure' }), true);
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

// The install commands have one machine-readable source, docs/facts.json, which the site
// reads (#150). The guides show the same commands, word for word; README shows npx.
type InstallStep = { cmd: string; note?: { en: string; zh: string } };
type Facts = { install: Record<string, InstallStep[]> };

/** The commands in `lists` of `facts` that `text` does not hold word for word. */
function missingCommands(facts: Facts, lists: string[], text: string): string[] {
  return lists.flatMap((list) => (facts.install[list] ?? []).map((step) => step.cmd)).filter((cmd) => !text.includes(cmd));
}

test('docs: every install command in docs/facts.json is in the guides and READMEs (#150)', () => {
  const fake: Facts = { install: { npx: [{ cmd: 'npx yokoten install' }, { cmd: 'npx yokoten uninstall' }] } };
  assert.deepEqual(missingCommands(fake, ['npx'], 'npx yokoten install\n'), ['npx yokoten uninstall']);

  const facts: Facts = JSON.parse(readFileSync(join(ROOT, 'docs/facts.json'), 'utf8'));
  assert.ok(facts.install.clone?.length && facts.install.npx?.length, 'docs/facts.json has no install.clone or install.npx; the site reads install.clone');
  for (const step of Object.values(facts.install).flat()) {
    if (step.note) assert.ok(step.note.en && step.note.zh, `"${step.cmd}": a note needs en and zh`);
  }
  const shown: [string, string[]][] = [
    ['docs/guide.md', ['npx', 'clone']],
    ['docs/i18n/zh-CN/guide.md', ['npx', 'clone']],
    ['README.md', ['npx']],
    ['docs/i18n/zh-CN/README.md', ['npx']],
    ['docs/i18n/ja/README.md', ['npx']],
    ['docs/i18n/zh-TW/README.md', ['npx']],
  ];
  for (const [file, lists] of shown) {
    assert.deepEqual(missingCommands(facts, lists, readFileSync(join(ROOT, file), 'utf8')), [], `${file} lacks these commands from docs/facts.json; change both`);
  }
});

// The guide's Commands table is typed by hand; COMMANDS in src/run/cli.ts is what the
// parser and --help read (#219). Each command needs a row, and each option must show in
// one of its rows or in the paragraph right after the table. A command with no row, like
// help and version, passes when that paragraph names `yokoten <name>`: they take no
// option, and a row would only repeat the paragraph (#230).
type GuideCommand = { name: string; options: { name: string }[] };

/** True when `text` holds `word` with no letter, digit or dash right before or after it. */
const hasWord = (text: string, word: string): boolean => new RegExp(`(?<![\\w-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);

/** What the Commands table under `heading` in `guide` lacks from `commands`, or names that `commands` lacks. */
function findGuideGaps(guide: string, heading: string, commands: GuideCommand[]): string[] {
  const lines = guide.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return [`no "${heading}" heading`];
  const tableStart = lines.findIndex((line, i) => i > start && line.startsWith('|'));
  if (tableStart < 0 || lines.slice(start + 1, tableStart).some((line) => line.startsWith('#'))) return [`no table under "${heading}"`];
  let tableEnd = tableStart;
  while (lines[tableEnd]?.startsWith('|')) tableEnd++;
  // Skip the header row and the |---| row.
  const rows = lines.slice(tableStart + 2, tableEnd);
  let paragraphEnd = tableEnd + 1;
  while (lines[paragraphEnd]?.trim()) paragraphEnd++;
  const paragraph = lines.slice(tableEnd + 1, paragraphEnd).join(' ');
  // The command a row is about: the first word of its first cell.
  const commandOf = (row: string): string => row.split('|')[1].replaceAll('`', '').trim().split(/\s+/)[0];
  const gaps: string[] = [];
  for (const row of rows) {
    const name = commandOf(row);
    if (!commands.some((command) => command.name === name)) gaps.push(`a row names "${name}", which is not in COMMANDS`);
  }
  for (const command of commands) {
    const commandRows = rows.filter((row) => commandOf(row) === command.name);
    if (!commandRows.length && !hasWord(paragraph, `yokoten ${command.name}`)) gaps.push(`${command.name}: no row`);
    for (const option of command.options) {
      const isInParagraph = hasWord(paragraph, `\`${command.name}`) && hasWord(paragraph, option.name);
      if (!commandRows.some((row) => hasWord(row, option.name)) && !isInParagraph) gaps.push(`${command.name} ${option.name}: in no row`);
    }
  }
  return gaps;
}

test('docs: the guides\' Commands table covers every command and option in COMMANDS (#230)', () => {
  const fake: GuideCommand[] = [
    { name: 'check', options: [{ name: '--json' }, { name: '--staged' }] },
    { name: 'version', options: [] },
  ];
  const table = '### Commands\n\nIntro.\n\n| Command | What |\n|---|---|\n';
  assert.deepEqual(findGuideGaps(`${table}| \`check [--staged]\` | x |\n| \`lint\` | y |\n\nRun \`yokoten version\`.\n`, '### Commands', fake), [
    'a row names "lint", which is not in COMMANDS',
    'check --json: in no row',
  ]);
  assert.deepEqual(findGuideGaps(`${table}| \`check --staged\` | x |\n\n\`check\` takes \`--json\`.\n\nRun \`yokoten version\`.\n`, '### Commands', fake), ['version: no row']);
  assert.deepEqual(findGuideGaps(`${table}| \`check --staged\` | x |\n\n\`check\` takes \`--json\`. \`yokoten version\` too.\n`, '### Commands', fake), []);

  const guides: [string, string][] = [
    ['docs/guide.md', '### Commands'],
    ['docs/i18n/zh-CN/guide.md', '### 命令'],
  ];
  for (const [file, heading] of guides) {
    assert.deepEqual(findGuideGaps(readFileSync(join(ROOT, file), 'utf8'), heading, COMMANDS), [], `${file}: its Commands table differs from COMMANDS in src/run/cli.ts`);
  }
});

// The split tool (#152) moves tests one or two folders deeper. A test that imports a script
// still finds it there; an import the tool cannot place stops it, with a list. The fixture
// repo has a script and two test files named like the real ones, so the real table places them.
function makeSplitFixture(files: Record<string, string>): string {
  const root = makeTempDir('yokoten-split-');
  const hoisted = "const ROOT = 'root';\nconst CLI = 'cli';\nconst at = '@';\nfunction makeSandbox(): string {\n  return ROOT + CLI + at;\n}\n";
  const all: Record<string, string> = {
    'test/cli.test.ts': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n\n${hoisted}\ntest('install: the helpers move', () => {\n  assert.equal(makeSandbox(), 'rootcli@');\n});\n`,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function runSplit(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/split-tests.ts'), '--from', join(root, 'test'), '--out', join(root, 'split')], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

test('split tests: an import of ../scripts/ gets the extra ../ and the moved test runs (#152)', () => {
  const root = makeSplitFixture({
    'scripts/greet.ts': 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
    'test/bot.test.ts': [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { greet } from '../scripts/greet.ts';",
      '',
      "test('board sync: a static import of a script', () => {",
      "  assert.equal(greet('board'), 'hello board');",
      '});',
      '',
      "test('board sync: a dynamic import of a script', async () => {",
      "  const module = await import('../scripts/greet.ts');",
      "  assert.equal(module.greet('sync'), 'hello sync');",
      '});',
      '',
    ].join('\n'),
  });
  const split = runSplit(root);
  assert.equal(split.status, 0, split.output);
  const moved = readFileSync(join(root, 'split/host/github.test.ts'), 'utf8');
  assert.match(moved, /^\/\/ Tests for scripts\/greet\.ts\.\n/);
  assert.match(moved, /^import \{ greet \} from '\.\.\/\.\.\/scripts\/greet\.ts';$/m);
  assert.match(moved, /await import\('\.\.\/\.\.\/scripts\/greet\.ts'\)/);
  // The child must not report to this test run, so it gets no NODE_TEST_CONTEXT.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'split/**/*.test.ts'], { cwd: root, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 3$/m);
  assert.match(run.stdout, /^# fail 0$/m);
});

test('split tests: an import it cannot place stops it with a list, and nothing is written (#152)', () => {
  const root = makeSplitFixture({
    'test/bot.test.ts': [
      "import { test } from 'node:test';",
      "import { missing } from '../scripts/missing.ts';",
      "import { packaged } from 'some-package';",
      '',
      "test('board sync: never runs', () => {",
      '  missing(packaged);',
      '});',
      '',
    ].join('\n'),
  });
  const split = runSplit(root);
  assert.equal(split.status, 1, split.output);
  assert.match(split.output, /imports this script cannot place/);
  assert.match(split.output, /test\/bot\.test\.ts:2: missing from '\.\.\/scripts\/missing\.ts': no file scripts\/missing\.ts in the repo/);
  assert.match(split.output, /test\/bot\.test\.ts:3: packaged from 'some-package': not node: and not a relative path/);
  assert.ok(!existsSync(join(root, 'split')), 'a stopped split writes nothing');
});

// Time a read by its input's length, with no real work: a busy wait as long as asked.
const busyWait = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

test('assertLinear: a quadratic read fails; a slow spell in one round does not (#343)', () => {
  // 1,000 chars take 0.6 ms; 8,000 take 64 times that when the cost is quadratic.
  const quadratic = (input: string) => busyWait(0.6 * (input.length / 1000) ** 2);
  assert.throws(() => assertLinear('quadratic', (n) => 'x'.repeat(n), quadratic, 1000), /linear is about 8x/);
  // Linear, but every big read of the first round is 200 ms slower, as on a busy runner. A round
  // has as many reads as fit in 20 ms, from one timed read, so a busy runner cuts the count
  // (#359). A 7 ms read is past 20 / 3 ms: every round has 3 reads, however busy the runner.
  let bigReads = 0;
  const noisy = (input: string) => {
    if (input.length > 1000 && ++bigReads <= 3) busyWait(200);
    busyWait(7 * (input.length / 1000));
  };
  assertLinear('linear with a slow spell', (n) => 'x'.repeat(n), noisy, 1000);
});

// No test reads or writes the real home folder (#356). test/repo/home.ts points HOME at an
// empty temp folder, so it has to load before anything else: it is each test file's first
// import. A child process inherits that HOME, unless the test gives it an env of its own
// with no HOME; then the CLI falls back to the system's home, the real one. In src, only
// privacy.ts asks the system for the home folder; the rest reads HOME from the env it is given.
const HOME_MODULE = 'repo/home.ts';
const RUNS_CHILD = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(/;

/** The object literal that starts at `open` (a `{`), braces matched; the rest of the line when it runs on. */
function literalAt(line: string, open: number): string {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '{') depth++;
    else if (line[i] === '}' && --depth === 0) return line.slice(open, i + 1);
  }
  return line.slice(open);
}

/** What breaks the rule in the test files, each given by its path inside test/ and its text. */
function homeProblems(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (path === HOME_MODULE) continue;
    const rel = posix.relative(posix.dirname(path), HOME_MODULE);
    const wanted = `import '${rel.startsWith('.') ? rel : `./${rel}`}';`;
    const lines = text.split('\n');
    const first = lines.find((line) => line.startsWith('import '));
    if (first !== wanted) problems.push(`test/${path}: the first import must be ${wanted}`);
    lines.forEach((line, i) => {
      if (!RUNS_CHILD.test(line)) return;
      for (const match of line.matchAll(/\benv: \{/g)) {
        const env = literalAt(line, (match.index ?? 0) + match[0].length - 1);
        if (!/\bHOME\b|\.\.\./.test(env)) problems.push(`test/${path}:${i + 1}: a child process gets an env with no HOME`);
      }
    });
  }
  return problems;
}

test('home: the scan finds a test file that loads the temp home late, and a child env with no HOME (#356)', () => {
  const call = 'spawnSync'; // a variable, so this file's own scan does not read the fixtures as calls
  const good = "// A test.\nimport '../repo/home.ts';\nimport assert from 'node:assert/strict';\n";
  assert.deepEqual(homeProblems({
    'run/good.test.ts': `${good}${call}('node', [CLI], { env: { ...sandbox.env, X: '1' } });\n${call}('node', [], { env: { PATH: '', HOME: temp } });\n`,
    'repo/helpers.ts': "import './home.ts';\n",
    'agents/runtimes/x.test.ts': "import '../../repo/home.ts';\n",
    'repo/home.ts': 'no imports needed\n',
  }), []);
  assert.deepEqual(homeProblems({
    'run/late.test.ts': "import assert from 'node:assert/strict';\nimport '../repo/home.ts';\n",
    'run/none.test.ts': "import { test } from 'node:test';\n",
    'run/bare.test.ts': `${good}const out = ${call}('node', [CLI, 'doctor'], { env: { PATH: process.env.PATH, TZ: 'UTC' }, encoding: 'utf8' });\n`,
  }), [
    "test/run/late.test.ts: the first import must be import '../repo/home.ts';",
    "test/run/none.test.ts: the first import must be import '../repo/home.ts';",
    'test/run/bare.test.ts:4: a child process gets an env with no HOME',
  ]);
});

test('home: every test file loads the temp home first, and no child gets an env with no HOME (#356)', () => {
  const files = Object.fromEntries(filesUnder(join(ROOT, 'test')).filter((path) => path.endsWith('.ts')).map((path) => [path, readFileSync(join(ROOT, 'test', path), 'utf8')]));
  assert.ok(Object.keys(files).length > 10, 'the test file scan found too few files; it is broken');
  assert.deepEqual(homeProblems(files), [], 'import test/repo/home.ts first; give a child process HOME, or spread an env that has it');
});

test('home: in src, only privacy.ts asks the system for the home folder (#356)', () => {
  const found = filesUnder(SRC).filter((path) => /\bhomedir\(|userInfo\(\)\.homedir/.test(readFileSync(join(SRC, path), 'utf8')));
  assert.deepEqual(found, ['rules/privacy.ts'], 'read the home folder from env.HOME (homeOf or homeIn); the CLI entry fills it in');
});

test('home: a test that reads the home folder gets the empty temp one, not the real one (#356)', () => {
  // The positive control: the plain lookups a careless test would use.
  assert.equal(homedir(), TEST_HOME);
  assert.equal(process.env.HOME, TEST_HOME);
  assert.ok(TEST_HOME.startsWith(tmpdir()), 'the test home is in the temp folder');
  let real = '';
  try {
    real = userInfo().homedir;
  } catch {
    // No password entry (some containers): there is no other home to compare with.
  }
  if (real) assert.notEqual(homedir(), real, 'homedir() in a test must not be the real home folder');
  assert.equal(existsSync(join(homedir(), '.config', 'yokoten')), false, 'the test home starts empty');
  // A child process with no env of its own inherits it.
  const child = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:os').homedir())"], { encoding: 'utf8' });
  assert.equal(child.stdout, TEST_HOME);
});

// ---- Code given to node -e (#329) ----
//
// Code built from values is code injection waiting for a hostile value (CodeQL
// js/bad-code-sanitization). The code a test gives `node -e` is fixed text: string literals,
// maybe joined. Values go in on stdin or as arguments, which the child reads as data.
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const OPENERS = new Set(['(', '[', '{', '${']);
const CLOSERS = new Set([')', ']', '}']);
const FIXED_PUNCTUATION = new Set(['[', ']', ',', '(', ')', '+', '.']);

/** The tokens of the argument that starts at `from`: up to a `,`, `)` or `]` at its own depth. */
function argumentAt(tokens: Token[], from: number): Token[] {
  let depth = 0;
  let end = from;
  for (; end < tokens.length; end++) {
    const text = tokens[end].text;
    if (depth === 0 && [',', ')', ']'].includes(text)) break;
    if (OPENERS.has(text)) depth++;
    else if (CLOSERS.has(text)) depth--;
  }
  return tokens.slice(from, end);
}

/** Whether `code` is only string literals, joined; a name is read through its `const`. */
function isFixedCode(tokens: Token[], code: Token[], before: number): boolean {
  if (code.length === 1 && code[0].kind === 'name') {
    const declared = tokens.findLastIndex((token, index) => index < before && token.text === 'const' && tokens[index + 1]?.text === code[0].text && tokens[index + 2]?.text === '=');
    if (declared === -1) return false;
    let end = declared + 3;
    let depth = 0;
    for (; end < tokens.length && !(depth === 0 && tokens[end].text === ';'); end++) {
      if (OPENERS.has(tokens[end].text)) depth++;
      else if (CLOSERS.has(tokens[end].text)) depth--;
    }
    return isFixedCode(tokens, tokens.slice(declared + 3, end), -1);
  }
  return code.length > 0 && code.every((token) => token.kind === 'string' || (token.kind === 'punct' && FIXED_PUNCTUATION.has(token.text)) || (token.kind === 'name' && token.text === 'join'));
}

/** The lines of `text` that run node with -e, --eval, -p or --print, and how many give code built from values. */
function findSplicedCode(text: string): { checked: number; lines: number[] } {
  const tokens = tokenize(text);
  const lines: number[] = [];
  let checked = 0;
  tokens.forEach((token, index) => {
    if (token.kind !== 'string' || !EVAL_FLAGS.has(token.text.replace(/^['"]|['"]$/g, '')) || tokens[index + 1]?.text !== ',') return;
    // Node reads the flag only before a script, so the flag's array holds only flags before
    // it: `[execPath, 'script.ts', '-p', ...]` is the script's -p.
    let open = index - 1;
    while (open >= 0 && (tokens[open].text === ',' || (tokens[open].kind === 'string' && /^['"]-/.test(tokens[open].text)))) open--;
    if (tokens[open]?.text !== '[' || tokens[open - 1]?.text !== ',') return;
    // Back to the `(` of the call the array is an argument of: it runs node.
    let start = open - 1;
    for (let depth = 0; start > 0; start--) {
      const text = tokens[start - 1].text;
      if (text === ';') return;
      if (CLOSERS.has(text)) depth++;
      else if (OPENERS.has(text) && depth > 0) depth--;
      else if (text === '(') break;
    }
    const runsNode = tokens.slice(start, open).some((before) => before.text === 'execPath' || /^['"]?node['"]?$/.test(before.text));
    if (!runsNode) return;
    checked++;
    if (!isFixedCode(tokens, argumentAt(tokens, index + 2), index)) lines.push(token.line);
  });
  return { checked, lines };
}

test('node -e: the reader passes fixed code and catches code built from values (#329)', () => {
  const good = [
    "spawnSync(process.execPath, ['-e', 'console.log(1)']);",
    "spawnSync(process.execPath, ['--input-type=module', '-e', 'import(process.argv[1])', pathToFileURL(path).href]);",
    "const code = ['const input = 1;', `console.log(input)`].join('\\n');",
    "spawnSync(process.execPath, ['--eval', code], { input: JSON.stringify({ path }) });",
    "execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`]);",
    "const shown = ['-e', `${value}`];",
  ].join('\n');
  assert.deepEqual(findSplicedCode(good), { checked: 3, lines: [] });
  const bad = [
    "spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path)})`]);",
    "execFileSync('node', ['--eval', 'import(' + JSON.stringify(path) + ')']);",
    'const code = `const path = ${JSON.stringify(path)};`;',
    "spawnSync(process.execPath, ['-p', code]);",
    "const lines = ['const a = 1;', JSON.stringify(path)].join('\\n');",
    "spawnSync(process.execPath, ['--print', lines]);",
    "spawnSync(process.execPath, ['-e', options.code]);",
  ].join('\n');
  assert.deepEqual(findSplicedCode(bad), { checked: 5, lines: [1, 2, 4, 6, 7] });
});

test('node -e: bin, src, scripts and test give node fixed code; values go on stdin or argv (#329)', () => {
  const found: string[] = [];
  let checked = 0;
  for (const path of execFileSync('git', ['ls-files', 'bin', 'src', 'scripts', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((file) => file.endsWith('.ts'))) {
    const result = findSplicedCode(readFileSync(join(ROOT, path), 'utf8'));
    checked += result.checked;
    for (const line of result.lines) found.push(`${path}:${line}`);
  }
  assert.ok(checked >= 2, `only ${checked} node -e calls found; the reader is broken`);
  assert.deepEqual(found, [], 'make the code fixed text; pass each value on stdin or as an argument, and import a path with import(pathToFileURL(path).href)');
});
