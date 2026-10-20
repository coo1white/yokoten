// Tests for src/rules/guards.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeSandbox, makeTempDir } from '../repo/helpers.ts';
import {
  DEFAULTS,
  type Env,
} from '../../src/rules/config.ts';
import {
  checkCommand,
  checkEdit,
  commandWords,
  hardenRead,
  hookFile,
  isGranted,
  isLeadOnly,
  isRedacted,
  printsAccount,
  runsCheck,
  wrapForRedact,
} from '../../src/rules/guards.ts';
import { judge } from '../../src/run/hook.ts';
import { assertLinear } from '../../scripts/linear.ts';

const blocked = (command: string, env: Env = {}) => assert.ok(checkCommand(command, { env }), `should block: ${command}`);

const allowed = (command: string, env: Env = {}) => assert.equal(checkCommand(command, { env }), null, `should allow: ${command}`);

// The hooks setting in a project with its own hooks folder (#217). A repo with husky's
// pre-commit running the check (and husky's own `.husky/_/pre-commit`, which git runs), a
// folder without it, and core.hooksPath set to `hooks/own`. Hook files are executable.
function writeHook(path: string, text: string, mode = 0o755): void {
  writeFileSync(path, text);
  chmodSync(path, mode);
}

// husky 9.1.7's own files in .husky/_: each hook sources h, and h runs .husky/<hook> with sh -e.
const HUSKY_HOOK = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';

const HUSKY_H = `#!/usr/bin/env sh
[ "$HUSKY" = "2" ] && set -x
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n

[ ! -f "$s" ] && exit 0

if [ -f "$HOME/.huskyrc" ]; then
	echo "husky - '~/.huskyrc' is DEPRECATED, please move your code to ~/.config/husky/init.sh"
fi
i="\${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"
[ -f "$i" ] && . "$i"

[ "\${HUSKY-}" = "0" ] && exit 0

export PATH="node_modules/.bin:$PATH"
sh -e "$s" "$@"
c=$?

[ $c != 0 ] && echo "husky - $n script failed (code $c)"
[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"
exit $c
`;

function makeHooksRepo(): string {
  const root = makeTempDir('yokoten-hooks-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.hooksPath', 'hooks/own');
  mkdirSync(join(root, '.husky', '_'), { recursive: true });
  writeHook(join(root, '.husky', 'pre-commit'), '#!/bin/sh\nnpx lint-staged\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\n');
  writeHook(join(root, '.husky', '_', 'pre-commit'), HUSKY_HOOK);
  writeHook(join(root, '.husky', '_', 'h'), HUSKY_H, 0o644);
  mkdirSync(join(root, 'hooks', 'plain'), { recursive: true });
  writeHook(join(root, 'hooks', 'plain', 'pre-commit'), '#!/bin/sh\n# yokoten check is not run here\nnpm test\n');
  return root;
}

// #192: a project blocks programs in yokoten.json "commands.block", each with its reason.
const pythonBlocked = { commands: { block: { python: 'TypeScript only', python3: 'this project is TypeScript only (AGENTS.md).' } } };

const isBlockedByList = (command: string, config: { commands: { block: Record<string, string> } } = pythonBlocked) => checkCommand(command, { env: {}, config })?.id === 'blocked-command';

// #226: gaps the reviews of #195 and #199 left. The blocked name is built from pieces.
const py = ['py', 'thon3'].join('');

const shouldBlock = (commands: string[]) => {
  for (const command of commands) assert.ok(isBlockedByList(command), `should block: ${command}`);
};

const shouldPass = (commands: string[]) => {
  for (const command of commands) assert.equal(isBlockedByList(command), false, `should allow: ${command}`);
};

// The review of #226: the reader must never fail open or lose a command.
const force = ['git', 'push', '--for' + 'ce'].join(' ');

// The command that sets the hooks folder, built so that this file's own text does not read as one.
const setHooks = (folder: string) => `${['git config core', 'hooksPath'].join('.')} ${folder}`;

// #283: heredoc shapes bash runs that the guard skipped. Each was run in bash (with a
// harmless command in place of the push) to see where bash ends the body and what it runs.
const refusedAs = (command: string, id: string) => assert.equal(checkCommand(command, { env: {} })?.id, id, `should refuse as ${id}: ${JSON.stringify(command)}`);

test('the bot is not a way around the guard', () => {
  assert.ok(checkCommand('node .yokoten/bin/yokoten.ts bot -- git push --tags', { env: {} }));
  assert.ok(checkCommand('yokoten bot -- gh release create v1', { env: {} }));
});

// .yokoten/ is the copy of yokoten the hooks and CI run: a worker that changes it can turn the checks off (#297).
test('the vendored .yokoten/ runtime is lead-only: the hook and check --staged stop a worker, not the lead (#297)', () => {
  const sandbox = makeSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const edit = (extra?: Record<string, string>) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { file_path: join(sandbox.repo, '.yokoten', 'src', 'run', 'check.ts') } }), extra });
  let result = edit(worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\.yokoten\/src\/run\/check\.ts is lead-only/);
  assert.equal(edit().status, 0, 'the lead may edit it');
  sandbox.write('.yokoten/src/run/check.ts', 'export {};\n');
  sandbox.git('add', '.');
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.yokoten\/src\/run\/check\.ts is lead-only/);
  result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
});

test('release: tag pushes, release commands and publishing are the owner\'s', () => {
  for (const command of [
    'git push --tags',
    'git push origin --follow-tags',
    'git push --mirror backup',
    'git push origin v1.2.0',
    'git push origin refs/tags/v1',
    'git push origin HEAD:refs/tags/x',
    'git -c push.followTags=true push',
    'git -C ../other push --tags',
    "bash -c 'git push --tags'",
    'echo ok && git push --tags',
    '/usr/bin/git push --tags',
    'gh release create v1.0.0',
    'gh release upload v1 file',
    'npm publish',
    'pnpm publish --access public',
    'yarn npm publish',
  ]) blocked(command);
});

test('release: the owner\'s approval lets it through', () => {
  const env = { YOKOTEN_RELEASE_APPROVAL: '1' };
  allowed('git push --tags', env);
  allowed('gh release create v1.0.0', env);
  allowed('npm publish', env);
});

test('release: without an agent, the fix names none (#350)', () => {
  assert.equal(checkCommand('git push --tags', { env: {} })?.fix, 'if the owner asked for this, they start a new session of their agent with YOKOTEN_RELEASE_APPROVAL=1; do not look for another way');
});

test('approval in the command text does not count', () => {
  blocked('YOKOTEN_RELEASE_APPROVAL=1 git push --tags');
});

test('force push: plain force is stopped, lease is fine', () => {
  for (const c of ['git push --force', 'git push -f origin main', 'git push -uf origin x', 'git push origin +main']) blocked(c);
  allowed('git push --force-with-lease');
  allowed('git push -u origin feature');
});

test('skipping the commit check is stopped', () => {
  for (const c of ['git commit --no-verify -m x', 'git commit -nm x', 'git push --no-verify', 'git config core.hooksPath /dev/null', 'git config --local core.hooksPath ""']) blocked(c);
  allowed('git config core.hooksPath .githooks');
  allowed('git commit -m "no --verify needed"'.replace('--verify', 'verify'));
});

// The hooks setting (#114). Each row of the issue's table first, then the other forms.
test('git options that take a value are skipped before the subcommand (#114)', () => {
  // `--attr-source <tree>` takes a value; without it in the list, `HEAD` looked like the subcommand.
  blocked('git --attr-source HEAD push --tags');
  blocked('git -C . --namespace x push --tags');
});

test('hooks setting: a read passes, a change or a one-command skip blocks (#114)', () => {
  allowed('git config core.hooksPath');
  allowed('git config --get core.hooksPath');
  allowed('git config --show-origin core.hooksPath');
  allowed('git config core.hooksPath .githooks');
  blocked('git config core.hooksPath /dev/null');
  blocked('git config --unset core.hooksPath');
  blocked('git -c core.hooksPath=/dev/null commit -m x');
});

test('hooks setting: every way to read it passes (#114)', () => {
  for (const command of [
    'git config --get-all core.hooksPath',
    'git config --get-regexp core.hooksPath',
    'git config --get-regexp hooks',
    'git config --show-origin --get core.hooksPath',
    'git config --local --show-scope core.hooksPath',
    'git config --get --default .githooks core.hooksPath',
    'git config --list',
    'git config -l --show-origin',
    'git config CORE.HOOKSPATH',
    'git config get core.hooksPath',
    'git config get --all --show-origin core.hooksPath',
    'git config list',
    'git -C ../other config --get core.hooksPath',
    'test "$(git config core.hooksPath)" = .githooks && echo ok',
    'grep -rn GIT_CONFIG_KEY_0=core.hooksPath test',
    'git -c core.hooksPath=.githooks commit -m x',
    'git -c user.name=x commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=.githooks git commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit -m x',
  ]) allowed(command);
});

test('hooks setting: a shell redirect is no value, so the read passes (#351)', () => {
  for (const command of [
    'git config core.hooksPath 2>/dev/null',
    'git config core.hooksPath 2>/dev/null || echo unset',
    'git config --get core.hooksPath 2>&1',
    'git config --local --get core.hooksPath > /tmp/hooks-path',
    'git config core.hookspath >>log 2>&1',
    'git config get core.hooksPath 2>/dev/null',
    'git config 2>/dev/null core.hooksPath',
    'git config --global --get-all core.hooksPath </dev/null',
    'git config --worktree --get core.hooksPath 2>/dev/null',
    'git config --list 2>/dev/null | grep -i hookspath',
    'git config -l | grep hooksPath',
  ]) allowed(command);
  for (const command of [
    'git config core.hooksPath x 2>/dev/null',
    'git config core.hooksPath /tmp/x >/dev/null 2>&1',
    'git config core.hooksPath "2>/dev/null"',
    "git config core.hooksPath '>x'",
    'git config core.hooksPath 2\\>x',
    'git config core.hooksPath 2 >/dev/null',
    'git config --unset core.hooksPath 2>/dev/null',
    'git config set core.hooksPath x 2>&1',
    'git config --file .git/config core.hooksPath x 2>/dev/null',
    'git -c core.hooksPath=/dev/null commit -m x 2>/dev/null',
    'git config --get core.hooksPath 2>/dev/null; git config core.hooksPath /tmp/x',
    'git config core.hooksPath 2>/dev/null && git config --unset core.hooksPath',
  ]) blocked(command);
});

test('hooks setting: every way to change it blocks, unless the value is .githooks (#114)', () => {
  for (const command of [
    'git config --local core.hooksPath /dev/null',
    'git config --global core.hooksPath ~/hooks',
    'git config core.hooksPath --local',
    'git config -f .git/config core.hooksPath x',
    'git config Core.HooksPath /dev/null',
    'git config --unset-all core.hooksPath',
    'git config --replace-all core.hooksPath /dev/null',
    'git config --add core.hooksPath /dev/null',
    'git config --edit core.hooksPath',
    'git config -e core.hooksPath',
    'git config --remove-section core',
    'git config --rename-section core old',
    'git config set core.hooksPath /dev/null',
    'git config set --local core.hooksPath /dev/null',
    'git config set core.hooksPath',
    'git config unset core.hooksPath',
    'git config unset --all core.hooksPath',
    'git config remove-section CORE',
  ]) blocked(command);
  allowed('git config set core.hooksPath .githooks');
  allowed('git config --add core.hooksPath .githooks');
  allowed('git config --replace-all core.hooksPath .githooks');
  allowed('git config --unset user.name');
  allowed('git config --remove-section alias');
});

test('hooks setting: git config --edit blocks in any scope, with any editor (#358)', () => {
  for (const command of [
    'git config --edit',
    'git config -e',
    'git config edit',
    "GIT_EDITOR='sed -i s/githooks/x/' git config --edit",
    "EDITOR='sed -i s/githooks/x/' git config -e",
    "VISUAL='sed -i s/githooks/x/' git config --local --edit",
    "git -c core.editor='sed -i s/githooks/x/' config -e",
    'git --config-env core.editor=EDIT config --edit',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.editor GIT_CONFIG_VALUE_0=true git config --edit',
    'git config --global --edit',
    'git config --system -e',
    'git config --worktree --edit',
    'git config --file .git/config --edit',
    'git config --file=.git/config -e',
    'git config edit --local',
    'git config --local edit',
    'git config -ef .git/config',
    'git config -ze',
    'git config --ed',
    'git config --edi --global',
    'bash -c "git config --edit"',
  ]) blocked(command);
  const edit = checkCommand('git config --edit', { env: {} });
  assert.match(edit?.what ?? '', /core\.hooksPath/);
  assert.match(edit?.fix ?? '', /git config --get/);
});

