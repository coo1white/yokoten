// Shared by the test files: the CLI's path, the repo root, a throwaway git repo to run it in,
// and every declaration that two or more test files use. Each file imports it. Its state is
// the temp folders below, which it removes when each test ends (#400), and the template
// repos the tests copy, made once per file and removed when it ends (#475).

import './home.ts';
import { COMPILE_CACHE } from './home.ts';
import assert from 'node:assert/strict';
import {
  execFileSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  after,
  afterEach,
  beforeEach,
} from 'node:test';
import { templateRepo } from './git-template.ts';
import { sourceMarker } from '../../src/run/translations.ts';
import {
  type Gh,
  type Label,
  readServer,
  type ServerSettings,
} from '../../src/host/github/index.ts';
import type { Fact } from '../../src/setup/advice/adopt.ts';
import {
  road,
  ROAD,
} from '../../src/setup/road.ts';
import type { MachineProbe } from '../../src/setup/doctor/machine.ts';

export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'yokoten.ts');

export const at = '@';

// ---- Temp folders (#400): every test folder goes under one parent per test process. ----
// A folder made in a test is removed when that test ends, pass or fail. A folder made
// outside a test (at the top of a file) is removed with the parent when the file ends.
// Test files must use makeTempDir, never a bare mkdtempSync: the architecture test checks.

let tempParent = '';
// One list per running test, innermost last: a subtest's folders go before its parent's.
const testFolders: string[][] = [];

const removeFolder = (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 3 });

// The running tests' names, innermost last, for a child that is killed (#436). Right only while
// tests in one file run one at a time, as all do today: with `concurrency` or `describe` they
// would overlap, and the last name might be another test's.
const testNames: string[] = [];

beforeEach((t) => {
  testFolders.push([]);
  testNames.push('fullName' in t ? t.fullName : t.name);
});
afterEach(() => {
  testNames.pop();
  for (const path of testFolders.pop() ?? []) removeFolder(path);
});
const removeParent = () => {
  if (tempParent) removeFolder(tempParent);
  tempParent = '';
};
after(removeParent);
process.on('exit', removeParent);

/** A new empty folder in the system temp folder, removed when the test that made it ends. */
export function makeTempDir(prefix = 'yokoten-'): string {
  if (!tempParent) tempParent = mkdtempSync(join(tmpdir(), 'yokoten-test-'));
  const path = mkdtempSync(join(tempParent, prefix));
  testFolders.at(-1)?.push(path);
  return path;
}

/**
 * Stop a checkout walk at `folder` (#712). A `.git` file that is not a gitdir line
 * is not a checkout, so the walk does not go on into the machine's temp folder.
 */
export function stopCheckoutWalk(folder: string): void {
  writeFileSync(join(folder, '.git'), 'not a checkout\n');
}

/** A new empty folder that outlives the test that made it, removed when the file ends: for a template (#475). */
function makeFileTempDir(prefix = 'yokoten-template-'): string {
  if (!tempParent) tempParent = mkdtempSync(join(tmpdir(), 'yokoten-test-'));
  return mkdtempSync(join(tempParent, prefix));
}

// ---- Child processes (#436): a loaded machine runs them slowly, never wrongly. ----
// A test judges what a child did, not how fast: no wall-clock limit. The timeout only stops a
// child that hangs, so it is generous, and the kill is printed with the running test's name:
// a file that dies later still says which test it was in.

/** How long a test's child may run before it is killed: well under the CI job's 10 minutes, so two hangs still print. */
export const CHILD_TIMEOUT_MS = 120_000;

/** How much output a test's child may print before it is killed. Node's 1 MB default cut a report short (#436). */
export const CHILD_MAX_BUFFER = 256 * 1024 * 1024;

/** The line printed when a test's child is killed, or null when it ended by itself. */
export function killedLine(testName: string | undefined, command: string, timeoutMs: number, result: { signal: NodeJS.Signals | null; error?: Error }): string | null {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (!result.signal && code !== 'ETIMEDOUT' && code !== 'ENOBUFS') return null;
  const why = code === 'ETIMEDOUT' ? `after ${timeoutMs} ms` : code === 'ENOBUFS' ? 'for printing more than maxBuffer' : `by ${result.signal}`;
  return `test ${JSON.stringify(testName ?? '(outside a test)')}: its child \`${command}\` was killed ${why}\n`;
}

