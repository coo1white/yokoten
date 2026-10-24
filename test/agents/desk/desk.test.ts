// Tests for src/agents/desk/desk.ts: the contract turned into a plan. The contract on a
// real system is checked in start.test.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DESK_RUNTIMES, findProgram, hiddenFolders, isInside, OWN_RUNTIME, planDesk, prepareDeskState, programExtensions, programFolders, proxyEnv } from '../../../src/agents/desk/desk.ts';
import { identityLine } from '../../../src/agents/desk/team/who.ts';
import { markWorktree } from '../../../src/commands/hook.ts';
import { workerMarkAt } from '../../../src/rules/guards.ts';
import { makeTempDir } from '../../repo/helpers.ts';
import { TEST_HOME } from '../../repo/home.ts';

/** A desk: a clone of a fresh repo, in a projects folder of its own. */
function makeDesk(): { projects: string; desk: string } {
  const projects = realpathSync(makeTempDir('projects-'));
  execFileSync('git', ['init', '-q', join(projects, 'origin')]);
  execFileSync('git', ['-C', join(projects, 'origin'), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'start']);
  execFileSync('git', ['clone', '-q', join(projects, 'origin'), join(projects, 'desk')]);
  return { projects, desk: join(projects, 'desk') };
}

// markWorktree runs git, so it gets the PATH that has git on it.
const gitEnv = () => ({ ...env(), PATH: process.env.PATH ?? '' });

/** A stand-in for `markWorktree`: the mark file, as the lead writes it. */
const writeMark = (desk: string) => {
  writeFileSync(join(desk, '.git', 'yokoten-worker'), 'mark\n');
  return { top: desk };
};

const env = () => ({ HOME: TEST_HOME, PATH: dirname(process.execPath), GH_TOKEN: 'not-a-real-token', SECRET_THING: 'x' });

test('isInside: the folder itself and what is under it, not a name that only starts the same', () => {
  assert.ok(isInside('/a/b', '/a/b'));
  assert.ok(isInside('/a/b/c', '/a/b'));
  assert.ok(!isInside('/a/bc', '/a/b'));
  assert.ok(!isInside('/A/b/c', '/a/b'), 'a system that keeps case compares it');
});

test('isInside: Windows paths compare without case, and only after a separator', () => {
  assert.ok(isInside('C:\\Users\\Me\\desk\\a', 'c:\\users\\me\\desk', 'win32'));
  assert.ok(isInside('C:\\Users\\Me', 'C:\\Users\\Me', 'win32'));
  assert.ok(!isInside('C:\\Users\\Mew', 'C:\\Users\\Me', 'win32'));
  assert.ok(!isInside('C:\\Users\\Me', 'C:\\Users\\Me\\desk', 'win32'));
});

test('findProgram: a name on PATH, a path as it is, null when missing', () => {
  const folder = makeTempDir('bin-');
  writeFileSync(join(folder, 'agent'), '');
  assert.equal(findProgram('agent', `relative:${folder}`), join(folder, 'agent'));
  assert.equal(findProgram(join(folder, 'agent'), ''), join(folder, 'agent'));
  assert.equal(findProgram('missing', folder), null);
});

test('findProgram: Windows tries the PATHEXT extensions, and a path with a backslash', () => {
  const folder = makeTempDir('bin-');
  writeFileSync(join(folder, 'agent.cmd'), '');
  assert.equal(findProgram('agent', folder, ['', '.cmd']), join(folder, 'agent.cmd'));
  assert.equal(findProgram(`C:\\tools\\agent.cmd`, ''), null, 'a Windows path is not on a Mac');
  assert.deepEqual(programExtensions('win32', { PATHEXT: '.EXE;.CMD' }), ['', '.EXE', '.CMD']);
  assert.deepEqual(programExtensions('win32', {}), ['', '.COM', '.EXE', '.BAT', '.CMD']);
  assert.deepEqual(programExtensions('linux', { PATHEXT: '.EXE' }), ['']);
});