test('hooks setting: a shortened option, or an include, is read as git reads it (#358)', () => {
  for (const command of [
    'git config --unset-a core.hooksPath',
    'git config --uns core.hooksPath',
    'git config --remove-sec core',
    'git config --rename-sec core old',
    'git config --fil .git/config core.hooksPath /dev/null',
    'git config --fi .git/config core.hooksPath /dev/null',
    'git config -f.git/config core.hooksPath .githooks/../x',
    'git config --glo core.hooksPath hooks',
    'git config --file .git/config --replace-all core.hooksPath /dev/null',
    'git config include.path /tmp/other.cfg',
    'git config --add include.path /tmp/other.cfg',
    'git config set include.path /tmp/other.cfg',
    'git config --global Include.Path /tmp/other.cfg',
    'git config includeIf.gitdir:/.path /tmp/other.cfg',
    'git config --rename-section hidden include',
    'git config --rename-section hidden includeIf.onbranch:main',
    'git -c include.path=/tmp/other.cfg commit -m x',
    'git -c includeIf.gitdir:/.path=/tmp/other.cfg commit -m x',
    'git --config-env include.path=OTHER commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=/tmp/other.cfg git commit -m x',
    "GIT_CONFIG_PARAMETERS=\"'include.path'='/tmp/other.cfg'\" git commit -m x",
  ]) blocked(command);
  for (const command of [
    'git config --get core.hooksPath',
    'git config --get-all core.hooksPath',
    'git config get core.hooksPath',
    'git config --list',
    'git config -l',
    'git config --list --show-origin',
    'git config --get-regexp hooks',
    'git config --get-a core.hooksPath',
    'git config --get include.path',
    'git config include.path',
    'git config --unset include.path',
    'git config --no-edit user.name',
    'git config user.name x',
    'git config --rename-section old new',
    'git config --file .gitmodules --get submodule.x.path',
    'git config -f .gitmodules --list',
    'GIT_EDITOR=true git commit --amend',
    'EDITOR=vim git commit',
    'git -c core.editor=true commit',
    'git commit -e -m x',
  ]) allowed(command);
});

test('hooks setting: git -c, --config-env and GIT_CONFIG_KEY_n cannot skip the check (#114)', () => {
  for (const command of [
    'git -c core.hookspath=/dev/null commit -m x',
    'git -c CORE.HOOKSPATH= commit -m x',
    'git -c core.hooksPath commit -m x',
    'git -c user.name=x -c core.hooksPath=/tmp/none commit -m x',
    'git -c core.hooksPath=.githooks -c core.hooksPath=/dev/null commit -m x',
    'git -C ../other -c core.hooksPath=/dev/null push',
    'git --config-env=core.hooksPath=HOOKS commit -m x',
    'git --config-env core.hooksPath=HOOKS commit -m x',
    'git --config-env core.hooksPath=HOOKS',
    'bash -c "git -c core.hooksPath=/dev/null commit -m x"',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=CORE.HOOKSPATH GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath git commit -m x',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0= git commit -m x',
    'sudo -u nobody GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null; git commit -m x',
    'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_0=.githooks GIT_CONFIG_VALUE_1=/x git commit',
    "GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git commit -m x",
  ]) blocked(command);
});

test('hooks setting: a read never blocks, in a repo with its own hooks folder (#217)', () => {
  const cwd = makeHooksRepo();
  try {
    for (const command of [
      'git config --get core.hooksPath',
      'git config --get-all core.hooksPath',
      'git config --list',
      'git config -l',
      'git config --local --get core.hooksPath',
      'git config core.hooksPath',
      'git config --get-regexp hooks',
    ]) assert.equal(checkCommand(command, { env: {}, cwd }), null, `should allow: ${command}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hooks setting: a folder whose pre-commit runs the check, or the value already set, passes (#217)', () => {
  const cwd = makeHooksRepo();
  const pass = (command: string, from = cwd) => assert.equal(checkCommand(command, { env: {}, cwd: from }), null, `should allow: ${command}`);
  const stop = (command: string) => assert.ok(checkCommand(command, { env: {}, cwd }), `should block: ${command}`);
  try {
    pass('git config core.hooksPath .husky/_');
    pass('git config --local core.hooksPath .husky/_');
    pass('git config set core.hooksPath .husky');
    pass('npm install && git config core.hooksPath .husky/_');
    pass(`git -C ${cwd} config core.hooksPath .husky/_`, tmpdir());
    pass('git config core.hooksPath hooks/own');
    for (const command of [
      'git config core.hooksPath hooks/plain',
      'git config core.hooksPath hooks/none',
      'git config core.hooksPath ../elsewhere',
      'git config core.hooksPath /tmp/x',
      'git config --unset core.hooksPath',
      'git config --global core.hooksPath .husky/_',
      'git config --system core.hooksPath .husky/_',
      'git config -f other.config core.hooksPath .husky/_',
      'git --git-dir=.git config core.hooksPath .husky/_',
      'git -c core.hooksPath=/tmp/x commit -m x',
      'git -c core.hooksPath=.husky/_ commit -m x',
    ]) stop(command);
    const refusal = checkCommand('git config core.hooksPath hooks/plain', { env: {}, cwd });
    assert.match(refusal?.what ?? '', /hooks\/plain\/pre-commit does not run `yokoten check`/);
    assert.match(refusal?.fix ?? '', /add `yokoten check` to hooks\/plain\/pre-commit/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hooks setting: the hook judges it in the folder the command runs in (#217, #218)', () => {
  const repo = makeHooksRepo();
  const command = 'git config core.hooksPath .husky/_';
  const judgeFrom = (cwd: string | undefined, root: string | null) => judge({ command, paths: [], cwd, worker: false }, { root, config: DEFAULTS, env: {} });
  try {
    // The session runs elsewhere; the agent's command runs in the repo.
    assert.equal(judgeFrom(repo, null), null, 'the call\'s cwd');
    assert.equal(judgeFrom(undefined, repo), null, 'else the repo root');
    // Positive control: the same command, judged from a folder outside the repo, is refused.
    assert.equal(checkCommand(command, { env: {}, cwd: tmpdir() })?.id, 'hooks-path');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hooks setting: only a line that runs yokoten check counts, not a comment (#217)', () => {
  assert.equal(runsCheck('#!/bin/sh\nnode "bin/yokoten.ts" check --staged\n'), true);
  assert.equal(runsCheck('npx yokoten check || exit 1\r\n'), true);
  assert.equal(runsCheck('#!/bin/sh\n# yokoten check\nnpm test\n'), false);
  assert.equal(runsCheck('node bin/yokoten.ts checkout\n'), false);
  // The JavaScript entry the agent hooks run (#408) counts as yokoten too.
  assert.equal(runsCheck('#!/bin/sh\nnode ".yokoten/bin/yokoten.mjs" check --staged || exit 1\n'), true);
  assert.equal(runsCheck('#!/bin/sh\nnode ".yokoten/bin/yokoten.mts" check --staged || exit 1\n'), false);
  assert.equal(hookFile('/repo', '.husky/_'), '.husky/pre-commit');
  assert.equal(hookFile('/repo', '../other'), null);
});

// The review of #226: a pre-commit that names the check but can skip it does not count.
test('hooks setting: only a check line that stops the commit counts, at the top level (#226)', () => {
  for (const script of [
    '#!/bin/sh\nexec node "bin/yokoten.ts" check --staged\n',
    '#!/bin/sh\nnpx lint-staged\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\n',
    `#!/bin/sh\n[ -f ".yokoten/bin/yokoten.ts" ] || { echo 'yokoten: missing' >&2; exit 1; }; node ".yokoten/bin/yokoten.ts" check --staged || exit 1\n`,
    '#!/bin/sh\nset -e\nnpx yokoten check\nnpm test\n',
    '#!/bin/sh\nif true; then npm test; fi\nnpx yokoten check || exit 1\n',
  ]) assert.equal(runsCheck(script), true, script);
  for (const script of [
    'echo yokoten check\n',
    'true || yokoten check\n',
    ': yokoten check\n',
    'exit 0\nyokoten check\n',
    'npm test || exit 0\nyokoten check\n',
    'exec true\nyokoten check\n',
    'yokoten check || true\n',
    'yokoten check || :\n',
    'yokoten check; true\n',
    'yokoten check &\n',
    'yokoten check\nnpm test\n',
    "cat <<'EOF'\nyokoten check\nEOF\n",
    'if false; then\nyokoten check\nfi\n',
    'if false; then\n  echo fi\n  yokoten check || exit 1\nfi\n',
    'false && {\nyokoten check || exit 1\n}\n',
    `[ -f x ] || { echo 'm'; exit 0; }; node x check || exit 1\n`,
  ]) assert.equal(runsCheck(script), false, script);
  assert.equal(hookFile('/repo', '.husky'), '.husky/pre-commit');
  assert.equal(hookFile('/repo', '.husky/nope'), '.husky/nope/pre-commit', 'git runs the folder it names');
});

test('hooks setting: a folder git expands, or a command that moves repo, is refused (#226)', () => {
  const cwd = makeHooksRepo();
  const stop = (command: string) => assert.equal(checkCommand(command, { env: {}, cwd })?.id, 'hooks-path', `should block: ${command}`);
  const pass = (command: string) => assert.equal(checkCommand(command, { env: {}, cwd }), null, `should allow: ${command}`);
  try {
    for (const command of [
      'git config core.hooksPath .husky/nope',
      'git config core.hooksPath ~/h',
      'git config core.hooksPath %(prefix)/h',
      `cd ${tmpdir()} && git config core.hooksPath .husky/_`,
      'pushd sub && git config core.hooksPath .husky/_',
      'GIT_DIR=/tmp/other/.git git config core.hooksPath .husky/_',
      'GIT_WORK_TREE=/tmp/other git config core.hooksPath .husky/_',
      'git config --worktree core.hooksPath .husky/_',
    ]) stop(command);
    // Reads, and .githooks, need no repo; the same set without a move still passes.
    pass(`cd ${tmpdir()} && git config --get core.hooksPath`);
    pass('cd sub && git config core.hooksPath .githooks');
    pass('git config core.hooksPath .husky/_');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('everyday commands pass', () => {
  for (const c of ['git status', 'git push', 'git push origin feature-v2', 'git commit -m "fix v1 parser"', 'npm test', 'gh pr create --fill', 'ls -la', 'gh release list']) allowed(c);
});

test('fix task: test files are off limits', () => {
  const env = { YOKOTEN_FIX_TASK: '1' };
  for (const p of ['test/a.ts', 'src/a.test.ts', 'web/b.spec.js', 'pkg/x_test.go', 'tests/fixtures/x.json']) {
    assert.ok(checkEdit(p, { config: DEFAULTS, env }), p);
  }
  assert.equal(checkEdit('src/a.ts', { config: DEFAULTS, env }), null);
  assert.equal(checkEdit('test/a.ts', { config: DEFAULTS, env: {} }), null);
});

test('lead-only files: a worker is stopped, the lead is not', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const p of ['AGENTS.md', 'CLAUDE.md', 'yokoten.json', '.claude/settings.json', '.claude-plugin/plugin.json', '.codex/hooks.json', '.gemini/settings.json', '.github/workflows/ci.yml', '.githooks/pre-commit', '.yokoten/src/run/check.ts']) {
    assert.ok(checkEdit(p, { config: DEFAULTS, env: worker }), p);
    assert.equal(checkEdit(p, { config: DEFAULTS, env: {} }), null, p);
  }
  // A glob with a slash is the root's folder only; one without matches in any folder.
  assert.ok(checkEdit('kit/project/AGENTS.md', { config: DEFAULTS, env: worker }));
  assert.equal(checkEdit('kit/project/.github/workflows/x.yml', { config: DEFAULTS, env: worker }), null);
});

// A worker's shell writes and commits to lead-only files (#402). The file rules apply in a
// repo that uses yokoten, as for an edit, so the sandbox gets a yokoten.json.
const yokotenSandbox = () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  return sandbox;
};

test('lead-only files: each shell writer form stops a worker, not the lead (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string, env: Env) => checkCommand(command, { env, cwd: sandbox.repo });
  sandbox.write('fix.patch', 'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-a\n+b\n');
  for (const command of [
    'echo x > AGENTS.md',
    'echo x >>AGENTS.md',
    'printf x &> CLAUDE.md',
    'echo x >| yokoten.json',
    'echo x 2>|CLAUDE.md',
    'echo x 2>&1 >&AGENTS.md',
    'cat > AGENTS.md <<EOF\nnew rules\nEOF',
    'sed -i s/a/b/ AGENTS.md',
    'sed -i.bak -e s/a/b/ AGENTS.md',
    'sed --in-place s/a/b/ AGENTS.md',
    'sed -Ei s/a/b/ src/a.ts AGENTS.md',
    'echo x | tee AGENTS.md',
    'echo x | tee -a .github/workflows/ci.yml',
    'cp /tmp/x AGENTS.md',
    'cp x y .githooks/',
    'cp -t .claude x',
    'mv AGENTS.md notes.md',
    'mv x .github/workflows/ci.yml',
    'install -m 755 x .githooks/pre-commit',
    'ln -sf x CLAUDE.md',
    'dd if=x of=AGENTS.md',
    'truncate -s 0 AGENTS.md',
    'rm AGENTS.md',
    'rm -rf .github',
    'perl -pi -e s/a/b/ AGENTS.md',
    'perl -i.bak -pe s/a/b/ AGENTS.md',
    'git checkout -- AGENTS.md',
    'git checkout main -- .github/workflows/ci.yml',
    'git restore AGENTS.md',
    'git restore --source main --worktree --staged AGENTS.md',
    'git rm AGENTS.md',
    'git mv AGENTS.md RULES.md',
    'git apply fix.patch',
    'cd src && cp x ../AGENTS.md',
    'sudo -u x sed -i s/a/b/ AGENTS.md',
    'bash -c "echo x > AGENTS.md"',
    'nice -n 10 tee AGENTS.md < x',
  ]) {
    assert.equal(run(command, worker)?.id, 'lead-only', `should stop a worker: ${JSON.stringify(command)}`);
    assert.equal(run(command, {}), null, `should let the lead: ${JSON.stringify(command)}`);
  }
  // The message names the file and how to hand it over.
  const found = run('sed -i s/a/b/ AGENTS.md', worker);
  assert.match(found?.what ?? '', /writes AGENTS\.md, which is lead-only/);
  assert.match(found?.fix ?? '', /hand the change to the lead/);
});

