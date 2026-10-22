// Tests for src/setup/init.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  at,
  CLI,
  COMMENTED,
  commentedGemini,
  doctorHandAdd,
  handAdd,
  JSON_FIX,
  makeSandbox,
  makeTempDir,
  MISSING_PROJECT,
  onToolCall,
  pick,
  ROOT,
  runChild,
  stepMark,
} from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { parseCodeOwners } from '../../src/rules/pr.ts';
import { hasHook } from '../../src/agents/hooks-file.ts';
import { readCodeOwners } from '../../src/host/github.ts';
import { KIT, readWorkflowHashes, render, textHash, VERSION } from '../../src/setup/files.ts';
import {
  AGENTS_BACKUP,
  checkLines,
  compareCoreRules,
  compareWorkflow,
  compareVersions,
  demoteHeadings,
  handOffLines,
  hasIntactKitJobs,
  NO_CI_REASON,
  moveUnderProjectHeading,
  placeHandOff,
  readKitVersion,
  splitFrontMatter,
} from '../../src/setup/init.ts';

const guarded = (path: string, args: string) => `[ -f ${path} ] 2>/dev/null || { echo '${MISSING_PROJECT}' >&2; exit 1; }; node ${path} ${args}`;

const guardedCall = (path: string, args: string) => onToolCall(`[ -f ${path} ] 2>/dev/null || { echo '${MISSING_PROJECT}' >&2; exit 1; }; `, path, args);

/** The paths CODEOWNERS should name: each lead-only default, a `x/**` glob as the folder `/x/`. */
const leadOnlyPaths = () => DEFAULTS.leadOnly.map((glob) => (glob.endsWith('/**') ? `/${glob.slice(0, -'**'.length)}` : `/${glob}`));

/**
 * A gh first on PATH that answers only the given calls (all its words, joined by spaces)
 * and fails every other one, so the real gh and GitHub are never reached (#313). Each
 * call is logged, one a line, for `ghCalls`.
 */
function stubGh(sandbox: ReturnType<typeof makeSandbox>, answers: Record<string, string>): Record<string, string> {
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const answers = ${JSON.stringify(answers)};
const call = process.argv.slice(2).join(' ');
require('node:fs').appendFileSync(${JSON.stringify(join(sandbox.home, 'gh.log'))}, call + '\\n');
const said = answers[call];
if (said === undefined) process.exit(1);
console.log(said);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}

/** The calls the gh from `stubGh` got, in order. */
const ghCalls = (sandbox: ReturnType<typeof makeSandbox>): string[] => {
  const log = join(sandbox.home, 'gh.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
};

// A clone's own hooks in .git/hooks (lefthook, the pre-commit framework, a hand-written
// one) must not be switched off when init points git at .githooks (#256).
const NO_EXEC_BIT = process.platform === 'win32' && 'Windows has no execute bit';

const SHELLS = ['sh', 'dash'].filter((shell) => spawnSync(shell, ['-c', 'true']).status === 0);

const BAD_PROJECT_SETTINGS: [content: string, reason: (file: string) => string][] = [
  ['{ not json', (file) => `can't read ${file} ${JSON_FIX('init')}`],
  ['{"hooks": "x"}\n', (file) => `${file} has an unexpected shape (\`hooks\` should be an object)`],
  ['[]', (file) => `${file} has an unexpected shape (the file should be a JSON object)`],
  ['{"env": "x"}', (file) => `${file} has an unexpected shape (\`env\` should be an object)`],
  // The stop check is the second hook init adds: checked before the first is written.
  ['{"hooks":{"Stop":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (\`hooks.Stop[0].hooks\` should be a list of objects)`],
  ['{"hooks":{"SubagentStop":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (\`hooks.SubagentStop[0].hooks\` should be a list of objects)`],
];

// Gemini CLI (v0.64.0) swaps `$GEMINI_PROJECT_DIR` in the command text for the shell-quoted
// launch folder, then runs the text in a shell (#210). This copies that against a repo whose
// path has a space and an @.
test('init: the Gemini hook command runs when Gemini quotes a path with a space (#210)', async () => {
  const sandbox = makeSandbox();
  // An older yokoten wrote the folder in double quotes; init updates that hook in place.
  const old = 'node "$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts" hook --agent gemini';
  sandbox.write('.gemini/settings.json', JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: old, name: 'yokoten' }] }] } }));
  const result = sandbox.run(['init']); // a real process: the entry point of init, end to end
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated the Gemini CLI tool-call hook/);
  const repo = join(dirname(sandbox.repo), 'my repo@1');
  renameSync(sandbox.repo, repo);
  const groups = JSON.parse(readFileSync(join(repo, '.gemini', 'settings.json'), 'utf8')).hooks.BeforeTool;
  assert.equal(groups.length, 1, 'updated, not added');
  const command: string = groups[0].hooks[0].command;
  assert.equal(command, guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --agent gemini'));
  // shell-quote, which Gemini uses, writes a path with a space and no single quote as
  // '…'; a single quote inside would become '\''.
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const input = JSON.stringify({ session_id: 's1', cwd: repo, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'git push --tags' } });
  const asGemini = (text: string) =>
    spawnSync('bash', ['-c', text.replaceAll('$GEMINI_PROJECT_DIR', quote(repo))], { cwd: repo, env: { ...sandbox.env, GEMINI_PROJECT_DIR: repo }, input, encoding: 'utf8' });
  const ran = asGemini(command);
  assert.equal(ran.status, 2, ran.stderr);
  assert.match(ran.stderr, /owner decides when to release/);
  // The control: the old quoted command never reaches yokoten.
  const broken = asGemini(old);
  assert.notEqual(broken.status, 2);
  assert.match(broken.stderr, /Cannot find module/);
});

