// Tests for src/setup/init/project-files.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  at,
  makeSandbox,
  stepMark,
  stubGh,
} from '../../repo/helpers.ts';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { parseCodeOwners } from '../../../src/rules/pr.ts';
import { readCodeOwners } from '../../../src/host/github/index.ts';

const leadOnlyPaths = () => DEFAULTS.leadOnly.map((glob) => (glob.endsWith('/**') ? `/${glob.slice(0, -'**'.length)}` : `/${glob}`));

/** The calls the gh from `stubGh` got, in order. */
const ghCalls = (sandbox: ReturnType<typeof makeSandbox>): string[] => {
  const log = join(sandbox.home, 'gh.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

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

test('init: a .gitignore for the worktrees, dependency folders and the board agent file, only adding missing lines (#521, #571, #601, #614)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{"name":"app"}\n');
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.gitignore \(\.worktrees\/, node_modules\/, \.yokoten-agent\.json\)/);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.worktrees/\nnode_modules/\n.yokoten-agent.json\n');
  // Again: nothing changes.
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /kept \.gitignore/);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.worktrees/\nnode_modules/\n.yokoten-agent.json\n');
  // The project's own lines stay, in order; a line that is there in another form counts.
  sandbox.write('.gitignore', '.env\n/node_modules');
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /added to \.gitignore: \.worktrees\/, \.yokoten-agent\.json/);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.env\n/node_modules\n.worktrees/\n.yokoten-agent.json\n');
  sandbox.write('.gitignore', '.env\ncoverage');
  sandbox.write('Cargo.toml', '[package]\nname = "x"\n');
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /added to \.gitignore: \.worktrees\/, node_modules\/, target\/, \.yokoten-agent\.json/);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.env\ncoverage\n.worktrees/\nnode_modules/\ntarget/\n.yokoten-agent.json\n');
  // A line that is already there is not added again.
  sandbox.write('.gitignore', '.yokoten-agent.json\n.env\n');
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /added to \.gitignore: \.worktrees\/, node_modules\/, target\//);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.yokoten-agent.json\n.env\n.worktrees/\nnode_modules/\ntarget/\n');
});

test('init: .gitignore holds .worktrees/ and the board agent file with no package manager (#571, #601, #614)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.gitignore \(\.worktrees\/, \.yokoten-agent\.json\)/);
  assert.equal(readFileSync(join(sandbox.repo, '.gitignore'), 'utf8'), '.worktrees/\n.yokoten-agent.json\n');
});
