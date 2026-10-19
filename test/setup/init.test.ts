// Tests for src/setup/init.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  MISSING_PROJECT,
  onToolCall,
  pick,
  stepMark,
} from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { parseCodeOwners } from '../../src/rules/pr.ts';
import { hasHook } from '../../src/agents/hooks-file.ts';
import { readCodeOwners } from '../../src/host/github.ts';
import {
  checkLines,
  compareCoreRules,
  compareVersions,
  handOffLines,
  placeHandOff,
  readKitVersion,
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
];

// Gemini CLI (v0.64.0) swaps `$GEMINI_PROJECT_DIR` in the command text for the shell-quoted
// launch folder, then runs the text in a shell (#210). This copies that against a repo whose
// path has a space and an @.
test('init: the Gemini hook command runs when Gemini quotes a path with a space (#210)', () => {
  const sandbox = makeSandbox();
  // An older yokoten wrote the folder in double quotes; init updates that hook in place.
  const old = 'node "$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts" hook --agent gemini';
  sandbox.write('.gemini/settings.json', JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: old, name: 'yokoten' }] }] } }));
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated the Gemini CLI tool-call hook/);
  const repo = join(dirname(sandbox.repo), 'my repo@1');
  renameSync(sandbox.repo, repo);
  const groups = JSON.parse(readFileSync(join(repo, '.gemini', 'settings.json'), 'utf8')).hooks.BeforeTool;
  assert.equal(groups.length, 1, 'updated, not added');
  const command: string = groups[0].hooks[0].command;
  assert.equal(command, guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts', 'hook --agent gemini'));
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

test('init: adds the practices, keeps what is there, and doctor goes on to stage 4', () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '# our own rules\n');
  sandbox.write('.github/SECURITY.md', '# email us\n');
  // The user's own Codex and Gemini CLI settings stay.
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  sandbox.write('.codex/hooks.json', JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  sandbox.write('.gemini/settings.json', JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  assert.match(sandbox.run(['doctor']).stdout, /note +codex-hook: no tool-call guard/, 'reported, not counted as missing');
  assert.match(sandbox.run(['doctor']).stdout, /note +antigravity-hook: no tool-call guard in \.agents\/hooks\.json/, 'the positive control for the Antigravity CLI step (#30)');
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept AGENTS\.md/);
  assert.match(result.stdout, /wrote \.githooks\/pre-commit/);
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), '# our own rules\n');
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
  assert.match(workflow, /^  ci:\n    if: always\(\)\n    needs: \[check, lint\]$/m, 'one required check that waits for the rest (#36)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/pr.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --pr/, 'the pull request check (#47)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/issue.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --issue/, 'the issue title check');
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  // Again: nothing changes.
  result = sandbox.run(['init']);
  assert.match(result.stdout, /kept \.github\/SECURITY\.md/);
  assert.match(result.stdout, /kept \.github\/dependabot\.yml/);
  assert.match(result.stdout, /kept CHANGELOG\.md/);
  assert.match(result.stdout, /same the tool-call hook/);
  assert.match(result.stdout, /same TZ=UTC for agent sessions/);
  const settings = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(result.stdout, /same the stop check/);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: guarded('"$CLAUDE_PROJECT_DIR/.yokoten/bin/yokoten.ts"', 'hook --stop') }] }], 'the stop check, once (#92)');
  assert.equal(settings.env.TZ, 'UTC', 'agent commits record no time zone (#40)');
  assert.match(result.stdout, /same the Codex tool-call hook/);
  assert.match(result.stdout, /same the Gemini CLI tool-call hook/);
  const codex = JSON.parse(readFileSync(join(sandbox.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.equal(codex.hooks.PreToolUse.length, 2);
  assert.deepEqual(codex.hooks.PreToolUse[1], {
    hooks: [{ type: 'command', command: guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts"', 'hook --agent codex') }],
    matcher: 'Bash|apply_patch',
  });
  const gemini = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.equal(gemini.hooks.BeforeTool.length, 2);
  assert.deepEqual(gemini.hooks.BeforeTool[1], {
    hooks: [{ type: 'command', command: guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts', 'hook --agent gemini'), name: 'yokoten' }],
    matcher: 'run_shell_command|write_file|replace',
  });
  // The stop checks (#211): Codex's Stop and Gemini's AfterAgent take no matcher, once each.
  assert.match(result.stdout, /same the Codex stop check/);
  assert.match(result.stdout, /same the Gemini CLI stop check/);
  assert.deepEqual(codex.hooks.Stop, [{ hooks: [{ type: 'command', command: guarded('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts"', 'hook --stop --agent codex') }] }]);
  assert.deepEqual(gemini.hooks.AfterAgent, [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts', 'hook --stop --agent gemini'), name: 'yokoten-stop' }] }]);
  // Codex's hooks are in place; this home has no ~/.codex, so doctor says nothing of its trust (#341).
  assert.match(sandbox.run(['doctor']).stdout, /ok +codex-hook: \.codex\/hooks\.json is in place; trust not checked, no ~\/\.codex\n +ok +gemini-hook\n +ok +antigravity-hook/);
  assert.match(result.stdout, /Codex runs the hooks in \.codex\/hooks\.json only after you trust this folder and the hooks\n.*to trust them in Codex: run `codex` in this folder, trust it, then trust both yokoten hooks in `\/hooks`/);
  // Antigravity CLI (#30): its own file, and Copilot CLI reads .claude/settings.json.
  assert.match(result.stdout, /same the Antigravity CLI tool-call hook in \.agents\/hooks\.json/);
  assert.match(result.stdout, /GitHub Copilot CLI runs the hooks in \.claude\/settings\.json only after you trust this folder\n.*to trust this folder in Copilot CLI: run `copilot` in this folder/);
  const agents = JSON.parse(readFileSync(join(sandbox.repo, '.agents', 'hooks.json'), 'utf8'));
  assert.deepEqual(agents.yokoten.PreToolUse[0].hooks[0].command, guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts"', 'hook --agent antigravity'));
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
  assert.match(sandbox.run(['doctor', '--session']).stdout, /^yokoten: stage 1 of 5, safety net\. Next: no workflow runs a test command/);
  sandbox.withTests();
  result = sandbox.run(['doctor', '--session']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^yokoten: stage 4 of 5, a team of agents\. Next: \.github\/CODEOWNERS names no owner yet \(@YOUR_GITHUB_HANDLE\); put your GitHub handle in \.github\/CODEOWNERS/);
});

test('init: safe defaults, Dependabot and a security policy; doctor lists the security switches (#35)', () => {
  const sandbox = makeSandbox();
  const r = sandbox.run(['init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote \.github\/SECURITY\.md/);
  assert.match(r.stdout, /wrote \.github\/dependabot\.yml/);
  const dependabot = readFileSync(join(sandbox.repo, '.github/dependabot.yml'), 'utf8');
  for (const line of [/package-ecosystem: github-actions/, /interval: monthly/, /default-days: 7/, /patterns: \['\*'\]/, /prefix: ci/]) assert.match(dependabot, line);
  assert.equal([...dependabot.matchAll(/^\s*- package-ecosystem:/gm)].length, 1, 'actions only, since the stack is unknown');
  assert.match(readFileSync(join(sandbox.repo, '.github/SECURITY.md'), 'utf8'), /\*\*Report a vulnerability\*\*/);
  const doctor = sandbox.run(['doctor']);
  for (const sw of [/private vulnerability reporting/, /secret scanning with push protection/, /Dependabot alerts/]) assert.match(doctor.stdout, sw);
  // Right after init only the license is missing: say what to do, not that init adds it (#208).
  const security = () => sandbox.run(['doctor']).stdout.split('\n').find((l) => / security-files\b/.test(l)) ?? '';
  assert.match(security(), /: no license file; choose a license and add it as LICENSE$/);
  assert.doesNotMatch(security(), /yokoten init/);
  rmSync(join(sandbox.repo, '.github/SECURITY.md'));
  assert.match(security(), /: no security policy \(SECURITY\.md\), no license file; run `yokoten init` to add the security policy and Dependabot, and choose a license and add it as LICENSE$/);
  sandbox.write('LICENSE', 'placeholder license\n');
  sandbox.run(['init']);
  assert.match(security(), /^ +done +security-files/);
});

test("init: a CLAUDE.md gets one line that imports AGENTS.md, and doctor's rules step wants it (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# our rules\n\nRun the tests first.\n');
  sandbox.write('AGENTS.md', '# shared rules\n');
  assert.notEqual(stepMark(sandbox, 'rules'), 'done', 'AGENTS.md that Claude Code does not read is not done');
  assert.match(sandbox.run(['doctor']).stdout, /rules[^\n]*: CLAUDE\.md does not import AGENTS\.md[^\n]*; add a line `@AGENTS\.md`/);
  rmSync(join(sandbox.repo, 'AGENTS.md'));
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote AGENTS\.md/);
  assert.match(result.stdout, /updated CLAUDE\.md: it now reads AGENTS\.md/);
  const claude = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# our rules\n\nRun the tests first.\n\n'), 'the project\'s own lines stay');
  assert.match(claude, /\n<!--[^\n]*-->\n@AGENTS\.md\n$/, 'a comment line, then the import, at the end');
  assert.equal(stepMark(sandbox, 'rules'), 'done');
  // Again: one import, not two.
  result = sandbox.run(['init']);
  assert.doesNotMatch(result.stdout, /updated CLAUDE\.md/);
  assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), claude);
});

test('init: writes .github/CODEOWNERS for every lead-only path, owned by the GitHub remote owner; check --pr then wants tier A (#304)', () => {
  const sandbox = makeSandbox();
  // A gh that always fails, so init never reaches GitHub for labels.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'gh'), 0o755);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = sandbox.run(['init'], { extra: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.github\/CODEOWNERS \(the lead-only paths, owned by @octo\)/);
  const owners = readCodeOwners(sandbox.repo, '');
  assert.equal(owners?.from, 'the working tree');
  const rules = parseCodeOwners(owners!.text);
  assert.deepEqual(rules.map((rule) => rule.pattern), leadOnlyPaths());
  for (const rule of rules) assert.deepEqual(rule.owners, [`${at}octo`], rule.pattern);
  assert.equal(stepMark(sandbox, 'codeowners', { PATH: `${bin}:${process.env.PATH}` }), 'done');
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
  const tierB = sandbox.run(['check', '--pr'], { extra: event('B') });
  assert.equal(tierB.status, 1, tierB.stdout);
  assert.match(tierB.stderr, /this changes 1 file\(s\) that CODEOWNERS owns \(read from the base branch\): \.yokoten\/extra\.md/);
  assert.doesNotMatch(sandbox.run(['check', '--pr'], { extra: event('A') }).stderr, /CODEOWNERS owns/);
});

test('init: a CODEOWNERS owner gh says is a user is written as is (#313)', () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, { 'api users/octo --jq .type': 'User' });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = sandbox.run(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.github\/CODEOWNERS \(the lead-only paths, owned by @octo\)/);
  for (const rule of parseCodeOwners(readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8'))) assert.deepEqual(rule.owners, [`${at}octo`], rule.pattern);
  // init asked GitHub, once, who @octo is.
  assert.deepEqual(ghCalls(sandbox).filter((c) => c.startsWith('api users/')), ['api users/octo --jq .type']);
});

test('init: an organization is no CODEOWNERS owner, so init writes the placeholder and says why; full doctor flags an org-only file (#313)', () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, {
    'api users/octo --jq .type': 'Organization',
    'api repos/octo/app': JSON.stringify({ default_branch: 'main', owner: { login: 'octo', type: 'Organization' } }),
  });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = sandbox.run(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.github\/CODEOWNERS \(the lead-only paths; @octo is an organization, so put a person or @octo\/<team> in place of @YOUR_GITHUB_HANDLE\)/);
  const text = readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8');
  assert.match(text, /^# @octo is an organization[^\n]*@octo\/<team>/m);
  const rules = parseCodeOwners(text);
  assert.deepEqual(rules.map((rule) => rule.pattern), leadOnlyPaths());
  for (const rule of rules) assert.deepEqual(rule.owners, ['@YOUR_GITHUB_HANDLE'], rule.pattern);
  // A file owned by the organization alone locks nothing on GitHub: full doctor says so.
  sandbox.write('.github/CODEOWNERS', '/AGENTS.md @octo\n/.github/ @Octo\n');
  assert.equal(stepMark(sandbox, 'codeowners', extra), 'to do');
  assert.match(sandbox.run(['doctor'], { extra }).stdout, /\.github\/CODEOWNERS names only @octo, an organization, and GitHub takes no organization as an owner; put a person's handle or @octo\/<team> in \.github\/CODEOWNERS/);
  // A team of the organization, or a person, is an owner.
  sandbox.write('.github/CODEOWNERS', '/AGENTS.md @octo/leads\n');
  assert.equal(stepMark(sandbox, 'codeowners', extra), 'done');
});

test('init: when gh fails, the CODEOWNERS owner is the remote owner, as before (#313)', () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, {});
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = sandbox.run(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.github\/CODEOWNERS \(the lead-only paths, owned by @octo\)/);
  assert.doesNotMatch(readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8'), /YOUR_GITHUB_HANDLE/);
});

test('init: an existing CODEOWNERS is kept byte for byte, in any place GitHub reads it (#304)', () => {
  const own = '# ours\r\n/src/ @octo\n';
  let sandbox = makeSandbox();
  sandbox.write('.github/CODEOWNERS', own);
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept \.github\/CODEOWNERS/);
  assert.equal(readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8'), own);
  // One in docs/: a new .github/CODEOWNERS would take its place, so init writes none.
  sandbox = makeSandbox();
  sandbox.write('docs/CODEOWNERS', own);
  result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept docs\/CODEOWNERS/);
  assert.equal(existsSync(join(sandbox.repo, '.github', 'CODEOWNERS')), false);
  assert.equal(readFileSync(join(sandbox.repo, 'docs', 'CODEOWNERS'), 'utf8'), own);
});

test('init: a CLAUDE.md that already imports AGENTS.md is left as it is (#206)', () => {
  for (const text of [`# rules\n${at}AGENTS.md\n`, `# rules\nRead ${at}./AGENTS.md first.\n`, `# rules\r\n${at}AGENTS.md\r\n`, `# rules\n${at}AGENTS.md`]) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), text);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test("init: a .claude/CLAUDE.md alone gets `@../AGENTS.md`, and doctor's rules step wants it (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('.claude/CLAUDE.md', '# our rules\n');
  sandbox.write('AGENTS.md', '# shared rules\n');
  assert.notEqual(stepMark(sandbox, 'rules'), 'done', 'Claude Code reads .claude/CLAUDE.md instead of AGENTS.md');
  assert.match(sandbox.run(['doctor']).stdout, /rules[^\n]*: \.claude\/CLAUDE\.md does not import AGENTS\.md[^\n]*; add a line `@\.\.\/AGENTS\.md`/);
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated \.claude\/CLAUDE\.md: it now reads AGENTS\.md/);
  // Claude Code resolves an import relative to the file that holds it, so this is the root AGENTS.md.
  assert.match(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), /^# our rules\n\n<!--[^\n]*-->\n@\.\.\/AGENTS\.md\n$/);
  assert.equal(existsSync(join(sandbox.repo, 'CLAUDE.md')), false, 'no root CLAUDE.md is made');
  assert.equal(stepMark(sandbox, 'rules'), 'done');
});

test('init: CLAUDE.md and .claude/CLAUDE.md, neither importing AGENTS.md: the root one gets the import (#206)', () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# root rules\n');
  sandbox.write('.claude/CLAUDE.md', '# folder rules\n');
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated CLAUDE\.md: it now reads AGENTS\.md/);
  assert.doesNotMatch(result.stdout, /updated \.claude\/CLAUDE\.md/);
  assert.match(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), /\n@AGENTS\.md\n$/);
  assert.equal(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), '# folder rules\n');
  assert.equal(stepMark(sandbox, 'rules'), 'done');
});