/**
 * spawnSync for a test, with text output, CHILD_TIMEOUT_MS and CHILD_MAX_BUFFER unless given.
 * A killed child is printed on stderr with the test that ran it.
 */
export function runChild(command: string, args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {}): SpawnSyncReturns<string> {
  const timeout = options.timeout ?? CHILD_TIMEOUT_MS;
  const result = spawnSync(command, args, { maxBuffer: CHILD_MAX_BUFFER, ...options, timeout, encoding: 'utf8' });
  const line = killedLine(testNames.at(-1), command, timeout, result);
  if (line) process.stderr.write(line);
  return result;
}

// A clean environment: no real HOME, no real marks, no role, and commit times in UTC
// whatever the machine's time zone (#40). No proxy either: the shell's proxy is not
// passed on, and a call to a fake server on this machine goes to it directly (#138).
// The sandbox lives in the temp folder; YOKOTEN_TEMP_DIRS turns off that note (#365) so the
// tests see what they set up. The compile cache stays in Node's own folder, not in the
// sandbox's home, where bin/yokoten.mjs puts it (#408): the tests list what lands there.
// No automatic maintenance (#442): git runs it after a commit, in the background on newer
// versions, and a worktree prune there can delete a `git worktree add` still being made.
// No gh telemetry (#436): see test/repo/home.ts.
const sandboxEnv = (home: string) => ({ PATH: process.env.PATH, HOME: home, NODE_COMPILE_CACHE: COMPILE_CACHE, TZ: 'UTC', YOKOTEN_TEMP_DIRS: '', GH_TELEMETRY: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });

/** A repo built once per test process by `build`, copied into each folder given (#475): see git-template.ts. */
export const makeRepoTemplate = (build: (dir: string) => void) => templateRepo(makeFileTempDir, build);

/** Runs git in `cwd` for a template, and fails loudly if it does not work. */
const templateGit = (cwd: string, env: Record<string, string | undefined>, ...args: string[]) => {
  const result = runChild('git', args, { cwd, env });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
};

// The sandbox's repo (#475): on main, with a user name and email, and no commit.
const copySandboxRepo = makeRepoTemplate((repo) => {
  const env = sandboxEnv(makeFileTempDir('yokoten-template-home-'));
  templateGit(repo, env, 'init', '-q', '-b', 'main');
  templateGit(repo, env, 'config', 'user.name', 'Test');
  templateGit(repo, env, 'config', 'user.email', `1+test${at}users.noreply.github.com`);
});

