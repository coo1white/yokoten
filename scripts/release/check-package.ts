// The npm package, end to end (#31): `npm pack`, install the tarball into a throwaway
// folder, and run what a new user runs. Run it before a release: npm run check-package
//
// Everything happens under one temp folder. HOME points there too, so `install` never
// touches your home folder. The install is --offline: the package has no dependencies,
// so it needs no network, and a dependency would make it fail.
//
// It needs `npm ci` first, for tsc. So it is not named *-test.ts: `node --test` would
// run it, and the test job in CI installs nothing.
import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const IS_WINDOWS = process.platform === 'win32';

const base = mkdtempSync(join(tmpdir(), 'yokoten-package-'));
const home = join(base, 'home');
const app = join(base, 'app');
const repo = join(base, 'repo');
for (const dir of [home, app, repo]) mkdirSync(dir);

// A clean environment: no real HOME, no npm settings from a parent `npm run`, commit times in UTC.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  npm_config_cache: join(base, 'npm-cache'),
  npm_config_update_notifier: 'false',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
};

function run(file: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  // npm and npx are .cmd files on Windows, which need a shell.
  return spawnSync(file, args, { cwd, env, encoding: 'utf8', shell: IS_WINDOWS });
}

/** Run a step; on a failure, stop with its output. */
function step(name: string, file: string, args: string[], cwd: string, { okCodes = [0] }: { okCodes?: number[] } = {}): SpawnSyncReturns<string> {
  const result = run(file, args, cwd);
  if (result.status === null || !okCodes.includes(result.status)) throw new Error(`${name} failed (exit ${result.status})\n${result.stdout}${result.stderr}${result.error ?? ''}`);
  process.stdout.write(`ok  ${name}\n`);
  return result;
}

try {
  // 1. Pack. The prepack script builds dist/ first.
  step('npm pack', 'npm', ['pack', '--pack-destination', base], ROOT);
  const tarballs = readdirSync(base).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `one tarball expected in the temp folder, found: ${tarballs.join(', ')}`);
  const tarball = join(base, tarballs[0]);

  // 2. Install it, offline, into a new folder.
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'check-package-app', private: true }));
  step('npm install <tarball> --offline', 'npm', ['install', '--offline', tarball], app);
  const installed = join(app, 'node_modules', 'yokoten');
  for (const path of ['dist/bin/yokoten.js', 'dist/bin/yokoten.mjs', 'bin/yokoten.ts', 'bin/yokoten.mjs', 'src/setup/files.ts', 'kit/project/AGENTS.md']) assert.ok(existsSync(join(installed, path)), `the package has no ${path}`);
  assert.ok(!existsSync(join(installed, 'test')), 'the package ships test/');
  assert.ok(!existsSync(join(installed, 'node_modules')), 'the package installed dependencies');

  // 3. The command a user types. The bin link runs dist/bin/yokoten.js.
  const bin = join(app, 'node_modules', '.bin', IS_WINDOWS ? 'yokoten.cmd' : 'yokoten');
  assert.equal(step('yokoten --version', bin, ['--version'], app).stdout.trim(), VERSION);
  assert.match(step('npx yokoten help', 'npx', ['--no', 'yokoten', 'help'], app).stdout, /yokoten init/);

  // 4. install: the machine layer, into the temp HOME. The machine copy runs as .ts.
  step('yokoten install', bin, ['install'], app);
  const machineCli = join(home, '.local', 'share', 'yokoten', 'bin', 'yokoten.ts');
  assert.ok(existsSync(machineCli), 'install wrote no machine copy');
  assert.equal(step('the machine copy runs', process.execPath, [machineCli, '--version'], app).stdout.trim(), VERSION);

  // 5. init in a new git repo; then the vendored copy the hooks run, and doctor.
  step('git init', 'git', ['init', '-q', '-b', 'main'], repo);
  step('yokoten init', bin, ['init'], repo);
  for (const path of ['.yokoten/bin/yokoten.ts', '.yokoten/bin/yokoten.mjs', 'AGENTS.md', '.githooks/pre-commit']) assert.ok(existsSync(join(repo, path)), `init wrote no ${path}`);
  step('node .yokoten/bin/yokoten.ts check', process.execPath, [join(repo, '.yokoten', 'bin', 'yokoten.ts'), 'check'], repo);
  // The guard as the hooks run it, through yokoten.mjs (#408): a tag push is refused (exit 2).
  const push = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin v1.0.0' }, cwd: repo });
  const guard = spawnSync(process.execPath, [join(repo, '.yokoten', 'bin', 'yokoten.mjs'), 'hook', '--json'], { cwd: repo, env, input: push, encoding: 'utf8' });
  assert.equal(guard.status, 2, `the guard let a tag push through (exit ${guard.status})\n${guard.stdout}${guard.stderr}`);
  assert.equal(JSON.parse(guard.stdout).finding?.id, 'release', 'the guard did not refuse a tag push as a release');
  process.stdout.write('ok  the guard, through .yokoten/bin/yokoten.mjs\n');
  // doctor exits 1 while the project has steps left, as a new one does. A crash exits 1
  // too, but then stdout holds no report.
  const doctor = step('yokoten doctor', bin, ['doctor', '--json'], repo, { okCodes: [0, 1] });
  const report = JSON.parse(doctor.stdout);
  assert.ok(report && typeof report === 'object', 'doctor printed no report');
  assert.equal(doctor.stderr, '', `doctor wrote to stderr: ${doctor.stderr}`);

  process.stdout.write(`check-package: ok (Node ${process.version})\n`);
} catch (err) {
  process.stderr.write(`check-package: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(base, { recursive: true, force: true });
}