test('init: adds the practices, keeps what is there, and doctor goes on to stage 4', async () => {
  const sandbox = makeSandbox();
  // An AGENTS.md with `## This project` is left to `update` (#378).
  const ours = '# our own rules\n\n## This project\n\nours\n';
  sandbox.write('AGENTS.md', ours);
  sandbox.write('.github/SECURITY.md', '# email us\n');
  // The user's own Codex and Gemini CLI settings stay.
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  sandbox.write('.codex/hooks.json', JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  sandbox.write('.gemini/settings.json', JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  assert.match(sandbox.run(['doctor']).stdout, /note +codex-hook: no tool-call guard/, 'reported, not counted as missing'); // a real process: the entry point of doctor
  assert.match((await sandbox.call(['doctor'])).stdout, /note +antigravity-hook: no tool-call guard in \.agents\/hooks\.json/, 'the positive control for the Antigravity CLI step (#30)');
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept AGENTS\.md/);
  assert.match(result.stdout, /wrote \.githooks\/pre-commit/);
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), ours);
  assert.match(result.stdout, /kept \.github\/SECURITY\.md/);
  assert.equal(readFileSync(join(sandbox.repo, '.github/SECURITY.md'), 'utf8'), '# email us\n', 'the project\'s own policy stays');
  assert.match(result.stdout, /wrote \.github\/dependabot\.yml/);
  assert.match(result.stdout, /wrote CHANGELOG\.md/);
  assert.match(readFileSync(join(sandbox.repo, 'CHANGELOG.md'), 'utf8'), /^## \[Unreleased\]$/m, 'the changelog skeleton (#34)');
  assert.match(result.stdout, /wrote changes\/README\.md/);
  assert.match(readFileSync(join(sandbox.repo, 'changes/README.md'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts changelog --write/, 'the change files folder (#132)');
  assert.ok(statSync(join(sandbox.repo, '.githooks', 'pre-commit')).mode & 0o100);
  const workflow = readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8');
  assert.match(workflow, /node \.yokoten\/bin\/yokoten\.ts check/);
  assert.match(workflow, /persist-credentials: false/, 'the hardened workflow (#36)');
  assert.match(workflow, /^  ci:\n    if: always\(\)\n    needs: \[changes, check, lint\]$/m, 'one required check that waits for the rest (#36)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/pr.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --pr/, 'the pull request check (#47)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/issue.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --issue/, 'the issue title check');
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  // Again: nothing changes.
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /kept \.github\/SECURITY\.md/);
  assert.match(result.stdout, /kept \.github\/dependabot\.yml/);
  assert.match(result.stdout, /kept CHANGELOG\.md/);
  assert.match(result.stdout, /same the tool-call hook/);
  assert.match(result.stdout, /same TZ=UTC for agent sessions/);
  const settings = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(result.stdout, /same the stop check/);
  const stopHook = { hooks: [{ type: 'command', command: guarded('"$CLAUDE_PROJECT_DIR/.yokoten/bin/yokoten.mjs"', 'hook --stop'), timeout: 600 }] };
  assert.deepEqual(settings.hooks.Stop, [stopHook], 'the stop check, once (#92)');
  assert.deepEqual(settings.hooks.SubagentStop, [stopHook], 'SubagentStop, once (#614)');
  assert.equal(settings.env.TZ, 'UTC', 'agent commits record no time zone (#40)');
  assert.match(result.stdout, /same the Codex tool-call hook/);
  assert.match(result.stdout, /same the Gemini CLI tool-call hook/);
  const codex = JSON.parse(readFileSync(join(sandbox.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.equal(codex.hooks.PreToolUse.length, 2);
  assert.deepEqual(codex.hooks.PreToolUse[1], {
    hooks: [{ type: 'command', command: guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --agent codex') }],
    matcher: 'Bash|apply_patch',
  });
  const gemini = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.equal(gemini.hooks.BeforeTool.length, 2);
  assert.deepEqual(gemini.hooks.BeforeTool[1], {
    hooks: [{ type: 'command', command: guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --agent gemini'), name: 'yokoten' }],
    matcher: 'run_shell_command|write_file|replace',
  });
  // The stop checks (#211): Codex's Stop and Gemini's AfterAgent take no matcher, once each.
  assert.match(result.stdout, /same the Codex stop check/);
  assert.match(result.stdout, /same the Gemini CLI stop check/);
  assert.deepEqual(codex.hooks.Stop, [{ hooks: [{ type: 'command', command: guarded('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --stop --agent codex'), timeout: 600 }] }]);
  assert.deepEqual(gemini.hooks.AfterAgent, [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --stop --agent gemini'), name: 'yokoten-stop', timeout: 600_000 }] }]);
  // Codex's hooks are in place; this home has no ~/.codex, so doctor says nothing of its trust (#341).
  assert.match((await sandbox.call(['doctor'])).stdout, /ok +codex-hook: \.codex\/hooks\.json is in place; trust not checked, no ~\/\.codex\n +ok +gemini-hook\n +ok +antigravity-hook/);
  assert.match(result.stdout, /Codex runs the hooks in \.codex\/hooks\.json only after you trust this folder and the hooks\n.*to trust them in Codex: run `codex` in this folder, trust it, then trust both yokoten hooks in `\/hooks`/);
  // Antigravity CLI (#30): its own file, and Copilot CLI reads .claude/settings.json.
  assert.match(result.stdout, /same the Antigravity CLI tool-call hook in \.agents\/hooks\.json/);
  assert.match(result.stdout, /GitHub Copilot CLI runs the hooks in \.claude\/settings\.json only after you trust this folder\n.*to trust this folder in Copilot CLI: run `copilot` in this folder/);
  const agents = JSON.parse(readFileSync(join(sandbox.repo, '.agents', 'hooks.json'), 'utf8'));
  assert.deepEqual(agents.yokoten.PreToolUse[0].hooks[0].command, guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --agent antigravity'));
  // The pre-commit hook runs the vendored check on a real commit.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0);
  sandbox.write('leak.md', `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}\n`);
  sandbox.git('add', 'leak.md');
  const secret = sandbox.git('commit', '-qm', 'leak');
  assert.notEqual(secret.status, 0, 'a secret is refused too (#8)');
  assert.match(secret.stderr, /leak\.md:1: a secret \(AWS access key id\)/);
  sandbox.git('reset', '-q', 'leak.md');
  // init does all of stages 1 to 3 but the tests, so with tests the road goes on to stage 4.
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /^yokoten: stage 1 of 5, safety net\. Next: no workflow runs a test command/);
  sandbox.withTests();
  result = await sandbox.call(['doctor', '--session']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^yokoten: stage 4 of 5, a team of agents\. Next: \.github\/CODEOWNERS names no owner yet \(@YOUR_GITHUB_HANDLE\); put your GitHub handle in \.github\/CODEOWNERS/);
});

test('init: safe defaults, Dependabot and a security policy; doctor lists the security switches (#35)', async () => {
  const sandbox = makeSandbox();
  const r = await sandbox.call(['init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote \.github\/SECURITY\.md/);
  assert.match(r.stdout, /wrote \.github\/dependabot\.yml/);
  const dependabot = readFileSync(join(sandbox.repo, '.github/dependabot.yml'), 'utf8');
  for (const line of [/package-ecosystem: github-actions/, /interval: monthly/, /default-days: 7/, /patterns: \['\*'\]/, /prefix: ci/]) assert.match(dependabot, line);
  assert.equal([...dependabot.matchAll(/^\s*- package-ecosystem:/gm)].length, 1, 'actions only, since the stack is unknown');
  assert.match(readFileSync(join(sandbox.repo, '.github/SECURITY.md'), 'utf8'), /\*\*Report a vulnerability\*\*/);
  const doctor = await sandbox.call(['doctor']);
  for (const sw of [/private vulnerability reporting/, /secret scanning with push protection/, /Dependabot alerts/]) assert.match(doctor.stdout, sw);
  // Right after init only the license is missing: say what to do, not that init adds it (#208).
  const security = async () => (await sandbox.call(['doctor'])).stdout.split('\n').find((l) => / security-files\b/.test(l)) ?? '';
  assert.match(await security(), /: no license file; choose a license and add it as LICENSE$/);
  assert.doesNotMatch(await security(), /yokoten init/);
  rmSync(join(sandbox.repo, '.github/SECURITY.md'));
  assert.match(await security(), /: no security policy \(SECURITY\.md\), no license file; run `yokoten init` to add the security policy and Dependabot, and choose a license and add it as LICENSE$/);
  sandbox.write('LICENSE', 'placeholder license\n');
  await sandbox.call(['init']);
  assert.match(await security(), /^ +done +security-files/);
});

// Dependabot for the project's own packages (#379): one block per ecosystem init finds.
const updateBlocks = (text: string) =>
  text.split(/^(?=  - package-ecosystem:)/m).slice(1).map((block) => ({
    ecosystem: /package-ecosystem: (\S+)/.exec(block)?.[1],
    dirs: [...block.matchAll(/^ {4}directory: (\S+)$|^ {6}- (\/\S*)$/gm)].map((match) => match[1] ?? match[2]),
    block,
  }));

const initDependabot = async (files: Record<string, string>) => {
  const sandbox = makeSandbox();
  for (const [path, text] of Object.entries(files)) sandbox.write(path, text);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  const path = join(sandbox.repo, '.github/dependabot.yml');
  return { stdout: result.stdout, text: readFileSync(path, 'utf8'), path, sandbox };
};

test('init: Dependabot updates a Cargo workspace from the root, once (#379)', async () => {
  const { stdout, text } = await initDependabot({
    'Cargo.toml': '[workspace]\nmembers = ["cli", "crates/core"]\n',
    'Cargo.lock': '',
    'cli/Cargo.toml': '[package]\nname = "cli"\n',
    'crates/core/Cargo.toml': '[package]\nname = "core"\n',
    'target/debug/Cargo.toml': '',
  });
  assert.match(stdout, /wrote \.github\/dependabot\.yml \(the actions CI runs, and cargo\)/);
  const blocks = updateBlocks(text);
  assert.deepEqual(blocks.map(({ ecosystem, dirs }) => [ecosystem, dirs]), [['github-actions', ['/']], ['cargo', ['/']]], 'the workspace root covers its members');
  const cargo = blocks[1].block;
  for (const line of [/interval: monthly/, /default-days: 7/, /^ {6}cargo:\n {8}patterns: \['\*'\]$/m, /prefix: chore/]) assert.match(cargo, line);
});

test('init: Dependabot updates a Node project, and a bun lock file means bun (#379)', async () => {
  const node = await initDependabot({ 'package.json': '{}', 'package-lock.json': '{}', 'node_modules/x/package.json': '{}' });
  assert.deepEqual(updateBlocks(node.text).map(({ ecosystem, dirs }) => [ecosystem, dirs]), [['github-actions', ['/']], ['npm', ['/']]]);
  assert.match(node.stdout, /\(the actions CI runs, and npm\)/);
  const bun = await initDependabot({ 'package.json': '{}', 'bun.lock': '' });
  assert.deepEqual(updateBlocks(bun.text).map(({ ecosystem }) => ecosystem), ['github-actions', 'bun']);
});

test('init: Dependabot covers each stack in a mixed project, in the root and one folder down (#379)', async () => {
  const { stdout, text } = await initDependabot({
    'go.mod': 'module example.com/demo\n',
    'web/package.json': '{}',
    'site/package.json': '{}',
    'api/pyproject.toml': '[project]\nname = "api"\n',
    'App/App.csproj': '<Project/>',
    'android/build.gradle.kts': '',
    '.cache/Gemfile': '',
    'docs/readme.md': '# docs\n',
  });
  assert.match(stdout, /\(the actions CI runs, and npm, pip, gomod, nuget, gradle\)/);
  assert.deepEqual(updateBlocks(text).map(({ ecosystem, dirs }) => [ecosystem, dirs]), [
    ['github-actions', ['/']],
    ['npm', ['/site', '/web']],
    ['pip', ['/api']],
    ['gomod', ['/']],
    ['nuget', ['/App']],
    ['gradle', ['/android']],
  ], 'a hidden folder is not read');
  assert.match(text, /^ {4}directories:\n {6}- \/site\n {6}- \/web\n {4}schedule:/m, 'two folders, one block');
});

test('init: Dependabot with no package manager found updates the actions only (#379)', async () => {
  const { stdout, text } = await initDependabot({ 'README.md': '# demo\n', 'src/main.c': '' });
  assert.match(stdout, /wrote \.github\/dependabot\.yml \(the actions CI runs\)/);
  assert.deepEqual(updateBlocks(text).map(({ ecosystem }) => ecosystem), ['github-actions']);
});

test('init: a dependabot.yml that is there is kept, and init names what it does not update (#379)', async () => {
  const mine = 'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: /\n    schedule:\n      interval: weekly\n';
  const { stdout, text, sandbox } = await initDependabot({ '.github/dependabot.yml': mine, 'package.json': '{}', 'Cargo.toml': '' });
  assert.equal(text, mine, 'the file is the project\'s, byte for byte');
  assert.match(stdout, /kept \.github\/dependabot\.yml; it does not update cargo\. Copy its github-actions block for each, with prefix chore/);
  assert.doesNotMatch(stdout, /does not update[^\n]*npm/, 'a quoted ecosystem name counts');
  // A dependabot.yaml counts too: init writes no second file next to it.
  const other = makeSandbox();
  other.write('.github/dependabot.yaml', 'version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n');
  const again = await other.call(['init']);
  assert.match(again.stdout, /^kept \.github\/dependabot\.yaml$/m);
  assert.ok(!existsSync(join(other.repo, '.github/dependabot.yml')));
  assert.match((await sandbox.call(['init'])).stdout, /kept \.github\/dependabot\.yml; it does not update cargo/, 'said again on each init');
});

test("init: a CLAUDE.md gets one line that imports AGENTS.md, and doctor's rules step wants it (#206)", async () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# our rules\n\nRun the tests first.\n');
  sandbox.write('AGENTS.md', '# shared rules\n');
  assert.notEqual(await stepMark(sandbox, 'rules'), 'done', 'AGENTS.md that Claude Code does not read is not done');
  assert.match((await sandbox.call(['doctor'])).stdout, /rules[^\n]*: CLAUDE\.md does not import AGENTS\.md[^\n]*; add a line `@AGENTS\.md`/);
  rmSync(join(sandbox.repo, 'AGENTS.md'));
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote AGENTS\.md/);
  assert.match(result.stdout, /updated CLAUDE\.md: it now reads AGENTS\.md/);
  const claude = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# our rules\n\nRun the tests first.\n\n'), 'the project\'s own lines stay');
  assert.match(claude, /\n<!--[^\n]*-->\n@AGENTS\.md\n$/, 'a comment line, then the import, at the end');
  assert.equal(await stepMark(sandbox, 'rules'), 'done');
  // Again: one import, not two.
  result = await sandbox.call(['init']);
  assert.doesNotMatch(result.stdout, /updated CLAUDE\.md/);
  assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), claude);
});

test('init: writes .github/CODEOWNERS for every lead-only path, owned by the GitHub remote owner; check --pr then wants tier A (#304)', async () => {
  const sandbox = makeSandbox();
  // A gh that always fails, so init never reaches GitHub for labels.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'gh'), 0o755);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = await sandbox.call(['init'], { extra: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.github\/CODEOWNERS \(the lead-only paths, owned by @octo\)/);
  const owners = readCodeOwners(sandbox.repo, '', process.env);
  assert.equal(owners?.from, 'the working tree');
  const rules = parseCodeOwners(owners!.text);
  assert.deepEqual(rules.map((rule) => rule.pattern), leadOnlyPaths());
  for (const rule of rules) assert.deepEqual(rule.owners, [`${at}octo`], rule.pattern);
  assert.equal(await stepMark(sandbox, 'codeowners', { PATH: `${bin}:${process.env.PATH}` }), 'done');
  // check --pr reads the file from the base branch, and a change under .yokoten/ needs tier A.
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('.yokoten/extra.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (tier: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = `tier: ${tier}\nCloses #1\nThis changes the runtime.\n## Why\nx\n## What changed\nx\n## How tested\nx\n`;
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  const tierB = await sandbox.call(['check', '--pr'], { extra: event('B') });
  assert.equal(tierB.status, 1, tierB.stdout);
  assert.match(tierB.stderr, /this changes 1 file\(s\) that CODEOWNERS owns \(read from the base branch\): \.yokoten\/extra\.md/);
  assert.doesNotMatch((await sandbox.call(['check', '--pr'], { extra: event('A') })).stderr, /CODEOWNERS owns/);
});

test('init: a CODEOWNERS owner gh says is a user is written as is (#313)', async () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, { 'api users/octo --jq .type': 'User' });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.github\/CODEOWNERS \(the lead-only paths, owned by @octo\)/);
  for (const rule of parseCodeOwners(readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8'))) assert.deepEqual(rule.owners, [`${at}octo`], rule.pattern);
  // init asked GitHub, once, who @octo is.
  assert.deepEqual(ghCalls(sandbox).filter((c) => c.startsWith('api users/')), ['api users/octo --jq .type']);
});

test('init: an organization is no CODEOWNERS owner, so init writes the placeholder and says why; full doctor flags an org-only file (#313)', async () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, {
    'api users/octo --jq .type': 'Organization',
    'api repos/octo/app': JSON.stringify({ default_branch: 'main', owner: { login: 'octo', type: 'Organization' } }),
  });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.github\/CODEOWNERS \(the lead-only paths; @octo is an organization, so put a person or @octo\/<team> in place of @YOUR_GITHUB_HANDLE\)/);
  const text = readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8');
  assert.match(text, /^# @octo is an organization[^\n]*@octo\/<team>/m);
  const rules = parseCodeOwners(text);
  assert.deepEqual(rules.map((rule) => rule.pattern), leadOnlyPaths());
  for (const rule of rules) assert.deepEqual(rule.owners, ['@YOUR_GITHUB_HANDLE'], rule.pattern);
  // A file owned by the organization alone locks nothing on GitHub: full doctor says so.
  sandbox.write('.github/CODEOWNERS', '/AGENTS.md @octo\n/.github/ @Octo\n');
  assert.equal(await stepMark(sandbox, 'codeowners', extra), 'to do');
  assert.match((await sandbox.call(['doctor'], { extra })).stdout, /\.github\/CODEOWNERS names only @octo, an organization, and GitHub takes no organization as an owner; put a person's handle or @octo\/<team> in \.github\/CODEOWNERS/);
  // A team of the organization, or a person, is an owner.
  sandbox.write('.github/CODEOWNERS', '/AGENTS.md @octo/leads\n');
  assert.equal(await stepMark(sandbox, 'codeowners', extra), 'done');
});

test('init: when gh fails, the CODEOWNERS owner is the remote owner, as before (#313)', async () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, {});
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.github\/CODEOWNERS \(the lead-only paths, owned by @octo\)/);
  assert.doesNotMatch(readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8'), /YOUR_GITHUB_HANDLE/);
});

test('init: an existing CODEOWNERS is kept byte for byte, in any place GitHub reads it (#304)', async () => {
  const own = '# ours\r\n/src/ @octo\n';
  let sandbox = makeSandbox();
  sandbox.write('.github/CODEOWNERS', own);
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept \.github\/CODEOWNERS/);
  assert.equal(readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8'), own);
  // One in docs/: a new .github/CODEOWNERS would take its place, so init writes none.
  sandbox = makeSandbox();
  sandbox.write('docs/CODEOWNERS', own);
  result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept docs\/CODEOWNERS/);
  assert.equal(existsSync(join(sandbox.repo, '.github', 'CODEOWNERS')), false);
  assert.equal(readFileSync(join(sandbox.repo, 'docs', 'CODEOWNERS'), 'utf8'), own);
});

test('init: a CLAUDE.md that already imports AGENTS.md is left as it is (#206)', async () => {
  for (const text of [`# rules\n${at}AGENTS.md\n`, `# rules\nRead ${at}./AGENTS.md first.\n`, `# rules\r\n${at}AGENTS.md\r\n`, `# rules\n${at}AGENTS.md`]) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), text);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', text);
  }
});

test("init: a .claude/CLAUDE.md alone gets `@../AGENTS.md`, and doctor's rules step wants it (#206)", async () => {
  const sandbox = makeSandbox();
  sandbox.write('.claude/CLAUDE.md', '# our rules\n');
  sandbox.write('AGENTS.md', '# shared rules\n');
  assert.notEqual(await stepMark(sandbox, 'rules'), 'done', 'Claude Code reads .claude/CLAUDE.md instead of AGENTS.md');
  assert.match((await sandbox.call(['doctor'])).stdout, /rules[^\n]*: \.claude\/CLAUDE\.md does not import AGENTS\.md[^\n]*; add a line `@\.\.\/AGENTS\.md`/);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated \.claude\/CLAUDE\.md: it now reads AGENTS\.md/);
  // Claude Code resolves an import relative to the file that holds it, so this is the root AGENTS.md.
  assert.match(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), /^# our rules\n\n<!--[^\n]*-->\n@\.\.\/AGENTS\.md\n$/);
  assert.equal(existsSync(join(sandbox.repo, 'CLAUDE.md')), false, 'no root CLAUDE.md is made');
  assert.equal(await stepMark(sandbox, 'rules'), 'done');
});

test('init: CLAUDE.md and .claude/CLAUDE.md, neither importing AGENTS.md: the root one gets the import (#206)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# root rules\n');
  sandbox.write('.claude/CLAUDE.md', '# folder rules\n');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated CLAUDE\.md: it now reads AGENTS\.md/);
  assert.doesNotMatch(result.stdout, /updated \.claude\/CLAUDE\.md/);
  assert.match(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), /\n@AGENTS\.md\n$/);
  assert.equal(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), '# folder rules\n');
  assert.equal(await stepMark(sandbox, 'rules'), 'done');
});

test('init: a .claude/CLAUDE.md that already imports AGENTS.md is left as it is (#206)', async () => {
  for (const text of [`# rules\n${at}../AGENTS.md\n`, `# rules\nRead ${at}../AGENTS.md first.\n`]) {
    const sandbox = makeSandbox();
    sandbox.write('.claude/CLAUDE.md', text);
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), text);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', text);
  }
});

const NO_SYMLINK = process.platform === 'win32' && 'Windows makes a symlink only with Developer Mode or admin rights';

test('init: a CLAUDE.md that is a link to AGENTS.md reads the rules; init writes nothing through it (#428)', { skip: NO_SYMLINK }, async () => {
  const cases = [
    [['CLAUDE.md', 'AGENTS.md']],
    [['.claude/CLAUDE.md', '../AGENTS.md']],
    [['CLAUDE.md', 'AGENTS.md'], ['.claude/CLAUDE.md', '../AGENTS.md']],
  ];
  for (const links of cases) {
    const sandbox = makeSandbox();
    // With `## This project`, init leaves AGENTS.md to `update` (#378), so it stays byte for byte.
    const rules = '# shared rules\n\n## This project\n\nRun the tests first.\n';
    sandbox.write('AGENTS.md', rules);
    for (const [file, target] of links) {
      mkdirSync(dirname(join(sandbox.repo, file)), { recursive: true });
      symlinkSync(target, join(sandbox.repo, file));
    }
    assert.equal(await stepMark(sandbox, 'rules'), 'done', `${links}: no rules gap`);
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, `${links}`);
    assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), rules, `${links}: AGENTS.md does not import itself`);
    for (const [file, target] of links) assert.equal(readlinkSync(join(sandbox.repo, file)), target, `${file} is the same link`);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', `${links}`);
  }
});

test('init: a CLAUDE.md link to an AGENTS.md without `## This project` gets the core rules once, and nothing through the link (#378, #428)', { skip: NO_SYMLINK }, async () => {
  for (const [file, target] of [['CLAUDE.md', 'AGENTS.md'], ['.claude/CLAUDE.md', '../AGENTS.md']]) {
    const sandbox = makeSandbox();
    sandbox.write('AGENTS.md', '# Our rules\n\nRun the tests first.\n');
    mkdirSync(dirname(join(sandbox.repo, file)), { recursive: true });
    symlinkSync(target, join(sandbox.repo, file));
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^updated AGENTS\.md: the core rules are on top, and your 3 line\(s\) moved under `## This project`/m, file);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, `${file}: no import, no note about the link`);
    const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
    assert.equal(text.match(/^<!-- yokoten kit /gm)?.length, 1, `${file}: the core rules once`);
    assert.equal(text.match(/^## This project$/gm)?.length, 1, file);
    assert.ok(text.endsWith('## This project\n\n## Our rules\n\nRun the tests first.\n'), text.slice(-120));
    assert.doesNotMatch(text, /^@(\.\.\/)?AGENTS\.md$/m, `${file}: AGENTS.md does not import itself`);
    assert.equal(readlinkSync(join(sandbox.repo, file)), target, `${file} is the same link`);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', file);
    // A second run changes nothing.
    const again = await sandbox.call(['init']);
    assert.match(again.stdout, /^kept AGENTS\.md \(`yokoten update` brings its core rules up to date\)$/m);
    assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), text, file);
  }
});

