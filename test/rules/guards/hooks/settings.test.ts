import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { makeTempDir, blocked, allowed, makeHooksRepo, setHooks } from '../../../../test/repo/helpers.ts';

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
  const edit = checkCommand('git config --edit', { cwd: process.cwd(), env: {} });
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

// #591: `NAME+=value` is a setting too, for the lead and a worker alike.

test('hooks setting: GIT_CONFIG_* += cannot skip the check, for lead and worker (#591)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const command of [
    "GIT_CONFIG_PARAMETERS+=\"'core.hooksPath=x'\" git commit -m x",
    "GIT_CONFIG_PARAMETERS+=\" 'include.path=x'\" git commit -m x",
    'GIT_CONFIG_COUNT+=1 GIT_CONFIG_KEY_0+=core.hooksPath GIT_CONFIG_VALUE_0+=/x git commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0+=Path GIT_CONFIG_VALUE_0=/x git commit -m x',
    'GIT_CONFIG_COUNT+=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0+=.githooks git commit -m x',
    'export GIT_CONFIG_COUNT+=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x; git commit -m x',
  ]) {
    assert.match(checkCommand(command, { env: {}, cwd: process.cwd() })?.id ?? "", /^(hooks-path|include)/, command);
    assert.ok(checkCommand(command, { env: worker, cwd: process.cwd() }), `a worker too: ${command}`);
  }
  allowed('git -c user.name=x log -1');
  allowed('git log --oneline');
});

// #361: git's config and hooks files, written by the shell, and the config variables.

test('hooks setting: a shell write to .git/config, .git/hooks or .githooks is refused, a read passes (#361)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  const outside = makeTempDir('yokoten-other-repo-');
  for (const command of [
    'cp /tmp/x .git/config',
    'cp /tmp/x ./.git//config',
    'mv /tmp/x .git/config',
    'echo x | tee .git/config',
    'echo x | tee -a .git/config',
    "printf '[core]\\n\\thooksPath = /dev/null\\n' >> .git/config",
    'echo x > .git/config',
    'sed -i s/githooks/x/ .git/config',
    'sed -i.bak -e s/githooks/x/ .git/config',
    'truncate -s 0 .git/config',
    'echo x >> .git/config.worktree',
    'echo x >> .git/worktrees/w/config.worktree',
    'echo /tmp/other > .git/commondir',
    'echo "gitdir: /tmp/other" > .git',
    'echo x > .GIT/CONFIG',
    'cd .git && echo x >> config',
    'cd .git && sed -i s/a/b/ config',
    'rm .githooks/pre-commit',
    'rm -rf .githooks',
    'chmod -x .githooks/pre-commit',
    'chmod 000 .githooks',
    'touch .githooks/pre-commit',
    'echo > .githooks/pre-commit',
    'echo exit 0 >> .githooks/pre-commit',
    'cp /tmp/x .githooks/pre-commit',
    'mv /tmp/x .githooks',
    'install -m 755 /tmp/x .githooks/pre-commit',
    'ln -sf /dev/null .githooks/pre-commit',
    'truncate -s 0 .githooks/pre-commit',
    'git rm .githooks/pre-commit',
    'echo x > .git/hooks/pre-commit',
    'ln -sf /dev/null .git/hooks/pre-commit',
    'chmod -x .git/hooks/pre-commit',
    'bash -c "echo x >> .git/config"',
    'cd src && cp /tmp/x ../.githooks/pre-commit',
    // A glob that could match the files (#361 review).
    'echo x >> .git/conf*',
    'echo x >> .git/confi?',
    'sed -i s/a/b/ .git/c?nfig',
    'cp /tmp/x .git/conf[i]g',
    'sed -i s/a/b/ .git/{config,}',
    'chmod -x .githook?/pre-commit',
    'rm -f .githoo*/pre-commit',
    'chmod -x .githooks/*',
    'chmod -x {.githooks,x}/pre-commit',
    // Editors, patchers, archives and find (#361 review).
    'patch .githooks/pre-commit < x.diff',
    'patch -o .git/config a b',
    'awk -i inplace 1 .githooks/pre-commit',
    'gawk -i inplace "{print}" .git/config',
    'ed -s .githooks/pre-commit',
    'ex .git/config',
    'vim -c "%d|wq" .githooks/pre-commit',
    'vi .git/config',
    'nvim .githooks/pre-commit',
    'tar xf /tmp/x.tar -C .git',
    'tar -xzf /tmp/x.tgz --directory=.githooks',
    'unzip -o /tmp/x.zip -d .githooks',
    'find .githooks -exec rm {} +',
    'find .githooks -delete',
  ]) {
    assert.equal(checkCommand(command, { env: {}, cwd: process.cwd() })?.id, 'hooks-path', `the lead: ${command}`);
    assert.ok(checkCommand(command, { env: worker, cwd: process.cwd() }), `a worker: ${command}`);
  }
  assert.match(checkCommand('rm .githooks/pre-commit', { env: {}, cwd: process.cwd() })?.what ?? '', /changes \.githooks\/pre-commit/);
  for (const command of [
    'cat .git/config',
    'grep -n hooksPath .git/config',
    'cat .githooks/pre-commit',
    'ls -la .githooks .git/hooks',
    'sed -n 1,5p .git/config',
    'cp .git/config /tmp/config-copy',
    'diff .githooks/pre-commit /tmp/x',
    'git config --get core.hooksPath',
    'test -x .githooks/pre-commit && echo ok',
    'echo x > notes/.githooks-plan.md',
    'awk 1 .git/config',
    'vim README.md',
    'tar cf box.tar src',
    'tar xf /tmp/x.tar -C /tmp/unpacked',
    'find . -name "*.log" -delete',
    'mkdir -p .githooks',
    'git add .githooks/pre-commit',
    'git show HEAD:.githooks/pre-commit > /tmp/pre-commit',
    'rm -f *.tmp',
  ]) {
    allowed(command);
    allowed(command, worker);
  }
  // Another repo's files, such as a test repo in /tmp, are its own business.
  for (const command of [
    `rm -rf ${outside}/.githooks`,
    `echo x >> ${outside}/.git/config`,
    `cd ${outside} && git init -q && cp /tmp/x .git/hooks/pre-commit`,
  ]) allowed(command);
  // The lead may bring back the committed hook; a worker may not touch it at all.
  for (const command of ['git checkout -- .githooks/pre-commit', 'git restore .githooks/pre-commit', 'git checkout HEAD -- .githooks']) {
    allowed(command);
    assert.ok(checkCommand(command, { env: worker, cwd: process.cwd() }), `a worker: ${command}`);
  }
});