test('init: a .claude/CLAUDE.md that already imports AGENTS.md is left as it is (#206)', () => {
  for (const text of [`# rules\n${at}../AGENTS.md\n`, `# rules\nRead ${at}../AGENTS.md first.\n`]) {
    const sandbox = makeSandbox();
    sandbox.write('.claude/CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), text);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: an import of another file that starts with AGENTS.md does not count; init adds the real import (#206)', () => {
  const cases = [
    { file: 'CLAUDE.md', text: `# rules\n${at}AGENTS.md.bak\n`, line: `${at}AGENTS.md` },
    { file: 'CLAUDE.md', text: `# rules\nOld: ${at}./AGENTS.md.old\n`, line: `${at}AGENTS.md` },
    { file: '.claude/CLAUDE.md', text: `# rules\n${at}../AGENTS.md.bak\n`, line: `${at}../AGENTS.md` },
  ];
  for (const { file, text, line } of cases) {
    const sandbox = makeSandbox();
    sandbox.write(file, text);
    sandbox.write('AGENTS.md', '# shared rules\n');
    assert.notEqual(stepMark(sandbox, 'rules'), 'done', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`updated ${file}: it now reads AGENTS.md`), result.stdout);
    const after = readFileSync(join(sandbox.repo, file), 'utf8');
    assert.ok(after.startsWith(text), 'the old line stays');
    assert.ok(after.endsWith(`-->\n${line}\n`), after);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: a Markdown link to AGENTS.md is not an import; init adds the import and keeps the link (#206)', () => {
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
    assert.notEqual(stepMark(sandbox, 'rules'), 'done', text);
    assert.match(sandbox.run(['doctor']).stdout, /rules[^\n]*does not import AGENTS\.md/, text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, file), 'utf8');
    assert.ok(after.startsWith(text), 'the link stays');
    assert.ok(after.endsWith(`-->\n${line}\n`), after);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: an import inside a code span or fenced block is not an import; init adds the real one (#206)', () => {
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
    assert.notEqual(stepMark(sandbox, 'rules'), 'done', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
    assert.ok(after.startsWith(text.replace(/\n$/, '')), 'the example stays');
    assert.ok(after.endsWith(`-->\n${at}AGENTS.md\n`), after);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: a real import next to a fenced or quoted example is left as it is (#206)', () => {
  const fence = '```';
  for (const text of [
    `# rules\n${at}AGENTS.md\n\nExample:\n${fence}\n${at}AGENTS.md\n${fence}\n`,
    `# rules\nExample: \`${at}AGENTS.md\`.\n${at}AGENTS.md\n`,
    `# rules\n${fence}\n${at}other.md\n${fence}\n${at}AGENTS.md\n`,
  ]) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), text);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test("init: a CLAUDE.md with mixed line endings gets the file's main ending and one blank line (#206)", () => {
  const cases = [
    { text: '# rules\r\nOne.\r\nTwo.\n', want: '# rules\r\nOne.\r\nTwo.\r\n\r\n<!--' },
    { text: '# rules\r\nOne.\r\nTwo.', want: '# rules\r\nOne.\r\nTwo.\r\n\r\n<!--' },
    { text: '# rules\nOne.\nTwo.\r\n', want: '# rules\nOne.\nTwo.\n\n<!--' },
    { text: '# rules\nOne.\n\n\n', want: '# rules\nOne.\n\n<!--' },
  ];
  for (const { text, want } of cases) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
    const newline = want.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(after.slice(0, want.length), want, JSON.stringify(after));
    assert.ok(after.endsWith(`-->${newline}${at}AGENTS.md${newline}`), JSON.stringify(after));
  }
});

test("init: husky keeps its hooks folder; .husky/pre-commit gets the check and keeps its own lines (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', '#!/bin/sh\ntouch own-hook-ran\n');
  chmodSync(join(sandbox.repo, '.husky/pre-commit'), 0o755);
  sandbox.git('config', 'core.hooksPath', '.husky');
  let result = sandbox.run(['init']);
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
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  // Again: the hook already runs yokoten.
  result = sandbox.run(['init']);
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

test('init: husky not yet installed in this clone; init leaves core.hooksPath unset and says to run npm install (#206)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', 'npm test\n');
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the check to \.husky\/pre-commit/);
  assert.match(result.stdout, /run `npm install`/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '');
  assert.match(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), /^# yokoten: [^\n]*\n\[ -f [^\n]*; node [^\n]*\nnpm test\n$/);
  // A hook that init changed before the runtime guard (#204) already runs the check.
  const before = '# yokoten: the commit check\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\nnpm test\n';
  sandbox.write('.husky/pre-commit', before);
  assert.match(sandbox.run(['init']).stdout, /^same \.husky\/pre-commit/m);
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), before);
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done', 'git runs no hook yet');
  assert.match(sandbox.run(['doctor']).stdout, /run `npm install` so husky sets core\.hooksPath/);
  sandbox.git('config', 'core.hooksPath', '.husky/_');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done', "husky 9's folder runs .husky/pre-commit");
});

// git runs pre-merge-commit, not pre-commit, for a merge it commits itself (#239).
test('init: a merge commit runs the commit check too (#239)', () => {
  const sandbox = makeSandbox();
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.githooks\/pre-merge-commit/);
  const mergeHook = join(sandbox.repo, '.githooks', 'pre-merge-commit');
  const hook = readFileSync(mergeHook, 'utf8');
  assert.equal(hook, readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), 'the same check as pre-commit');
  assert.ok(statSync(mergeHook).mode & 0o100, 'executable');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  // Again: nothing changes.
  result = sandbox.run(['init']);
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
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done');
  const doctor = sandbox.run(['doctor']).stdout;
  // Ordinary commits are still checked; only merge commits are not.
  assert.match(doctor, /merge commits are not checked: there is no \.githooks\/pre-merge-commit/);
  assert.doesNotMatch(doctor, /(?<!merge )commits are not checked/);
  assert.doesNotMatch(doctor, /\.githooks\/pre-commit/);
  assert.match(doctor, /`yokoten init` sets up \.githooks\/pre-merge-commit/);
  // A pre-merge-commit of the project's own keeps its lines and gets the check.
  writeFileSync(mergeHook, '#!/bin/sh\necho own\n');
  result = sandbox.run(['init']);
  assert.match(result.stdout, /added the check to \.githooks\/pre-merge-commit/);
  assert.equal(readFileSync(mergeHook, 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\necho own\n`);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
});

test('init: a core.hooksPath outside the repo is kept, and the advice is the line init would write (#204)', () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'core.hooksPath', join(sandbox.home, 'hooks'));
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  const [, checkLine] = checkLines('.yokoten/bin/yokoten.ts');
  assert.ok(result.stdout.includes(`Add this line to its pre-commit and pre-merge-commit: ${checkLine}\n`), result.stdout);
});

test("init: another core.hooksPath is kept, and its pre-commit is made with the check (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('tools/hooks/commit-msg', '#!/bin/sh\n');
  sandbox.git('config', 'core.hooksPath', 'tools/hooks');
  const doctor = sandbox.run(['doctor']).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): commits are not checked: there is no tools\/hooks\/pre-commit; there is no tools\/hooks\/pre-merge-commit/);
  // The advice shows the line init writes, runtime guard included (#204). A new file needs
  // a `#!` line and the execute bit, or git skips it (#239).
  const [, checkLine] = checkLines('.yokoten/bin/yokoten.ts');
  assert.ok(doctor.includes(`or do it yourself: make tools/hooks/pre-commit and tools/hooks/pre-merge-commit with \`#!/bin/sh\` as the first line and the line below after it; run \`chmod +x tools/hooks/pre-commit tools/hooks/pre-merge-commit\`. The line: ${checkLine}`), doctor);
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote tools\/hooks\/pre-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/);
  assert.match(result.stdout, /wrote tools\/hooks\/pre-merge-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), 'tools/hooks');
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    const path = join(sandbox.repo, 'tools/hooks', hook);
    assert.equal(readFileSync(path, 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\n`, hook);
    assert.ok(statSync(path).mode & 0o100, `${hook} is executable`);
  }
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
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

test('init: a pre-commit in .git/hooks keeps running, after the check, from .githooks (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  const gitDir = join(sandbox.repo, '.git');
  // The old hooks leave a mark in .git, and the pre-commit fails while .git/block-me is there.
  writeFileSync(join(gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\ndir="$(git rev-parse --git-dir)"\ntouch "$dir/old-hook-ran"\n[ ! -f "$dir/block-me" ]\n', { mode: 0o755 });
  writeFileSync(join(gitDir, 'hooks', 'pre-merge-commit'), '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/old-merge-hook-ran"\n', { mode: 0o755 });
  sandbox.write('lefthook.yml', 'pre-commit:\n  commands:\n    lint:\n      run: echo lint\n');
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept your \.git\/hooks\/pre-commit: \.githooks\/pre-commit runs it after the check$/m);
  assert.match(result.stdout, /^kept your \.git\/hooks\/pre-merge-commit: \.githooks\/pre-merge-commit runs it after the check$/m);
  assert.match(result.stdout, /^note: lefthook\.yml is here; \.githooks runs these hooks in \.git\/hooks: \.git\/hooks\/pre-commit \(after the check\), \.git\/hooks\/pre-merge-commit \(after the check\)\. /m);
  assert.match(result.stdout, /^set git core\.hooksPath to \.githooks/m);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.ok(existsSync(join(gitDir, 'hooks', 'pre-commit')), 'the old hook stays where it was');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
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
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done', 'the old pre-commit would be dropped');
  const doctor = sandbox.run(['doctor']).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): a hook this clone had is switched off: \.git\/hooks\/pre-commit no longer runs: \.githooks\/pre-commit does not run it; `yokoten init` makes \.githooks\/pre-commit run \.git\/hooks\/pre-commit after the check/);
  result = sandbox.run(['init']);
  assert.match(result.stdout, /^updated \.githooks\/pre-commit$/m);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  const hook = readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8');
  assert.match(hook, /^node "\.yokoten\/bin\/yokoten\.ts" check --staged \|\| exit 1\n# yokoten: then the pre-commit/m, 'the kit\'s `exec` goes, so the hand-off runs after the check');
  rmSync(join(gitDir, 'old-hook-ran'));
  sandbox.write('b.md', 'fine\n');
  sandbox.git('add', 'b.md');
  assert.equal(sandbox.git('commit', '-qm', 'b').status, 0);
  assert.ok(existsSync(join(gitDir, 'old-hook-ran')), 'the old pre-commit runs again');
});

test('init: a pre-commit in .git/hooks that git skips does not hold the check back; init says how to keep it (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  chmodSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), 0o644);
  const note = 'note: .git/hooks/pre-commit is not executable, so git skips it today; `chmod +x .git/hooks/pre-commit` and run `yokoten init` again to keep it running';
  const doctor = sandbox.run(['doctor']).stdout;
  assert.ok(doctor.includes(`commit-check (OSPS-BR-07.01): commits are not checked: core.hooksPath is not set; \`yokoten init\` sets it up; ${note}\n`), doctor);
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^set git core\.hooksPath to \.githooks/m);
  assert.ok(result.stdout.includes(`\n${note}\n`), result.stdout);
  assert.doesNotMatch(result.stdout, /kept your/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done', 'a hook git skipped is not dropped');
  // Made executable, the next init hands off to it.
  chmodSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), 0o755);
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done', 'now it would be dropped');
  assert.match(sandbox.run(['init']).stdout, /^kept your \.git\/hooks\/pre-commit: \.githooks\/pre-commit runs it after the check$/m);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
});