export function makeSandbox() {
  const base = makeTempDir();
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  copySandboxRepo(repo);
  const env = sandboxEnv(home);
  const git = (...args: string[]) => runChild('git', args, { cwd: repo, env });
  const run = (args: string[], { input, cwd = repo, extra = {}, timeout }: { input?: string; cwd?: string; extra?: Record<string, string>; timeout?: number } = {}) =>
    runChild('node', [CLI, ...args], { cwd, env: { ...env, ...extra }, input, timeout });
  // The same as run, in this process (#475): no child, so no second strip of every file's types.
  // Its result has run's shape. invoke.ts is loaded on the first call, so a file that never
  // calls it does not load every command. Keep one or two run tests per command for the entry.
  const call = async (args: string[], { input, cwd = repo, extra = {} }: { input?: string; cwd?: string; extra?: Record<string, string> } = {}) => {
    const { invoke } = await import('./invoke.ts');
    const done = await invoke(args, { env: { ...env, ...extra }, cwd, stdin: input });
    return { status: done.code, stdout: done.stdout, stderr: done.stderr };
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  // The tests step (#55): a test script, and a workflow that runs it.
  const withTests = () => {
    write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    write('.github/workflows/test.yml', 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
  };
  return { home, repo, env, git, run, call, write, withTests };
}

export const ROOT = join(dirname(CLI), '..');

// The server settings (#7), read through a fake gh. Each route is an API path; a missing
// route answers 404, as GitHub does. The real gh is never run.
export const REPO = 'octo/demo';

export const said = (code: number) => Object.assign(new Error('gh failed'), { stderr: `gh: request failed (HTTP ${code})\n` });

export const GOOD: Record<string, unknown> = {
  [`repos/${REPO}`]: {
    default_branch: 'main',
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
  },
  [`repos/${REPO}/rules/branches/main`]: [
    { type: 'pull_request', parameters: { require_code_owner_review: true, allowed_merge_methods: ['squash'] } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
    { type: 'non_fast_forward' },
    { type: 'deletion' },
  ],
  [`repos/${REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`]: [{ id: 7, target: 'tag', enforcement: 'active' }],
  [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] },
  [`repos/${REPO}/private-vulnerability-reporting`]: { enabled: true },
  [`repos/${REPO}/vulnerability-alerts`]: '',
  [`repos/${REPO}/pulls?state=open&per_page=100`]: 'octo:feat/a\nsomeone:main\n',
  [`repos/${REPO}/branches?per_page=100`]: 'main\nfeat/a\nold/b\n',
};

export function serverGh(routes: Record<string, unknown>) {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    const route = routes[args.find((a) => a.startsWith('repos/')) ?? ''];
    if (route instanceof Error) throw route;
    if (route === undefined) throw said(404);
    return typeof route === 'string' ? route : JSON.stringify(route);
  };
  return { gh, calls };
}

export function fakeGh(labels: (string | Label)[], milestones: string[] = []) {
  const calls: string[][] = [];
  const held: Label[] = labels.map((l) => (typeof l === 'string' ? { name: l, color: 'ededed', description: '' } : l));
  const option = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const gh: Gh = (args) => {
    calls.push(args);
    const [command, subcommand, name] = args;
    assert.ok(command === 'api' || args.includes('me/repo'), `every call names the repo: ${args.join(' ')}`);
    if (command === 'label' && args.includes('docs') && subcommand !== 'delete') throw Object.assign(new Error('failed'), { stderr: 'HTTP 403: no access\n' });
    if (command === 'label' && subcommand === 'create') held.push({ name, color: option(args, '--color'), description: option(args, '--description') });
    else if (command === 'label' && subcommand === 'edit') Object.assign(held.find((l) => l.name === name)!, { color: option(args, '--color'), description: option(args, '--description') });
    else if (command === 'label' && subcommand === 'delete') held.splice(held.findIndex((l) => l.name === name), 1);
    else if (command === 'api' && args.includes('POST')) milestones.push(`open ${args.at(-1)?.slice('title='.length)}`);
    else if (command === 'api' && args.includes('repos/me/repo/labels?per_page=100')) return held.map((l) => `${JSON.stringify(l)}\n`).join('');
    else if (command === 'api' && args.includes('repos/me/repo/milestones?state=all&per_page=100')) return milestones.map((m) => `${m}\n`).join('');
    else throw new Error(`unexpected gh ${args.join(' ')}`);
    return '';
  };
  return { gh, calls, held, milestones };
}

// The planning steps (#10): stage 2, read in full doctor only.
export const planningFound = (server: Parameters<typeof road>[3]) => Object.fromEntries(road('.', {}, ROAD.filter((s) => ['labels', 'milestone'].includes(s.key)), server).map((r) => [r.step.key, r.found]));

export const withPlanning = (planning: ServerSettings['planning']) => ({ ...(readServer(serverGh(GOOD).gh, REPO) as ServerSettings), planning });

// A project hook command as init writes it: a plain line when `path` is gone (#204), else node.
export const MISSING_PROJECT = 'yokoten: the hook cannot run, because .yokoten/ is missing. Restore it from git, or run yokoten init again';

// A tool-call guard fails closed (#260): no node is one line and exit 1; then a small heap,
// node's stderr held back, and any exit but 0 and 2 becomes 2 with one line.
export const MISSING_NODE = 'yokoten: the guard cannot run, because node is not on PATH for this agent; run yokoten doctor in a terminal';

export const REFUSE = 'case $code in 0|2) printf %s "${err%x}" >&2;; *) echo "yokoten\'s guard failed (exit $code), so the command is refused; run \\`yokoten doctor\\`" >&2; code=2;; esac; exit $code';

export const onToolCall = (check: string, path: string, args: string) =>
  `${check}command -v node >/dev/null 2>&1 || { echo '${MISSING_NODE}' >&2; exit 1; }; { err=$( ( node --max-old-space-size=256 ${path} ${args} 2>&1 1>&3 3>&-; c=$?; printf x; exit $c ) 2>/dev/null ); code=$?; } 3>&1; ${REFUSE}`;

export const pick = (result: { status: number | null; stdout: string; stderr: string }) => [result.status, result.stdout, result.stderr];

/** The doctor --json mark of one road step, read in this process (#475). */
export const stepMark = async (sandbox: ReturnType<typeof makeSandbox>, id: string, extra?: Record<string, string>) =>
  (JSON.parse((await sandbox.call(['doctor', '--json'], { extra })).stdout).steps as { id: string; mark: string }[]).find((step) => step.id === id)?.mark;

// #258: Gemini CLI reads settings.json with comments allowed (strip-json-comments), but
// not trailing commas. yokoten reads it the same way, and never rewrites a commented file:
// it prints the hooks to add by hand, and the file with them added by hand is ok.
export const commentedGemini = (hooks: string) => `{
  // my theme
  "theme": "dark", /* a block
  comment */
  "url": "http://example.com/*not a comment*/",
  "quote": "a \\" // still a string",
  "hooks": ${hooks}
}
`;

export const COMMENTED = (file: string) => `${file} has comments, so yokoten won't rewrite it; add this under "hooks" by hand (each group in the list for its event, in place of an older yokoten one)`;

/** The skip line, and the JSON printed under it to add by hand. */
export function handAdd(stdout: string, skip: string): Record<string, unknown[]> {
  const lines = stdout.split('\n');
  const at = lines.indexOf(skip);
  assert.ok(at >= 0, `no line ${JSON.stringify(skip)} in:\n${stdout}`);
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('  ')) break;
    block.push(line);
  }
  return JSON.parse(block.join('\n'));
}