test('init: a CLAUDE.md that is a link to another file is left as it is, and init says what to do (#428)', { skip: NO_SYMLINK }, async () => {
  for (const outside of [false, true]) {
    const sandbox = makeSandbox();
    sandbox.write('AGENTS.md', '# shared rules\n');
    const real = outside ? join(dirname(sandbox.repo), 'shared-claude.md') : join(sandbox.repo, 'docs', 'claude.md');
    const named = outside ? 'a file outside this repo' : 'docs/claude\\.md';
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, '# our rules\n');
    symlinkSync(outside ? real : 'docs/claude.md', join(sandbox.repo, 'CLAUDE.md'));
    assert.match((await sandbox.call(['doctor'])).stdout, new RegExp(`rules[^\\n]*CLAUDE\\.md is a link to ${named}: add a line \`@AGENTS\\.md\` to that file`));
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`left CLAUDE\\.md as it is: it is a link to ${named}`));
    assert.doesNotMatch(result.stdout, /updated CLAUDE\.md/);
    assert.equal(readFileSync(real, 'utf8'), '# our rules\n', 'nothing is written through the link');
    assert.equal(lstatSync(join(sandbox.repo, 'CLAUDE.md')).isSymbolicLink(), true);
    assert.notEqual(await stepMark(sandbox, 'rules'), 'done');
  }
});

test('init: with CLAUDE.md a link to another file, a plain .claude/CLAUDE.md gets the import (#428)', { skip: NO_SYMLINK }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '# shared rules\n');
  sandbox.write('docs/claude.md', '# linked rules\n');
  sandbox.write('.claude/CLAUDE.md', '# folder rules\n');
  symlinkSync('docs/claude.md', join(sandbox.repo, 'CLAUDE.md'));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated \.claude\/CLAUDE\.md: it now reads AGENTS\.md/);
  assert.equal(readFileSync(join(sandbox.repo, 'docs', 'claude.md'), 'utf8'), '# linked rules\n');
  assert.match(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), /\n@\.\.\/AGENTS\.md\n$/);
  assert.equal(await stepMark(sandbox, 'rules'), 'done');
});

test('init: an import of another file that starts with AGENTS.md does not count; init adds the real import (#206)', async () => {
  const cases = [
    { file: 'CLAUDE.md', text: `# rules\n${at}AGENTS.md.bak\n`, line: `${at}AGENTS.md` },
    { file: 'CLAUDE.md', text: `# rules\nOld: ${at}./AGENTS.md.old\n`, line: `${at}AGENTS.md` },
    { file: '.claude/CLAUDE.md', text: `# rules\n${at}../AGENTS.md.bak\n`, line: `${at}../AGENTS.md` },
  ];
  for (const { file, text, line } of cases) {
    const sandbox = makeSandbox();
    sandbox.write(file, text);
    sandbox.write('AGENTS.md', '# shared rules\n');
    assert.notEqual(await stepMark(sandbox, 'rules'), 'done', text);
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`updated ${file}: it now reads AGENTS.md`), result.stdout);
    const after = readFileSync(join(sandbox.repo, file), 'utf8');
    assert.ok(after.startsWith(text), 'the old line stays');
    assert.ok(after.endsWith(`-->\n${line}\n`), after);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: a Markdown link to AGENTS.md is not an import; init adds the import and keeps the link (#206)', async () => {
  // Claude Code loads only `@path` imports; a link is text, so the session would not read AGENTS.md.
  const cases = [
    { file: 'CLAUDE.md', text: '# rules\nSee [the rules](AGENTS.md).\n', line: `${at}AGENTS.md` },
    { file: 'CLAUDE.md', text: '# rules\nSee [the rules](./AGENTS.md).\n', line: `${at}AGENTS.md` },
    { file: '.claude/CLAUDE.md', text: '# rules\nSee [the rules](../AGENTS.md).\n', line: `${at}../AGENTS.md` },
  ];
  for (const { file, text, line } of cases) {
    const sandbox = makeSandbox();
    sandbox.write(file, text);
    sandbox.write('AGENTS.md', '# shared rules\n');
    assert.notEqual(await stepMark(sandbox, 'rules'), 'done', text);
    assert.match((await sandbox.call(['doctor'])).stdout, /rules[^\n]*does not import AGENTS\.md/, text);
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, file), 'utf8');
    assert.ok(after.startsWith(text), 'the link stays');
    assert.ok(after.endsWith(`-->\n${line}\n`), after);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: an import inside a code span or fenced block is not an import; init adds the real one (#206)', async () => {
  // Claude Code skips Markdown code spans and fenced code blocks when it reads imports.
  const fence = '```';
  for (const text of [
    `# rules\nWrite \`${at}AGENTS.md\` to import it.\n`,
    `# rules\nWrite \`\`${at}AGENTS.md\`\` to import it.\n`,
    `# rules\n${fence}md\n${at}AGENTS.md\n${fence}\n`,
    `# rules\n~~~\n${at}AGENTS.md\n~~~\n`,
    `# rules\n  ${fence}\n${at}AGENTS.md\n  ${fence}\n`,
  ]) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    sandbox.write('AGENTS.md', '# shared rules\n');
    assert.notEqual(await stepMark(sandbox, 'rules'), 'done', text);
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
    assert.ok(after.startsWith(text.replace(/\n$/, '')), 'the example stays');
    assert.ok(after.endsWith(`-->\n${at}AGENTS.md\n`), after);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: a real import next to a fenced or quoted example is left as it is (#206)', async () => {
  const fence = '```';
  for (const text of [
    `# rules\n${at}AGENTS.md\n\nExample:\n${fence}\n${at}AGENTS.md\n${fence}\n`,
    `# rules\nExample: \`${at}AGENTS.md\`.\n${at}AGENTS.md\n`,
    `# rules\n${fence}\n${at}other.md\n${fence}\n${at}AGENTS.md\n`,
  ]) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), text);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', text);
  }
});

test("init: a CLAUDE.md with mixed line endings gets the file's main ending and one blank line (#206)", async () => {
  const cases = [
    { text: '# rules\r\nOne.\r\nTwo.\n', want: '# rules\r\nOne.\r\nTwo.\r\n\r\n<!--' },
    { text: '# rules\r\nOne.\r\nTwo.', want: '# rules\r\nOne.\r\nTwo.\r\n\r\n<!--' },
    { text: '# rules\nOne.\nTwo.\r\n', want: '# rules\nOne.\nTwo.\n\n<!--' },
    { text: '# rules\nOne.\n\n\n', want: '# rules\nOne.\n\n<!--' },
  ];
  for (const { text, want } of cases) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = await sandbox.call(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
    const newline = want.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(after.slice(0, want.length), want, JSON.stringify(after));
    assert.ok(after.endsWith(`-->${newline}${at}AGENTS.md${newline}`), JSON.stringify(after));
  }
});

test("init: husky keeps its hooks folder; .husky/pre-commit gets the check and keeps its own lines (#206)", async () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', '#!/bin/sh\ntouch own-hook-ran\n');
  chmodSync(join(sandbox.repo, '.husky/pre-commit'), 0o755);
  sandbox.git('config', 'core.hooksPath', '.husky');
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the check to \.husky\/pre-commit: the commit check \(kept core\.hooksPath \(husky\)/);
  assert.match(result.stdout, /wrote \.husky\/pre-merge-commit: the commit check \(kept core\.hooksPath \(husky\)/, 'a merge commit is checked too (#239)');
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-merge-commit'), 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\n`);
  assert.ok(statSync(join(sandbox.repo, '.husky/pre-merge-commit')).mode & 0o100, 'executable');
  assert.doesNotMatch(result.stdout, /set git core\.hooksPath/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.husky', 'the project\'s hooks folder stays');
  assert.ok(!existsSync(join(sandbox.repo, '.githooks')), 'no second hooks folder that git never runs');
  const hook = readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8');
  assert.equal(hook, `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\ntouch own-hook-ran\n`);
  assert.match(hook, /\n\[ -f "\.yokoten\/bin\/yokoten\.ts" \] 2>\/dev\/null \|\| \{ echo [^\n]* >&2; exit 1; \}; node "\.yokoten\/bin\/yokoten\.ts" check --staged \|\| exit 1\n/);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // Again: the hook already runs yokoten.
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /same \.husky\/pre-commit/);
  assert.match(result.stdout, /same \.husky\/pre-merge-commit/);
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), hook);
  // A real commit runs both: the project's hook and the yokoten check.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.ok(existsSync(join(sandbox.repo, 'own-hook-ran')), 'the project\'s own hook still runs');
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0);
  sandbox.git('reset', '-q', 'leak.md');
  // Without the runtime, one plain line and no commit, never a stack trace (#204).
  rmSync(join(sandbox.repo, '.yokoten'), { recursive: true });
  sandbox.write('b.md', 'fine\n');
  sandbox.git('add', 'b.md');
  assert.deepEqual(pick(sandbox.git('commit', '-qm', 'b')), [1, '', 'yokoten: the commit check cannot run, because .yokoten/bin/yokoten.ts is missing. Restore it from git, or run yokoten init again\n']);
});

test('init: husky not yet installed in this clone; init leaves core.hooksPath unset and says to run npm install (#206)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', 'npm test\n');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the check to \.husky\/pre-commit/);
  assert.match(result.stdout, /run `npm install`/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '');
  assert.match(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), /^# yokoten: [^\n]*\n\[ -f [^\n]*; node [^\n]*\nnpm test\n$/);
  // A hook that init changed before the runtime guard (#204) already runs the check.
  const before = '# yokoten: the commit check\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\nnpm test\n';
  sandbox.write('.husky/pre-commit', before);
  assert.match((await sandbox.call(['init'])).stdout, /^same \.husky\/pre-commit/m);
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), before);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done', 'git runs no hook yet');
  assert.match((await sandbox.call(['doctor'])).stdout, /run `npm install` so husky sets core\.hooksPath/);
  sandbox.git('config', 'core.hooksPath', '.husky/_');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done', "husky 9's folder runs .husky/pre-commit");
});