test('init: every other hook in .git/hooks keeps running from .githooks, with its arguments and stdin (#256)', { skip: NO_EXEC_BIT }, () => {
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
  const result = sandbox.run(['init']);
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
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
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
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done');
  const doctor = sandbox.run(['doctor']).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): a hook this clone had is switched off: \.git\/hooks\/commit-msg no longer runs: \.githooks\/commit-msg does not run it; `yokoten init` makes \.githooks\/commit-msg run \.git\/hooks\/commit-msg\n/);
  assert.match(sandbox.run(['init']).stdout, /^wrote \.githooks\/commit-msg$/m);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
});

test('init: an old hook that reads stdin, next to a .githooks one of the project\'s own, is left to the owner (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ncat >/dev/null\n', { mode: 0o755 });
  sandbox.write('.githooks/pre-push', '#!/bin/sh\nwhile read line; do echo "$line"; done\n');
  const before = readFileSync(join(sandbox.repo, '.githooks', 'pre-push'), 'utf8');
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^left core\.hooksPath unset, so the commit check is not on yet: \.githooks\/pre-push is the project's own and reads stdin, as \.git\/hooks\/pre-push does, so yokoten can't run both from one file\. To keep \.git\/hooks\/pre-push, make \.githooks\/pre-push save stdin to a file and give it to both: its own lines, and \.git\/hooks\/pre-push with the same arguments; then run `git config core\.hooksPath \.githooks`$/m);
  assert.equal(readFileSync(join(sandbox.repo, '.githooks', 'pre-push'), 'utf8'), before);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '');
  assert.match(sandbox.run(['doctor']).stdout, /commits are not checked: core\.hooksPath is not set; \.githooks\/pre-push is the project's own and reads stdin/);
});