test('programFolders: the folder named, and the package the real file is in', () => {
  const root = realpathSync(makeTempDir('program-'));
  mkdirSync(join(root, 'lib', 'agent', 'bin'), { recursive: true });
  writeFileSync(join(root, 'lib', 'agent', 'package.json'), '{}');
  writeFileSync(join(root, 'lib', 'agent', 'bin', 'agent.js'), '');
  mkdirSync(join(root, 'bin'));
  symlinkSync(join(root, 'lib', 'agent', 'bin', 'agent.js'), join(root, 'bin', 'agent'));
  assert.deepEqual(programFolders(join(root, 'bin', 'agent')), [join(root, 'bin'), join(root, 'lib', 'agent')]);
});

test('hiddenFolders: every home, other drives, and the desk parent; only those that are there', () => {
  const desk = join(makeTempDir('projects-'), 'desk');
  const linux = hiddenFolders('linux', TEST_HOME, desk);
  assert.ok(linux.includes(TEST_HOME) && linux.includes(dirname(desk)));
  for (const folder of hiddenFolders('darwin', TEST_HOME, desk)) assert.ok(!['/home', '/mnt'].includes(folder));
});

test('hiddenFolders: Windows hides every profile folder and every other drive', () => {
  const hidden = hiddenFolders('win32', 'C:\\Users\\Me', 'C:\\Users\\Me\\projects\\desk', () => true);
  assert.ok(hidden.includes('C:\\Users\\Me'), 'the home folder');
  assert.ok(hidden.includes('C:\\Users'), 'every profile folder');
  assert.ok(hidden.includes('C:\\Users\\Me\\projects'), 'the desk parent');
  assert.ok(hidden.includes('D:\\') && hidden.includes('Z:\\'), 'the other drives');
  assert.ok(!hidden.includes('C:\\'), 'the desk drive stays walkable');
});

test('planDesk: the desk and its own state writable, a token dropped, role and time zone fixed', () => {
  const { projects, desk } = makeDesk();
  const plan = planDesk({ runtime: 'claude-code', desk, command: ['node', 'x.js'], env: env(), markDesk: (folder) => markWorktree(join(projects, 'origin'), folder, gitEnv()), extraHosts: ['api.deepseek.com'] });
  assert.equal(plan.desk, desk);
  assert.deepEqual(plan.state, [`${desk}.state/claude-code`]);
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, `${desk}.state/claude-code`, "the agent uses the desk's state, not the lead's");
  assert.ok(!plan.readable.some((path) => isInside(path, join(realpathSync(TEST_HOME), '.claude'))), "nothing of the lead's state is shown");
  assert.ok(plan.hidden.includes(projects) && plan.hidden.includes(realpathSync(TEST_HOME)));
  assert.ok(plan.readable.includes(dirname(dirname(realpathSync(process.execPath)))), 'Node is shown');
  assert.ok(plan.readable.includes(OWN_RUNTIME[1]), "yokoten's src is shown");
  assert.ok(!plan.readable.some((path) => plan.hidden.some((folder) => isInside(folder, path))), 'no readable path opens a hidden folder');
  assert.deepEqual(plan.hosts, [...DESK_RUNTIMES['claude-code'].hosts, 'api.deepseek.com']);
  assert.equal(plan.env.YOKOTEN_ROLE, 'worker');
  assert.equal(plan.env.TZ, 'UTC');
  assert.equal(plan.env.GH_TOKEN, undefined);
  assert.equal(plan.env.SECRET_THING, undefined);
  assert.deepEqual(plan.locked, [join(desk, '.git', 'config'), join(desk, '.git', 'hooks'), join(desk, '.git', 'yokoten-worker')], "git's config and hooks, and the worker mark, stay read-only");
  // #672: the desk clone carries the worker mark, so a runtime that drops YOKOTEN_ROLE (Muse Code) is a worker there.
  assert.equal(workerMarkAt(desk, {}), 'mark');
});