// git runs pre-merge-commit, not pre-commit, for a merge it commits itself (#239).
test('init: a merge commit runs the commit check too (#239)', async () => {
  const sandbox = makeSandbox();
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.githooks\/pre-merge-commit/);
  const mergeHook = join(sandbox.repo, '.githooks', 'pre-merge-commit');
  const hook = readFileSync(mergeHook, 'utf8');
  assert.equal(hook, readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), 'the same check as pre-commit');
  assert.ok(statSync(mergeHook).mode & 0o100, 'executable');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // Again: nothing changes.
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /kept \.githooks\/pre-merge-commit/);
  assert.equal(readFileSync(mergeHook, 'utf8'), hook);
  sandbox.git('add', '.');
  assert.equal(sandbox.git('commit', '-qm', 'adopt yokoten').status, 0);
  sandbox.git('checkout', '-qb', 'topic');
  sandbox.write('topic.md', 'fine\n');
  sandbox.git('add', 'topic.md');
  assert.equal(sandbox.git('commit', '-qm', 'topic').status, 0);
  sandbox.git('checkout', '-q', 'main');
  const merge = (zone: string) => spawnSync('git', ['merge', '--no-ff', '-q', '-m', 'merge topic', 'topic'], { cwd: sandbox.repo, env: { ...sandbox.env, TZ: zone }, encoding: 'utf8' });
  // A merge with the author's time zone is refused, and the zone is never printed.
  const zoned = merge('Asia/Tokyo');
  assert.notEqual(zoned.status, 0, 'the merge commit is checked');
  assert.match(zoned.stderr, /carries your time zone/);
  assert.doesNotMatch(zoned.stderr, /\+0900/);
  assert.equal(sandbox.git('rev-list', '--count', '--merges', 'HEAD').stdout.trim(), '0');
  sandbox.git('merge', '--abort');
  const plain = merge('UTC');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(sandbox.git('rev-list', '--count', '--merges', 'HEAD').stdout.trim(), '1');
  // Doctor names a missing pre-merge-commit, and init writes it back.
  rmSync(mergeHook);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done');
  const doctor = (await sandbox.call(['doctor'])).stdout;
  // Ordinary commits are still checked; only merge commits are not.
  assert.match(doctor, /merge commits are not checked: there is no \.githooks\/pre-merge-commit/);
  assert.doesNotMatch(doctor, /(?<!merge )commits are not checked/);
  assert.doesNotMatch(doctor, /\.githooks\/pre-commit/);
  assert.match(doctor, /`yokoten init` sets up \.githooks\/pre-merge-commit/);
  // A pre-merge-commit of the project's own keeps its lines and gets the check.
  writeFileSync(mergeHook, '#!/bin/sh\necho own\n');
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /added the check to \.githooks\/pre-merge-commit/);
  assert.equal(readFileSync(mergeHook, 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\necho own\n`);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
});

test('init: a core.hooksPath outside the repo is kept, and the advice is the line init would write (#204)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'core.hooksPath', join(sandbox.home, 'hooks'));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  const [, checkLine] = checkLines('.yokoten/bin/yokoten.ts');
  assert.ok(result.stdout.includes(`Add this line to its pre-commit and pre-merge-commit: ${checkLine}\n`), result.stdout);
});

test("init: another core.hooksPath is kept, and its pre-commit is made with the check (#206)", async () => {
  const sandbox = makeSandbox();
  sandbox.write('tools/hooks/commit-msg', '#!/bin/sh\n');
  sandbox.git('config', 'core.hooksPath', 'tools/hooks');
  const doctor = (await sandbox.call(['doctor'])).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): commits are not checked: there is no tools\/hooks\/pre-commit; there is no tools\/hooks\/pre-merge-commit/);
  // The advice shows the line init writes, runtime guard included (#204). A new file needs
  // a `#!` line and the execute bit, or git skips it (#239).
  const [, checkLine] = checkLines('.yokoten/bin/yokoten.ts');
  assert.ok(doctor.includes(`or do it yourself: make tools/hooks/pre-commit and tools/hooks/pre-merge-commit with \`#!/bin/sh\` as the first line and the line below after it; run \`chmod +x tools/hooks/pre-commit tools/hooks/pre-merge-commit\`. The line: ${checkLine}`), doctor);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote tools\/hooks\/pre-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/);
  assert.match(result.stdout, /wrote tools\/hooks\/pre-merge-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), 'tools/hooks');
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    const path = join(sandbox.repo, 'tools/hooks', hook);
    assert.equal(readFileSync(path, 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\n`, hook);
    assert.ok(statSync(path).mode & 0o100, `${hook} is executable`);
  }
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  sandbox.git('add', '.');
  assert.equal(sandbox.git('commit', '-qm', 'adopt yokoten').status, 0);
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0, 'the check runs from the project\'s folder');
  sandbox.git('rm', '-q', '--cached', 'leak.md');
  rmSync(join(sandbox.repo, 'leak.md'));
  // A real merge commit with the author's time zone is refused from the project's folder (#239).
  sandbox.git('checkout', '-qb', 'topic');
  sandbox.write('topic.md', 'fine\n');
  sandbox.git('add', 'topic.md');
  assert.equal(sandbox.git('commit', '-qm', 'topic').status, 0);
  sandbox.git('checkout', '-q', 'main');
  const merge = spawnSync('git', ['merge', '--no-ff', '-q', '-m', 'merge topic', 'topic'], { cwd: sandbox.repo, env: { ...sandbox.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8' });
  assert.notEqual(merge.status, 0, 'tools/hooks/pre-merge-commit runs the check');
  assert.match(merge.stderr, /carries your time zone/);
  assert.equal(sandbox.git('rev-list', '--count', '--merges', 'HEAD').stdout.trim(), '0');
  sandbox.git('merge', '--abort');
});

test('init: a pre-commit in .git/hooks keeps running, after the check, from .githooks (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const gitDir = join(sandbox.repo, '.git');
  // The old hooks leave a mark in .git, and the pre-commit fails while .git/block-me is there.
  writeFileSync(join(gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\ndir="$(git rev-parse --git-dir)"\ntouch "$dir/old-hook-ran"\n[ ! -f "$dir/block-me" ]\n', { mode: 0o755 });
  writeFileSync(join(gitDir, 'hooks', 'pre-merge-commit'), '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/old-merge-hook-ran"\n', { mode: 0o755 });
  sandbox.write('lefthook.yml', 'pre-commit:\n  commands:\n    lint:\n      run: echo lint\n');
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept your \.git\/hooks\/pre-commit: \.githooks\/pre-commit runs it after the check$/m);
  assert.match(result.stdout, /^kept your \.git\/hooks\/pre-merge-commit: \.githooks\/pre-merge-commit runs it after the check$/m);
  assert.match(result.stdout, /^note: lefthook\.yml is here; \.githooks runs these hooks in \.git\/hooks: \.git\/hooks\/pre-commit \(after the check\), \.git\/hooks\/pre-merge-commit \(after the check\)\. /m);
  assert.match(result.stdout, /^set git core\.hooksPath to \.githooks/m);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.ok(existsSync(join(gitDir, 'hooks', 'pre-commit')), 'the old hook stays where it was');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // A real commit runs the check, then the old hook.
  sandbox.git('add', '.');
  let commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.ok(existsSync(join(gitDir, 'old-hook-ran')), 'the old pre-commit ran');
  // The old hook's failure stops the commit.
  writeFileSync(join(gitDir, 'block-me'), '');
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', 'a.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'blocked').status, 0, 'the old hook can still refuse a commit');
  rmSync(join(gitDir, 'block-me'));
  // The check comes first: when it refuses, the old hook does not run.
  rmSync(join(gitDir, 'old-hook-ran'));
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  commit = sandbox.git('commit', '-qm', 'leak');
  assert.notEqual(commit.status, 0, 'the check runs');
  assert.ok(!existsSync(join(gitDir, 'old-hook-ran')), 'the check runs before the old hook');
  sandbox.git('rm', '-q', '--cached', 'leak.md');
  rmSync(join(sandbox.repo, 'leak.md'));
  assert.equal(sandbox.git('commit', '-qm', 'a').status, 0);
  // A merge commit runs the old pre-merge-commit too.
  sandbox.git('checkout', '-qb', 'topic');
  sandbox.write('topic.md', 'fine\n');
  sandbox.git('add', 'topic.md');
  assert.equal(sandbox.git('commit', '-qm', 'topic').status, 0);
  sandbox.git('checkout', '-q', 'main');
  const merge = sandbox.git('merge', '--no-ff', '-q', '-m', 'merge topic', 'topic');
  assert.equal(merge.status, 0, merge.stderr);
  assert.ok(existsSync(join(gitDir, 'old-merge-hook-ran')), 'the old pre-merge-commit ran');
  // A clone that ran an older init: .githooks/pre-commit without the hand-off drops the old hook, and doctor says so.
  const kitHook = readFileSync(join(CLI, '..', '..', 'kit', 'project', '.githooks', 'pre-commit'), 'utf8').replaceAll('{{cli}}', '.yokoten/bin/yokoten.ts');
  writeFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), kitHook);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done', 'the old pre-commit would be dropped');
  const doctor = (await sandbox.call(['doctor'])).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): a hook this clone had is switched off: \.git\/hooks\/pre-commit no longer runs: \.githooks\/pre-commit does not run it; `yokoten init` makes \.githooks\/pre-commit run \.git\/hooks\/pre-commit after the check/);
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /^updated \.githooks\/pre-commit$/m);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  const hook = readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8');
  assert.match(hook, /^node "\.yokoten\/bin\/yokoten\.ts" check --staged \|\| exit 1\n# yokoten: then the pre-commit/m, 'the kit\'s `exec` goes, so the hand-off runs after the check');
  rmSync(join(gitDir, 'old-hook-ran'));
  sandbox.write('b.md', 'fine\n');
  sandbox.git('add', 'b.md');
  assert.equal(sandbox.git('commit', '-qm', 'b').status, 0);
  assert.ok(existsSync(join(gitDir, 'old-hook-ran')), 'the old pre-commit runs again');
});

test('init: a pre-commit in .git/hooks that git skips does not hold the check back; init says how to keep it (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  chmodSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), 0o644);
  const note = 'note: .git/hooks/pre-commit is not executable, so git skips it today; `chmod +x .git/hooks/pre-commit` and run `yokoten init` again to keep it running';
  const doctor = (await sandbox.call(['doctor'])).stdout;
  assert.ok(doctor.includes(`commit-check (OSPS-BR-07.01): commits are not checked: core.hooksPath is not set; \`yokoten init\` sets it up; ${note}\n`), doctor);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^set git core\.hooksPath to \.githooks/m);
  assert.ok(result.stdout.includes(`\n${note}\n`), result.stdout);
  assert.doesNotMatch(result.stdout, /kept your/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done', 'a hook git skipped is not dropped');
  // Made executable, the next init hands off to it.
  chmodSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), 0o755);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done', 'now it would be dropped');
  assert.match((await sandbox.call(['init'])).stdout, /^kept your \.git\/hooks\/pre-commit: \.githooks\/pre-commit runs it after the check$/m);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
});

test('init: every other hook in .git/hooks keeps running from .githooks, with its arguments and stdin (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const hooks = join(sandbox.repo, '.git', 'hooks');
  // Each old hook leaves a mark in .git with its arguments.
  const marker = (name: string) => `#!/bin/sh\necho "$*" > "$(git rev-parse --git-common-dir)/${name}-ran"\n`;
  writeFileSync(join(hooks, 'commit-msg'), marker('commit-msg'), { mode: 0o755 });
  writeFileSync(join(hooks, 'post-commit'), marker('post-commit'), { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\ncat > "$(git rev-parse --git-common-dir)/pre-push-ran"\nexit 4\n', { mode: 0o755 });
  writeFileSync(join(hooks, 'post-checkout'), marker('post-checkout'), { mode: 0o644 });
  chmodSync(join(hooks, 'post-checkout'), 0o644);
  writeFileSync(join(hooks, 'pre-commit.old'), marker('old'), { mode: 0o755 });
  // A hook of the project's own in .githooks gets the hand-off after its `#!` line.
  sandbox.write('.githooks/prepare-commit-msg', '#!/bin/sh\necho own >> "$1"\n');
  chmodSync(join(sandbox.repo, '.githooks', 'prepare-commit-msg'), 0o755);
  writeFileSync(join(hooks, 'prepare-commit-msg'), marker('prepare-commit-msg'), { mode: 0o755 });
  sandbox.write('lefthook.yml', 'commit-msg:\n  commands:\n    lint:\n      run: echo lint\n');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  for (const hook of ['commit-msg', 'post-commit', 'pre-push']) {
    assert.match(result.stdout, new RegExp(`^wrote \\.githooks/${hook}$`, 'm'));
    assert.match(result.stdout, new RegExp(`^kept your \\.git/hooks/${hook}: \\.githooks/${hook} runs it$`, 'm'));
  }
  assert.match(result.stdout, /^updated \.githooks\/prepare-commit-msg$/m);
  assert.ok(result.stdout.includes('\nnote: lefthook.yml is here; .githooks runs these hooks in .git/hooks: .git/hooks/commit-msg, .git/hooks/post-commit, .git/hooks/pre-push, .git/hooks/prepare-commit-msg. A hook it installs later'), result.stdout);
  assert.match(result.stdout, /^note: \.git\/hooks\/post-checkout is not executable, so git skips it today/m);
  assert.ok(!existsSync(join(sandbox.repo, '.githooks', 'post-checkout')), 'a hook git skips gets no .githooks file');
  assert.ok(!existsSync(join(sandbox.repo, '.githooks', 'pre-commit.old')), 'a file git never runs is not a hook');
  assert.equal(readFileSync(join(sandbox.repo, '.githooks', 'prepare-commit-msg'), 'utf8'), ['#!/bin/sh', ...handOffLines('prepare-commit-msg'), 'echo own >> "$1"', ''].join('\n'));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // A real commit runs them, with git's arguments.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(readFileSync(join(sandbox.repo, '.git', 'commit-msg-ran'), 'utf8'), '.git/COMMIT_EDITMSG\n');
  assert.ok(existsSync(join(sandbox.repo, '.git', 'post-commit-ran')));
  assert.match(readFileSync(join(sandbox.repo, '.git', 'prepare-commit-msg-ran'), 'utf8'), /COMMIT_EDITMSG message/);
  assert.match(sandbox.git('log', '-1', '--format=%B').stdout, /own/, 'the project\'s own lines still run');
  // pre-push gets git's stdin, and its failure stops the push.
  const remote = join(sandbox.home, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote], { env: sandbox.env });
  const push = sandbox.git('push', '-q', remote, 'main');
  assert.notEqual(push.status, 0, 'the old pre-push can still refuse a push');
  assert.match(readFileSync(join(sandbox.repo, '.git', 'pre-push-ran'), 'utf8'), /^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main /);
  // A clone that ran an older init: no .githooks/commit-msg, so the old one is dropped, and doctor counts it.
  rmSync(join(sandbox.repo, '.githooks', 'commit-msg'));
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done');
  const doctor = (await sandbox.call(['doctor'])).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): a hook this clone had is switched off: \.git\/hooks\/commit-msg no longer runs: \.githooks\/commit-msg does not run it; `yokoten init` makes \.githooks\/commit-msg run \.git\/hooks\/commit-msg\n/);
  assert.match((await sandbox.call(['init'])).stdout, /^wrote \.githooks\/commit-msg$/m);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
});

test('init: an old hook that reads stdin, next to a .githooks one of the project\'s own, is left to the owner (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ncat >/dev/null\n', { mode: 0o755 });
  sandbox.write('.githooks/pre-push', '#!/bin/sh\nwhile read line; do echo "$line"; done\n');
  const before = readFileSync(join(sandbox.repo, '.githooks', 'pre-push'), 'utf8');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^left core\.hooksPath unset, so the commit check is not on yet: \.githooks\/pre-push is the project's own and reads stdin, as \.git\/hooks\/pre-push does, so yokoten can't run both from one file\. To keep \.git\/hooks\/pre-push, make \.githooks\/pre-push save stdin to a file and give it to both: its own lines, and \.git\/hooks\/pre-push with the same arguments; then run `git config core\.hooksPath \.githooks`$/m);
  assert.equal(readFileSync(join(sandbox.repo, '.githooks', 'pre-push'), 'utf8'), before);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '');
  assert.match((await sandbox.call(['doctor'])).stdout, /commits are not checked: core\.hooksPath is not set; \.githooks\/pre-push is the project's own and reads stdin/);
});

test('init: the hand-off has no switch, and a .git/hooks link to .githooks does not loop (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const gitDir = join(sandbox.repo, '.git');
  writeFileSync(join(gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\necho x >> "$(git rev-parse --git-dir)/old-hook-ran"\n', { mode: 0o755 });
  assert.equal((await sandbox.call(['init'])).status, 0);
  sandbox.git('add', '.');
  const commit = (message: string, extra: Record<string, string> = {}) =>
    runChild('git', ['commit', '-qm', message], { cwd: sandbox.repo, env: { ...sandbox.env, ...extra } });
  let result = commit('adopt yokoten', { YOKOTEN_OLD_HOOK: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(gitDir, 'old-hook-ran'), 'utf8'), 'x\n', 'YOKOTEN_OLD_HOOK=1 does not skip the old hook');
  // .git/hooks/pre-commit as a link to .githooks/pre-commit: the hand-off sees it is the same file.
  rmSync(join(gitDir, 'hooks', 'pre-commit'));
  symlinkSync(join(sandbox.repo, '.githooks', 'pre-commit'), join(gitDir, 'hooks', 'pre-commit'));
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', 'a.md');
  result = commit('a');
  assert.equal(result.status, 0, `${result.stderr} ${result.error ?? ''}`);
  assert.equal((result.stderr.match(/yokoten check: ok/g) ?? []).length, 1, 'the check ran once');
  // The same for the file run with sh, or dash, from a relative path.
  sandbox.write('b.md', 'fine\n');
  sandbox.git('add', 'b.md');
  for (const shell of SHELLS) {
    const run = runChild(shell, ['.git/hooks/pre-commit'], { cwd: sandbox.repo, env: sandbox.env });
    assert.equal(run.status, 0, `${shell}: ${run.stderr}`);
    assert.equal((`${run.stdout}${run.stderr}`.match(/yokoten check: ok/g) ?? []).length, 1, `${shell}: the check ran once`);
  }
});

test('init: the hooks it writes run under sh and dash, with the arguments and stdin (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const hooks = join(sandbox.repo, '.git', 'hooks');
  writeFileSync(join(hooks, 'pre-merge-commit'), '#!/bin/sh\nprintf "%s|" "$@" > "$(git rev-parse --git-dir)/args"; cat > "$(git rev-parse --git-dir)/stdin"; exit 5\n', { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nprintf "%s|" "$@" > "$(git rev-parse --git-dir)/args"; cat > "$(git rev-parse --git-dir)/stdin"; exit 6\n', { mode: 0o755 });
  assert.equal((await sandbox.call(['init'])).status, 0);
  for (const shell of SHELLS) {
    for (const [hook, code] of [['pre-merge-commit', 5], ['pre-push', 6]] as const) {
      const run = spawnSync(shell, [`.githooks/${hook}`, 'a b', 'c'], { cwd: sandbox.repo, env: sandbox.env, input: 'line in\n', encoding: 'utf8' });
      assert.equal(run.status, code, `${shell} ${hook}: ${run.stderr}`);
      assert.equal(readFileSync(join(sandbox.repo, '.git', 'args'), 'utf8'), 'a b|c|', `${shell} ${hook}`);
      assert.equal(readFileSync(join(sandbox.repo, '.git', 'stdin'), 'utf8'), 'line in\n', `${shell} ${hook}`);
    }
  }
});

test('init: the hand-off goes only after a check at column 0, and the kit\'s exec line only when it is last (#256)', () => {
  const hook = 'pre-commit';
  // The reviewer's hook: the check sits in an `if`, and more lines follow.
  const nested = '#!/bin/sh\nif [ -n "$FAST" ]; then\n  exec node ".yokoten/bin/yokoten.ts" check --staged\nfi\nnpm run lint\n';
  assert.equal(placeHandOff(nested, hook), null);
  assert.equal(placeHandOff('#!/bin/sh\nexec node ".yokoten/bin/yokoten.ts" check --staged\nnpm run lint\n', hook), null, 'exec, then more lines');
  assert.equal(placeHandOff('#!/bin/sh\n  exec node ".yokoten/bin/yokoten.ts" check --staged\n', hook), null, 'exec, indented');
  assert.equal(placeHandOff('#!/bin/sh\ncheck() {\n  node ".yokoten/bin/yokoten.ts" check --staged || exit 1\n}\ncheck\n', hook), null, 'a check inside a function');
  assert.equal(placeHandOff('#!/bin/sh\nexec node  ".yokoten/bin/yokoten.ts"  check --staged\n\n', hook), ['#!/bin/sh', 'node  ".yokoten/bin/yokoten.ts"  check --staged || exit 1', ...handOffLines(hook), '', ''].join('\n'));
  assert.equal(placeHandOff('#!/bin/sh\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\nnpm run lint\n', hook), ['#!/bin/sh', 'node ".yokoten/bin/yokoten.ts" check --staged || exit 1', ...handOffLines(hook), 'npm run lint', ''].join('\n'));
});

test('init: the reviewer\'s own hook with the check in an `if` is kept as it is, with the steps to do by hand (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const own = '#!/bin/sh\nif [ -n "$FAST" ]; then\n  exec node ".yokoten/bin/yokoten.ts" check --staged\nfi\nnpm run lint\n';
  sandbox.write('.githooks/pre-commit', own);
  chmodSync(join(sandbox.repo, '.githooks', 'pre-commit'), 0o755);
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  sandbox.git('config', 'core.hooksPath', '.githooks');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), own);
  assert.match(result.stdout, /^a hook this clone had is switched off: \.githooks\/pre-commit is the project's own, and yokoten can't tell where its check ends\. To keep \.git\/hooks\/pre-commit, add this line after the check: yokoten_old=/m);
});