test('init: the hand-off has no switch, and a .git/hooks link to .githooks does not loop (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  const gitDir = join(sandbox.repo, '.git');
  writeFileSync(join(gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\necho x >> "$(git rev-parse --git-dir)/old-hook-ran"\n', { mode: 0o755 });
  assert.equal(sandbox.run(['init']).status, 0);
  sandbox.git('add', '.');
  const commit = (message: string, extra: Record<string, string> = {}) =>
    spawnSync('git', ['commit', '-qm', message], { cwd: sandbox.repo, env: { ...sandbox.env, ...extra }, encoding: 'utf8', timeout: 60_000 });
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
    const run = spawnSync(shell, ['.git/hooks/pre-commit'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, `${shell}: ${run.stderr}`);
    assert.equal((`${run.stdout}${run.stderr}`.match(/yokoten check: ok/g) ?? []).length, 1, `${shell}: the check ran once`);
  }
});

test('init: the hooks it writes run under sh and dash, with the arguments and stdin (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  const hooks = join(sandbox.repo, '.git', 'hooks');
  writeFileSync(join(hooks, 'pre-merge-commit'), '#!/bin/sh\nprintf "%s|" "$@" > "$(git rev-parse --git-dir)/args"; cat > "$(git rev-parse --git-dir)/stdin"; exit 5\n', { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nprintf "%s|" "$@" > "$(git rev-parse --git-dir)/args"; cat > "$(git rev-parse --git-dir)/stdin"; exit 6\n', { mode: 0o755 });
  assert.equal(sandbox.run(['init']).status, 0);
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

test('init: the reviewer\'s own hook with the check in an `if` is kept as it is, with the steps to do by hand (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  const own = '#!/bin/sh\nif [ -n "$FAST" ]; then\n  exec node ".yokoten/bin/yokoten.ts" check --staged\nfi\nnpm run lint\n';
  sandbox.write('.githooks/pre-commit', own);
  chmodSync(join(sandbox.repo, '.githooks', 'pre-commit'), 0o755);
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  sandbox.git('config', 'core.hooksPath', '.githooks');
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), own);
  assert.match(result.stdout, /^a hook this clone had is switched off: \.githooks\/pre-commit is the project's own, and yokoten can't tell where its check ends\. To keep \.git\/hooks\/pre-commit, add this line after the check: yokoten_old=/m);
});

test('init: with a global core.hooksPath, the files in .git/hooks are dead and are not handed off to (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  const global = join(sandbox.home, 'global-hooks');
  mkdirSync(global);
  // Written with fs: the guard on a machine may stop `git config --global` in a shell.
  writeFileSync(sandbox.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${global}\n`);
  for (const hook of ['pre-commit', 'commit-msg']) writeFileSync(join(sandbox.repo, '.git', 'hooks', hook), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // A clone an older init set up: core.hooksPath is .githooks here, and the global one decided before.
  sandbox.git('config', 'core.hooksPath', '.githooks');
  assert.equal(sandbox.run(['init']).status, 0);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done', 'a dead hook is not dropped');
  sandbox.git('config', '--unset', 'core.hooksPath');
  rmSync(join(sandbox.repo, '.githooks'), { recursive: true });
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /kept your|note:/);
  assert.match(result.stdout, /^set git core\.hooksPath to \.githooks/m);
  assert.doesNotMatch(readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), /git-common-dir/);
  assert.ok(!existsSync(join(sandbox.repo, '.githooks', 'commit-msg')));
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
});

// doctor's advice must be true: when it says init sets it up, init does (#256).
test('init: a .githooks/pre-commit of the project\'s own gets the check, and a kept one keeps its mode (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  sandbox.write('.githooks/pre-commit', '#!/bin/sh\necho own\n');
  chmodSync(join(sandbox.repo, '.githooks/pre-commit'), 0o700);
  sandbox.git('config', 'core.hooksPath', '.githooks');
  assert.match(sandbox.run(['doctor']).stdout, /commits are not checked: \.githooks\/pre-commit does not run yokoten[^\n]*; `yokoten init` sets it up/);
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^added the check to \.githooks\/pre-commit$/m);
  const path = join(sandbox.repo, '.githooks/pre-commit');
  const hook = readFileSync(path, 'utf8');
  assert.equal(hook, `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\necho own\n`);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  const mode = statSync(path).mode & 0o777;
  // Again: the file is kept as it is, mode too.
  result = sandbox.run(['init']);
  assert.match(result.stdout, /^kept \.githooks\/pre-commit$/m);
  assert.equal(readFileSync(path, 'utf8'), hook);
  assert.equal(statSync(path).mode & 0o777, mode, 'no chmod on a file init did not change');
});

test('init: a file under .husky/ keeps its mode; husky 9 runs it with sh (#256)', { skip: NO_EXEC_BIT }, () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', 'npm test\n');
  sandbox.write('.husky/pre-merge-commit', 'npm test\n');
  for (const hook of ['pre-commit', 'pre-merge-commit']) chmodSync(join(sandbox.repo, '.husky', hook), 0o644);
  sandbox.write('.husky/_/h', '#!/bin/sh\n');
  sandbox.git('config', 'core.hooksPath', '.husky/_');
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the check to \.husky\/pre-commit/);
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    assert.equal(statSync(join(sandbox.repo, '.husky', hook)).mode & 0o777, 0o644, `.husky/${hook} keeps its mode`);
  }
  assert.equal(stepMark(sandbox, 'commit-check'), 'done', 'husky 9 needs no execute bit on .husky/pre-commit');
});

// A lesson added to the kit's core rules reaches a project that already ran init (#120).
test('update: doctor says when the core rules are behind; update previews, and --write keeps "This project" byte for byte (#120)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));
  assert.match(sandbox.run(['doctor']).stdout, /\n {2}ok +core-rules\n/, 'init wrote the kit, so it is up to date');
  let result = sandbox.run(['update']);
  assert.deepEqual([result.status, result.stdout], [0, 'yokoten update: the core rules in AGENTS.md are up to date with yokoten 0.1.0; nothing to change\n']);

  // An older kit had no rule 12, and someone edited a line by hand. The project's own
  // part has trailing spaces and a CRLF line end, to show it is kept byte for byte.
  const own = '## This project\n\nBuild with `make`.  \n<!-- ours -->\r\n';
  const old = kitCore.replace(/^\| 12 \|.*\n/m, '').replace('Plain English, close to', 'Plain words, close to') + own;
  writeFileSync(path, old);
  const doctor = sandbox.run(['doctor']);
  assert.match(doctor.stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind yokoten 0\.1\.0's, or were edited by hand \(2 line\(s\) added, 1 removed; sections changed: Core rules, Writing\); run `yokoten update` to see the change/);
  assert.equal(doctor.status, 1);
  assert.match(sandbox.run(['doctor', '--session']).stdout, /^yokoten: the core rules in AGENTS\.md are behind/m, 'a session hears it');
  assert.ok(JSON.parse(sandbox.run(['doctor', '--json']).stdout).findings.some((f: { id: string }) => f.id === 'core-rules'));

  // The preview shows each line, the hand edit too, and writes nothing.
  result = sandbox.run(['update']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten update: the core rules in AGENTS\.md differ from yokoten 0\.1\.0's: 2 line\(s\) added, 1 removed; sections changed: Core rules, Writing\n/);
  assert.match(result.stdout, /^- Plain words, close to ASD-STE100/m, 'the hand-edited line is shown as replaced');
  assert.match(result.stdout, /^\+ Plain English, close to ASD-STE100/m);
  assert.match(result.stdout, /^\+ \| 12 \| Decisions are written down once/m);
  assert.match(result.stdout, /Nothing was written\. Run `yokoten update --write` to write it\.\n$/);
  assert.equal(readFileSync(path, 'utf8'), old, 'the preview writes nothing');

  // --write replaces the core part only; a second run has nothing to do.
  result = sandbox.run(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `yokoten update: replaced the core rules in AGENTS.md with yokoten 0.1.0's: 2 line(s) added, 1 removed; sections changed: Core rules, Writing. "## This project" and below are unchanged\n`);
  assert.equal(readFileSync(path, 'utf8'), kitCore + own);
  assert.match(sandbox.run(['update']).stdout, /up to date/);
  assert.match(sandbox.run(['doctor']).stdout, /\n {2}ok +core-rules\n/);

  // Line ends do not count: a CRLF checkout is up to date.
  writeFileSync(path, kitCore.replaceAll('\n', '\r\n') + own);
  assert.match(sandbox.run(['update']).stdout, /up to date/);

  // Without the heading, doctor can't tell the core rules from the project's: a note, never a guess.
  writeFileSync(path, '# our own rules\n');
  assert.match(sandbox.run(['doctor']).stdout, /\n {2}note +core-rules: can't compare the core rules in AGENTS\.md: AGENTS\.md has no `## This project` heading/);
  assert.doesNotMatch(sandbox.run(['doctor', '--session']).stdout, /core rules/);
  result = sandbox.run(['update', '--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten update: can't compare AGENTS\.md with the kit: .*Nothing was written/);
  assert.equal(readFileSync(path, 'utf8'), '# our own rules\n');

  rmSync(path);
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, /core-rules/, 'the road asks for AGENTS.md');
  result = sandbox.run(['update']);
  assert.deepEqual([result.status, result.stderr], [1, 'yokoten update: no AGENTS.md here; nothing was written. Run `yokoten init` to add one\n']);
  assert.equal(sandbox.run(['update', '--force']).status, 1, 'an unknown option is refused');
  assert.match(sandbox.run(['explain', 'core-rules']).stdout, /^core-rules: the core rules in AGENTS\.md/);
});

// A project written by a newer yokoten is never taken back to an older kit (#141).
test('update: init writes the kit version; a newer project is refused, an older one is updated (#141)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
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
    const result = sandbox.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^yokoten update: AGENTS\.md was written by yokoten 0\.2\.0, newer than this yokoten 0\.1\.0\. Nothing was written/);
  }
  assert.equal(readFileSync(path, 'utf8'), newer, 'a newer project is not downgraded');
  const doctor = sandbox.run(['doctor']);
  assert.match(doctor.stdout, /\n {2}note +core-rules: the core rules in AGENTS\.md come from yokoten 0\.2\.0, newer than this yokoten 0\.1\.0; update yokoten itself, not the project/);
  assert.doesNotMatch(doctor.stdout, /MISSING core-rules/);

  // Older: the same text with an older mark is updated, and gets the new mark.
  writeFileSync(path, newer.replace('0.2.0 -->', '0.0.9 -->'));
  assert.match(sandbox.run(['doctor']).stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind/);
  let result = sandbox.run(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh);

  // No mark (every project before #141): an unknown version, compared by content as before.
  const unmarked = newer.replace(/^<!-- yokoten kit .* -->\n/, '');
  writeFileSync(path, unmarked);
  result = sandbox.run(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh, 'updated, and the mark is added');
  writeFileSync(path, fresh.replace(/^<!-- yokoten kit .* -->\n/, ''));
  assert.match(sandbox.run(['update']).stdout, /up to date/, 'the mark alone is no change');
});