test('hooks setting: GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and GIT_CONFIG_COUNT/KEY/VALUE are refused (#361)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const command of [
    'GIT_CONFIG_GLOBAL=/tmp/x git commit -m x',
    'GIT_CONFIG_SYSTEM=/tmp/x git commit -m x',
    'GIT_CONFIG_GLOBAL=/dev/null git status',
    'env GIT_CONFIG_GLOBAL=/tmp/x git commit -m x',
    'export GIT_CONFIG_GLOBAL=/tmp/x; git commit -m x',
    'git_config_global=/tmp/x git commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=.githooks git commit -m x',
    'GIT_CONFIG_VALUE_0=x git status',
    'GIT_CONFIG_COUNT+=1 git log',
    'GIT_CONFIG_GLOBAL=/tmp/x bash -c "git commit -m x"',
    // Set for the rest of the line, then exported (#361 review).
    'read GIT_CONFIG_GLOBAL <<< /tmp/x; export GIT_CONFIG_GLOBAL; git commit -m x',
    'read GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 <<< "1 core.hooksPath /dev/null"; export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; git commit -m x',
    'printf -v GIT_CONFIG_GLOBAL %s /tmp/x; export GIT_CONFIG_GLOBAL; git commit -m x',
    'printf -vGIT_CONFIG_GLOBAL %s /tmp/x; export GIT_CONFIG_GLOBAL; git commit -m x',
    'for GIT_CONFIG_GLOBAL in /tmp/x; do export GIT_CONFIG_GLOBAL; git commit -m x; done',
    'declare -x GIT_CONFIG_GLOBAL=/tmp/x; git commit -m x',
    'unset GIT_CONFIG_NOSYSTEM; : ${GIT_CONFIG_GLOBAL:=/tmp/x}; export GIT_CONFIG_GLOBAL; git commit -m x',
    ': ${GIT_CONFIG_GLOBAL=/tmp/x}; export GIT_CONFIG_GLOBAL; git commit -m x',
  ]) {
    assert.equal(checkCommand(command, { env: {}, cwd: process.cwd() })?.id, 'hooks-path', `the lead: ${command}`);
    assert.ok(checkCommand(command, { env: worker, cwd: process.cwd() }), `a worker: ${command}`);
  }
  assert.match(checkCommand('GIT_CONFIG_GLOBAL=/tmp/x git commit -m x', { env: {}, cwd: process.cwd() })?.fix ?? '', /git -c <name>=<value>/);
  for (const command of [
    'grep -rn GIT_CONFIG_GLOBAL=x test',
    'echo $GIT_CONFIG_GLOBAL',
    'git -c user.name=x commit -m x',
    'GIT_CONFIG_NOSYSTEM=1 git status',
    'GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm test',
    'echo GIT_CONFIG_GLOBAL=x git commit',
  ]) allowed(command);
});