/** The JSON at the end of doctor's line for `id`. */
export function doctorHandAdd(stdout: string, id: string, file: string): Record<string, unknown[]> {
  const line = stdout.split('\n').find((l) => l.startsWith(`  note    ${id}: `)) ?? '';
  assert.ok(line.startsWith(`  note    ${id}: ${COMMENTED(file)}: {`), `doctor: ${stdout}`);
  return JSON.parse(line.slice(line.indexOf(': {') + 2));
}

// #254: the same for Claude Code's own settings file, the one people edit by hand most.
// Each bad file and why it is skipped: a parse error asks for valid JSON, a wrong shape names the key.
export const JSON_FIX = (command: string) => `(make it valid JSON, then run \`yokoten ${command}\` again)`;

export const manifest = (name: string) => JSON.parse(readFileSync(join(ROOT, '.claude-plugin', name), 'utf8'));

export const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';

// ---- Adoption (#6): the facts from files, then a draft from a model or the rules. ----

// A bare `git init`, made once per test process (#475).
const copyFixtureRepo = makeRepoTemplate((dir) => execFileSync('git', ['init', '-q'], { cwd: dir }));

export function fixture(files: Record<string, string>): string {
  const dir = makeTempDir('yokoten-adopt-');
  copyFixtureRepo(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

export const FACTS: Fact[] = [
  { key: 'rules', status: 'done', evidence: 'AGENTS.md', why: 'an agent follows the rules it can read' },
  { key: 'ci', status: 'partial', evidence: 'CI exists', why: 'a commit made with the hook off would reach main unchecked' },
  { key: 'codeowners', status: 'missing', evidence: 'no CODEOWNERS file', why: 'the host then asks you to review' },
];

export const answer = (rows: unknown) => JSON.stringify({ rows });

// A file with a long-lived one-letter name on line 1, a 5-word name on line 2, and `i`
// in a short loop on line 3. The one-letter name is used on line 15.
export const NAMED = [
  'const t = 0;',
  'const loadTheWholeUserList = () => [];',
  'for (let i = 0; i < 3; i++) console.log(i);',
  ...Array(11).fill('// filler'),
  'console.log(t);',
].join('\n');

/**
 * A git repo with an English file and a translation whose line 1 names it, at the
 * English text as committed. `git` runs in it with no global config, in UTC.
 */
export function makeTranslatedRepo() {
  const root = makeTempDir();
  copyTranslatedRepo(root);
  return translatedRepoIn(root);
}

function translatedRepoIn(root: string) {
  // No automatic gc or maintenance (#516). Newer git (CI has 2.55) runs maintenance in the background
  // after a commit, and this env leaves out the test home's settings that turn it off; it then wrote
  // into the template while a test copied it (ENOENT in cpSync, twice, both from this template).
  const env = { PATH: process.env.PATH, HOME: root, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'none'), GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const commit = (path: string, text: string) => {
    writeFileSync(join(root, path), text);
    git('add', path);
    git('commit', '-q', '-m', `change ${path}`);
  };
  return { root, git, commit };
}

// Built once per test process (#475): the two commits keep the same ids in every copy.
const copyTranslatedRepo = makeRepoTemplate((root) => {
  const { git, commit } = translatedRepoIn(root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  commit('en.md', '# Guide\n\nStep one.\n');
  commit('zh.md', `${sourceMarker('en.md')}\n# 指南\n\n第一步。\n`);
});

export const GB = 1024 ** 3;

export const MOUNTS = 'none / ext4 rw 0 0\nC:\\134 /mnt/c 9p rw 0 0\nD:\\134 /mnt/d 9p rw 0 0\n';

export const NOW = new Date('2026-10-20T08:30:00Z');

export const WSL = { WSL_DISTRO_NAME: '<distro>', HOME: '/home/<user>' };

/**
 * A machine with `free` bytes on every disk. Files live in `files`, /proc/mounts is MOUNTS,
 * and running a program throws unless `programs` answers it.
 */
export function fakeMachine(free: number, more: Partial<MachineProbe> & { programs?: Record<string, string>; ran?: string[]; files?: Map<string, string> } = {}): MachineProbe {
  const { programs = {}, ran = [], files = new Map<string, string>(), ...rest } = more;
  return {
    readDiskSpace: () => ({ free, size: 250 * GB }),
    readOwner: () => null,
    runProgram: (file) => {
      ran.push(file);
      if (file in programs) return programs[file];
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
    readText: (path) => (path === '/proc/mounts' ? MOUNTS : (files.get(path) ?? null)),
    writeText: (path, text) => void files.set(path, text),
    uid: 1000,
    now: () => NOW,
    nodeVersion: '24.22.1',
    ...rest,
  };
}
// The team of #674 (test/agents/desk/team/, test/commands/advice/messages.test.ts).
/** A lead's checkout and a desk next to it, both with a bare `.git` folder: no git process is needed. */
export function makeTeamFixture() {
  // The real path: on macOS the temp folder is a link (/var to /private/var), and whoAmI answers with real paths.
  const projects = realpathSync(makeTempDir('team-'));
  const main = join(projects, 'repo');
  const desk = join(projects, 'desks', 'g1');
  const state = `${desk}.state/grok`;
  for (const folder of [join(main, '.git'), join(desk, '.git'), state]) mkdirSync(folder, { recursive: true });
  const team = `${main}.team`;
  return { projects, main, desk, state, team };
}

/** Make the team folder read-only, as the desk's fence shows it, and give it back afterwards. */
export function fence(team: string): () => void {
  for (const part of ['', 'agents', 'outbox', 'lead']) chmodSync(join(team, part), 0o555);
  return () => {
    for (const part of ['', 'agents', 'outbox', 'lead']) chmodSync(join(team, part), 0o755);
  };
}