test('init: with a global core.hooksPath, the files in .git/hooks are dead and are not handed off to (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const global = join(sandbox.home, 'global-hooks');
  mkdirSync(global);
  // Written with fs: the guard on a machine may stop `git config --global` in a shell.
  writeFileSync(sandbox.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${global}\n`);
  for (const hook of ['pre-commit', 'commit-msg']) writeFileSync(join(sandbox.repo, '.git', 'hooks', hook), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // A clone an older init set up: core.hooksPath is .githooks here, and the global one decided before.
  sandbox.git('config', 'core.hooksPath', '.githooks');
  assert.equal((await sandbox.call(['init'])).status, 0);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done', 'a dead hook is not dropped');
  sandbox.git('config', '--unset', 'core.hooksPath');
  rmSync(join(sandbox.repo, '.githooks'), { recursive: true });
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /kept your|note:/);
  assert.match(result.stdout, /^set git core\.hooksPath to \.githooks/m);
  assert.doesNotMatch(readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), /git-common-dir/);
  assert.ok(!existsSync(join(sandbox.repo, '.githooks', 'commit-msg')));
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
});

// doctor's advice must be true: when it says init sets it up, init does (#256).
test('init: a .githooks/pre-commit of the project\'s own gets the check, and a kept one keeps its mode (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('.githooks/pre-commit', '#!/bin/sh\necho own\n');
  chmodSync(join(sandbox.repo, '.githooks/pre-commit'), 0o700);
  sandbox.git('config', 'core.hooksPath', '.githooks');
  assert.match((await sandbox.call(['doctor'])).stdout, /commits are not checked: \.githooks\/pre-commit does not run yokoten[^\n]*; `yokoten init` sets it up/);
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^added the check to \.githooks\/pre-commit$/m);
  const path = join(sandbox.repo, '.githooks/pre-commit');
  const hook = readFileSync(path, 'utf8');
  assert.equal(hook, `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\necho own\n`);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  const mode = statSync(path).mode & 0o777;
  // Again: the file is kept as it is, mode too.
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /^kept \.githooks\/pre-commit$/m);
  assert.equal(readFileSync(path, 'utf8'), hook);
  assert.equal(statSync(path).mode & 0o777, mode, 'no chmod on a file init did not change');
});

test('init: a file under .husky/ keeps its mode; husky 9 runs it with sh (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', 'npm test\n');
  sandbox.write('.husky/pre-merge-commit', 'npm test\n');
  for (const hook of ['pre-commit', 'pre-merge-commit']) chmodSync(join(sandbox.repo, '.husky', hook), 0o644);
  sandbox.write('.husky/_/h', '#!/bin/sh\n');
  sandbox.git('config', 'core.hooksPath', '.husky/_');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the check to \.husky\/pre-commit/);
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    assert.equal(statSync(join(sandbox.repo, '.husky', hook)).mode & 0o777, 0o644, `.husky/${hook} keeps its mode`);
  }
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done', 'husky 9 needs no execute bit on .husky/pre-commit');
});

// A lesson added to the kit's core rules reaches a project that already ran init (#120).
test('update: doctor says when the core rules are behind; update previews, and --write keeps "This project" byte for byte (#120)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));
  assert.match((await sandbox.call(['doctor'])).stdout, /\n {2}ok +core-rules\n/, 'init wrote the kit, so it is up to date');
  let result: { status: number | null; stdout: string; stderr: string } = sandbox.run(['update']); // a real process: the entry point of update
  assert.deepEqual([result.status, result.stdout], [0, 'yokoten update: the core rules in AGENTS.md are up to date with yokoten 0.1.0; nothing to change\n']);

  // An older kit had no rule 12, and someone edited a line by hand. The project's own
  // part has trailing spaces and a CRLF line end, to show it is kept byte for byte.
  const own = '## This project\n\nBuild with `make`.  \n<!-- ours -->\r\n';
  const old = kitCore.replace(/^\| 12 \|.*\n/m, '').replace('Plain English, close to', 'Plain words, close to') + own;
  writeFileSync(path, old);
  const doctor = await sandbox.call(['doctor']);
  assert.match(doctor.stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind yokoten 0\.1\.0's, or were edited by hand \(2 line\(s\) added, 1 removed; sections changed: Core rules, Writing\); run `yokoten update` to see the change/);
  assert.equal(doctor.status, 1);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /^yokoten: the core rules in AGENTS\.md are behind/m, 'a session hears it');
  assert.ok(JSON.parse((await sandbox.call(['doctor', '--json'])).stdout).findings.some((f: { id: string }) => f.id === 'core-rules'));

  // The preview shows each line, the hand edit too, and writes nothing.
  result = await sandbox.call(['update']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten update: the core rules in AGENTS\.md differ from yokoten 0\.1\.0's: 2 line\(s\) added, 1 removed; sections changed: Core rules, Writing\n/);
  assert.match(result.stdout, /^- Plain words, close to ASD-STE100/m, 'the hand-edited line is shown as replaced');
  assert.match(result.stdout, /^\+ Plain English, close to ASD-STE100/m);
  assert.match(result.stdout, /^\+ \| 12 \| Decisions are written down once/m);
  assert.match(result.stdout, /Nothing was written\. Run `yokoten update --write` to write it\.\n$/);
  assert.equal(readFileSync(path, 'utf8'), old, 'the preview writes nothing');

  // --write replaces the core part only; a second run has nothing to do.
  result = await sandbox.call(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `yokoten update: replaced the core rules in AGENTS.md with yokoten 0.1.0's: 2 line(s) added, 1 removed; sections changed: Core rules, Writing. "## This project" and below are unchanged\n`);
  assert.equal(readFileSync(path, 'utf8'), kitCore + own);
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);
  assert.match((await sandbox.call(['doctor'])).stdout, /\n {2}ok +core-rules\n/);

  // Line ends do not count: a CRLF checkout is up to date.
  writeFileSync(path, kitCore.replaceAll('\n', '\r\n') + own);
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);

  // Without the heading, doctor can't tell the core rules from the project's: a note, never a guess.
  writeFileSync(path, '# our own rules\n');
  assert.match((await sandbox.call(['doctor'])).stdout, /\n {2}note +core-rules: can't compare the core rules in AGENTS\.md: AGENTS\.md has no `## This project` heading/);
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, /core rules/);
  result = await sandbox.call(['update', '--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten update: can't compare AGENTS\.md with the kit: .*Nothing was written/);
  assert.equal(readFileSync(path, 'utf8'), '# our own rules\n');

  rmSync(path);
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /core-rules/, 'the road asks for AGENTS.md');
  result = await sandbox.call(['update']);
  assert.deepEqual([result.status, result.stderr], [1, 'yokoten update: no AGENTS.md here; nothing was written. Run `yokoten init` to add one\n']);
  assert.equal((await sandbox.call(['update', '--force'])).status, 1, 'an unknown option is refused');
  assert.match((await sandbox.call(['explain', 'core-rules'])).stdout, /^core-rules: the core rules in AGENTS\.md/);
});

// A project written by a newer yokoten is never taken back to an older kit (#141).
test('update: init writes the kit version; a newer project is refused, an older one is updated (#141)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  assert.match(fresh, /^<!-- yokoten kit 0\.1\.0 -->\n# How work is done here\n/, 'init writes the mark on the first line');
  const own = fresh.slice(fresh.indexOf('## This project'));
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));

  // Newer: a later kit added a line. update refuses, with or without --write, and doctor
  // says to update yokoten, not the project.
  const newer = kitCore.replace('0.1.0 -->', '0.2.0 -->').replace('## Roles\n', '## Roles\n\nA rule from a later kit.\n') + own;
  writeFileSync(path, newer);
  for (const args of [['update'], ['update', '--write']]) {
    const result = await sandbox.call(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^yokoten update: AGENTS\.md was written by yokoten 0\.2\.0, newer than this yokoten 0\.1\.0\. Nothing was written/);
  }
  assert.equal(readFileSync(path, 'utf8'), newer, 'a newer project is not downgraded');
  const doctor = await sandbox.call(['doctor']);
  assert.match(doctor.stdout, /\n {2}note +core-rules: the core rules in AGENTS\.md come from yokoten 0\.2\.0, newer than this yokoten 0\.1\.0; update yokoten itself, not the project/);
  assert.doesNotMatch(doctor.stdout, /MISSING core-rules/);

  // Older: the same text with an older mark is updated, and gets the new mark.
  writeFileSync(path, newer.replace('0.2.0 -->', '0.0.9 -->'));
  assert.match((await sandbox.call(['doctor'])).stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind/);
  let result = await sandbox.call(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh);

  // No mark (every project before #141): an unknown version, compared by content as before.
  const unmarked = newer.replace(/^<!-- yokoten kit .* -->\n/, '');
  writeFileSync(path, unmarked);
  result = await sandbox.call(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh, 'updated, and the mark is added');
  writeFileSync(path, fresh.replace(/^<!-- yokoten kit .* -->\n/, ''));
  assert.match((await sandbox.call(['update'])).stdout, /up to date/, 'the mark alone is no change');
});