// #664: another home folder hides the private marks from the commit check and the gh guard.

test('home folder: an agent may not set HOME or USERPROFILE for git, gh, yokoten or a shell (#664)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const command of [
    'HOME=/tmp/elsewhere git commit -m x',
    'HOME=/tmp/elsewhere gh issue create --title x --body y',
    'HOME=/tmp/elsewhere yokoten check',
    'HOME=/tmp/elsewhere node bin/yokoten.ts check',
    'HOME=/tmp/elsewhere npx yokoten check',
    'HOME=/tmp/elsewhere bash -c "git commit -m x"',
    'HOME=/tmp/elsewhere sh script.sh',
    'HOME=/tmp/elsewhere eval "git commit -m x"',
    'USERPROFILE=C:\\elsewhere git commit -m x',
    'home=/tmp/elsewhere git commit -m x',
    'Home=/tmp/elsewhere git commit -m x',
    'env HOME=/tmp/elsewhere gh issue create --title x --body y',
    'env -u X HOME=/tmp/elsewhere git commit -m x',
    'env -i HOME=/tmp/elsewhere git commit -m x',
    'sudo HOME=/tmp/elsewhere git commit -m x',
    'nice env HOME=/tmp/elsewhere git commit -m x',
    'find . -exec env HOME=/tmp/elsewhere git commit -m x \;',
    'export HOME=/tmp/elsewhere; git commit -m x',
    'export HOME=/tmp/elsewhere && gh pr create --fill',
    'export HOME=/tmp/elsewhere; npm test',
    'declare -x HOME=/tmp/elsewhere; git commit -m x',
    'HOME=/tmp/elsewhere; git commit -m x',
    'HOME+=/elsewhere git commit -m x',
    'read HOME <<< /tmp/elsewhere; git commit -m x',
    'read -r -a HOME < /tmp/f',
    'mapfile -t HOME < /tmp/f',
    'printf -v HOME %s /tmp/elsewhere; git commit -m x',
    'printf -vHOME %s /tmp/elsewhere; export HOME; git commit -m x',
    'getopts ab HOME',
    'let HOME=1',
    'for HOME in /tmp/elsewhere; do git commit -m x; done',
    'select HOME in /tmp/elsewhere; do break; done',
    'unset HOME; : ${HOME:=/tmp/elsewhere}; export HOME; git commit -m x',
    ': ${HOME=/tmp/elsewhere}; git commit -m x',
    'bash -c "HOME=/tmp/elsewhere git commit -m x"',
    'echo "HOME=/tmp/elsewhere git commit -m x" | sh',
  ]) {
    assert.equal(checkCommand(command, { env: {}, cwd: process.cwd() })?.id, 'home-folder', `the lead: ${command}`);
    assert.ok(checkCommand(command, { env: worker, cwd: process.cwd() }), `a worker: ${command}`);
  }
  const found = checkCommand('HOME=/tmp/elsewhere git commit -m x', { env: {}, cwd: process.cwd() });
  assert.match(found?.what ?? '', /sets HOME/);
  assert.match(found?.fix ?? '', /without changing the home folder/);
  for (const command of [
    'echo $HOME',
    'ls ~',
    'cat "$HOME/.gitconfig"',
    'grep -rn HOME= src',
    'grep -rn HOME= src test git',
    'echo HOME=x',
    'echo HOME=/tmp/x git commit',
    'printf HOME',
    'git commit -m "HOME=x is refused"',
    'for v in PATH HOME USER; do echo "$v=${!v}"; done',
    'for f in a b; do echo HOME; done',
  ]) {
    allowed(command);
    allowed(command, worker);
  }
  // Before another program, a home folder of its own is ordinary test isolation. XDG_CONFIG_HOME
  // moves nothing yokoten's checks read.
  // getopts sets only its name argument; a worker's box refuses getopts as a whole.
  allowed('getopts ab opt HOME');
  for (const command of ['HOME=$(mktemp -d) npm test', 'HOME="$(mktemp -d)" node --test', 'XDG_CONFIG_HOME=/tmp/x gh issue create --title x --body y', 'XDG_CONFIG_HOME=$(mktemp -d) node --test test/agents']) allowed(command);
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

// The fourth review of #226. The shapes run in a node of their own. There each is read
// at 512 repeats and at 8 times that, and the steps must grow like the text (#754).
// A shape gives what it should at 8 times 512, or, for one with a size of its own, at
// that size: 100k substitutions are refused. The cases go in on stdin.

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