test('lead-only files: reads, other files and files outside the repo pass a worker (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const command of [
    'cat AGENTS.md',
    'grep x AGENTS.md',
    'grep -n ">" AGENTS.md',
    'echo ">" AGENTS.md',
    'head -5 AGENTS.md > /dev/null',
    'sed -n 1,5p AGENTS.md',
    'perl -ne print AGENTS.md',
    'cp AGENTS.md notes.md',
    'diff AGENTS.md CLAUDE.md 2>&1',
    'echo x > src/a.ts',
    'sed -i s/a/b/ src/a.ts',
    'rm -rf dist',
    'git checkout main',
    'git checkout -b 402-x',
    'git restore --staged AGENTS.md',
    'git diff AGENTS.md',
    'git log -p -- .github',
    'echo x > /tmp/AGENTS.md',
  ]) {
    assert.equal(checkCommand(command, { env: worker, cwd: sandbox.repo }), null, `should allow: ${JSON.stringify(command)}`);
  }
});

test('lead-only files: YOKOTEN_LEAD_ONLY_OK lets the paths it names through, and no others (#402)', () => {
  const sandbox = yokotenSandbox();
  const granted = { YOKOTEN_ROLE: 'worker', YOKOTEN_LEAD_ONLY_OK: ' AGENTS.md, ./.github/workflows/*.yml' };
  const run = (command: string) => checkCommand(command, { env: granted, cwd: sandbox.repo });
  assert.equal(run('sed -i s/a/b/ AGENTS.md'), null);
  assert.equal(run('echo x > .github/workflows/ci.yml'), null);
  assert.equal(run('echo x > CLAUDE.md')?.id, 'lead-only');
  assert.equal(run('echo x > .github/CODEOWNERS')?.id, 'lead-only');
  assert.equal(run('rm -rf .github')?.id, 'lead-only', 'a folder that holds more than the grant');
  assert.equal(checkEdit('AGENTS.md', { config: DEFAULTS, env: granted }), null);
  assert.ok(checkEdit('CLAUDE.md', { config: DEFAULTS, env: granted }));
  assert.ok(checkEdit('kit/AGENTS.md', { config: DEFAULTS, env: granted }), 'a path is the one path, not a glob');
  // A trailing /, \\ for / and empty entries are read as the lead meant them.
  assert.ok(isGranted('.github/workflows/ci.yml', { YOKOTEN_LEAD_ONLY_OK: ',, .github\\workflows\\ci.yml ,' }, false));
  assert.ok(isGranted('CLAUDE.md', { YOKOTEN_LEAD_ONLY_OK: 'CLAUDE.md/' }, false));
  assert.ok(!isGranted('CLAUDE.md', { YOKOTEN_LEAD_ONLY_OK: ' , ' }, false), 'no entry grants nothing');
  // `*` grants every lead-only file.
  assert.ok(isGranted('.github/workflows/ci.yml', { YOKOTEN_LEAD_ONLY_OK: '*' }, false));
  assert.ok(isGranted('AGENTS.md', { YOKOTEN_LEAD_ONLY_OK: '*' }, false));
});