// CI and the hooks run the copy in .yokoten/. It carries the kit's AGENTS.md, so doctor
// there compares with the kit the project vendored, not "can't compare" (#145).
test('update: the .yokoten/ copy has the kit\'s AGENTS.md, so doctor and update compare from it (#145)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const vendored = (...args: string[]) => spawnSync('node', ['.yokoten/bin/yokoten.ts', ...args], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  const kitDir = join(sandbox.repo, '.yokoten', 'kit');
  // The kit's lessons come too (#77), so doctor from the copy runs them, and the kit's
  // workflows with their hashes (#456), for the command that compares them; nothing else of the kit.
  const kitFiles = readdirSync(kitDir, { recursive: true }).map(String).sort();
  const workflows = join('project', '.github', 'workflows');
  assert.deepEqual(
    kitFiles.filter((path) => !path.startsWith('lessons')),
    ['project', join('project', '.github'), workflows, ...['issue.yml', 'pr.yml', 'yokoten.yml'].map((name) => join(workflows, name)), join('project', 'AGENTS.md'), 'workflow-hashes.json'],
    'the kit\'s AGENTS.md, workflows and their hashes, and the lessons, no more',
  );
  assert.ok(kitFiles.includes(join('lessons', 'README.md')), 'the lessons table');
  assert.match(vendored('doctor').stdout, /\n {2}ok +core-rules\n/, 'a fresh project is up to date');

  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  writeFileSync(path, fresh.replace('Plain English, close to', 'Plain words, close to'));
  assert.match(vendored('doctor').stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind yokoten 0\.1\.0's, or were edited by hand/);
  const result = vendored('update', '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh, 'the copy writes its own kit, the one CI checks against');

  // The control: without the kit file, the copy can't compare. init puts it back.
  rmSync(kitDir, { recursive: true });
  assert.match(vendored('doctor').stdout, /\n {2}note +core-rules: can't compare the core rules in AGENTS\.md: this copy of yokoten has no kit/);
  assert.equal((await sandbox.call(['init'])).status, 0);
  assert.ok(existsSync(join(kitDir, 'project', 'AGENTS.md')), 'init refreshes the copied kit file');
  assert.match(vendored('doctor').stdout, /\n {2}ok +core-rules\n/);
});

test('init: an unreadable project .codex/hooks.json or .gemini/settings.json is skipped, the rest goes on, and init exits 1 (#248)', async () => {
  for (const [bad, good, name, stop] of [['.codex/hooks.json', '.gemini/settings.json', 'the Codex hooks', 'Stop'], ['.gemini/settings.json', '.codex/hooks.json', 'the Gemini CLI hooks', 'AfterAgent']]) {
    const cases = [
      ['{ not json', `can't read ${bad} (make it valid JSON, then run \`yokoten init\` again)`],
      ['{"hooks": "x"}', `${bad} has an unexpected shape (\`hooks\` should be an object)`],
      // The stop event is added second: a bad one leaves the file whole.
      [`{"hooks":{"${stop}":[{"hooks":[1]}]}}`, `${bad} has an unexpected shape (\`hooks.${stop}[0].hooks\` should be a list of objects)`],
    ];
    for (const [content, skip] of cases) {
      const sandbox = makeSandbox();
      mkdirSync(join(sandbox.repo, dirname(bad)));
      writeFileSync(join(sandbox.repo, bad), content);
      const result = await sandbox.call(['init']);
      const what = `${bad}, ${JSON.stringify(content)}`;
      assert.equal(result.status, 1, what);
      assert.ok(result.stdout.split('\n').includes(`skipped ${name}: ${skip}`), `${what}: ${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(join(sandbox.repo, bad), 'utf8'), content, `${what}: the file changed`);
      assert.ok(hasHook(join(sandbox.repo, good), dirname(good) === '.codex' ? 'Stop' : 'AfterAgent', 'hook'), `${what}: no stop check in ${good}`);
      assert.match(result.stdout, /TZ=UTC for agent sessions/, what);
    }
  }
});

test('init: a commented .gemini/settings.json is left as it was and gets the hooks to add by hand; with them, it is ok (#258)', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.gemini', 'settings.json');
  const before = commentedGemini('{ "BeforeTool": [] }');
  sandbox.write('.gemini/settings.json', before);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /can't read|unexpected shape/);
  assert.equal(readFileSync(file, 'utf8'), before, 'the file changed');
  const add = handAdd(result.stdout, `skipped the Gemini CLI hooks: ${COMMENTED('.gemini/settings.json')}, then run \`yokoten init\` again:`);
  // The tool-call command may carry a fail-closed wrapper (#260); either way it checks for the
  // project runtime first, then runs the yokoten guard with node.
  const runtimePath = '$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs';
  const guardCall = String((add.BeforeTool?.[0] as { hooks?: { command?: unknown }[] } | undefined)?.hooks?.[0]?.command);
  const missingCheck = guarded(runtimePath, 'x').slice(0, -`node ${runtimePath} x`.length);
  assert.ok(guardCall.startsWith(missingCheck), guardCall);
  assert.match(guardCall, /\bnode(?: --\S+)* \$GEMINI_PROJECT_DIR\/\.yokoten\/bin\/yokoten\.mjs hook --agent gemini(?: |$)/);
  assert.deepEqual(add, {
    BeforeTool: [{ hooks: [{ type: 'command', command: guardCall, name: 'yokoten' }], matcher: 'run_shell_command|write_file|replace' }],
    AfterAgent: [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --stop --agent gemini'), name: 'yokoten-stop', timeout: 600_000 }] }],
  });
  assert.ok(hasHook(join(sandbox.repo, '.codex', 'hooks.json'), 'Stop', 'hook'), 'no Codex stop check');
  assert.deepEqual(doctorHandAdd((await sandbox.call(['doctor'])).stdout, 'gemini-hook', '.gemini/settings.json'), add);

  const after = commentedGemini(JSON.stringify(add, null, 2));
  writeFileSync(file, after);
  const again = await sandbox.call(['init']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^same the Gemini CLI tool-call hook in \.gemini\/settings\.json$/m);
  assert.match(again.stdout, /^same the Gemini CLI stop check in \.gemini\/settings\.json/m);
  assert.equal(readFileSync(file, 'utf8'), after, 'the file changed');
  assert.match((await sandbox.call(['doctor'])).stdout, /^ {2}ok {6}gemini-hook$/m);
});

test('init: an unreadable project .claude/settings.json is skipped, the rest goes on, and init exits 1 (#254)', async () => {
  for (const [content, reason] of BAD_PROJECT_SETTINGS) {
    const sandbox = makeSandbox();
    const file = join(sandbox.repo, '.claude', 'settings.json');
    mkdirSync(dirname(file));
    writeFileSync(file, content);
    const result = await sandbox.call(['init']);
    const what = JSON.stringify(content);
    assert.equal(result.status, 1, `${what}: ${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split('\n').includes(`skipped the Claude Code settings: ${reason('.claude/settings.json')}`), `${what}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /in \.claude\/settings\.json/, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: the file changed`);
    // Every other step still ran: the Codex and Gemini CLI hooks, and the commit check.
    assert.ok(hasHook(join(sandbox.repo, '.codex', 'hooks.json'), 'Stop', 'hook'), `${what}: no Codex stop check`);
    assert.ok(hasHook(join(sandbox.repo, '.gemini', 'settings.json'), 'AfterAgent', 'hook'), `${what}: no Gemini CLI stop check`);
    assert.match(result.stdout, /the commit check/, what);
    const doctor = await sandbox.call(['doctor']);
    assert.doesNotMatch(doctor.stderr, /SyntaxError|TypeError|at /, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: doctor changed the file`);
  }
});

test('init: run from the project\'s .yokoten/, it keeps .yokoten/ (#204)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const vendored = () => spawnSync('node', ['.yokoten/bin/yokoten.ts', 'init'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  let result = vendored();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.yokoten\/ \(the copy running now\)$/m);
  result = vendored();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
});

// A repo inside the clone that runs init was told "kept", with nothing written (#204).
test('init: a repo inside the running copy gets its own .yokoten/, unless the copy would hold itself (#204)', () => {
  const sandbox = makeSandbox();
  const clone = join(sandbox.home, 'clone');
  for (const part of ['bin', 'src', 'kit', 'package.json']) cpSync(join(dirname(CLI), '..', part), join(clone, part), { recursive: true });
  const initIn = (path: string) => {
    mkdirSync(path, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: path, env: sandbox.env });
    return spawnSync('node', [join(clone, 'bin', 'yokoten.ts'), 'init'], { cwd: path, env: sandbox.env, encoding: 'utf8' });
  };
  const project = join(clone, 'project');
  let result = initIn(project);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^wrote \.yokoten\/ /m);
  assert.ok(existsSync(join(project, '.yokoten', 'VERSION')), 'the project has its own runtime');
  // Copying src/ into a folder inside src/ never ends, so init writes nothing and says why.
  const inside = join(clone, 'src', 'project');
  result = initIn(inside);
  assert.deepEqual(pick(result), [1, '', 'yokoten init: cannot copy the runtime to src/project/.yokoten, because it is inside src/ of the copy running now. Run yokoten from a copy outside that folder\n']);
  assert.deepEqual(readdirSync(inside), ['.git'], 'nothing is written');
  assert.ok(!readdirSync(join(clone, 'src')).some((name) => name.startsWith('.')), 'no temp folder is left');
});

test('init: reads GitHub and says what it would do; --github --yes does it, and a second run changes nothing (#10)', async () => {
  const sandbox = makeSandbox();
  // A fake gh first on PATH, holding the repo in a file. The real gh and GitHub are never reached.
  const bin = join(sandbox.home, 'bin');
  const state = join(sandbox.home, 'gh.json');
  mkdirSync(bin);
  writeFileSync(state, JSON.stringify({ labels: [{ name: 'bug', color: 'd73a4a', description: 'Something does not work as it should' }, { name: 'question', color: 'd876e3', description: '' }], milestones: [], calls: [] }));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const a = process.argv.slice(2);
const option = (name) => a[a.indexOf(name) + 1];
s.calls.push(a.join(' '));
if (a[0] === 'label' && a[1] === 'create') s.labels.push({ name: a[2], color: option('--color'), description: option('--description') });
else if (a[0] === 'label' && a[1] === 'delete') s.labels = s.labels.filter((l) => l.name !== a[2]);
else if (a.includes('POST')) s.milestones.push(a.at(-1).slice(6));
else if (a[0] === 'api' && a.some((w) => w.includes('/labels'))) s.labels.forEach((l) => console.log(JSON.stringify(l)));
else if (a[0] === 'api') s.milestones.forEach((m) => console.log('open ' + m));
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  const calls = (): string[] => JSON.parse(readFileSync(state, 'utf8')).calls;
  const changed = () => calls().filter((c) => /^label |POST/.test(c));
  // Without a GitHub remote, init succeeds, says what it skipped, and never runs gh.
  let result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because there is no origin remote yet/);
  assert.equal(calls().length, 0);
  assert.equal((await sandbox.call(['init', '--yes'], { extra })).status, 1, '--yes alone is refused');
  assert.equal((await sandbox.call(['init', '--remove-default-labels'], { extra })).status, 1, 'so is --remove-default-labels');
  assert.equal((await sandbox.call(['init', '--board'], { extra })).status, 1, 'and --board (#156)');
  // --github --yes asked for changes on GitHub; with no remote none were made, so it fails (#208).
  result = await sandbox.call(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub: skipped, because there is no origin remote yet\. Add one on GitHub, then run `yokoten init --github --yes`/);
  assert.match(result.stderr, /\nyokoten init: --github --yes changed nothing on GitHub \(the reason is above\)\. The project files are as listed above\.\n$/);
  assert.equal(calls().length, 0);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: example\/repo\n- 1 of the 12 standard labels are there; kept\n- not in the standard set: question\./);
  assert.match(result.stdout, /Would do:\n- make label "feat"[^]*- make milestone "First release"\nNothing changed\./);
  assert.deepEqual(changed(), [], 'plain init only reads');
  result = await sandbox.call(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- done: make label "good first issue"[^\n]*\n[^]*- done: make milestone "First release"/);
  assert.equal(changed().length, 12);
  result = await sandbox.call(['init', '--github', '--yes'], { extra });
  assert.match(result.stdout, /- 12 of the 12 standard labels are there; kept\n- a milestone is open; kept\n[^]*Nothing to change\./);
  assert.equal(changed().length, 12, 'the second run changed nothing');
  // Without gh on the PATH, plain init still succeeds and says so. Only node and git are there.
  const noGh = join(sandbox.home, 'no-gh');
  mkdirSync(noGh);
  const gitPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(process.execPath, join(noGh, 'node'));
  symlinkSync(join(gitPath, 'git'), join(noGh, 'git'));
  result = await sandbox.call(['init'], { extra: { PATH: noGh } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because gh is not installed/);
  // init --github --yes fails: it was asked to change GitHub and could not (#208).
  result = await sandbox.call(['init', '--github', '--yes'], { extra: { PATH: noGh } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub: skipped, because gh is not installed[^\n]*\nyokoten init: --github --yes changed nothing on GitHub/);
});

test('init: a yokoten.json "areas" that is not a list stops init before it writes a file (#156)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: 'cli' }));
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten init: yokoten\.json: "areas" must be a list of names/);
  assert.doesNotMatch(result.stderr, /is not a function/);
  assert.ok(!existsSync(join(sandbox.repo, 'AGENTS.md')), 'nothing written');
  // The control: the same project with a list runs.
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['cli'] }));
  result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(sandbox.repo, 'AGENTS.md')));
});

// The kit version mark in AGENTS.md (#141): newer is never "behind", and no mark compares by content.
test('core rules: the kit version mark tells older from newer; no mark compares by content (#141)', () => {
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1, 'numbers, not text');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1, 'a pre-release is older than its release');
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('{{version}}', '0.1.0'), null, 'not a version');
  assert.equal(readKitVersion('<!-- yokoten kit 0.3.1 -->\r\n# rules\n'), '0.3.1');
  assert.equal(readKitVersion('# rules\n'), null);

  const kit = '<!-- yokoten kit 0.2.0 -->\n# rules\n\n## This project\n';
  const own = '## This project\n\nours\n';
  const newer = compareCoreRules(`<!-- yokoten kit 0.3.0 -->\n# rules, later\n\n${own}`, kit);
  assert.deepEqual(newer, { state: 'newer', version: '0.3.0', kitVersion: '0.2.0' });
  const older = compareCoreRules(`<!-- yokoten kit 0.1.0 -->\n# old rules\n\n${own}`, kit);
  assert.equal(older.state, 'behind');
  assert.equal(older.state === 'behind' && older.updated, `<!-- yokoten kit 0.2.0 -->\n# rules\n\n${own}`, 'the update writes the new mark');
  const unmarked = compareCoreRules(`# old rules\n\n${own}`, kit);
  assert.equal(unmarked.state === 'behind' && unmarked.updated, `<!-- yokoten kit 0.2.0 -->\n# rules\n\n${own}`, 'no mark: an unknown version, compared by content');
  assert.equal(compareCoreRules(`# rules\n\n${own}`, kit).state, 'same', 'the mark alone is no change');
  assert.equal(compareCoreRules(`<!-- yokoten kit 0.9.0 -->\n# rules\n\n${own}`, kit).state, 'same', 'a newer mark with the same text is up to date');
  assert.equal(compareCoreRules(`<!-- yokoten kit {{version}} -->\n# rules, later\n\n${own}`, kit).state, 'behind', 'a mark that is not a version is unknown');
});

// #377: a private repo pays for its Actions minutes. init says so and never chooses for
// the owner; `init --no-ci` keeps CI off, and the road can still be finished.
test('init: a private repo can keep CI off with --no-ci, finish the road, and take CI up again (#377)', async () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, { 'api users/octo --jq .type': 'User', 'api repos/octo/app --jq .private': 'true' });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const ciFiles = ['.github/workflows/yokoten.yml', '.github/workflows/pr.yml', '.github/workflows/issue.yml', '.github/dependabot.yml'];
  const isThere = (file: string) => existsSync(join(sandbox.repo, file));
  const notNow = () => JSON.parse(readFileSync(join(sandbox.repo, 'yokoten.json'), 'utf8')).notNow;
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, 'not a real key\n');
  const machine = { ...extra, YOKOTEN_PRIVATE_MARKS: marks, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key };
  const session = async () => (await sandbox.call(['doctor', '--session'], { extra: machine })).stdout.trimEnd().split('\n');
  assert.equal(sandbox.run(['install']).status, 0); // a real process: the entry point of install

  // Without the choice: today's behaviour. The workflows are written, and init says what they cost.
  let result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^note: this repo is private, so the workflows in \.github\/workflows use Actions minutes from your plan$/m);
  assert.match(result.stdout, /^to keep CI off, run `yokoten init --no-ci`/m);
  assert.ok(ciFiles.every(isThere));
  assert.deepEqual(notNow(), {}, 'init never makes the choice itself');
  sandbox.write('.github/CODEOWNERS', '* @octo\n');
  sandbox.write('LICENSE', 'placeholder license\n');
  assert.match((await session())[0], /stage 1 of 5, safety net\. Next: no workflow runs a test command/, 'the tests step still asks for CI');

  // With the choice: the kit's copies go, a changed one stays and is named, and "notNow" holds the reason.
  sandbox.write('.github/workflows/issue.yml', 'name: ours\n');
  result = await sandbox.call(['init', '--no-ci'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^wrote "notNow" ci in yokoten\.json/m);
  for (const file of ['.github/workflows/yokoten.yml', '.github/workflows/pr.yml', '.github/dependabot.yml']) {
    assert.match(result.stdout, new RegExp(`^removed ${file.replaceAll('.', '\\.')} \\(the kit's copy; CI is off\\)$`, 'm'));
    assert.ok(!isThere(file), file);
  }
  assert.match(result.stdout, /^kept \.github\/workflows\/issue\.yml: it is not the kit's copy/m);
  assert.equal(result.stdout.match(/^kept \.github\/workflows\/issue\.yml/gm)?.length, 1, 'a kept file is named once');
  assert.doesNotMatch(result.stdout, /this repo is private/, 'the choice is made, so no offer');
  assert.deepEqual(notNow(), { ci: NO_CI_REASON });
  rmSync(join(sandbox.repo, '.github', 'workflows', 'issue.yml'));
  // A later init writes no workflow again, and says why.
  result = await sandbox.call(['init'], { extra });
  assert.match(result.stdout, /^skipped \.github\/workflows\/yokoten\.yml \(yokoten\.json "notNow" names ci\)$/m);
  assert.match(result.stdout, /^skipped \.github\/dependabot\.yml \(yokoten\.json "notNow" names ci\)$/m);
  assert.ok(!ciFiles.some(isThere));

  // The road: no nag about CI, and every step yokoten can check is done or not now.
  assert.deepEqual(await session(), ['yokoten: every step yokoten can check is done, or marked not now.']);
  const full = (await sandbox.call(['doctor'], { extra: machine })).stdout;
  assert.match(full, /^ +not now +tests \(Best Practices: test\): CI is off to save Actions minutes[^\n]*\(notNow ci\); run the tests yourself before each merge$/m);
  assert.match(full, /^ +not now +ci \(Scorecard: CI-Tests\): CI is off to save Actions minutes/m);
  assert.match(full, /^ +not now +titles \([^)]*\): [^\n]*; run `npx yokoten check --pr <number>` before each merge$/m);
  assert.match(full, /^ +done +security-files/m, 'no Dependabot config is asked for');
  // The trade-off, said once: what is not checked, and when to end the choice.
  assert.equal(full.match(/no-ci: /g)?.length, 1, full);
  assert.match(full, /^ +note +no-ci: CI is off \("notNow" names `ci`\), so nothing on the server checks pull requests, issue titles or the workflows, no code scanning such as CodeQL runs[^\n]*; before each merge, run `npx yokoten check --pr <number>` and the tests; when the repo goes public, remove "ci" from "notNow"/m);

  // Taking CI up again: remove the choice, and init brings the workflows back.
  sandbox.write('yokoten.json', JSON.stringify({ notNow: {} }));
  result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(ciFiles.every(isThere), result.stdout);
  assert.match((await session())[0], /stage 1 of 5, safety net\. Next: no workflow runs a test command/);
  assert.doesNotMatch((await sandbox.call(['doctor'], { extra: machine })).stdout, /no-ci/);
});