// #739: a worker's HOME or XDG_CONFIG_HOME before the commit check is the same skip as #664,
// and the fix has to say so. The lead's XDG_CONFIG_HOME, and a plain git commit, stay allowed.
test('home folder: a worker cannot hide the real home from git commit, yokoten check or a shell (#739)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  const fix = 'the commit check needs the real home; in a desk, the runner commits for you (issue #736)';
  for (const command of [
    'HOME=/tmp/elsewhere git commit -m x',
    'env HOME=/tmp/elsewhere git commit -m x',
    'export HOME=/tmp/elsewhere; git commit -m x',
    'XDG_CONFIG_HOME=/tmp/elsewhere git commit -m x',
    'env XDG_CONFIG_HOME=/tmp/elsewhere git commit -m x',
    'export XDG_CONFIG_HOME=/tmp/elsewhere; git commit -m x',
    'HOME=/tmp/elsewhere yokoten check',
    'env HOME=/tmp/elsewhere yokoten check',
    'export HOME=/tmp/elsewhere; yokoten check',
    'XDG_CONFIG_HOME=/tmp/elsewhere yokoten check',
    'env XDG_CONFIG_HOME=/tmp/elsewhere node bin/yokoten.ts check',
    'export XDG_CONFIG_HOME=/tmp/elsewhere; yokoten check',
    'HOME=/tmp/elsewhere bash -c "git commit -m x"',
    'env HOME=/tmp/elsewhere bash -c "yokoten check"',
    'export HOME=/tmp/elsewhere; sh -c "git commit -m x"',
    'XDG_CONFIG_HOME=/tmp/elsewhere bash -c "git commit -m x"',
    'env XDG_CONFIG_HOME=/tmp/elsewhere sh -c "yokoten check"',
    'export XDG_CONFIG_HOME=/tmp/elsewhere; bash -c "git commit -m x"',
    'bash -c "HOME=/tmp/elsewhere git commit -m x"',
    'bash -c "XDG_CONFIG_HOME=/tmp/elsewhere yokoten check"',
    'USERPROFILE=C:\\elsewhere git commit -m x',
    'home=/tmp/elsewhere yokoten check',
    'xdg_config_home=/tmp/elsewhere git commit -m x',
  ]) {
    const found = checkCommand(command, { env: worker, cwd: process.cwd() });
    assert.equal(found?.id, 'home-folder', command);
    assert.match(found?.what ?? '', new RegExp(`sets ${command.match(/[A-Za-z_]+(?==)/)?.[0]}`));
    assert.equal(found?.fix, fix, command);
  }
  // A script file is not in the command. The guard cannot tell whether it sets HOME, so it refuses.
  // `bash -c` stays allowed: the text is in the command. The lead may still run a script file.
  const fixForFile = 'the commit check needs the real home; in a desk, the runner commits for you (issue #736)';
  for (const command of [
    'bash /tmp/hide-home.sh',
    'sh /tmp/hide-home.sh',
    'Bash /tmp/hide-home.sh',
    'SH script.sh',
    'dash ./hide.sh',
    'zsh hide.sh',
    '/bin/bash /tmp/hide-home.sh',
    'busybox sh /tmp/hide-home.sh',
    'rbash /tmp/hide.sh',
    'mksh /tmp/hide.sh',
    'bash --posix /tmp/hide.sh',
    'bash -- /tmp/hide.sh',
    'env bash /tmp/hide.sh',
    'nice bash /tmp/hide.sh',
    'bash < /tmp/hide.sh',
    'bash </tmp/hide.sh',
    'bash --rcfile /tmp/e.sh -c "git status"',
    'bash script.sh -c foo',
    'bash -o pipefail -c "git status"',
  ]) {
    const found = checkCommand(command, { env: worker, cwd: process.cwd() });
    assert.equal(found?.id, 'home-folder', command);
    assert.match(found?.what ?? '', /cannot read/, command);
    assert.equal(found?.fix, fixForFile, command);
    assert.equal(checkCommand(command, { env: {}, cwd: process.cwd() }), null, `the lead may: ${command}`);
  }
  for (const command of ['bash -c "git status"', 'sh -c "git commit -m x"', 'bash -eu -c "git status"', 'bash -lc "git status"', 'bash <<EOF\nls\nEOF', 'echo hi | sh']) {
    allowed(command, worker);
  }
  // `source` and `.` already refuse, as a setting the box cannot see. They stay on that rule.
  assert.equal(checkCommand('source /tmp/hide.sh', { env: worker, cwd: process.cwd() })?.id, 'worker-mark');
  assert.equal(checkCommand('. /tmp/hide.sh', { env: worker, cwd: process.cwd() })?.id, 'worker-mark');
  // Unsetting the home is the same skip. The lead's fix names the home folder. A worker's names the commit check.
  const leadFix = /without changing the home folder/;
  for (const command of [
    'unset HOME; git commit -m x',
    'unset USERPROFILE; yokoten check',
    'unset home; sh -c "git commit -m x"',
    'unset -v HOME; git commit -m x',
    'env -u HOME git commit -m x',
    'env --unset HOME git commit -m x',
    'env --unset=HOME git commit -m x',
    'env -uHOME git commit -m x',
    'env -u PATH -u HOME git commit -m x',
    'env -C /tmp -u HOME git commit -m x',
    'env -iuHOME git commit -m x',
    'env -iu HOME git commit -m x',
    'bash -c "unset HOME; git commit -m x"',
  ]) {
    const found = checkCommand(command, { env: {}, cwd: process.cwd() });
    assert.equal(found?.id, 'home-folder', `the lead: ${command}`);
    assert.match(found?.what ?? '', /unsets/i, command);
    assert.match(found?.fix ?? '', leadFix, command);
  }
  assert.equal(checkCommand('unset XDG_CONFIG_HOME; git commit -m x', { env: {}, cwd: process.cwd() }), null);
  assert.equal(checkCommand('env -u XDG_CONFIG_HOME git commit -m x', { env: {}, cwd: process.cwd() }), null);
  assert.equal(checkCommand('env -u HOME npm test', { env: {}, cwd: process.cwd() }), null);
  assert.equal(checkCommand('env -iu HOME npm test', { env: {}, cwd: process.cwd() }), null);
  assert.notEqual(checkCommand('env -uiHOME git commit -m x', { env: {}, cwd: process.cwd() })?.id, 'home-folder');
  assert.notEqual(checkCommand('unset PATH; git commit -m x', { env: {}, cwd: process.cwd() })?.id, 'home-folder');
  for (const command of [
    'unset HOME; git commit -m x',
    'unset USERPROFILE; yokoten check',
    'unset XDG_CONFIG_HOME; git commit -m x',
    'unset home; sh -c "git commit -m x"',
    'unset -v HOME; git commit -m x',
    'env -u HOME git commit -m x',
    'env --unset=HOME yokoten check',
    'env -uHOME sh -c "git status"',
    'env -u PATH -u HOME git commit -m x',
    'env -iuHOME git commit -m x',
    'unset HOME; bash -c "ls"',
  ]) {
    const found = checkCommand(command, { env: worker, cwd: process.cwd() });
    assert.equal(found?.id, 'home-folder', command);
    assert.match(found?.what ?? '', /unsets/i, command);
    assert.equal(found?.fix, fix, command);
  }
  // An unset that does not reach the commit check stays off this rule.
  assert.notEqual(checkCommand('unset HOME; rm -rf build', { env: worker, cwd: process.cwd() })?.id, 'home-folder');
  assert.equal(checkCommand('env -u HOME npm test', { env: worker, cwd: process.cwd() })?.id, 'worker-mark');
  assert.notEqual(checkCommand('unset PATH; git commit -m x', { env: worker, cwd: process.cwd() })?.id, 'home-folder');
  allowed('git commit -m x');
  allowed('git commit -m x', worker);
  // The lead's XDG_CONFIG_HOME still passes, including before git commit. So does HOME before npm.
  for (const command of ['XDG_CONFIG_HOME=/tmp/x git commit -m x', 'XDG_CONFIG_HOME=/tmp/x gh issue create --title x --body y', 'XDG_CONFIG_HOME=$(mktemp -d) node --test test/agents', 'export XDG_CONFIG_HOME=/tmp/x', 'HOME=$(mktemp -d) npm test']) allowed(command);
  // Other settings, and a home before a program that is not the commit check, stay refused.
  for (const command of ['HOME=/tmp/elsewhere npm test', 'HOME=/tmp/elsewhere git status', 'XDG_CONFIG_HOME=/tmp/elsewhere git status', 'XDG_CONFIG_HOME=/tmp/elsewhere node --test']) {
    assert.equal(checkCommand(command, { env: worker, cwd: process.cwd() })?.id, 'worker-mark', command);
  }
  const lead = checkCommand('HOME=/tmp/elsewhere git commit -m x', { env: {}, cwd: process.cwd() });
  assert.equal(lead?.id, 'home-folder');
  assert.match(lead?.fix ?? '', /without changing the home folder/);
});