test('lead-only files: a worker\'s git commit of a lead-only file is stopped, in the guard and the commit check (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  sandbox.write('AGENTS.md', 'rules\n');
  sandbox.write('src/a.ts', 'export {};\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const run = (command: string, env: Env = worker) => checkCommand(command, { env, cwd: sandbox.repo });
  sandbox.write('AGENTS.md', 'new rules\n');
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  // Not staged yet: only -a commits it.
  assert.equal(run('git commit -m x'), null);
  assert.equal(run('git commit -am x')?.id, 'lead-only');
  assert.equal(run('git commit --all -m x')?.id, 'lead-only');
  assert.equal(run('git commit -m x AGENTS.md')?.id, 'lead-only');
  sandbox.git('add', '.');
  const found = run('git commit -m "feat(x): y"');
  assert.equal(found?.id, 'lead-only');
  assert.match(found?.what ?? '', /this commit changes AGENTS\.md/);
  assert.match(found?.fix ?? '', /git restore --staged AGENTS\.md/);
  assert.equal(run(`git -C ${sandbox.repo} commit -qm x`)?.id, 'lead-only');
  assert.equal(run(`cd ${join(sandbox.repo, 'src')} && git commit -m x`)?.id, 'lead-only');
  // Pathspecs commit only what they name.
  assert.equal(run('git commit -m x src/a.ts'), null);
  assert.equal(run('git commit -i -m x src/a.ts')?.id, 'lead-only');
  assert.equal(run('git commit -m x', {}), null, 'the lead');
  assert.equal(run('git commit -m x', { ...worker, YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' }), null, 'the grant');
  // The commit check refuses the same commit for a YOKOTEN_ROLE worker, unless granted.
  let result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  result = sandbox.run(['check', '--staged'], { extra: { ...worker, YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' } });
  assert.equal(result.status, 0, result.stderr);
});

test('lead-only files: the hook stops a shell write from the plugin agent yokoten:worker, with no YOKOTEN_ROLE (#402)', () => {
  // The session folder is reached through a symlink, as /var is /private/var on macOS: git
  // names the root by its real path, the agent by the link. The full hook rules the session's
  // repo with no yokoten.json, as it does for an edit.
  const sandbox = makeSandbox();
  const link = join(sandbox.home, 'repo-link');
  symlinkSync(sandbox.repo, link);
  for (const cwd of [sandbox.repo, link]) {
    const call = (agentType?: string) =>
      sandbox.run(['hook'], { cwd, input: JSON.stringify({ cwd, agent_type: agentType, tool_input: { command: 'sed -i s/a/b/ AGENTS.md' } }) });
    const result = call('yokoten:worker');
    assert.equal(result.status, 2, `${cwd === link ? 'through the link' : 'the repo'}: ${result.stderr}`);
    assert.match(result.stderr, /writes AGENTS\.md, which is lead-only/);
    assert.equal(call().status, 0, 'the lead');
    assert.equal(call('yokoten:reviewer').status, 0, 'not a worker');
  }
});

test('lead-only files: a redirect is read when its operator is unquoted, glued or quoted file and all (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string) => checkCommand(command, { env: worker, cwd: sandbox.repo })?.id ?? null;
  for (const command of [
    'echo hi >"AGENTS.md"',
    "echo hi >'AGENTS.md'",
    'echo hi >"dir with space/AGENTS.md"',
    'echo hi>AGENTS.md',
    'ls>AGENTS.md',
    'echo hi>>AGENTS.md',
    'echo x>|AGENTS.md',
    'echo x >|AGENTS.md | cat',
    'echo hi&>AGENTS.md',
    'echo hi 2>AGENTS.md',
    'echo hi 2>"AGENTS.md"',
  ]) assert.equal(run(command), 'lead-only', `should stop: ${JSON.stringify(command)}`);
  // A quoted or escaped operator is text.
  for (const command of ['echo ">AGENTS.md"', "echo '>AGENTS.md'", 'echo \\>AGENTS.md', 'echo "a>AGENTS.md"', 'grep "x>" AGENTS.md']) {
    assert.equal(run(command), null, `should allow: ${JSON.stringify(command)}`);
  }
});

test('bash: an unquoted > inside a word starts a redirect; quoted text and file-descriptor forms read as before (#402)', () => {
  assert.deepEqual(commandWords('echo hi>f'), [['echo', 'hi', '>f']]);
  assert.deepEqual(commandWords('ls>f'), [['ls', '>f']]);
  assert.deepEqual(commandWords('echo x>|f'), [['echo', 'x', '>|f']]);
  assert.deepEqual(commandWords('a >| f | b'), [['a', '>|', 'f'], ['b']]);
  assert.deepEqual(commandWords('echo hi&>f'), [['echo', 'hi', '&>f']]);
  assert.deepEqual(commandWords('echo hi>>f'), [['echo', 'hi', '>>f']]);
  // As in bash: unquoted, => and -> redirect too.
  assert.deepEqual(commandWords('x --arg=a=>b'), [['x', '--arg=a=', '>b']]);
  // Read as before: quotes, file descriptors, process substitution and && .
  assert.deepEqual(commandWords('echo "a>b"'), [['echo', 'a>b']]);
  assert.deepEqual(commandWords("x --arg='a=>b' \"c->d\""), [['x', '--arg=a=>b', 'c->d']]);
  assert.deepEqual(commandWords('curl "https://example.com/?a>b"'), [['curl', 'https://example.com/?a>b']]);
  assert.deepEqual(commandWords('x 2>&1'), [['x', '2>&1']]);
  assert.deepEqual(commandWords('x 2>&1 >f'), [['x', '2>&1', '>f']]);
  assert.deepEqual(commandWords('x {fd}>f'), [['x', '{fd}>f']]);
  assert.deepEqual(commandWords('echo a&&b'), [['echo', 'a'], ['b']]);
  assert.deepEqual(commandWords('diff <(a) >(b)'), [['a'], ['b'], ['diff', '<(a)', '>(b)']]);
  // The other checks still read a glued redirect away: no file named by it is a value.
  allowed('git config core.hooksPath>/dev/null');
  blocked('npm publish>log');
});

test('lead-only files: a symlink to a lead-only file is that file (#402)', () => {
  const sandbox = yokotenSandbox();
  sandbox.write('AGENTS.md', 'rules\n');
  symlinkSync('AGENTS.md', join(sandbox.repo, 'link.md'));
  const worker = { YOKOTEN_ROLE: 'worker' };
  const found = checkCommand('echo x > link.md', { env: worker, cwd: sandbox.repo });
  assert.equal(found?.id, 'lead-only');
  assert.match(found?.what ?? '', /writes AGENTS\.md/);
  assert.equal(checkCommand('echo x > notes.md', { env: worker, cwd: sandbox.repo }), null);
});

test('lead-only files: on macOS and Windows a name matches in any case (#402)', () => {
  assert.ok(isLeadOnly('agents.md', DEFAULTS.leadOnly, true));
  assert.ok(isLeadOnly('.GitHub/workflows/ci.yml', DEFAULTS.leadOnly, true));
  assert.ok(!isLeadOnly('agents.md', DEFAULTS.leadOnly, false), 'Linux: another file');
  assert.ok(isGranted('agents.md', { YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' }, true));
  assert.ok(!isGranted('agents.md', { YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' }, false));
});

test('lead-only files: git apply reads only a plain patch file under 1 MB, and stops a worker on any other (#402)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string) => checkCommand(command, { env: worker, cwd: sandbox.repo });
  sandbox.write('ok.patch', 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n');
  assert.equal(run('git apply ok.patch'), null);
  sandbox.write('big.patch', `diff --git a/src/a.ts b/src/a.ts\n${'+x\n'.repeat(600_000)}`);
  assert.match(run('git apply big.patch')?.what ?? '', /can't read which files it changes/);
  assert.equal(run('git apply missing.patch')?.id, 'lead-only');
  assert.equal(run('git apply /dev/stdin')?.id, 'lead-only', 'a device is never read');
  if (process.platform !== 'win32') {
    assert.equal(spawnSync('mkfifo', [join(sandbox.repo, 'pipe.patch')]).status, 0);
    const start = Date.now();
    assert.equal(run('git apply pipe.patch')?.id, 'lead-only', 'a FIFO is never read');
    assert.ok(Date.now() - start < 2000, 'and the guard does not wait on it');
  }
  // stdin is a known gap: the guide says so.
  assert.equal(run('git apply - < ok.patch'), null);
  assert.equal(checkCommand('git apply big.patch', { env: {}, cwd: sandbox.repo }), null, 'the lead');
});


test('lead-only files: shell writes follow the edit guard\'s scope, only in repos that use yokoten (#402)', () => {
  const sandbox = makeSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  // No yokoten.json and no repo from the hook: yokoten's file list is not this repo's.
  assert.equal(checkCommand('sed -i s/a/b/ AGENTS.md', { env: worker, cwd: sandbox.repo }), null);
  assert.equal(checkEdit('AGENTS.md', { config: DEFAULTS, env: worker }) === null, false, 'the edit guard has the same list');
  const hook = (flags: string[], command: string) => sandbox.run(['hook', ...flags], { input: JSON.stringify({ cwd: sandbox.repo, agent_type: 'yokoten:worker', tool_input: { command } }) });
  const edit = (flags: string[]) => sandbox.run(['hook', ...flags], { input: JSON.stringify({ cwd: sandbox.repo, agent_type: 'yokoten:worker', tool_input: { file_path: join(sandbox.repo, 'AGENTS.md') } }) });
  // The user-level hook: neither an edit nor a shell write is stopped outside a yokoten repo...
  assert.equal(edit(['--commands-only']).status, 0);
  assert.equal(hook(['--commands-only'], 'echo x > AGENTS.md').status, 0);
  // ...and both are, once the repo has a yokoten.json.
  sandbox.write('yokoten.json', '{}\n');
  assert.equal(edit(['--commands-only']).status, 2);
  assert.equal(hook(['--commands-only'], 'echo x > AGENTS.md').status, 2);
  // The repo's own list applies.
  sandbox.write('yokoten.json', '{ "leadOnly": ["RULES.md"] }\n');
  assert.equal(hook(['--commands-only'], 'echo x > AGENTS.md').status, 0);
  assert.equal(hook(['--commands-only'], 'echo x > RULES.md').status, 2);
  assert.equal(checkCommand('echo x > RULES.md', { env: worker, cwd: sandbox.repo })?.id, 'lead-only', 'found by the walk up');
  // A repo the hook passes in is ruled as given, with no walk: here the file system's root.
  const root = join(sandbox.repo, '..');
  assert.equal(checkCommand('echo x > other/AGENTS.md', { env: worker, cwd: root, repos: [{ root, leadOnly: DEFAULTS.leadOnly }] })?.id, 'lead-only');
});

test('bash: `>|` is a redirect, and a plain `|` is still a pipe (#402)', () => {
  assert.deepEqual(commandWords('echo x >| yokoten.json'), [['echo', 'x', '>|', 'yokoten.json']]);
  assert.deepEqual(commandWords('echo x 2>|a'), [['echo', 'x', '2>|a']]);
  assert.deepEqual(commandWords('a | b'), [['a'], ['b']]);
  assert.deepEqual(commandWords('a|b'), [['a'], ['b']]);
  assert.deepEqual(commandWords('a || b'), [['a'], ['b']]);
  assert.deepEqual(commandWords('a |& b'), [['a'], ['b']]);
  // A quoted > is text, so the | after it is a pipe.
  assert.deepEqual(commandWords("echo '>'|cat"), [['echo', '>'], ['cat']]);
  for (const command of ['echo "npm publish >"|bash', "echo 'npm publish >'|sh", 'echo npm publish|bash', 'echo npm publish | bash']) blocked(command);
  allowed('echo x >| out.txt');
  blocked('echo x >| out.txt && git push --tags');
});

// Bash syntax (#105). Each row of the issue's table first, then the rest of everyday bash.
test('bash: words in quotes or a heredoc are data, not commands (#105)', () => {
  allowed('git commit -m "docs: explain when to run npm publish"');
  allowed('echo "never run gh release create by hand"');
  allowed('grep -rn "git push --tags" docs');
  allowed('cat > notes.md <<EOF\nRun npm publish after the tag.\nEOF');
  allowed("ego-browser nodejs <<'EOF'\nawait page.fill(\"#q\", \"npm publish\");\nEOF");
  blocked('npm publish');
  blocked('bash <<EOF\nnpm publish\nEOF');
  for (const c of ['bash -c "npm publish"', "sh -c 'git push --tags'", 'zsh -c "gh release create v1"', 'eval "npm publish"', '/bin/bash -c "npm publish"', 'sudo -u x bash -lc "npm publish"', 'find . -exec sh -c "npm publish" \\;']) blocked(c);
  // A commit message written the usual way, with an apostrophe and brackets in it.
  allowed("git commit -m \"$(cat <<'EOF'\nfix: don't run npm publish (yet)\n\nCo-Authored-By: x\nEOF\n)\"");
  blocked("git commit -m \"$(cat <<'EOF'\nfix: don't\nEOF\n)\" && git push --tags");
  allowed('bash -c "git commit -m \\"docs: npm publish\\""');
});

test('bash: a shell that reads a heredoc, a pipe or a here-string runs it (#105)', () => {
  for (const c of [
    'bash <<-EOF\n\tnpm publish\n\tEOF',
    "sh <<'EOF'\nnpm publish\nEOF",
    'env FOO=1 bash -s <<EOF\nnpm publish\nEOF',
    'cat <<EOF | bash\nnpm publish\nEOF',
    "ssh host <<'EOF'\nnpm publish\nEOF",
    'echo "npm publish" | bash',
    "printf 'npm publish\\n' | sh",
    'bash <<< "npm publish"',
    'ssh host "git push --tags"',
  ]) blocked(c);
  allowed('cat <<< "npm publish"');
  // After the end line, the text is commands again.
  blocked('cat <<-EOF\n\tdata\n\tEOF\nnpm publish');
  allowed('cat <<-EOF\n\tnpm publish\n\tEOF\nls');
});

// #196: three false refusals in one night, each from a heredoc body a non-shell reads.
test('bash: a heredoc read by a program that is not a shell is data (#196)', () => {
  const caseOne = "cat > body.md <<'EOF'\n## What happened\nThe owner runs npm publish after the tag.\nEOF";
  allowed(caseOne);
  allowed("node - <<'EOF'\nconst a = 'git commit -m \"x\"';\nconst b = 'nice -n 10';\nEOF");
  allowed(`cat > issue.md <<'EOF'\nA PR body written with:\n\n${caseOne}\n\nwas refused.\nEOF`);
  for (const command of [
    'cat > f <<EOF\ngit push --force\nEOF',
    "tee notes.md <<'EOF'\nnpm publish\nEOF",
    "gh issue create --title 'check: add x' --body-file - <<'EOF'\ngh release create v1\nEOF",
    "nice -n 10 node - <<'EOF'\ngit push --tags\nEOF",
    // A word that names a shell or a runner is not the program: a file called sh or script.
    'cat > sh <<EOF\nnpm publish\nEOF',
    'cat > script <<EOF\nnpm publish\nEOF',
    'node x.ts --shell bash <<EOF\nnpm publish\nEOF',
    // Only the command that holds the << and what it pipes into read the body.
    'cat <<EOF > run.sh; bash -n run.sh\nnpm publish\nEOF',
    'cat <<EOF && bash -c true\nnpm publish\nEOF',
    // Several heredocs, quoted and not, with <<-: each body goes to its own command.
    "cat <<'A' > a.md; tee b.md <<-B\nnpm publish\nA\n\tgit push --force\n\tB",
    'cat <<A <<"B"\nnpm publish\nA\ngit push --tags\nB',
  ]) allowed(command);
  // The same text read by the block list: python is stopped by its own name, not its body.
  assert.equal(checkCommand("python3 - <<'EOF'\nprint(1)\nEOF", { env: {}, config: { commands: { block: { python3: 'TypeScript only' } } } })?.id, 'blocked-command');
});

test('bash: a heredoc read by a shell is commands, and so are the lines after it (#196)', () => {
  for (const command of [
    "bash <<'EOF'\ngit push --force\nEOF",
    'sh -s <<EOF\nnpm publish\nEOF',
    'nice -n 10 bash <<EOF\nnpm publish\nEOF',
    'sudo -u x zsh <<EOF\nnpm publish\nEOF',
    'sudo -s <<EOF\nnpm publish\nEOF',
    '/bin/dash <<-EOF\n\tnpm publish\n\tEOF',
    'ksh <<EOF\nnpm publish\nEOF',
    'cat <<EOF | tee log | bash\nnpm publish\nEOF',
    'cat <<EOF |\nnpm publish\nEOF\nbash',
    'cat <<EOF\ndata\nEOF\ngit push --force',
    "node - <<'EOF'\nconsole.log(1);\nEOF\nnpm publish",
    // The second heredoc is a shell's, though the first is data.
    "cat <<'A'; bash <<'B'\nhello\nA\nnpm publish\nB",
    'cat > f <<A <<B; ls\nx\nA\ny\nB\ngit push --force',
  ]) blocked(command);
});

test('bash: a shell after a keyword or a launcher reads the heredoc (#196)', () => {
  for (const command of [
    "if true; then bash <<'EOF'\ngit push --force origin main\nEOF\nfi",
    "for r in a; do bash <<'EOF'\ngit push --force origin main\nEOF\ndone",
    'while false; do sh <<EOF\ngit push --force origin main\nEOF\ndone',
    "! bash <<'EOF'\nnpm publish\nEOF",
    "stdbuf -oL bash <<'EOF'\ngit push --force origin main\nEOF",
    "setsid bash <<'EOF'\ngit push --force origin main\nEOF",
    "busybox sh <<'EOF'\ngit push --force origin main\nEOF",
    "chrt -f 10 bash <<'EOF'\nnpm publish\nEOF",
    "cat <<'EOF' | stdbuf -oL bash\ngit push --force origin main\nEOF",
    // A program the guard does not know may hand its input to a shell: refused, not guessed.
    "some-launcher --flag bash <<'EOF'\nnpm publish\nEOF",
  ]) blocked(command);
  // A program known to read data keeps its body as data, with a shell word after it.
  allowed("if true; then cat > sh <<'EOF'\nnpm publish\nEOF\nfi");
  allowed("stdbuf -oL tee bash <<'EOF'\nnpm publish\nEOF");
});

test('bash: substitutions run, so their commands count, even inside "..." (#105)', () => {
  for (const c of ['echo $(npm publish)', 'echo `npm publish`', 'echo "$(npm publish)"', 'echo "`npm publish`"', 'diff <(npm publish) x', 'cat > f <<EOF\n$(npm publish)\nEOF']) blocked(c);
  // A quoted heredoc word turns substitution off.
  allowed("cat > f <<'EOF'\n$(npm publish)\nEOF");
  // $(( )) is maths: its << is a shift, not a heredoc.
  allowed('echo $((1<<2))\nls');
  blocked('echo $((1<<2))\nnpm publish');
});

test('bash: separators, groups, comments and line joins (#105)', () => {
  for (const c of ["git commit -m 'x' && npm publish", 'false || npm publish', 'ls; npm publish', 'ls | npm publish', 'sleep 1 & npm publish', 'ls\nnpm publish', '(cd x && npm publish)', '{ cd x; npm publish; }', 'echo a \\\n&& npm publish', 'git push origin main 2>&1 --tags']) blocked(c);
  allowed('ls # npm publish');
  blocked('ls # a comment\nnpm publish');
  allowed('echo a#b');
  assert.deepEqual(commandWords("printf '%s' \"a;b\""), [['printf', '%s', 'a;b']]);
  assert.deepEqual(commandWords('git commit \\\n  -m x'), [['git', 'commit', '-m', 'x']]);
  assert.deepEqual(commandWords("echo $'it\\'s;' $\"a|b\" \\;"),[['echo', "it's;", 'a|b', ';']]);
});

test('bash: prefixes and wrappers do not hide the command (#105)', () => {
  for (const c of ['FOO=1 npm publish', 'NODE_ENV=prod npm publish', 'sudo npm publish', 'env X=1 npm publish', 'command npm publish', 'exec npm publish', 'time npm publish', 'nice -n 5 npm publish', 'nohup npm publish', 'timeout 10 npm publish', 'ls | xargs npm publish', 'npm --tag beta publish', 'env -S "npm publish"', "git -c alias.p='!git push --tags' p"]) blocked(c);
  // sudo runs a program, not a shell string, so a quoted message stays a message.
  allowed('sudo git commit -m "docs: npm publish"');
});

test('bash: an unclosed quote is dropped and the rest read as words (#105)', () => {
  blocked("echo 'x; npm publish");
  blocked('git commit -m "fix; npm publish');
  blocked('echo "$(echo x; npm publish');
  blocked('echo `npm publish');
});

test('blocked commands: the program is stopped by its name, with any folder or .exe (#192)', () => {
  for (const command of [
    'python3 --version',
    'python x.py',
    '/usr/bin/python3 -c "print(1)"',
    '"C:\\Python\\python.exe" x.py',
    'C:/Python/python.exe x.py',
    'python3.EXE x.py',
    'npm test && python3 x.py',
    'cat a | python3 -',
    'ls; python x.py',
    'echo $(python3 -V)',
    "bash -c 'python3 x.py'",
    'env X=1 python3 x.py',
    'FOO=1 python3 x.py',
    '/usr/bin/env python3 x.py',
    'nice -n 10 python3 x.py',
    'sudo -u root python3 x.py',
    'timeout 5 python3 x.py',
    'ls | xargs -n 1 python3',
  ]) assert.ok(isBlockedByList(command), `should block: ${command}`);
  const found = checkCommand('python3 --version', { env: {}, config: pythonBlocked });
  assert.equal(found?.what, '`python3` is blocked in this project');
  assert.equal(found?.why, 'this project is TypeScript only (AGENTS.md)', 'the reason from yokoten.json, with no full stop');
  assert.match(found?.fix ?? '', /project's own stack/);
  assert.match(found?.docs ?? '', /#blocked-commands$/);
});

test('blocked commands: after a shell keyword, a launcher, find -exec or env -S (#192)', () => {
  for (const command of [
    'for f in *.json; do python3 -m json.tool $f; done',
    'if true; then python3 x; fi',
    'if python3 x; then echo; fi',
    'if false; then echo; else python3 x; fi',
    'while python3 x; do :; done',
    'until false; do python3 x; done',
    '! python3 x',
    '{ python3 x; }',
    "find . -name '*.py' -exec python3 {} \\;",
    "find . -name '*.py' -execdir nice python3 {} +",
    "find . -type f -print -ok python3 {} ';'",
    'setsid python3 x',
    'stdbuf -oL python3 x',
    'stdbuf -o L python3 x',
    'busybox nohup python3 x',
    'chrt -f 10 python3 x',
    'ionice -c 3 python3 x',
    'taskset -c 0 python3 x',
    'unbuffer python3 x',
    "env --split-string='python3 x'",
    "env -S 'python3 x'",
    "env -S'python3 x'",
    'time python3 x',
  ]) assert.ok(isBlockedByList(command), `should block: ${command}`);
  for (const command of ['for python3 in a b; do echo $python3; done', "find . -name 'python3'", 'git commit -m "no python3 here"', "echo 'then python3'", 'setsid node x.ts', 'stdbuf -oL node x.ts']) {
    assert.equal(isBlockedByList(command), false, `should allow: ${command}`);
  }
});

test('blocked commands: a word that only holds the name passes, and so does no list (#192)', () => {
  for (const command of ['echo python', 'pythonic x', 'cat python.md', 'ls python3/', 'grep -r python3 src', 'command -v python3', 'node bin/yokoten.ts check', 'env X=1 node x.ts', 'nice -n 10 node --test']) {
    assert.equal(isBlockedByList(command), false, `should allow: ${command}`);
  }
  // Positive control: the same commands pass without the list.
  for (const command of ['python3 --version', 'env X=1 python3 x.py']) {
    assert.equal(checkCommand(command, { env: {} }), null, command);
    assert.equal(isBlockedByList(command, { commands: { block: {} } }), false, command);
  }
  assert.equal(isBlockedByList('toString x'), false, 'only the list\'s own keys');
});

test('blocked commands: the string ssh and flock run is read, after their options (#226)', () => {
  shouldBlock([
    `ssh host '${py} x'`,
    `ssh -p 22 host ${py} x`,
    `ssh -tp 22 host ${py} x`,
    `ssh -o BatchMode=yes -tt host "${py} -V"`,
    `ssh -- host ${py} x`,
    `flock /tmp/lock -c '${py} x'`,
    `flock -n /tmp/lock -c '${py} x'`,
    `flock -xc '${py} x' /tmp/lock`,
    `flock /tmp/lock --command '${py} x'`,
    `flock -w 5 /tmp/lock ${py} x`,
  ]);
  shouldPass(['ssh host ls', `ssh -i key host 'echo ${py}'`, 'flock /tmp/lock -c "npm test"', `ssh ${py}-box ls`]);
  // The core rules read the same string.
  blocked("ssh -p 22 host 'git push --force'");
  blocked("flock /tmp/lock -c 'npm publish'");
});

test('blocked commands: a case pattern is no program, the commands after it are (#226)', () => {
  shouldPass([
    `case $x in\n${py})\n  echo one;;\nesac`,
    `case $x in\n${py}|py)\n  echo one\n  ;;\n*) echo other ;;\nesac`,
    `case $x in a) echo a;; ${py}) echo b;; esac`,
    `case $x in\n(${py}) echo one;;\nesac`,
    `x=$(case $y in ${py}) echo;; esac)`,
    `echo "case ${py}) x"`,
  ]);
  shouldBlock([
    `case $x in\n${py})\n  ${py} x;;\nesac`,
    `case $x in ${py}) echo;; *) ${py} x;; esac`,
    `case $x in\na) echo;;\nesac\n${py} x`,
    `case a in x) case b in y) echo;; esac;; esac; ${py} x`,
  ]);
  blocked('case $x in a) git push --force;; esac');
  assert.deepEqual(commandWords('case $x in\na|b)\n  echo one;;\nesac'), [['case', '$x', 'in'], ['echo', 'one'], ['esac']]);
});

test('blocked commands: env -S in combined flags or a cut-short long option (#226)', () => {
  shouldBlock([`env -iS'${py} x'`, `env -iS '${py} x'`, `env -vS"${py} x"`, `env --split='${py} x'`, `env --s '${py} x'`]);
  shouldPass(['env -i node x.ts', `env --unset=X echo ${py}`]);
});

test('blocked commands: a redirect before the program does not hide it (#226)', () => {
  shouldBlock([`>out ${py} x`, `2>/dev/null ${py} x`, `<in ${py}`, `> out ${py} x`, `&>log ${py} x`, `2>&1 nice ${py} x`]);
  shouldPass([`>out echo ${py}`, `< ${py} cat`, `2> ${py}.log node x.ts`]);
});

test('bash: a redirect before the program, and the heredoc it holds (#226)', () => {
  blocked("2>&1 bash <<'EOF'\ngit push --force\nEOF");
  blocked(">out bash <<'EOF'\nnpm publish\nEOF");
  // The program is cat, and the shell names are files.
  allowed(">out cat <<'EOF'\ngit push --force\nEOF");
  allowed("> sh cat <<'EOF'\nnpm publish\nEOF");
  allowed("cat > f <<'EOF'\ngit push --force\nEOF");
});

test('bash: a heredoc in a group or subshell that pipes into a shell is commands (#226)', () => {
  for (const command of [
    "{ cat <<'EOF'; } | bash\ngit push --force\nEOF",
    "( cat <<'EOF' ) | sh\ngit push --force\nEOF",
    "{ cat <<'EOF'; echo; } | bash\nnpm publish\nEOF",
    "{ cat <<'EOF'; }|bash\nnpm publish\nEOF",
    "{ cat <<'EOF'; } | tee log | bash\nnpm publish\nEOF",
    "{ cat <<'EOF'; } |\nbash\nnpm publish\nEOF",
    "{\ncat <<'EOF'\ngit push --force\nEOF\n} | bash",
    "(\ncat <<'EOF'\ngit push --force\nEOF\n) | sh",
    "{ { cat <<'EOF'; }\nnpm publish\nEOF\n} | bash",
    "{\ncat <<'EOF'\nnpm publish\nEOF\n} | tee x | bash",
    // A group that never closes: bash stops, the guard does not guess.
    "{\ncat <<'EOF'\nnpm publish\nEOF\n",
    "echo 'npm publish' | (bash)",
  ]) blocked(command);
  for (const command of [
    "{ cat <<'EOF'; } > file\ngit push --force\nEOF",
    "( cat <<'EOF' ) > file\ngit push --force\nEOF",
    "{\ncat <<'EOF'\ngit push --force\nEOF\n} > file",
    "{ cat <<'EOF'; } | grep x\nnpm publish\nEOF",
    "{\ncat <<'EOF'\nnpm publish\nEOF\n} | tee x\nbash -n x",
    'f() { echo hi; }',
    'echo $((1<<2))',
    '(( i = 1 << 2 ))',
  ]) allowed(command);
  assert.ok(isBlockedByList(`( (${py} x) )`), 'a subshell in a subshell');
});

test('bash: a command the reader cannot read is refused with exit 2, not let through (#226)', () => {
  // So many commands in one shell string that reading them throws (too many to spread).
  const tooBig = `bash -c "${':;'.repeat(300000)}"`;
  assert.equal(checkCommand(tooBig, { env: {} })?.id, 'unreadable-command');
  const hook = spawnSync(process.execPath, [join(import.meta.dirname, '../..', 'bin', 'yokoten.ts'), 'hook'], {
    cwd: tmpdir(),
    input: JSON.stringify({ cwd: tmpdir(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: tooBig } }),
    encoding: 'utf8',
  });
  assert.equal(hook.status, 2, hook.stderr);
  assert.match(hook.stderr, /yokoten could not read this command/);
  assert.match(hook.stderr, /split it into simpler commands/i);
  // A long command that reads fine still passes.
  allowed(`bash -c "${':;'.repeat(1000)}"`);
});

test('bash: what looked like a case pattern but holds a cut or two words is commands (#226)', () => {
  for (const command of [
    `( 'case' x in; ${force} )`,
    `x=$(\\case a in; ${force})`,
    `case x in a) echo;;\n${force} | x)\nesac`,
    `case x in ${force})`,
    `case x in a && ${force})`,
  ]) blocked(command);
  assert.ok(isBlockedByList(`case x in a b) ${py} x;; esac`), 'two words before ) are no pattern');
  allowed('case x in a|b) echo;; esac');
  allowed('case x in\n  a | b) echo;;\nesac');
});

test('blocked commands: a find inside a find is read once, fast, and a huge list is refused (#226)', () => {
  // Read once, the time grows with the depth, from 18 finds deep to 144.
  const chain = (inner: string, depth: number) => `find . ${'-exec find . '.repeat(depth)}${inner}${'\\; '.repeat(depth + 1)}`;
  assertLinear('a find chain then a force push', (depth) => `${chain('', depth)}&& ${force}`, (command) => blocked(command), 18);
  assertLinear('a find chain that ends in python', (depth) => chain(`-exec ${py} {} `, depth), (command) => assert.ok(isBlockedByList(command), 'the program at the end of the chain'), 18);
  assertLinear('a find chain of echo', (depth) => chain('-exec echo {} ', depth), (command) => assert.equal(isBlockedByList(command), false, 'a chain that runs no blocked program'), 18);
  shouldBlock([`find . -exec nice ${py} {} +`, `find . -exec echo {} \\; -ok ${py} {} \\;`]);
  const many = `find . ${'-exec echo {} \\; '.repeat(300)}`;
  assert.equal(checkCommand(many, { env: {}, config: pythonBlocked })?.id, 'unreadable-command');
  assert.equal(checkCommand(many, { env: {} }), null, 'without a block list, nothing to look for');
});

test('bash: a quoted or escaped case is no keyword, so nothing after it is a pattern (#226)', () => {
  const tagPush = ['git', 'push', '--tags'].join(' ');
  const publish = ['npm', 'publish'].join(' ');
  for (const command of [
    `( 'case' x in; ${force} )`,
    `echo $( 'case' x in; ${tagPush} )`,
    `x=$(\\case a in; ${publish})`,
    `"case" x in ${force})`,
    `case x "in" ${force})`,
    `case x in a) echo;; 'esac' ${force})`,
  ]) blocked(command);
  // Bash runs a program named case here; the words stay a command, none is dropped.
  assert.deepEqual(commandWords("'case' x in a) b"), [['case', 'x', 'in', 'a'], ['b']]);
  // The keyword, unquoted, still has patterns; a quoted pattern is still a pattern.
  shouldPass([`case x in ${py}) echo;; esac`, `case "x" in '${py}') echo;; esac`]);
});

test('bash: a heredoc on exec alone or a bare redirect feeds the shell, so it is commands (#226)', () => {
  for (const command of [
    `exec <<'EOF'; bash\n${force}\nEOF`,
    `exec 0<<'EOF'; sh\n${force}\nEOF`,
    `exec 3<<'EOF'; bash <&3\n${force}\nEOF`,
    `<<'EOF'\n${force}\nEOF`,
    `X=1 <<'EOF'\n${force}\nEOF`,
  ]) blocked(command);
  for (const command of [
    `exec cat <<'EOF'\n${force}\nEOF`,
    `cat 3<<'EOF'\n${force}\nEOF`,
    `while read line; do echo "$line"; done <<'EOF'\n${force}\nEOF`,
  ]) allowed(command);
});

test('bash: a command of 100k words is read in linear time (#226)', () => {
  const commands: [string, (n: number) => string][] = [
    ['echo a', (n) => `echo ${'a '.repeat(n)}`],
    ['then', (n) => `${'then '.repeat(n)}echo`],
    ['env', (n) => `${'env '.repeat(n)}echo`],
    ['sudo', (n) => `${'sudo '.repeat(n)}echo`],
    ['GIT_CONFIG_KEY_0', (n) => `${'GIT_CONFIG_KEY_0=x '.repeat(n)}git status`],
  ];
  for (const [name, make] of commands) {
    assertLinear(`${name} words`, make, (command) => assert.equal(checkCommand(command, { env: {}, config: pythonBlocked }), null, name), 12500);
  }
  blocked(`echo ${'a '.repeat(100000)}; ${force}`);
});

test('bash: the core rules read the string env -S runs, in every spelling (#226)', () => {
  for (const command of [
    `env -iS'${force}'`,
    `env -S '${force}'`,
    `env --split-string='${force}'`,
    `env --split='${force}'`,
    `env -u X -S '${force}'`,
    `env -S 'git push' --force`,
  ]) blocked(command);
  allowed("env -iS'git status' --short");
  allowed('env -S "git status"');
});

// The third review of #226. The reader's work is bounded: each construct is read once, and
// one budget covers every read of a command.
test('bash: an unclosed $( is read once, not again at each level (#226)', () => {
  blocked(`${'echo $(a '.repeat(30)}; ${force}`);
  // From 1250 repeats to 10k, the time grows like the text.
  for (const shape of ['echo $(a ', 'echo "$(a ', 'cat <(a ', '((', 'echo `a ']) {
    assertLinear(`${shape} unclosed`, (n) => `${shape.repeat(n)}; ${force}`, (command) => assert.ok(checkCommand(command, { env: {} }), `${shape} unclosed then a force push should block`), 1250);
  }
  // What an unclosed $( holds is still read: a force push inside it blocks, a read passes.
  blocked(`echo $(${force}`);
  allowed('echo $(git status');
});

test('bash: a heredoc pipeline is read in linear time (#226)', () => {
  // From 1000 heredocs to 8000.
  const pipeline = (reader: string, body: string, n: number) => `${'cat <<E | '.repeat(n)}${reader}\n${`${body}\nE\n`.repeat(n)}`;
  assertLinear('a heredoc pipeline into cat', (n) => pipeline('cat', force, n), (command) => assert.equal(checkCommand(command, { env: {} }), null, 'bodies piped into cat are data'), 1000);
  assertLinear('a heredoc pipeline into bash', (n) => pipeline('bash', force, n), (command) => assert.equal(checkCommand(command, { env: {} })?.id, 'force-push', 'bodies piped into bash are commands'), 1000);
});

test('bash: nested constructs up to 8000 repeats are read in linear time and never throw (#226)', () => {
  const shapes = [
    '$(', '$( ', '<(', '>(', '((', '$((', '"$(', '"`', '`', '`"', "$'\\'", '<<"', "<<'", '{ ', '( ', '${', '"${',
    'case x in ', 'a) ', ';; ', 'bash -c "', "bash -c '", 'eval "', 'env -S"', 'ssh h "', 'sudo -s "', 'x | bash ', '\\\n',
    'cat <<E | ', 'cat <<E\n', '{ cat <<E; } | ', 'find . -exec ', 'git -c alias.x="!', '$(echo "$(', '"$(echo \'',
    // #283: compound commands as groups, substitutions handed to a shell, xargs, env -S ${X}.
    'if a; then ', 'while a; do ', 'done | ', 'fi <<E\n', 'bash <(', 'bash <(a) ', 'source <(a) ', 'eval "$(a)" ', 'eval "$(cat <<E\n',
    'xargs ', 'a | xargs git ', 'xargs git <<E\n', 'env -S"${X}', '<<$\'E\'\n', '{ echo a; ',
    // #308: what a command prints through a pipe, from a substitution or a printf format.
    'cat <(echo a) | bash ', 'echo $(echo a) | ', 'echo "$(echo a)" | xargs git ', "printf '%s\\n' a | xargs git ", "printf '%s%b%d' ", '{ echo a; } | xargs git ',
    // #314: pass-throughs in the middle of a pipeline.
    '| cat ', '| tee f ', 'echo a | cat | ', 'cat <(echo a) | tee f | bash ',
  ];
  const forms: [string, (text: string) => string][] = [
    ['alone', (text) => text],
    ['then a force push', (text) => `${text}\n${force}`],
    ['after a force push', (text) => `${force}; ${text}`],
  ];
  for (const shape of shapes) {
    for (const [form, wrap] of forms) {
      const name = `${JSON.stringify(shape)} ${form}`;
      assertLinear(name, (n) => wrap(shape.repeat(n)), (command) => {
        let result: ReturnType<typeof checkCommand> = null;
        assert.doesNotThrow(() => {
          result = checkCommand(command, { env: {}, config: pythonBlocked });
        }, name);
        if (command.startsWith(force)) assert.ok(result, `${name} should block`);
      }, 1000);
    }
  }
});

test('hooks setting: git must run the hook file as an executable shell script (#226)', () => {
  const cwd = makeHooksRepo();
  const verdict = (folder: string) => checkCommand(`git config core.hooksPath ${folder}`, { env: {}, cwd })?.id ?? 'pass';
  const hook = (folder: string, text: string, mode = 0o755) => {
    mkdirSync(join(cwd, folder), { recursive: true });
    writeHook(join(cwd, folder, 'pre-commit'), text, mode);
  };
  const runs = 'npx yokoten check || exit 1\n';
  try {
    hook('hooks/sh', `#!/bin/sh\n${runs}`);
    hook('hooks/env', `#!/usr/bin/env bash\n${runs}`);
    hook('hooks/zsh', `#!/usr/bin/zsh -e\n${runs}`);
    hook('hooks/none', runs);
    hook('hooks/py', `#!/usr/bin/env ${py}\n${runs}`);
    hook('hooks/node', `#!/usr/bin/env node\n${runs}`);
    mkdirSync(join(cwd, 'hooks', 'dir', 'pre-commit'), { recursive: true });
    // A hook with no #! line git runs with sh.
    for (const folder of ['hooks/sh', 'hooks/env', 'hooks/zsh', 'hooks/none']) assert.equal(verdict(folder), 'pass', folder);
    for (const folder of ['hooks/py', 'hooks/node', 'hooks/dir', 'hooks/missing']) assert.equal(verdict(folder), 'hooks-path', folder);
    if (process.platform !== 'win32') {
      hook('hooks/plainmode', `#!/bin/sh\n${runs}`, 0o644);
      assert.equal(verdict('hooks/plainmode'), 'hooks-path', 'a hook git cannot execute');
      assert.match(checkCommand('git config core.hooksPath hooks/plainmode', { env: {}, cwd })?.what ?? '', /hooks\/plainmode\/pre-commit, which is not executable/);
      // husky: git runs .husky/_/pre-commit, which must be there and executable.
      assert.equal(verdict('.husky/_'), 'pass');
      chmodSync(join(cwd, '.husky', '_', 'pre-commit'), 0o644);
      assert.equal(verdict('.husky/_'), 'hooks-path', 'husky\'s own hook is not executable');
    }
    rmSync(join(cwd, '.husky', '_', 'pre-commit'));
    assert.equal(verdict('.husky/_'), 'hooks-path', 'husky\'s own hook is missing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hooks setting: the script is read as the shell reads it, across lines (#226)', () => {
  const check = 'npx yokoten check';
  for (const script of [
    `true ||\n${check}\n`,
    `echo x |\n${check}\n`,
    `true \\\n${check}\n`,
    `echo "\n${check}\n"\n`,
    `: '\n${check}\n'\n`,
    `${check} --issue\n`,
    `${check} --pr\n`,
    `${check} --staged --pr\n`,
    `return 0\n${check}\n`,
    `npm test || return 0\n${check}\n`,
    `set -e\nset +e\n${check}\nnpm test\n`,
    `set -e\nnpm test; set +e\n${check}\nnpm test\n`,
  ]) assert.equal(runsCheck(script), false, script);
  for (const script of [
    `true\n${check}\n`,
    `echo x | cat\n${check}\n`,
    `npm \\\n  test\n${check}\n`,
    `echo "a\nb"\n${check}\n`,
    `${check} --staged --json\n`,
    `npm test || exit 1\n${check}\n`,
    `true &&\n${check} || exit 1\nnpm test\n`,
    `set -e\n${check}\nnpm test\n`,
    `set -e\nset +x\n${check}\nnpm test\n`,
  ]) assert.equal(runsCheck(script), true, script);
});

test('hooks setting: the check line in every runner yokoten knows, and only yokoten (#226)', () => {
  for (const script of [
    'pnpm exec yokoten check\n',
    'yarn yokoten check --staged\n',
    'bunx yokoten check || exit 1\nnpm test\n',
    'npx --no -- yokoten check || exit 1\nnpm test\n',
    'npx --no-install yokoten check || exit 1\nnpm test\n',
    'npx yokoten check || exit $?\nnpm test\n',
    'npx lint-staged && npx yokoten check\n',
    'npx lint-staged && npx yokoten check || exit 1\nnpm test\n',
    'npx yokoten check # the commit check\n',
    'npx yokoten check || exit 1 # the commit check\nnpm test\n',
    'npx yokoten check;\n',
    'node ./node_modules/.bin/yokoten check || exit 1\nnpm test\n',
    'exec node ".yokoten/bin/yokoten.ts" check --staged\nnpm test\n',
  ]) assert.equal(runsCheck(script), true, script);
  for (const script of [
    './fake-yokoten check\n',
    'node ./fake-yokoten check\n',
    'node "evil/yokoten.ts" check\n',
    'npx yokoten check#x\n',
    'npx lint-staged && npx yokoten check\nnpm test\n',
    'exit 0 && npx yokoten check || exit 1\n',
    'set -e\nnpx lint-staged && npx yokoten check\nnpm test\n',
    `[ -f ./fake ] || { echo 'm' >&2; exit 1; }; node ./fake check || exit 1\nnpm test\n`,
  ]) assert.equal(runsCheck(script), false, script);
});

test('bash: env -S reads its own escapes before it splits the string (#226)', () => {
  const spaced = (escape: string) => ['env ', "-S'git", `${escape}push`, `${escape}--for` + 'ce', `${escape}origin`, `${escape}main'`].join('');
  for (const escape of ['\\_', '\\t', '\\n', '\\v', '\\f', '\\r']) blocked(spaced(escape));
  blocked(['env ', "--split-string='git", '\\_push', "\\_--for" + "ce'"].join(''));
  allowed(['env ', "-S'git", '\\_status', '\\cgit push --for' + "ce'"].join(''));
  allowed(['env ', "-S'git", "\\_status'"].join(''));
  shouldBlock([['env ', `-S'${py}`, "\\_x'"].join('')]);
});

test('bash: a heredoc right after a group or subshell is the group\'s input (#226)', () => {
  for (const command of [
    `{ read -r a; } <<'EOF'\n${force}\nEOF`,
    `( read -r a ) <<'EOF'\n${force}\nEOF`,
    `{\n  read -r a\n  read -r b\n} <<'EOF'\n${force}\nEOF`,
    `{ cat; } <<'EOF' > out\n${force}\nEOF`,
  ]) allowed(command);
  for (const command of [
    `{ bash; } <<'EOF'\n${force}\nEOF`,
    `( read -r a; sh ) <<'EOF'\n${force}\nEOF`,
    `{\n  bash\n} <<'EOF'\n${force}\nEOF`,
    `{ cat; } <<'EOF' | bash\n${force}\nEOF`,
  ]) blocked(command);
});

test('bash: source or . of stdin or a file descriptor runs its input (#226)', () => {
  for (const command of [
    `source /dev/stdin <<'EOF'\n${force}\nEOF`,
    `. /dev/stdin <<'EOF'\n${force}\nEOF`,
    `. /dev/fd/3 3<<'EOF'\n${force}\nEOF`,
    `echo '${force}' | source /dev/stdin`,
    `echo '${force}' | . /proc/self/fd/0`,
  ]) blocked(command);
  allowed(`source ./env.sh <<'EOF'\n${force}\nEOF`);
  allowed(`echo '${force}' | . ./x.sh`);
});

test('hooks setting: env -C, env --chdir, builtin cd and GIT_COMMON_DIR move repo (#226)', () => {
  const cwd = makeHooksRepo();
  const set = ['git config core', 'hooksPath .husky/_'].join('.');
  const stop = (command: string) => assert.equal(checkCommand(command, { env: {}, cwd })?.id, 'hooks-path', `should block: ${command}`);
  const pass = (command: string) => assert.equal(checkCommand(command, { env: {}, cwd }), null, `should allow: ${command}`);
  try {
    for (const prefix of ['env -C /tmp ', 'env -iC /tmp ', 'env --chdir=/tmp ', 'env --ch /tmp ', 'builtin cd /tmp && ', 'GIT_COMMON_DIR=/tmp/other/.git ']) stop(prefix + set);
    for (const prefix of ['env -i ', 'env -u X ', 'builtin echo x && ']) pass(prefix + set);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The fourth review of #226. Each shape runs in its own node, which a slow read cannot hold
// up for long. There each is read at n and 8n repeats, 32k or 100k, and its time must grow
// like the text (#316). A case goes in on stdin: its parts, a part in brackets repeated n times.
test('bash and hooks: loops that never spent the budget read 32k to 100k repeats in linear time (#226)', () => {
  const guards = join(import.meta.dirname, '../..', 'src', 'rules', 'guards.ts');
  const linear = join(import.meta.dirname, '../..', 'scripts', 'linear.ts');
  type Part = string | [string];
  const run = (mode: 'command' | 'hook', parts: Part[], want: string, repeats = 4096) => {
    // The code is fixed text: every value goes in on stdin, so nothing is spliced into code.
    const code = [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "const { guards, linear, mode, config, cwd, parts, want, repeats } = JSON.parse(readFileSync(0, 'utf8'));",
      'const { checkCommand, runsCheck } = await import(guards);',
      'const { assertLinear } = await import(linear);',
      "const make = (n) => parts.map((part) => (typeof part === 'string' ? part : part[0].repeat(n))).join('');",
      "const read = (text) => (mode === 'hook' ? String(runsCheck(text)) : (checkCommand(text, { env: {}, config, cwd })?.id ?? 'allow'));",
      // What the text at 8n gives is what the case proves; a smaller one may still be read in full.
      'const big = make(8 * repeats).length;',
      'assertLinear(JSON.stringify(parts).slice(0, 60), make, (text) => {',
      '  const found = read(text);',
      '  if (text.length === big) assert.equal(found, want);',
      '}, repeats);',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', code], { input: JSON.stringify({ guards: pathToFileURL(guards).href, linear: pathToFileURL(linear).href, mode, config: pythonBlocked, cwd: tmpdir(), parts, want, repeats }), encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 0, `${JSON.stringify(parts).slice(0, 60)}... failed: ${child.signal ?? child.error ?? child.stderr.slice(0, 600)}`);
  };
  const keys: Part = ['GIT_CONFIG_KEY_0=core.hooksPath '];
  const commands: [Part[], string, number?][] = [
    [[['-/env ']], 'allow'],
    [[`${force}; `, ['-/env ']], 'force-push'],
    [['find . ', ['-exec env ']], 'allow'],
    [[`${force}; find . `, ['-exec env ']], 'force-push'],
    [['find . ', ['-exec env -u ']], 'allow'],
    [['find . ', ['-exec timeout ']], 'allow'],
    [['find . ', ['-exec > ']], 'allow'],
    [[keys, 'GIT_CONFIG_VALUE_0=.githooks git status'], 'allow'],
    [[keys, 'GIT_CONFIG_VALUE_0=/x git status'], 'hooks-path'],
    // #283: each new reader.
    [[['{ echo a; '], ['} '], '| bash'], 'allow'],
    [[['if a; then echo a; '], ['fi; ']], 'allow'],
    [[['for a in b; do '], 'echo a', ['; done'], ' | cat'], 'allow'],
    // What 100k substitutions print, handed to a shell, is too many commands to read: refused, in time.
    [['bash ', ['<(echo a) ']], 'unreadable-command', 12500],
    [['eval "', ['$(echo a)'], '"'], 'unreadable-command', 12500],
    [['echo a | xargs ', ['-0 '], 'git status'], 'allow'],
    [["env -S'git status ", ['${X}'], "'"], 'allow'],
    // #308: a printf format said again for each argument, and substitutions printed into a pipe.
    [["printf '%s\\n' status ", ['a '], '| xargs git'], 'allow'],
    [["printf '", ['x'], "%s' status ", ['a '], '| xargs git'], 'allow'],
    [["printf '", ['%s'], "\\n' git status | bash"], 'allow'],
    [['cat ', ['<(echo a) '], '| bash'], 'unreadable-command', 12500],
    [['echo "', ['$(echo a)'], '" | xargs git status'], 'allow'],
    // #314: a long chain of pass-throughs hands the first command's text to the shell.
    [['echo a ', ['| cat '], '| bash'], 'allow'],
    [[`echo '${force}' `, ['| cat '], '| bash'], 'force-push'],
    [[`cat <(echo '${force}') `, ['| tee f '], '| bash'], 'force-push'],
  ];
  for (const [parts, want, repeats] of commands) run('command', parts, want, repeats);
  // A line that opens more than it closes leaves the check inside a block; a pipe at the end
  // of each line joins the check to the pipeline.
  for (const open of ['$((((', '$(', '${']) run('hook', ['#!/bin/sh\n', [open], '\nnpx yokoten check\n'], 'false');
  run('hook', ['#!/bin/sh\n', ['a |\n'], 'npx yokoten check\n'], 'false');
  // The linear reads keep what the old ones found: a closed $( and quotes cut no block.
  for (const line of ['x="(" y=\'{\' z=${a:-x} w=$(echo a) v=$((1 + (2)))', 'echo "a\\"(" \'"\'']) {
    assert.equal(runsCheck(`#!/bin/sh\n${line}\nnpx yokoten check\n`), true, line);
  }
  assert.equal(runsCheck('#!/bin/sh\necho "(" (\nnpx yokoten check\n'), false, 'a ( outside the quotes');
});

test('hooks setting: the check line yokoten init writes, with 2>/dev/null after the ], counts (#226)', () => {
  // As `commitCheckLine` and `handOffLines` in yokoten init write them (#256, #263).
  const cli = '.yokoten/bin/yokoten.ts';
  const check = `[ -f "${cli}" ] 2>/dev/null || { echo 'yokoten: the commit check cannot run, because ${cli} is missing. Restore it from git, or run yokoten init again' >&2; exit 1; }; node "${cli}" check --staged || exit 1`;
  const handOff = [
    '# yokoten: then the pre-commit this clone has in .git/hooks, as git ran it before core.hooksPath was set (#256)',
    'yokoten_old="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/pre-commit"; if [ -x "$yokoten_old" ] && ! [ "$yokoten_old" -ef "$0" ]; then "$yokoten_old" "$@" || exit $?; fi',
  ];
  assert.equal(runsCheck(['#!/bin/sh', check, ...handOff, ''].join('\n')), true);
  assert.equal(runsCheck(['#!/bin/sh', check, ...handOff, 'npm test', ''].join('\n')), true);
  assert.equal(runsCheck(['#!/bin/sh', check.replace(' 2>/dev/null', ' 2>/tmp/x'), ''].join('\n')), false, 'only 2>/dev/null');
});

test('hooks setting: with .husky/_, git runs husky\'s own hook, which runs .husky/pre-commit with sh -e (#226)', () => {
  const cwd = makeHooksRepo();
  const verdict = () => checkCommand(setHooks('.husky/_'), { env: {}, cwd })?.id ?? 'pass';
  const write = (path: string, text: string, mode = 0o755) => writeHook(join(cwd, '.husky', path), text, mode);
  try {
    // sh -e stops at a failed check, so the check need not be last or end in || exit.
    write('pre-commit', 'npx yokoten check\nnpm test\n', 0o644);
    assert.equal(verdict(), 'pass', 'husky runs .husky/pre-commit with sh -e');
    write('_/pre-commit', '#!/usr/bin/env sh\n. "${0%/*}/h"');
    assert.equal(verdict(), 'pass', 'husky 9.0\'s own hook');
    write('_/pre-commit', '#!/bin/sh\nexit 0\n');
    assert.equal(verdict(), 'hooks-path', 'a .husky/_/pre-commit that runs nothing');
    write('_/pre-commit', `${HUSKY_HOOK}\nexit 0\n`);
    assert.equal(verdict(), 'hooks-path', 'husky\'s hook with more after it');
    write('_/pre-commit', HUSKY_HOOK);
    write('_/h', HUSKY_H.replace('sh -e "$s" "$@"', 'exit 0'), 0o644);
    assert.equal(verdict(), 'hooks-path', 'an h that does not run .husky/pre-commit');
    write('_/h', HUSKY_H.replace('sh -e', 'sh'), 0o644);
    assert.equal(verdict(), 'hooks-path', 'an h that runs it without -e');
    rmSync(join(cwd, '.husky', '_', 'h'));
    assert.match(checkCommand(setHooks('.husky/_'), { env: {}, cwd })?.what ?? '', /\.husky\/_\/h is missing/);
    write('_/h', `# a comment\n\n${HUSKY_H.replaceAll('\n', '\r\n')}`, 0o644);
    assert.equal(verdict(), 'pass', 'husky\'s h, with CRLF and a comment');
    // .husky itself (husky 8) runs .husky/pre-commit as it is: no sh -e.
    assert.equal(checkCommand(setHooks('.husky'), { env: {}, cwd })?.id, 'hooks-path');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hooks setting: a hook with no #! line, or #!/usr/bin/env -S bash, runs as a shell script (#226)', () => {
  const cwd = makeHooksRepo();
  const verdict = (folder: string) => checkCommand(setHooks(folder), { env: {}, cwd })?.id ?? 'pass';
  const hook = (folder: string, text: string) => {
    mkdirSync(join(cwd, folder), { recursive: true });
    writeHook(join(cwd, folder, 'pre-commit'), text);
  };
  try {
    hook('hooks/bare', 'npx yokoten check || exit 1\n');
    hook('hooks/envs', '#!/usr/bin/env -S bash -e\nnpx yokoten check || exit 1\n');
    hook('hooks/envs-node', '#!/usr/bin/env -S node\nnpx yokoten check || exit 1\n');
    hook('hooks/bare-plain', 'npm test\n');
    assert.equal(verdict('hooks/bare'), 'pass');
    assert.equal(verdict('hooks/envs'), 'pass');
    assert.equal(verdict('hooks/envs-node'), 'hooks-path');
    assert.equal(verdict('hooks/bare-plain'), 'hooks-path');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('bash: source -- /dev/stdin, //dev/stdin and /proc/<pid>/fd/0 run their input (#226)', () => {
  for (const command of [
    `source -- /dev/stdin <<'EOF'\n${force}\nEOF`,
    `. //dev/stdin <<'EOF'\n${force}\nEOF`,
    `. /dev//fd/0 <<'EOF'\n${force}\nEOF`,
    `. /proc/$$/fd/0 <<'EOF'\n${force}\nEOF`,
    `echo '${force}' | source /proc/123/fd/0`,
  ]) blocked(command);
  allowed(`source -- ./env.sh <<'EOF'\n${force}\nEOF`);
  allowed(`. /proc/self/status <<'EOF'\n${force}\nEOF`);
});

test('hooks setting: sudo -D and sudo --chdir move repo, like env -C (#226)', () => {
  const cwd = makeHooksRepo();
  const set = setHooks('.husky/_');
  try {
    for (const prefix of ['sudo -D /tmp ', 'sudo -nD /tmp ', 'sudo -D/tmp ', 'sudo --chdir=/tmp ', 'sudo --chdir /tmp ', 'sudo -u root -D /tmp ']) {
      assert.equal(checkCommand(prefix + set, { env: {}, cwd })?.id, 'hooks-path', `should block: ${prefix}`);
    }
    for (const prefix of ['sudo ', 'sudo -n ', 'sudo -u root ']) assert.equal(checkCommand(prefix + set, { env: {}, cwd }), null, `should allow: ${prefix}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hooks setting: one command asks git each question once, however often it sets the folder (#226)', { skip: process.platform === 'win32' }, () => {
  const cwd = makeHooksRepo();
  const bin = makeTempDir('yokoten-git-');
  const log = join(bin, 'log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeHook(join(bin, 'git'), `#!/bin/sh\necho x >> "${log}"\nexec "${real}" "$@"\n`);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    assert.equal(checkCommand(`${setHooks('.husky/_')}; `.repeat(50), { env: {}, cwd }), null);
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(calls, 2, 'rev-parse --show-toplevel and config --get, once each');
  } finally {
    process.env.PATH = path;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('bash: a heredoc ends where bash ends it: at EOF for <<$\'EOF\', and not at EOF\\r (#283)', () => {
  refusedAs(`cat <<$'EOF'\nx\nEOF\n${force}\n$EOF`, 'force-push');
  refusedAs(`cat <<$"EOF"\nx\nEOF\n${force}\n$EOF`, 'force-push');
  refusedAs(`cat <<'EOF'\nEOF\r\ncat <<'X'\nEOF\n${force}\nX`, 'force-push');
  // `<<EOF\r` (a CRLF line): the word is EOF\r, the body ends at EOF\r, and the next line runs.
  refusedAs(`cat <<'EOF'\r\nx\r\nEOF\r\n${force}\r\n`, 'force-push');
  refusedAs(`cat <<EOF\r\nx\r\nEOF\r\n${force}\r\n`, 'force-push');
  // Look-alikes: the push is in the body, which cat prints.
  allowed(`cat <<$'EOF'\n${force}\nEOF`);
  allowed(`cat <<'EOF'\n${force}\r\nEOF`);
  allowed(`cat <<'EOF'\r\n${force}\r\nEOF\r\n`);
  // Only the word itself ends a body: a space before it does not, nor spaces after <<-.
  allowed(`cat << 'A'\nx\n A\n${force}\nA`);
  allowed(`cat <<-A\nx\n  A\n${force}\nA`);
});

test('bash: what a substitution prints, handed to a shell, is commands (#283)', () => {
  for (const command of [
    `bash <(echo '${force}')`,
    `source <(echo '${force}')`,
    `. <(printf '%s\\n' '${force}')`,
    `bash <(cat <<'EOF'\n${force}\nEOF\n)`,
    `bash -c "$(cat <<'EOF'\n${force}\nEOF\n)"`,
    `eval "$(cat <<'EOF'\n${force}\nEOF\n)"`,
    `eval "$(echo '${force}')"`,
    `eval \`echo '${force}'\``,
    `sh -c "$(printf '%s' '${force}')"`,
  ]) refusedAs(command, 'force-push');
  for (const command of [
    'bash <(echo ls)',
    `cat <(echo '${force}')`,
    `diff <(echo '${force}') <(echo x)`,
    `bash <(cat <<'EOF'\nls\nEOF\n)`,
    `git commit -m "$(cat <<'EOF'\nfix: say why ${force} is refused\nEOF\n)"`,
    `echo "$(echo '${force}')"`,
  ]) allowed(command);
});

test('bash: a compound command piped to a shell is read like a group (#283)', () => {
  for (const command of [
    `if true; then cat <<'E'\n${force}\nE\nfi | bash`,
    `for i in 1; do cat <<'E'\n${force}\nE\ndone | bash`,
    `while true; do echo '${force}'; break; done | sh`,
    `until false; do echo '${force}'; done | bash`,
    `case a in a) echo '${force}';; esac | bash`,
    `{ echo '${force}'; } | bash`,
    `( echo '${force}' ) | bash`,
    `if true; then { echo '${force}'; }; fi | bash`,
  ]) refusedAs(command, 'force-push');
  for (const command of [
    `if true; then cat <<'E'\n${force}\nE\nfi | cat`,
    `for i in 1; do echo '${force}'; done`,
    `{ echo '${force}'; } | tee out`,
    'if true; then echo ls; fi | bash',
    `if true; then echo x; fi\necho '${force}' | cat`,
  ]) allowed(command);
});

test('bash: a loop fed by a heredoc that runs each line reads it as commands (#283)', () => {
  refusedAs(`while read l; do eval "$l"; done <<'E'\n${force}\nE`, 'force-push');
  refusedAs(`while read -r l; do $l; done <<'E'\n${force}\nE`, 'force-push');
  refusedAs(`while read -r l; do "$l"; done <<'E'\n${force}\nE`, 'force-push');
  allowed(`while read -r l; do echo "$l"; done <<'E'\n${force}\nE`);
  allowed(`while read -r l; do printf '%s\\n' "$l"; done <<'E'\n${force}\nE`);
});

test('bash: xargs hands what comes in to its program (#283)', () => {
  const pushForce = force.split(' ').slice(1).join(' ');
  refusedAs(`xargs -0 git <<'E'\n${pushForce}\nE`, 'force-push');
  refusedAs(`echo ${pushForce} | xargs git`, 'force-push');
  refusedAs(`echo ${pushForce} | xargs -n 9 -P 2 git`, 'force-push');
  allowed(`xargs git add <<'E'\na.ts\nE`);
  allowed('echo a.ts | xargs git add');
  allowed(`echo ${pushForce} | xargs echo`);
});

test('bash: what a command prints through a pipe reaches the shell or xargs git (#308)', () => {
  const pushForce = force.split(' ').slice(1).join(' ');
  const [, push, option] = force.split(' ');
  for (const command of [
    `cat <(echo '${force}') | bash`,
    `cat <(echo '${force} origin main') | sh`,
    `echo $(echo '${force}') | bash`,
    `echo "$(echo '${force}')" | bash`,
    `cat <(echo '${force}') | source /dev/stdin`,
    `printf '%s\\n' ${push} ${option} | xargs git`,
    `printf '%s\\n' ${push} origin ${option} | xargs git`,
    `printf '%s %s\\n' ${push} ${option} origin main | xargs -n 9 git`,
    `printf 'git %s\\n' '${pushForce}' | bash`,
    `printf '%b' 'echo x\\n${force}' | bash`,
    `printf '%d\\n' ${push} ${option} | xargs git`,
    `echo "$(echo ${pushForce})" | xargs git`,
    `{ echo ${pushForce}; } | xargs git`,
  ]) refusedAs(command, 'force-push');
  for (const command of [
    `printf '%s\\n' ${push} --tags | xargs git`,
    `printf '%s\\n' ${push} origin --tags | xargs git`,
    `printf '%s\\n' ${push} origin v1.2.0 | xargs git`,
    `cat <(echo 'git ${push} --tags') | bash`,
  ]) refusedAs(command, 'release');
  for (const command of [
    'cat <(echo ls) | grep x',
    "printf '%s\\n' a b | sort",
    "printf '%s\\n' a.ts | xargs git add",
    `cat <(echo '${force}') | cat`,
    `echo $(echo '${force}') | tee out`,
    `printf '%s\\n' '${force}' | grep x`,
    'cat <(echo ls) | bash',
  ]) allowed(command);
});

test('bash: cat and tee in the middle of a pipeline hand on what came before (#314)', () => {
  const pushForce = force.split(' ').slice(1).join(' ');
  const tags = `${force.split(' ').slice(0, 2).join(' ')} --tags`;
  for (const [command, id] of [
    [`cat <(echo '${force}') | tee f | bash`, 'force-push'],
    [`echo '${force}' | cat | bash`, 'force-push'],
    [`echo '${force}' | cat - | tee a b | cat -u | sh`, 'force-push'],
    [`echo ${pushForce} | tee f | xargs git`, 'force-push'],
    [`cat <(echo '${tags}') | tee f | bash`, 'release'],
    [`echo '${tags}' | cat | bash`, 'release'],
  ]) refusedAs(command, id);
  for (const command of [
    'echo ls | tee f | grep x',
    `echo '${force}' | tee f | grep x`,
    // cat with a file prints the file, not what comes in.
    `echo '${force}' | cat notes.txt | bash`,
    'echo ls | cat | bash',
  ]) allowed(command);
});

test('bash: env -S puts a variable\'s value in place of ${NAME}, which the guard reads as empty (#283)', () => {
  const [git, push, option] = force.split(' ');
  refusedAs(`env -S"${git} ${push} ${option.slice(0, 5)}\${X}${option.slice(5)} origin main"`, 'force-push');
  refusedAs(`env -S'${git} ${push} ${option.slice(0, 5)}\${X}${option.slice(5)}'`, 'force-push');
  allowed('env -S\'git status ${X}\'');
});

// ---- Commands that print account details (#390) ----

test('printsAccount: one plain read from the table is caught (#390)', () => {
  const caught = [
    'git log -3', 'git show HEAD', 'git blame README.md', 'git shortlog -sn HEAD', 'git whatchanged', '/usr/bin/git log',
    'git remote -v', 'git remote get-url origin', 'git remote show origin', 'git config --list', 'git config --global --get user.email', 'git config get remote.origin.url',
    'gh api user', 'gh api repos/o/r/traffic/views --jq .count', 'gh api -X GET users/someone', 'gh api --method=GET user --paginate', 'gh auth status', 'gh auth status --hostname github.com',
    'npm whoami', 'npm whoami --registry https://registry.npmjs.org', 'wrangler whoami', 'npx wrangler whoami', 'pnpm dlx wrangler@3 whoami',
    // Any format: the author can print with no "Author:" line (#413).
    'git log --format=%an', 'git log --pretty=format:%ae', 'git log --oneline', 'git show --pretty=format:%s', 'git log --format=%H -1',
    "git log --format='%an <%ae>'", 'git log --format="%cn <%ce>" -3', 'git shortlog -sne HEAD', 'git shortlog -s -n -e main', 'git blame -e README.md',
    "git for-each-ref --format='%(authorname) %(refname)'", 'git for-each-ref refs/tags', 'git cat-file -p HEAD', 'git cat-file commit HEAD', 'git cat-file tag v1',
    // A quote inside the other kind is plain text.
    `git log '"'`, `git log "'"`, "git log -- '*.md'",
    // A shortlog with a revision; an option's value comes first.
    'git shortlog --group=author HEAD', 'git shortlog --group author HEAD', 'git shortlog -s HEAD -- docs',
  ];
  for (const command of caught) assert.ok(printsAccount(command), `not caught: ${command}`);
  assert.equal(printsAccount('git log -1'), '`git log` prints author names and emails');
  assert.equal(printsAccount('git remote show origin'), '`git remote` prints remote URLs');
});

test('printsAccount: anything more than one plain read is left to the normal flow (#390)', () => {
  const left = [
    // More than one command, or shell around it.
    'cd x && git log', 'git log; ls', 'git log | head', 'git log > out', 'git log 2>/dev/null', 'git log &', 'git log $(echo x)', 'git log `x`', '(git log)', '{ git log; }', 'git log # note', 'git log\ngit push',
    // A prefix or a launcher.
    'FOO=1 git log', 'sudo git log', 'env git log', 'nice git log', 'bash -c "git log"', 'npx --yes wrangler whoami',
    // Options that write a file, run a program, or pick another git.
    'git -c a=b log', 'git -C x log', 'git log --output=x', 'git log -o x', 'git log --ext-diff', 'git show --textconv x', 'git log --exec-path=/x',
    // A subcommand only by name further on.
    'git remote add show x', 'git remote rename get-url x', 'git remote',
    // A write, or something sent.
    'git config user.email x', 'git config --get core.hooksPath', 'git push', 'git fetch', 'git pull', 'git clone x', 'git ls-remote', 'wrangler deploy', 'wrangler login', 'npx wrangler pages deploy',
    'gh api -X PATCH user -f name=x', 'gh api user -f bio=x', 'gh api --method=POST user/emails', 'gh api repos/o/r', 'gh auth status --show-token', 'gh auth token',
    // Not in the table any more: they print secrets, not only the owner.
    'env', 'printenv', 'printenv HOME',
    // A format in a compound command, or quoted text bash still reads (#413).
    "git log --format='%an'; ls", 'git log --format=%an | head', 'git log --format="$(id)"', 'git log --format="`id`"', "git log \\'x;ls'", "git log 'a'\\';ls'", 'git log --format=%an > out', "git log '%an' && git push",
    // A quote the plain-text search can't match to bash's own reading: it could hide a redirect (#413).
    `git log --format="%an %ae'$x" > out.txt --invert-grep --grep='"'`, `git log "'$x" >> ~/.bashrc '"'`, `git log 'x`, `git log "x`, `git log "a\\"b"`,
    // A word that reads as a redirect, even quoted.
    `git log '>' out`, `git log '2>&1'`, `git log '&>' x`,
    // A glob: a file named `--output=x` would become an option (#413).
    'git log *', 'git log -- *.md', 'git show HEAD?', 'git log [a]', 'git blame *',
    // A shortlog with no revision reads stdin: an option's value or a path after -- is none.
    'git shortlog -sne', 'git shortlog -sn', 'git shortlog -s --group author', 'git shortlog --format %an', 'git shortlog -w 20', 'git shortlog -s -- HEAD',
    // The subcommand quoted: the rewrite can't place its options.
    '"git" log -1', "git 'log' -1",
    // A cat-file that is not one object printed: a batch reads stdin, a filter runs a program.
    'git cat-file --batch', 'git cat-file -p', 'git cat-file --filters HEAD:x', 'git cat-file -t HEAD', 'git cat-file -p HEAD extra',
    'git status', 'echo git log',
  ];
  for (const command of left) assert.equal(printsAccount(command), null, command);
});

test('hardenRead: a log, show or blame runs no textconv or external diff; other reads stay as they are (#413)', () => {
  assert.equal(hardenRead('git log -1'), 'git log --no-ext-diff --no-textconv -1');
  assert.equal(hardenRead('git show'), 'git show --no-ext-diff --no-textconv');
  assert.equal(hardenRead('/usr/bin/git whatchanged -p'), '/usr/bin/git whatchanged --no-ext-diff --no-textconv -p');
  assert.equal(hardenRead('git blame -e README.md'), 'git blame --no-textconv -e README.md');
  for (const command of ['git shortlog -sn HEAD', 'git cat-file -p HEAD', 'git remote -v', 'npm whoami', 'git status']) assert.equal(hardenRead(command), command);
});

test('isRedacted: the wrapper\'s own first line and the call; a comment that names them is not enough (#390)', () => {
  const wrapped = wrapForRedact('git log', '"node" "$HOME/y/bin/yokoten.ts" redact');
  assert.equal(isRedacted(wrapped), true);
  assert.equal(printsAccount(wrapped), null);
  assert.equal(isRedacted('git log # yokoten-redact yokoten redact'), false);
  assert.equal(isRedacted(`echo hi\n${wrapped}`), false);
  assert.equal(isRedacted(wrapped.replace('yokoten.ts" redact', 'other.ts" redact')), false);
  assert.equal(wrapped, 'set -o pipefail # yokoten-redact\n(\ngit log\n) 2>&1 | { "node" "$HOME/y/bin/yokoten.ts" redact || cat; }');
});

test('wrapForRedact: keeps the exit code; a redact that fails passes the output through; a heredoc still ends (#390)', () => {
  const run = (command: string, redact = 'tr a-z A-Z') => spawnSync('bash', ['-c', wrapForRedact(command, redact)], { encoding: 'utf8' });
  assert.deepEqual([run('echo hi; exit 3').status, run('echo hi; exit 3').stdout], [3, 'HI\n']);
  assert.deepEqual([run('echo out; echo err >&2').status, run('echo out; echo err >&2').stdout], [0, 'OUT\nERR\n']);
  assert.equal(run('cat <<EOF\nbody\nEOF').stdout, 'BODY\n');
  // redact missing or failing: the command still runs, and its output and exit code come through.
  const broken = run('echo plain; exit 4', '"/nonexistent/node" "/nonexistent/yokoten.ts" redact');
  assert.deepEqual([broken.status, broken.stdout], [4, 'plain\n']);
  assert.ok(broken.stderr.split('\n').filter(Boolean).length <= 1, broken.stderr);
});