test('init --no-ci: the dependabot.yml init wrote with an ecosystem block is removed too (#377, #379)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{}\n');
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(sandbox.repo, '.github', 'dependabot.yml'), 'utf8'), /package-ecosystem: npm/);
  result = await sandbox.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^removed \.github\/dependabot\.yml \(the kit's copy; CI is off\)$/m);
  assert.ok(!existsSync(join(sandbox.repo, '.github', 'dependabot.yml')));
});

test('init: only "notNow" ci leaves kit files out; other steps in "notNow" keep today\'s files (#377)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { templates: 'later', changelog: 'later', codeowners: 'later', 'security-files': 'later', titles: 'later' } }));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^skipped /m);
  for (const file of ['.github/ISSUE_TEMPLATE/task.yml', '.github/pull_request_template.md', 'changes/README.md', '.github/SECURITY.md', '.github/dependabot.yml', '.github/CODEOWNERS', '.github/workflows/pr.yml']) {
    assert.ok(existsSync(join(sandbox.repo, file)), file);
  }
});

test('init --no-ci: a kit copy with Windows line ends is removed; a symlinked file or folder is kept and named (#377)', { skip: process.platform === 'win32' && 'symlinks need rights on Windows' }, async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const workflows = join(sandbox.repo, '.github', 'workflows');
  // A Windows checkout (core.autocrlf) has CRLF line ends on every line.
  const pr = join(workflows, 'pr.yml');
  writeFileSync(pr, readFileSync(pr, 'utf8').replace(/\n/g, '\r\n'));
  // A symlinked file: the file it points at stays, whatever it holds.
  const target = join(sandbox.home, 'issue.yml');
  cpSync(join(workflows, 'issue.yml'), target);
  rmSync(join(workflows, 'issue.yml'));
  symlinkSync(target, join(workflows, 'issue.yml'));
  let result = await sandbox.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^removed \.github\/workflows\/pr\.yml \(the kit's copy; CI is off\)$/m);
  assert.match(result.stdout, /^kept \.github\/workflows\/issue\.yml: \.github\/workflows\/issue\.yml is a symlink, and init never deletes through one/m);
  assert.ok(existsSync(target));
  assert.ok(lstatSync(join(workflows, 'issue.yml')).isSymbolicLink());

  // A symlinked .github/workflows folder: nothing in it is deleted.
  const other = makeSandbox();
  assert.equal((await other.call(['init'])).status, 0);
  const real = join(other.home, 'workflows');
  cpSync(join(other.repo, '.github', 'workflows'), real, { recursive: true });
  rmSync(join(other.repo, '.github', 'workflows'), { recursive: true });
  symlinkSync(real, join(other.repo, '.github', 'workflows'));
  result = await other.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml: \.github\/workflows is a symlink/m);
  assert.deepEqual(readdirSync(real).sort(), ['issue.yml', 'pr.yml', 'yokoten.yml']);
  // The control: dependabot.yml is a plain file, the kit's copy, so it goes.
  assert.match(result.stdout, /^removed \.github\/dependabot\.yml/m);
});

test('init --no-ci: only the "notNow" key changes in yokoten.json; the rest keeps its formatting (#377)', async () => {
  const sandbox = makeSandbox();
  const own = '{\n    "areas": ["cli",   "docs"],\n    "notNow": {\n        "bot": "no app yet"\n    }\n}\n';
  sandbox.write('yokoten.json', own);
  let result = await sandbox.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(sandbox.repo, 'yokoten.json'), 'utf8'), `{\n    "areas": ["cli",   "docs"],\n    "notNow": {\n        "ci": ${JSON.stringify(NO_CI_REASON)},\n        "bot": "no app yet"\n    }\n}\n`);
  // No "notNow" key yet: one is added after the opening brace, and nothing else moves.
  const other = makeSandbox();
  other.write('yokoten.json', '{ "areas": ["cli"] }\n');
  result = await other.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(other.repo, 'yokoten.json'), 'utf8'), `{ "notNow": { "ci": ${JSON.stringify(NO_CI_REASON)} }, "areas": ["cli"] }\n`);
  // A second run keeps it.
  assert.match((await other.call(['init', '--no-ci'])).stdout, /^kept "notNow" ci in yokoten\.json$/m);
});

// ---- The core rules into an AGENTS.md the project already has (#378) ----

const KIT_RULES = '<!-- yokoten kit 1.0.0 -->\n# How work is done here\n\n## Core rules\n\n1. a rule\n\n## This project\n\n<!-- yours here -->\n';
const KIT_CORE = KIT_RULES.slice(0, KIT_RULES.indexOf('## This project'));

test('core rules into AGENTS.md: headings go one level down, everything else stays byte for byte (#378)', () => {
  // No headings: the text moves as it is.
  assert.deepEqual(demoteHeadings('just text\nmore\n'), { text: 'just text\nmore\n', headings: [], deepest: [] });
  // `# Title` first, and ATX headings at each level; level 6 stays; `#tag` is no heading.
  const atx = demoteHeadings('# Title\n\nText\n## Sub\n  ### Indented ###\n###### Six\n#tag\n');
  assert.equal(atx.text, '## Title\n\nText\n### Sub\n  #### Indented ###\n###### Six\n#tag\n');
  assert.deepEqual(atx.headings.map((h) => h.after), ['`## Title`', '`### Sub`', '`#### Indented ###`']);
  assert.deepEqual(atx.deepest, ['`###### Six`']);
  // Setext: `===` becomes `---`; a `---` heading becomes `###`. A rule after a blank line, a
  // list or a quote is not a heading.
  const setext = demoteHeadings('Big\n===\n\nSmall\n---\n\n---\n\n- item\n---\n> quote\nlazy\n---\n');
  assert.equal(setext.text, 'Big\n---\n\n### Small\n\n---\n\n- item\n---\n> quote\nlazy\n---\n');
  assert.equal(setext.headings.length, 2);
  // Headings inside fenced code blocks stay, with either fence and a longer closing fence.
  const fenced = '```md\n# not a heading\nTitle\n===\n```\n~~~~\n# not\n~~~\n## still not\n~~~~~\n# yes\n    # indented code\n';
  assert.equal(demoteHeadings(fenced).text, fenced.replace('# yes', '## yes'));
  // CRLF lines keep CRLF; a last line without a newline keeps none.
  assert.equal(demoteHeadings('# A\r\n\r\nB\r\n---\r\ntext').text, '## A\r\n\r\n### B\r\ntext');
  assert.equal(demoteHeadings('').text, '');
});

test('core rules into AGENTS.md: the kit core on top, then `## This project`, then the text (#378)', () => {
  const moved = moveUnderProjectHeading('# Ours\n\nBuild with make.\n', KIT_RULES);
  assert.equal(moved.text, `${KIT_CORE}## This project\n\n## Ours\n\nBuild with make.\n`);
  assert.equal(moved.lines, 3);
  assert.equal(compareCoreRules(moved.text, KIT_RULES).state, 'same', 'doctor finds the core rules up to date');
  // CRLF: the new lines take CRLF too, so update compares it as the same.
  const crlf = moveUnderProjectHeading('# Ours\r\n\r\nrule\r\n', KIT_RULES);
  assert.equal(crlf.text, `${KIT_CORE.replaceAll('\n', '\r\n')}## This project\r\n\r\n## Ours\r\n\r\nrule\r\n`);
  assert.equal(compareCoreRules(crlf.text, KIT_RULES).state, 'same');
  // A byte order mark is dropped, so the kit version line comes first.
  const bom = moveUnderProjectHeading('\uFEFF# Ours\n', KIT_RULES);
  assert.ok(bom.hadBom);
  assert.ok(bom.text.startsWith('<!-- yokoten kit 1.0.0 -->\n'));
  assert.equal(readKitVersion(bom.text), '1.0.0');
  // An empty file, or one with blank lines only, gets the kit's file.
  for (const empty of ['', '\n\n', '\uFEFF']) assert.deepEqual(moveUnderProjectHeading(empty, KIT_RULES), { text: KIT_RULES, lines: 0, headings: [], deepest: [], hadBom: empty === '\uFEFF', frontMatter: false });
});

test('init: an AGENTS.md without `## This project` gets the core rules on top, and a copy of the old file (#378)', async () => {
  const sandbox = makeSandbox();
  const old = '# Our rules\n\nRun `make test`.\n\n## Style\n\nTabs.\n';
  sandbox.write('AGENTS.md', old);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^updated AGENTS\.md: the core rules are on top, and your 7 line\(s\) moved under `## This project`; only their heading levels changed \(kept the old file as AGENTS\.md\.before-yokoten;/m);
  assert.match(result.stdout, /^ {2}heading one level down: `# Our rules` is now `## Our rules`$/m);
  assert.match(result.stdout, /^ {2}heading one level down: `## Style` is now `### Style`$/m);
  const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
  const kit = readFileSync(join(ROOT, 'kit', 'project', 'AGENTS.md'), 'utf8');
  const kitCore = kit.slice(0, kit.search(/^## This project$/m)).replace('{{version}}', JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(text, `${kitCore}## This project\n\n## Our rules\n\nRun \`make test\`.\n\n### Style\n\nTabs.\n`);
  assert.equal(readFileSync(join(sandbox.repo, AGENTS_BACKUP), 'utf8'), old, 'the old file, byte for byte');
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);
  // A second run finds the heading and leaves the file to `update`.
  const again = await sandbox.call(['init']);
  assert.match(again.stdout, /^kept AGENTS\.md \(`yokoten update` brings its core rules up to date\)$/m);
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), text);
});

test('init: a committed AGENTS.md with CRLF and a BOM moves with no copy; git gives the old one back (#378)', async () => {
  const sandbox = makeSandbox();
  const old = '\uFEFFRules\r\n=====\r\n\r\n```sh\r\n# a comment, not a heading\r\n```\r\n';
  sandbox.write('AGENTS.md', old);
  sandbox.git('add', 'AGENTS.md');
  sandbox.git('commit', '-q', '-m', 'rules');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /to get the old file back: `git checkout HEAD -- AGENTS\.md`/);
  assert.match(result.stdout, /^ {2}heading one level down: `Rules` \(underlined with =\) is now `Rules` \(underlined with -\)$/m);
  assert.match(result.stdout, /^ {2}dropped the byte order mark/m);
  assert.ok(!existsSync(join(sandbox.repo, AGENTS_BACKUP)), 'git has the old file');
  const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith('<!-- yokoten kit '));
  assert.ok(text.endsWith('## This project\r\n\r\nRules\r\n-----\r\n\r\n```sh\r\n# a comment, not a heading\r\n```\r\n'), text.slice(-120));
  assert.ok(!/(?<!\r)\n/.test(text), 'every line ends in CRLF');
  sandbox.git('checkout', 'HEAD', '--', 'AGENTS.md');
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), old, 'the command it prints gives the old file back');
});

test('init: an empty AGENTS.md gets the kit file; a different copy already there stops the move (#378)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '');
  const result = await sandbox.call(['init']);
  assert.match(result.stdout, /^wrote AGENTS\.md: it had no text, so it now has the core rules and an empty `## This project` section/m);
  assert.match(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), /^## This project$/m);

  const other = makeSandbox();
  other.write('AGENTS.md', '# mine\n');
  other.write(AGENTS_BACKUP, '# an older copy\n');
  const stopped = await other.call(['init']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /^kept AGENTS\.md: it has no `## This project` heading, and AGENTS\.md\.before-yokoten is there already/m);
  assert.equal(readFileSync(join(other.repo, 'AGENTS.md'), 'utf8'), '# mine\n');
  assert.equal(readFileSync(join(other.repo, AGENTS_BACKUP), 'utf8'), '# an older copy\n');
});

test('init: an AGENTS.md that is a link is kept, so init never writes through it into CLAUDE.md (#378)', { skip: process.platform === 'win32' && 'a link needs admin rights on Windows' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# our rules\n');
  symlinkSync('CLAUDE.md', join(sandbox.repo, 'AGENTS.md'));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept AGENTS\.md: it is a link to CLAUDE\.md/m);
  assert.doesNotMatch(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), /Core rules/);
});

test('core rules into AGENTS.md: YAML front matter stays at the very top, as it was (#378)', () => {
  // `---` or `...` closes it; nothing inside is demoted, not even a `# comment` line.
  for (const close of ['---', '...']) {
    const front = `---\ntitle: Rules\n# a YAML comment\n${close}\n`;
    const moved = moveUnderProjectHeading(`${front}# Ours\n`, KIT_RULES);
    assert.ok(moved.frontMatter);
    assert.equal(moved.text, `${front}${KIT_CORE}## This project\n\n## Ours\n`);
    assert.deepEqual(moved.headings.map((h) => h.after), ['`## Ours`']);
    // doctor and update read past it: the core rules are the same, and an update keeps it.
    assert.equal(compareCoreRules(moved.text, KIT_RULES).state, 'same');
    const behind = compareCoreRules(moved.text.replace('1. a rule', '1. an old rule'), KIT_RULES);
    assert.ok(behind.state === 'behind' && behind.updated === moved.text, 'update --write keeps the front matter');
  }
  // CRLF, a BOM, and a closing line at the very end of the file.
  assert.equal(moveUnderProjectHeading('\uFEFF---\r\na: 1\r\n---\r\nText\r\n', KIT_RULES).text, `---\r\na: 1\r\n---\r\n${KIT_CORE.replaceAll('\n', '\r\n')}## This project\r\n\r\nText\r\n`);
  assert.equal(moveUnderProjectHeading('---\na: 1\n---', KIT_RULES).text, `---\na: 1\n---\n${KIT_RULES}`);
  // A first line `---` with no closing line is plain text: a rule, then a heading under it.
  assert.deepEqual(splitFrontMatter('---\n# Rules\n'), { front: '', rest: '---\n# Rules\n' });
  const plain = moveUnderProjectHeading('---\n# Rules\nText\n', KIT_RULES);
  assert.ok(!plain.frontMatter);
  assert.equal(plain.text, `${KIT_CORE}## This project\n\n---\n## Rules\nText\n`);
});

test('init: an AGENTS.md with front matter keeps it on top and says so (#378)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '---\ndescription: our rules\n---\n# Ours\n');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}kept the front matter at the very top, as it was$/m);
  const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith('---\ndescription: our rules\n---\n<!-- yokoten kit '), text.slice(0, 80));
  assert.ok(text.endsWith('## This project\n\n## Ours\n'));
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);
});