test('planDesk: the OpenCode desk keeps its XDG folders and only the login rows in its state (#770)', () => {
  const { projects, desk } = makeDesk();
  const xdg = realpathSync(makeTempDir('xdg-'));
  const data = join(xdg, 'data');
  mkdirSync(join(data, 'opencode'), { recursive: true });
  const lead = new DatabaseSync(join(data, 'opencode', 'opencode.db'));
  lead.exec('CREATE TABLE credential (id text PRIMARY KEY, value text); CREATE TABLE session_v2 (id text PRIMARY KEY, text text); CREATE TABLE kv (key text PRIMARY KEY, value text);');
  lead.exec("INSERT INTO credential VALUES ('c1', 'the login'); INSERT INTO session_v2 VALUES ('s1', 'a private prompt'); INSERT INTO kv VALUES ('job.background/msg_1', 'a private message');");
  lead.close();
  const plan = planDesk({ runtime: 'opencode', desk, command: ['node', 'x.js'], env: { ...env(), XDG_DATA_HOME: data }, markDesk: (folder) => markWorktree(join(projects, 'origin'), folder, gitEnv()) });
  const state = join(`${desk}.state`, 'opencode');
  assert.equal(plan.env.XDG_DATA_HOME, join(state, 'data'));
  assert.equal(plan.env.XDG_STATE_HOME, join(state, 'state'));
  assert.equal(plan.env.XDG_CONFIG_HOME, join(state, 'config'));
  assert.equal(plan.env.OPENCODE_DB, join(state, 'data', 'opencode', 'opencode.db'));
  assert.deepEqual(plan.hosts, ['opencode.ai', 'api.opencode.ai', 'models.opencode.ai']);
  assert.equal(plan.loopback, true, 'its private server talks on loopback');
  assert.equal(plan.allowLoopback, false, 'opening loopback is the lead\'s choice, not the desk\'s');
  assert.ok(plan.hidden.includes(join(data, 'opencode')), "the lead's OpenCode data is hidden");
  const copied = new DatabaseSync(join(state, 'data', 'opencode', 'opencode.db'), { readOnly: true });
  try {
    assert.equal(copied.prepare('SELECT value FROM credential').get()?.value, 'the login');
    assert.equal(copied.prepare('SELECT count(*) AS count FROM session_v2').get()?.count, 0, 'no session text comes along');
    assert.equal(copied.prepare('SELECT count(*) AS count FROM kv').get()?.count, 0, 'kv holds no login: its rows stay out too');
  } finally {
    copied.close();
  }
});

test('planDesk: the OpenCode program folder is shown, not the whole ~/.opencode (#770)', () => {
  const { projects, desk } = makeDesk();
  const home = realpathSync(makeTempDir('home-'));
  mkdirSync(join(home, '.opencode', 'bin'), { recursive: true });
  writeFileSync(join(home, '.opencode', 'bin', 'opencode'), '');
  writeFileSync(join(home, '.opencode', 'secret-note.txt'), 'private');
  const plan = planDesk({ runtime: 'opencode', desk, command: ['node', 'x.js'], env: { ...env(), HOME: home }, markDesk: (folder) => markWorktree(join(projects, 'origin'), folder, gitEnv()) });
  assert.ok(plan.readable.includes(join(home, '.opencode', 'bin')), 'the program folder is shown');
  // Positive control: the file next to it would be visible if the whole folder were shown.
  assert.ok(!plan.readable.includes(join(home, '.opencode')), 'the rest of ~/.opencode is hidden');
});

test('planDesk: --allow-loopback is the lead\'s answer to a loopback agent, and only that agent\'s (#770)', () => {
  const { projects, desk } = makeDesk();
  const mark = (folder: string) => markWorktree(join(projects, 'origin'), folder, gitEnv());
  assert.equal(planDesk({ runtime: 'opencode', desk, command: ['node', 'x.js'], env: env(), allowLoopback: true, markDesk: mark }).allowLoopback, true);
  assert.equal(planDesk({ runtime: 'grok', desk, command: ['node', 'x.js'], env: env(), allowLoopback: true, markDesk: mark }).allowLoopback, undefined, 'a desk that needs no loopback keeps it shut');
});