// CI and the hooks run the copy in .yokoten/. It carries the kit's AGENTS.md, so doctor
// there compares with the kit the project vendored, not "can't compare" (#145).
test('update: the .yokoten/ copy has the kit\'s AGENTS.md, so doctor and update compare from it (#145)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const vendored = (...args: string[]) => spawnSync('node', ['.yokoten/bin/yokoten.ts', ...args], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  const kitDir = join(sandbox.repo, '.yokoten', 'kit');
  // The kit's lessons come too (#77), so doctor from the copy runs them; nothing else of the kit.
  const kitFiles = readdirSync(kitDir, { recursive: true }).map(String).sort();
  assert.deepEqual(kitFiles.filter((path) => !path.startsWith('lessons')), ['project', join('project', 'AGENTS.md')], 'one kit file and the lessons, no more');
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
  assert.equal(sandbox.run(['init']).status, 0);
  assert.ok(existsSync(join(kitDir, 'project', 'AGENTS.md')), 'init refreshes the copied kit file');
  assert.match(vendored('doctor').stdout, /\n {2}ok +core-rules\n/);
});

test('init: an unreadable project .codex/hooks.json or .gemini/settings.json is skipped, the rest goes on, and init exits 1 (#248)', () => {
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
      const result = sandbox.run(['init']);
      const what = `${bad}, ${JSON.stringify(content)}`;
      assert.equal(result.status, 1, what);
      assert.ok(result.stdout.split('\n').includes(`skipped ${name}: ${skip}`), `${what}: ${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(join(sandbox.repo, bad), 'utf8'), content, `${what}: the file changed`);
      assert.ok(hasHook(join(sandbox.repo, good), dirname(good) === '.codex' ? 'Stop' : 'AfterAgent', 'hook'), `${what}: no stop check in ${good}`);
      assert.match(result.stdout, /TZ=UTC for agent sessions/, what);
    }
  }
});

test('init: a commented .gemini/settings.json is left as it was and gets the hooks to add by hand; with them, it is ok (#258)', () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.gemini', 'settings.json');
  const before = commentedGemini('{ "BeforeTool": [] }');
  sandbox.write('.gemini/settings.json', before);
  const result = sandbox.run(['init']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /can't read|unexpected shape/);
  assert.equal(readFileSync(file, 'utf8'), before, 'the file changed');
  const add = handAdd(result.stdout, `skipped the Gemini CLI hooks: ${COMMENTED('.gemini/settings.json')}, then run \`yokoten init\` again:`);
  // The tool-call command may carry a fail-closed wrapper (#260); either way it checks for the
  // project runtime first, then runs the yokoten guard with node.
  const runtimePath = '$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts';
  const guardCall = String((add.BeforeTool?.[0] as { hooks?: { command?: unknown }[] } | undefined)?.hooks?.[0]?.command);
  const missingCheck = guarded(runtimePath, 'x').slice(0, -`node ${runtimePath} x`.length);
  assert.ok(guardCall.startsWith(missingCheck), guardCall);
  assert.match(guardCall, /\bnode(?: --\S+)* \$GEMINI_PROJECT_DIR\/\.yokoten\/bin\/yokoten\.ts hook --agent gemini(?: |$)/);
  assert.deepEqual(add, {
    BeforeTool: [{ hooks: [{ type: 'command', command: guardCall, name: 'yokoten' }], matcher: 'run_shell_command|write_file|replace' }],
    AfterAgent: [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts', 'hook --stop --agent gemini'), name: 'yokoten-stop' }] }],
  });
  assert.ok(hasHook(join(sandbox.repo, '.codex', 'hooks.json'), 'Stop', 'hook'), 'no Codex stop check');
  assert.deepEqual(doctorHandAdd(sandbox.run(['doctor']).stdout, 'gemini-hook', '.gemini/settings.json'), add);

  const after = commentedGemini(JSON.stringify(add, null, 2));
  writeFileSync(file, after);
  const again = sandbox.run(['init']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^same the Gemini CLI tool-call hook in \.gemini\/settings\.json$/m);
  assert.match(again.stdout, /^same the Gemini CLI stop check in \.gemini\/settings\.json/m);
  assert.equal(readFileSync(file, 'utf8'), after, 'the file changed');
  assert.match(sandbox.run(['doctor']).stdout, /^ {2}ok {6}gemini-hook$/m);
});

test('init: an unreadable project .claude/settings.json is skipped, the rest goes on, and init exits 1 (#254)', () => {
  for (const [content, reason] of BAD_PROJECT_SETTINGS) {
    const sandbox = makeSandbox();
    const file = join(sandbox.repo, '.claude', 'settings.json');
    mkdirSync(dirname(file));
    writeFileSync(file, content);
    const result = sandbox.run(['init']);
    const what = JSON.stringify(content);
    assert.equal(result.status, 1, `${what}: ${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split('\n').includes(`skipped the Claude Code settings: ${reason('.claude/settings.json')}`), `${what}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /in \.claude\/settings\.json/, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: the file changed`);
    // Every other step still ran: the Codex and Gemini CLI hooks, and the commit check.
    assert.ok(hasHook(join(sandbox.repo, '.codex', 'hooks.json'), 'Stop', 'hook'), `${what}: no Codex stop check`);
    assert.ok(hasHook(join(sandbox.repo, '.gemini', 'settings.json'), 'AfterAgent', 'hook'), `${what}: no Gemini CLI stop check`);
    assert.match(result.stdout, /the commit check/, what);
    const doctor = sandbox.run(['doctor']);
    assert.doesNotMatch(doctor.stderr, /SyntaxError|TypeError|at /, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: doctor changed the file`);
  }
});

test('init: run from the project\'s .yokoten/, it keeps .yokoten/ (#204)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
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

test('init: reads GitHub and says what it would do; --github --yes does it, and a second run changes nothing (#10)', () => {
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
  let result = sandbox.run(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because there is no origin remote yet/);
  assert.equal(calls().length, 0);
  assert.equal(sandbox.run(['init', '--yes'], { extra }).status, 1, '--yes alone is refused');
  assert.equal(sandbox.run(['init', '--remove-default-labels'], { extra }).status, 1, 'so is --remove-default-labels');
  assert.equal(sandbox.run(['init', '--board'], { extra }).status, 1, 'and --board (#156)');
  // --github --yes asked for changes on GitHub; with no remote none were made, so it fails (#208).
  result = sandbox.run(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub: skipped, because there is no origin remote yet\. Add one on GitHub, then run `yokoten init --github --yes`/);
  assert.match(result.stderr, /\nyokoten init: --github --yes changed nothing on GitHub \(the reason is above\)\. The project files are as listed above\.\n$/);
  assert.equal(calls().length, 0);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  result = sandbox.run(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: example\/repo\n- 1 of the 12 standard labels are there; kept\n- not in the standard set: question\./);
  assert.match(result.stdout, /Would do:\n- make label "feat"[^]*- make milestone "First release"\nNothing changed\./);
  assert.deepEqual(changed(), [], 'plain init only reads');
  result = sandbox.run(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- done: make label "good first issue"[^\n]*\n[^]*- done: make milestone "First release"/);
  assert.equal(changed().length, 12);
  result = sandbox.run(['init', '--github', '--yes'], { extra });
  assert.match(result.stdout, /- 12 of the 12 standard labels are there; kept\n- a milestone is open; kept\n[^]*Nothing to change\./);
  assert.equal(changed().length, 12, 'the second run changed nothing');
  // Without gh on the PATH, plain init still succeeds and says so. Only node and git are there.
  const noGh = join(sandbox.home, 'no-gh');
  mkdirSync(noGh);
  const gitPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(process.execPath, join(noGh, 'node'));
  symlinkSync(join(gitPath, 'git'), join(noGh, 'git'));
  result = sandbox.run(['init'], { extra: { PATH: noGh } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because gh is not installed/);
  // init --github --yes fails: it was asked to change GitHub and could not (#208).
  result = sandbox.run(['init', '--github', '--yes'], { extra: { PATH: noGh } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub: skipped, because gh is not installed[^\n]*\nyokoten init: --github --yes changed nothing on GitHub/);
});

test('init: a yokoten.json "areas" that is not a list stops init before it writes a file (#156)', () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: 'cli' }));
  let result = sandbox.run(['init']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten init: yokoten\.json: "areas" must be a list of names/);
  assert.doesNotMatch(result.stderr, /is not a function/);
  assert.ok(!existsSync(join(sandbox.repo, 'AGENTS.md')), 'nothing written');
  // The control: the same project with a list runs.
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['cli'] }));
  result = sandbox.run(['init']);
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