// ---- The kit's workflows: an old copy the project never changed is updated (#456) ----

const KIT_WORKFLOWS = join(KIT, 'project', '.github', 'workflows');

/** Commit everything in the sandbox repo, so git has the files init may replace. */
const commitAll = (sandbox: ReturnType<typeof makeSandbox>) => {
  assert.equal(sandbox.git('add', '-A').status, 0);
  assert.equal(sandbox.git('commit', '-q', '-m', 'before init').status, 0);
};

/** The kit's workflow `name` as init writes it into a project. */
const kitWorkflow = (name: string) => render(readFileSync(join(KIT_WORKFLOWS, name), 'utf8'), { cli: '.yokoten/bin/yokoten.ts', version: VERSION });

/** The kit's newest yokoten.yml with a `tests` job added the way the tests step says (#552). */
const withTestsJob = (yml: string): string =>
  yml
    .replace(/^  ci:$/m, '  tests:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - run: npm test\n  ci:')
    .replace('needs: [changes, check, lint]', 'needs: [changes, check, lint, tests]');

/** The kit's yokoten.yml before #451, rebuilt from the newest: one of the versions init wrote. */
const oldYokotenYml = () =>
  kitWorkflow('yokoten.yml')
    .replace(
      '# A newer run cancels the one still going for the same pull request or branch. On main,\n# the newest run tests everything the older ones would have, so a merge never waits\n# behind runs that no longer matter.\n',
      '# A new push to a pull request cancels the run still going for it. A push to main gets\n# a group of its own, so a run on main is never cancelled.\n',
    )
    .replace("group: ${{ github.workflow }}-${{ github.ref }}", "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}")
    // Before #572, the kit set up Node by its line alone.
    .replace("node-version: '^22.23.4'", 'node-version: 22')
    // Before #590, the kit never ran on a merge queue group.
    .replace('  # A merge queue runs the same checks as a pull request: every job below also runs\n  # on a merge group. Turn the queue on in the repo settings.\n  merge_group:\n', '')
    .replace(
      "  # Markdown can't break are skipped. A push to main is a full run, and so is a merge\n  # queue group. So is a file list that can't be read: docs_only is true only when the\n  # list was read and every file fits.\n",
      "  # Markdown can't break are skipped. A push to main is a full run. So is a file list\n  # that can't be read: docs_only is true only when the list was read and every file fits.\n",
    );

test('init: the list of kit workflow hashes ends with each workflow as it is now (#456)', () => {
  const hashes = readWorkflowHashes();
  const names = readdirSync(KIT_WORKFLOWS).sort();
  assert.deepEqual(Object.keys(hashes).sort(), names.map((name) => `.github/workflows/${name}`), 'one list for each kit workflow, no more');
  for (const name of names) {
    const list = hashes[`.github/workflows/${name}`];
    assert.equal(list.at(-1), textHash(kitWorkflow(name)), `kit/project/.github/workflows/${name} changed: add its new hash at the end of kit/workflow-hashes.json, and keep the old ones`);
    assert.equal(new Set(list).size, list.length, `${name}: each hash once`);
  }
  assert.ok(hashes['.github/workflows/yokoten.yml'].includes(textHash(oldYokotenYml())), 'the old copy the next tests use is one the kit wrote');
});

test('init: a project with no workflows gets the kit\'s, and a second run keeps them (#456)', async () => {
  const sandbox = makeSandbox();
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  for (const name of readdirSync(KIT_WORKFLOWS)) {
    assert.match(result.stdout, new RegExp(`^wrote \\.github/workflows/${name.replace('.', '\\.')}$`, 'm'));
    assert.equal(readFileSync(join(sandbox.repo, '.github/workflows', name), 'utf8'), kitWorkflow(name));
  }
  result = await sandbox.call(['init']);
  for (const name of readdirSync(KIT_WORKFLOWS)) assert.match(result.stdout, new RegExp(`^kept \\.github/workflows/${name.replace('.', '\\.')}$`, 'm'));
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/, 'nothing to say about the kit\'s own copies');
});

test('init: updates a kit workflow the project never changed, with its line ends (#456)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/workflows/yokoten.yml', oldYokotenYml().replace(/\n/g, '\r\n'));
  // The newest copy with Windows line ends is the same file: kept byte for byte.
  const prCrlf = kitWorkflow('pr.yml').replace(/\n/g, '\r\n');
  sandbox.write('.github/workflows/pr.yml', prCrlf);
  commitAll(sandbox);
  assert.match((await sandbox.call(['doctor'])).stdout, /note +kit-workflows: \.github\/workflows\/yokoten\.yml is an older copy of the kit's, and you never changed it; run `yokoten init` to update it/);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^updated \.github\/workflows\/yokoten\.yml to the kit's newest copy \(you had not changed it; `git restore --source=HEAD -- \.github\/workflows\/yokoten\.yml` brings the old one back\)$/m);
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8'), kitWorkflow('yokoten.yml').replace(/\n/g, '\r\n'), 'the newest copy, with the line ends the file had');
  assert.match(result.stdout, /^kept \.github\/workflows\/pr\.yml$/m);
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/pr.yml'), 'utf8'), prCrlf);
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/);
});

test('init: keeps a kit workflow with the project\'s changes, and says once how to see the difference (#456)', async () => {
  const sandbox = makeSandbox();
  const mine = `${oldYokotenYml()}  # our own job goes here\n`;
  sandbox.write('.github/workflows/yokoten.yml', mine);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  const diff = 'git diff --no-index .github/workflows/yokoten.yml .yokoten/kit/project/.github/workflows/yokoten.yml';
  assert.match(result.stdout, new RegExp(`^kept \\.github/workflows/yokoten\\.yml: it has your changes\\. To see how the kit's newest copy differs: \`${diff.replaceAll('.', '\\.')}\`$`, 'm'));
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8'), mine, 'kept byte for byte');
  assert.ok(existsSync(join(sandbox.repo, '.yokoten/kit/project/.github/workflows/yokoten.yml')), 'the command names a file that is there');
  assert.equal(sandbox.git(...diff.split(' ').slice(1)).status, 1, 'and it shows a difference');
  const first = (await sandbox.call(['doctor'])).stdout;
  assert.match(first, /note +kit-workflows: \.github\/workflows\/yokoten\.yml has your changes, and the kit's newest copy differs; to see how: `git diff --no-index/);
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/, 'said once for this kit version');
});

test('init: never writes through a symlinked kit workflow (#456)', async () => {
  const sandbox = makeSandbox();
  const target = join(makeTempDir(), 'yokoten.yml');
  writeFileSync(target, oldYokotenYml());
  mkdirSync(join(sandbox.repo, '.github/workflows'), { recursive: true });
  symlinkSync(target, join(sandbox.repo, '.github/workflows/yokoten.yml'));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml: it is a symlink, so yokoten did not write through it$/m);
  assert.equal(readFileSync(target, 'utf8'), oldYokotenYml());
  assert.ok(lstatSync(join(sandbox.repo, '.github/workflows/yokoten.yml')).isSymbolicLink());
});

test('compareWorkflow: same, older, changed, missing; Windows line ends compare as Unix ones (#456)', () => {
  const root = makeTempDir();
  const rel = '.github/workflows/ci.yml';
  const hashes = { [rel]: [textHash('old: 1\n'), textHash('new: 2\n')] };
  assert.equal(compareWorkflow(root, rel, 'new: 2\n', hashes), 'missing');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const [text, state] of [['new: 2\r\n', 'same'], ['old: 1\r\n', 'older'], ['old: 1\r\n\r\n', 'changed'], ['old: 1\n\n', 'changed'], ['old: 1\nx: 1\r\n', 'changed'], ['old: 1\nmine: 3\n', 'changed']] as const) {
    writeFileSync(join(root, rel), text);
    assert.equal(compareWorkflow(root, rel, 'new: 2\n', hashes), state, JSON.stringify(text));
  }
  assert.equal(compareWorkflow(root, rel, 'new: 2\n', {}), 'changed', 'a file with no list is never taken for a kit copy');
});

test('compareWorkflow: a job added the way doctor says stays up to date (#552)', () => {
  const root = makeTempDir();
  const rel = '.github/workflows/yokoten.yml';
  const kit = kitWorkflow('yokoten.yml');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, rel), withTestsJob(kit));
  assert.equal(compareWorkflow(root, rel, kit, readWorkflowHashes()), 'same');
  assert.equal(compareWorkflow(root, rel, kit, {}), 'same', 'no hash list needed');
});

test('hasIntactKitJobs: own jobs and wider needs pass; a kit job behind does not (#552)', () => {
  const kit = 'name: small\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make check\n  ci:\n    if: always()\n    needs: [check]\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n';
  const plusTests = kit
    .replace('  ci:\n', '  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  ci:\n')
    .replace('needs: [check]', 'needs: [check, tests]');
  assert.ok(hasIntactKitJobs(plusTests, kit), 'an added job and a wider needs list');
  assert.ok(hasIntactKitJobs(plusTests.replace('needs: [check, tests]', 'needs:\n      - check\n      - tests'), kit), 'a block needs list');
  assert.ok(!hasIntactKitJobs(plusTests, kit.replace('on: push', 'on: pull_request')), 'words outside the jobs');
  assert.ok(!hasIntactKitJobs(plusTests.replace('      - run: make check', '      - run: make check-all'), kit), 'a changed kit job');
  assert.ok(!hasIntactKitJobs(plusTests.replace('needs: [check, tests]', 'needs: [tests]'), kit), 'a narrower needs list');
  assert.ok(!hasIntactKitJobs(kit, plusTests), 'the other way round: the kit lacks the added job');
  assert.ok(!hasIntactKitJobs('no jobs here\n', kit), 'no jobs block in the project');
  assert.ok(!hasIntactKitJobs(plusTests, 'no jobs here\n'), 'no jobs block in the kit');
});

test('init: keeps a kit workflow with only the project\'s own jobs added (#552)', async () => {
  const sandbox = makeSandbox();
  const mine = withTestsJob(kitWorkflow('yokoten.yml'));
  sandbox.write(YML, mine);
  commitAll(sandbox);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml$/m);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), mine, 'kept byte for byte');
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/);
});

test('doctor: no kit-workflows note after adding the tests job the way doctor says (#552)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{"scripts": {"test": "node --test"}}\n');
  sandbox.write(YML, withTestsJob(kitWorkflow('yokoten.yml')));
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/);
});

test('doctor: a kit-workflows note when the kit\'s own jobs fall behind (#552)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{"scripts": {"test": "node --test"}}\n');
  sandbox.write(YML, withTestsJob(kitWorkflow('yokoten.yml')).replace('node .yokoten/bin/yokoten.ts check', 'node .yokoten/bin/yokoten.ts check --stray'));
  assert.match((await sandbox.call(['doctor'])).stdout, /note +kit-workflows: \.github\/workflows\/yokoten\.yml has your changes, and the kit's newest copy differs/);
});

const YML = '.github/workflows/yokoten.yml';

test('init: keeps an old kit workflow that git cannot give back: untracked, or edited since the last commit (#456)', async () => {
  const old = oldYokotenYml();
  const keptLine = /^kept \.github\/workflows\/yokoten\.yml: it is an older kit copy that is not committed, so commit it and run init again$/m;
  // Untracked.
  let sandbox = makeSandbox();
  sandbox.write(YML, old);
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, keptLine);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), old);
  // Tracked, with an uncommitted edit that leaves the text a kit copy: HEAD has other text.
  sandbox = makeSandbox();
  sandbox.write(YML, `${old}# committed note\n`);
  commitAll(sandbox);
  sandbox.write(YML, old);
  result = await sandbox.call(['init']);
  assert.match(result.stdout, keptLine);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), old);
  // Committed, then init, then the way back is true.
  sandbox = makeSandbox();
  sandbox.write(YML, old);
  commitAll(sandbox);
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /^updated \.github\/workflows\/yokoten\.yml to the kit's newest copy/m);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), kitWorkflow('yokoten.yml'));
  assert.equal(sandbox.git('restore', '--source=HEAD', '--', YML).status, 0);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), old, 'git restore gives the old text back');
});

test('init: a file that differs only in line ends or blank lines at the end is the project\'s change, and is kept (#456)', async () => {
  const old = oldYokotenYml();
  for (const [name, text] of [['one CRLF', `${old.slice(0, old.indexOf('\n'))}\r${old.slice(old.indexOf('\n'))}`], ['blank lines at the end', `${old}\n\n`]] as const) {
    const sandbox = makeSandbox();
    sandbox.write(YML, text);
    commitAll(sandbox);
    const result = await sandbox.call(['init']);
    assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml: it has your changes/m, name);
    assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), text, name);
  }
});

test('init: a folder where a kit workflow goes is kept, not a crash (#456)', async () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.repo, YML), { recursive: true });
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml: it has your changes/m);
  assert.ok(lstatSync(join(sandbox.repo, YML)).isDirectory());
});

test('init --no-ci: removes a never-edited old kit workflow, and doctor is quiet about workflows when CI is off (#456)', async () => {
  const sandbox = makeSandbox();
  sandbox.write(YML, oldYokotenYml());
  commitAll(sandbox);
  const result = await sandbox.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^removed \.github\/workflows\/yokoten\.yml \(the kit's copy; CI is off\)$/m);
  assert.ok(!existsSync(join(sandbox.repo, YML)));
  // An old copy that stays (CI is off, init keeps it): no note to run init.
  sandbox.write(YML, oldYokotenYml());
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/);
});

test('init: a .gitignore for the status file, the worktrees and dependency folders, only adding missing lines (#521, #571, #614)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{"name":"app"}\n');
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.gitignore \(\.yokoten-agent\.json, \.worktrees\/, node_modules\/\)/);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.yokoten-agent.json\n.worktrees/\nnode_modules/\n');
  // Again: nothing changes.
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /kept \.gitignore/);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.yokoten-agent.json\n.worktrees/\nnode_modules/\n');
  // The project's own lines stay, in order; a line that is there in another form counts.
  sandbox.write('.gitignore', '.env\n/node_modules');
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /added to \.gitignore: \.yokoten-agent\.json, \.worktrees\//);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.env\n/node_modules\n.yokoten-agent.json\n.worktrees/\n');
  sandbox.write('.gitignore', '.env\ncoverage');
  sandbox.write('Cargo.toml', '[package]\nname = "x"\n');
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /added to \.gitignore: \.yokoten-agent\.json, \.worktrees\/, node_modules\/, target\//);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.env\ncoverage\n.yokoten-agent.json\n.worktrees/\nnode_modules/\ntarget/\n');
  // A line that is already there is not added again.
  sandbox.write('.gitignore', '.yokoten-agent.json\n.env\n');
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /added to \.gitignore: \.worktrees\/, node_modules\/, target\//);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.yokoten-agent.json\n.env\n.worktrees/\nnode_modules/\ntarget/\n');
});

test('init: .gitignore holds the status file and .worktrees/ even with no package manager (#571, #614)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.gitignore \(\.yokoten-agent\.json, \.worktrees\/\)/);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.yokoten-agent.json\n.worktrees/\n');
});