test('planDesk: the OpenCode login copy never follows a link out of the desk state (#770)', () => {
  const { projects, desk } = makeDesk();
  const xdg = realpathSync(makeTempDir('xdg-'));
  const data = join(xdg, 'data');
  const outside = realpathSync(makeTempDir('outside-'));
  mkdirSync(join(data, 'opencode'), { recursive: true });
  writeFileSync(join(data, 'opencode', 'opencode.db'), 'not a database');
  const state = join(`${desk}.state`, 'opencode');
  mkdirSync(state, { recursive: true });
  symlinkSync(outside, join(state, 'data'));
  assert.throws(
    () => planDesk({ runtime: 'opencode', desk, command: ['node'], env: { ...env(), XDG_DATA_HOME: data }, markDesk: (folder) => markWorktree(join(projects, 'origin'), folder, gitEnv()) }),
    /is a link or not a folder/,
  );
  // Positive control: the folders are checked before anything is made, so the link's target stays empty.
  assert.deepEqual(readdirSync(outside), []);
});

test('planDesk: a desk that cannot be marked does not start, with the plain reason (#672)', () => {
  const { projects, desk } = makeDesk();
  // From inside the desk the lead would mark its own checkout: markWorktree refuses, and so does the desk.
  assert.throws(() => planDesk({ runtime: 'grok', desk, command: ['node'], env: env(), markDesk: (folder) => markWorktree(desk, folder, gitEnv()) }), /can't mark the desk as a worker's: .*is the main checkout, the lead's/);
  assert.throws(() => planDesk({ runtime: 'grok', desk, command: ['node'], env: env(), markDesk: () => ({ top: desk }) }), /can't mark the desk as a worker's: no mark in /);
  assert.ok(existsSync(join(projects, 'origin')));
});

test('prepareDeskState: only the login file comes from the lead; a newer one is copied again; a link is refused', () => {
  const { desk } = makeDesk();
  const lead = join(TEST_HOME, '.claude');
  mkdirSync(join(lead, 'projects'), { recursive: true });
  writeFileSync(join(lead, '.credentials.json'), 'login-1');
  writeFileSync(join(lead, 'settings.json'), '{"hooks": {}}');
  writeFileSync(join(lead, 'history.jsonl'), '{}');
  try {
    const state = prepareDeskState(DESK_RUNTIMES['claude-code'], 'claude-code', desk, env());
    assert.deepEqual(readdirSync(state).sort(), ['.claude.json', '.credentials.json']);
    assert.equal(readFileSync(join(state, '.credentials.json'), 'utf8'), 'login-1');
    writeFileSync(join(state, '.credentials.json'), 'renewed in the desk');
    prepareDeskState(DESK_RUNTIMES['claude-code'], 'claude-code', desk, env());
    assert.equal(readFileSync(join(state, '.credentials.json'), 'utf8'), 'renewed in the desk', "a newer login in the desk is kept");
    // Positive control: a link a worker left in the desk's state is never followed.
    rmSync(join(state, '.credentials.json'));
    symlinkSync(join(lead, 'settings.json'), join(state, '.credentials.json'));
    prepareDeskState(DESK_RUNTIMES['claude-code'], 'claude-code', desk, env());
    assert.equal(readFileSync(join(lead, 'settings.json'), 'utf8'), '{"hooks": {}}', "the lead's file is untouched");
    assert.ok(!lstatSync(join(state, '.credentials.json')).isSymbolicLink());
    rmSync(state, { recursive: true });
    symlinkSync(lead, state);
    assert.throws(() => prepareDeskState(DESK_RUNTIMES['claude-code'], 'claude-code', desk, env()), /is a link/);
  } finally {
    rmSync(lead, { recursive: true, force: true });
  }
});

test('planDesk: the marks file only with --marks; the worker mark is locked', () => {
  const { desk } = makeDesk();
  const marks = join(makeTempDir('config-'), 'private-marks');
  writeFileSync(marks, 'x\n');
  writeFileSync(join(desk, '.git', 'yokoten-worker'), 'mark\n');
  assert.ok(!planDesk({ runtime: 'grok', desk, command: ['node'], env: env(), markDesk: writeMark }).readable.includes(realpathSync(marks)));
  const plan = planDesk({ runtime: 'grok', desk, command: ['node'], env: env(), markDesk: writeMark, marks });
  assert.ok(plan.readable.includes(realpathSync(marks)));
  assert.deepEqual(plan.locked, [join(desk, '.git', 'config'), join(desk, '.git', 'hooks'), join(desk, '.git', 'yokoten-worker')]);
  // Positive control: a link in place of .git/config would show the lead's file, so it is refused.
  rmSync(join(desk, '.git', 'config'));
  symlinkSync(marks, join(desk, '.git', 'config'));
  assert.throws(() => planDesk({ runtime: 'grok', desk, command: ['node'], env: env(), markDesk: writeMark }), /is a link/);
});

test('planDesk: refuses an unknown agent, a worktree, a folder that is no clone, and a path that opens a hidden folder', () => {
  const { projects, desk } = makeDesk();
  assert.throws(() => planDesk({ runtime: 'gemini', desk, command: ['node'], env: env(), markDesk: writeMark }), /DeepSeek runs through codex/);
  assert.throws(() => planDesk({ runtime: 'codex', desk: projects, command: ['node'], env: env(), markDesk: writeMark }), /not a git clone/);
  execFileSync('git', ['-C', desk, 'worktree', 'add', '-q', join(projects, 'tree')]);
  assert.throws(() => planDesk({ runtime: 'codex', desk: join(projects, 'tree'), command: ['node'], env: env(), markDesk: writeMark }), /is a worktree/);
  assert.throws(() => planDesk({ runtime: 'codex', desk, command: ['node'], env: env(), markDesk: writeMark, extraReadable: [projects] }), /would open a hidden folder/);
  assert.throws(() => planDesk({ runtime: 'codex', desk, command: ['node'], env: env(), markDesk: writeMark, extraReadable: ['/'] }), /whole system/);
  assert.throws(() => planDesk({ runtime: 'codex', desk, command: ['no-such-agent'], env: env(), markDesk: writeMark }), /can't find no-such-agent/);
  const leadCodex = makeTempDir('codex-home-');
  mkdirSync(join(leadCodex, 'sessions'));
  assert.ok(planDesk({ runtime: 'codex', desk, command: ['node'], env: { ...env(), CODEX_HOME: leadCodex }, markDesk: writeMark }).hidden.includes(realpathSync(leadCodex)), "the lead's CODEX_HOME is hidden wherever it is");
  assert.throws(() => planDesk({ runtime: 'codex', desk, command: ['node'], env: { ...env(), CODEX_HOME: leadCodex }, markDesk: writeMark, extraReadable: [join(leadCodex, 'sessions')] }), /lead's own codex state/);
});

test('proxyEnv: every proxy name in both cases, and Node told to read them', () => {
  const names = proxyEnv('http://127.0.0.1:3128');
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) assert.equal(names[name], 'http://127.0.0.1:3128');
  assert.equal(names.NODE_USE_ENV_PROXY, '1');
  assert.equal(names.NO_PROXY, '', 'an agent with no server of its own keeps every name on the proxy');
  assert.equal(names.no_proxy, '');
});

test('proxyEnv: an agent that talks to itself on loopback gets the loopback names (#770)', () => {
  const names = proxyEnv('http://127.0.0.1:3128', true);
  assert.equal(names.NO_PROXY, '127.0.0.1,localhost,::1');
  assert.equal(names.no_proxy, names.NO_PROXY);
});

test('planDesk: a Codex config of another vendor names the model, and the brief starts with who it is (#748)', () => {
  const { desk } = makeDesk();
  const codexHome = makeTempDir('codex-');
  const config = (text: string) => writeFileSync(join(codexHome, 'config.toml'), text);
  const plan = () => planDesk({ runtime: 'codex', desk, command: ['node'], env: { ...env(), CODEX_HOME: codexHome }, markDesk: writeMark });
  // A DeepSeek model through Codex: the board gets the real model, and the brief starts
  // with who the agent is, so Codex's words about OpenAI are not its own.
  config('model = "deepseek-flash"\nmodel_provider = "deepseek"\n\n[model_providers.deepseek]\nname = "DeepSeek"\n');
  const deepseek = plan();
  assert.equal(deepseek.env.YOKOTEN_MODEL, 'deepseek-flash');
  assert.equal(deepseek.env.YOKOTEN_VENDOR, 'DeepSeek');
  assert.match(identityLine('codex', deepseek.env), /^yokoten: you are DeepSeek \(deepseek-flash\), served through codex; /);
  // The harness's own vendor needs no line: its prompt already tells the truth. The real
  // model still reaches the board, so it shows the model rather than the harness default.
  config('model = "gpt-6.1-sol"\nmodel_provider = "openai"\n');
  const openai = plan();
  assert.equal(openai.env.YOKOTEN_MODEL, 'gpt-6.1-sol');
  assert.equal(openai.env.YOKOTEN_VENDOR, undefined);
  assert.equal(identityLine('codex', openai.env), '');
  // A provider whose name names its vendor counts when the model name does not.
  config('model = "flash"\nmodel_provider = "deepseek"\n');
  assert.equal(plan().env.YOKOTEN_VENDOR, 'DeepSeek');
});

test('planDesk: a command model wins over the config, for the roster and the env (#748)', () => {
  const { projects, desk } = makeDesk();
  const team = join(projects, 'origin.team');
  const codexHome = makeTempDir('codex-');
  writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n');
  const plan = planDesk({ runtime: 'codex', desk, command: ['node', '--model', 'deepseek-flash'], env: { ...env(), CODEX_HOME: codexHome }, markDesk: (folder) => markWorktree(join(projects, 'origin'), folder, gitEnv()), team: { folder: team, name: 'g1' } });
  assert.equal(plan.env.YOKOTEN_MODEL, 'deepseek-flash');
  assert.equal(plan.env.YOKOTEN_VENDOR, 'DeepSeek');
  assert.match(identityLine('codex', plan.env), /^yokoten: you are DeepSeek \(deepseek-flash\)/);
  assert.match(readFileSync(join(team, 'agents', 'g1.json'), 'utf8'), /"model": "deepseek-flash"/, 'the roster names the model the env names');
});

test('planDesk: on a team, the team folder read-only, only the own outbox writable, the desk file locked (#674)', () => {
  const { projects, desk } = makeDesk();
  const team = join(projects, 'origin.team');
  const plan = planDesk({ runtime: 'grok', desk, command: ['node', '--model', 'grok-4.7'], env: env(), markDesk: (folder) => markWorktree(join(projects, 'origin'), folder, gitEnv()), team: { folder: team, name: 'g1' } });
  assert.ok(plan.readable.includes(team));
  assert.ok(plan.state.includes(join(team, 'outbox', 'g1.jsonl')));
  assert.ok(!plan.state.some((path) => path === team || path === join(team, 'outbox')), 'the team folder itself is not writable');
  assert.ok(plan.locked.includes(join(desk, '.git', 'yokoten-desk.json')));
  assert.match(readFileSync(join(team, 'agents', 'g1.json'), 'utf8'), /"model": "grok-4.7"/);
  // Without a team, an old desk file goes: the agent has no name on a team.
  planDesk({ runtime: 'grok', desk, command: ['node'], env: env(), markDesk: (folder) => markWorktree(join(projects, 'origin'), folder, gitEnv()) });
  assert.ok(!readdirSync(join(desk, '.git')).includes('yokoten-desk.json'));
  assert.throws(() => planDesk({ runtime: 'grok', desk, command: ['node'], env: env(), markDesk: (folder) => markWorktree(join(projects, 'origin'), folder, gitEnv()), team: { folder: projects, name: 'g1' } }), /would open a hidden folder or the desk/);
});
