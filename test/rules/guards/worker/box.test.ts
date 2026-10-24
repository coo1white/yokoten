import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { makeTempDir, allowed } from '../../../../test/repo/helpers.ts';

test('guard: a worker stays in its box: plain cd inside the worktree, short settings list (#591)', () => {
  const base = makeTempDir('yokoten-box-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  const worker = { YOKOTEN_ROLE: 'worker', HOME: home };
  const lead = { HOME: home };
  const cwd = process.cwd();
  const into = 'cd ~/?config/yokoten && ';
  const refused = [
    // git writes a file.
    'git diff --output ~/.config/yokoten/workers',
    'git diff --output=$HOME/.config/yokoten/workers',
    'git log -0 --output ~/.config/yokoten/workers',
    'git diff --outp=w',
    'git diff --output .git/yokoten-worker',
    // A cd the guard can't read, or one out of the worktree.
    "cd ~ && cd $'\\x2econfig'/yokoten && chmod 000 workers",
    'cd ~/.c* && cd yokoten && chmod 000 workers',
    'cd ~/?config/yokoten && chmod 000 workers',
    'pushd $XDG_CONFIG_HOME/yokoten && chmod 000 workers',
    'CDPATH=$XDG_CONFIG_HOME cd yokoten && chmod 000 workers',
    ...['chown x workers', 'chattr +i workers', 'setfacl -m u:x:0 workers', 'rsync /dev/null workers', 'tar -xf a.tar', 'unzip -o a.zip', 'sort -o workers /dev/null', 'awk -i inplace 1 workers', 'ed workers', 'vim workers', 'gpg -o workers -d x', 'git init && git clean -fdx'].map((write) => into + write),
    'cd ..',
    'cd',
    'cd -',
    'cd "$HOME"',
    'cd /tmp',
    'popd +1',
    '(cd src) && cd .. && ls',
    'cd src | cat',
    'cd src & ls',
    // The work folder by a spelling the guard can't read.
    "git --work-tree=~/$'\\x2econfig'/yokoten clean -fdx",
    'x=GIT_WORK; export ${x}_TREE=~/.config/yokoten; git clean -fdx',
    "git -c core.worktre$'\\x65'=~/.config/yokoten clean -fdx",
    "git config core.worktre$'\\x65' ~/.config/yokoten",
    'git config core.worktree ~/.config/yokoten',
    'git -C src status',
    'env --chd=$XDG_CONFIG_HOME/yokoten chmod 000 workers',
    'env -i ls',
    'sudo -D /tmp ls',
    'printf -v GIT_WORK_TREE %s /tmp/x',
    'read GIT_WORK_TREE <<< /tmp/x',
    "eval 'GIT_DIR=x'",
    'export GIT_DIR=x',
    'declare -x FOO=1',
    // Readers that run code from a setting.
    "LESSOPEN='|chmod 0 %s' less README.md",
    'GIT_EXTERNAL_DIFF=./x.sh git diff',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=./x.sh git diff',
    "GIT_PAGER='chmod 0 w' git log",
    "x='$(chmod 0 w)'; echo ${x@P}",
    'RIPGREP_CONFIG_PATH=./rc rg x',
    'TZ=UTC GIT_DIR=x git status',
    // less and file that write.
    'less -o w README.md',
    'less -O w README.md',
    'less -RO w README.md',
    'less --log-file=w README.md',
    'less --LOG-FILE w README.md',
    'less --log w README.md',
    "less '+s w' README.md",
    'file -C -m x',
    'file --compile -m x',
  ];
  for (const command of refused) {
    assert.equal(checkCommand(command, { cwd, env: worker })?.id, 'worker-mark', command);
    assert.notEqual(checkCommand(command, { cwd, env: lead })?.id, 'worker-mark', `the lead may: ${command}`);
  }
  const worktree = cwd.split(/[\\/]/).pop();
  for (const command of [
    "git commit -m 'fix GIT_DIR handling'",
    'git add .config/x',
    'cp .config/a .config/b',
    'npm test -- --config .config/x',
    'cd src && ls',
    'cd src && cd .. && ls',
    `cd ../${worktree}/src && ls`,
    'cd ./src/rules; ls',
    'TZ=UTC git commit -m x',
    'NODE_ENV=test npm test',
    'export TZ=UTC',
    'cat ~/.config/yokoten/workers',
    'git log -- ~/.config/yokoten',
    'git --no-pager log -3',
    'git config user.name',
    'git config --get user.name',
    'git config --list',
    "grep -E 'a|b' src/rules/guards/index.ts",
    'less README.md',
    'file README.md',
  ]) allowed(command, worker);
  // A shell already in or above the config folder has no box: everything is refused.
  assert.equal(checkCommand('chmod 000 workers', { cwd: join(home, '.config', 'yokoten'), env: worker })?.id, 'worker-mark');
  assert.equal(checkCommand('ls', { cwd: home, env: worker })?.id, 'worker-mark');
  assert.equal(checkCommand('chmod 000 workers', { cwd: join(home, '.config', 'yokoten'), env: lead }), null, 'the lead');
});

// #591, round 6: `+=` settings, globs past the writer lists, `~+`, writers through a symlink,
// and alias. Each is refused for a worker in a worktree that holds symlinks to the config folder.

test('guard: a worker box closes += settings, globs, ~+ and symlinked writers (#591)', () => {
  const base = makeTempDir('yokoten-box6-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(home, '.config', 'yokoten', 'workers'), '# list\n');
  const tree = join(home, 'dev', 'wt');
  mkdirSync(join(tree, 'src'), { recursive: true });
  mkdirSync(join(tree, 'dist'));
  mkdirSync(join(base, 'store'));
  writeFileSync(join(tree, '.git'), 'gitdir: ' + join(base, 'store') + '\n');
  const worker = { YOKOTEN_ROLE: 'worker', HOME: home };
  const lead = { HOME: home };
  const links = process.platform !== 'win32';
  if (links) {
    symlinkSync('../../.config/yokoten', join(tree, 'link'));
    symlinkSync('../../.config', join(tree, 'cfg'));
  }
  const refused = [
    // `+=` is a setting too.
    'HOME+=/.config/yokoten; rm -f ~/workers',
    'HOME+=/.config; rm -rf ~/yokoten',
    'GIT_WORK_TREE+=link git checkout -- .',
    'GIT_DIR+=x git status',
    'GIT_PAGER+="sh -c x" git log',
    'LESSOPEN+="|./x.sh %s" less README.md',
    'HOME+=/x true',
    // Globs and brackets with programs past the writer lists.
    'sort -o ~/.c?nfig/yok*/workers /dev/null',
    'gzip -f ~/.[c]onfig/[y]okoten/[w]orkers',
    'tar -xf a.tar -C ~/.c*/yokoten',
    'unzip -o a.zip -d ../../.c*/yokoten',
    'split -b 1M /dev/null ~/.c*/yokoten/work',
    'git format-patch -o ~/.c*/yokoten HEAD~1',
    'npm install --prefix ~/.c*/yokoten x',
    'npx --prefix ~/.c*/yokoten x',
    'for f in ~/.*/*/workers; do gzip -f $f; done',
    'cp -rs ~/.c?nfig/yok* l',
    // alias can rename a program past every list.
    'alias c=cd',
  ];
  const throughLinks = [
    // `~+` is the shell's folder.
    'cp /dev/null ~+/link/workers',
    'rm -rf ~+/link/',
    'cat /dev/null > ~+/link/workers',
    'sed -i d ~+/link/workers',
    'chmod 000 ~+/link',
    'git clone . ~+/link/x',
    // Writers past the lists, through a symlink to the folder.
    'gzip -f link/workers',
    'sort -o link/workers /dev/null',
    'ed -s link/workers <<EOF\n1d\nw\nEOF',
    'exec gzip -f link/workers',
    'f() { gzip -f link/workers; }; f',
    'find -L . -name workers -delete',
    'find -L . -name workers -exec truncate -s0 {} +',
    'git archive -o link/workers HEAD',
    'git bundle create link/workers HEAD',
    'git format-patch -o link HEAD~1',
    'npm --prefix link install',
    'npm pack --pack-destination link',
    'gzip -f cfg/yokoten/workers',
  ];
  for (const command of [...refused, ...(links ? throughLinks : [])]) {
    const found = checkCommand(command, { cwd: tree, env: worker });
    assert.equal(found?.id, 'worker-mark', command);
    assert.notEqual(checkCommand(command, { cwd: tree, env: lead })?.id, 'worker-mark', `the lead may: ${command}`);
  }
  // A config refusal says why in its own words: the worker list and the bot's keys.
  for (const command of ['gzip -f ~/.[c]onfig/[y]okoten/[w]orkers', ...(links ? ['gzip -f link/workers'] : [])]) {
    const found = checkCommand(command, { cwd: tree, env: worker });
    assert.match(found?.what ?? '', /config folder/, command);
    assert.match(found?.fix ?? '', /worker list and the bot's keys/, command);
  }
  for (const command of [
    'npm test',
    'npx tsc --noEmit',
    'git commit -m "msg"',
    'cd src && npm test',
    'ls | grep x',
    'for f in src/*; do echo $f; done',
    'git log --oneline',
    'git status',
    'cat ~/.config/yokoten/workers',
    'TZ=UTC git log -1',
    'node --test',
    'git diff HEAD~1 --stat',
    'grep -rn foo src | head',
    'gzip -f dist/a.txt',
    'sort -o out.txt in.txt',
  ]) {
    assert.equal(checkCommand(command, { cwd: tree, env: worker }), null, `should allow: ${command}`);
    allowed(command, worker);
  }
});

// #591, round 7: the guard resolves each path word of a worker's non-reader command the way
// the kernel would (one part at a time, following a symlink before a later `..`), then expands
// globs itself, reads attached short-option values and $PWD, and refuses the directory stack,
// so no spelling reaches the config folder through the worktree's symlinks.

test('guard: a worker command cannot reach the config folder by any path spelling (#591)', () => {
  const base = makeTempDir('yokoten-box7-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(home, '.config', 'yokoten', 'workers'), '# list\n');
  writeFileSync(join(home, '.config', 'yokoten', 'bot.pem'), 'k\n');
  const tree = join(home, 'dev', 'wt');
  mkdirSync(join(tree, 'src'), { recursive: true });
  mkdirSync(join(tree, 'dist'));
  mkdirSync(join(tree, 'build'));
  mkdirSync(join(base, 'store'));
  writeFileSync(join(tree, '.git'), 'gitdir: ' + join(base, 'store') + '\n');
  writeFileSync(join(tree, 'src', 'x.ts'), 'a\n');
  writeFileSync(join(tree, 'src', 'a.ts'), 'a\n');
  writeFileSync(join(tree, 'out.tgz'), 'x\n');
  const worker = { YOKOTEN_ROLE: 'worker', HOME: home };
  const lead = { HOME: home };
  const links = process.platform !== 'win32';
  if (links) {
    symlinkSync('../../.config/yokoten', join(tree, 'link'));
    symlinkSync('../../.config', join(tree, 'cfg'));
  }
  // These need no symlink: the directory stack and $OLDPWD are refused outright.
  const always = [
    'gzip -f $OLDPWD/link/workers',
    'gzip -f ~0/link/workers',
    'gzip -f ~+0/link/workers',
    'rm -rf ~+0/link/',
    'cd src; gzip -f ~-/link/workers',
    'enable -n cd',
  ];
  // These reach the config folder through a symlink the worktree holds.
  const throughLinks = [
    // A: component-wise real path, a `..` after a symlink.
    'rm -rf link/../yokoten',
    'cp /dev/null link/../yokoten/bot.pem',
    'cat /dev/null > link/../yokoten/bot.pem',
    'mv x link/../yokoten/bot.pem',
    'sort -o link/../yokoten/bot.pem /dev/null',
    'gzip -rf link/..',
    'chmod -R 000 link/..',
    'truncate -s0 link/../*/*',
    'gzip -f link/../*/*',
    // B: globs the guard expands itself, dotfiles and symlinked folders too.
    'cp /dev/null l*/bot.pem',
    'rm -f */bot.pem',
    'rm -rf l*/',
    'gzip -f l*/workers',
    'truncate -s0 ?ink/bot.pem',
    'sed -i d [l]ink/bot.pem',
    'gzip -f */*',
    'chmod 000 l*',
    'gzip -rf *',
    'find -H l* -delete',
    // C: attached short-option values.
    'sort -olink/workers /dev/null',
    'tar -xf a.tar -Clink',
    'unzip -o a.zip -dlink',
    'make -Clink',
    'gcc -olink/workers x.c',
    'git archive -olink/workers HEAD',
    // D: $PWD read as the folder.
    'gzip -f $PWD/link/workers',
    'gzip -f ${PWD}/link/workers',
    'cp /dev/null $PWD/link/workers',
    'cat /dev/null > $PWD/link/workers',
    // E: hash -p points a name at another program.
    'hash -p /bin/rm ls; ls link/workers',
    // F: a symlink-following read piped into xargs, and -L/-H on chmod/chown/chgrp.
    'find -L . -name workers | xargs rm',
    'find . -follow -name workers | xargs truncate -s0',
    'find -L . -type f -print0 | xargs -0 sed -i d',
    'grep -Rl . . | xargs truncate -s0',
    'chmod -RL 000 .',
    'chown -R -L x .',
  ];
  for (const command of [...always, ...(links ? throughLinks : [])]) {
    assert.equal(checkCommand(command, { cwd: tree, env: worker })?.id, 'worker-mark', command);
    assert.notEqual(checkCommand(command, { cwd: tree, env: lead })?.id, 'worker-mark', `the lead may: ${command}`);
  }
  for (const command of [
    'npm test',
    'npx tsc --noEmit',
    'git commit -m "fix a/b"',
    'cd src && npm test',
    'ls | grep x',
    'git log --oneline',
    'tar -czf out.tgz src',
    'tar -xzf out.tgz -C build',
    'sed -i s/a/b/ src/x.ts',
    'mkdir -p build',
    'rm -rf dist',
    'rm -rf ./*.log',
    'gzip -f src/x.log',
    'sort -o out.txt in.txt',
    'find . -name "*.ts" -exec grep -l x {} +',
    'find -L . -name "*.ts"',
    'grep -rn foo src | head',
    'cp src/a.ts src/b.ts',
    'npm install --save-dev x',
    'cat ~/.config/yokoten/workers',
    'node -e "let x=0; x+=1"',
    'git commit -m "a+=b"',
  ]) assert.equal(checkCommand(command, { cwd: tree, env: worker }), null, `should allow: ${command}`);
});

test('guard: a worker command with a part the guard cannot read, or a shell mode it does not follow, is refused (#591)', () => {
  const base = makeTempDir('yokoten-box8-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(home, '.config', 'yokoten', 'workers'), '# list\n');
  const make = (name: string) => {
    const tree = join(home, 'dev', name);
    mkdirSync(join(tree, 'src'), { recursive: true });
    mkdirSync(join(tree, 'a', 'b'), { recursive: true });
    mkdirSync(join(tree, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(base, 'store-' + name));
    writeFileSync(join(tree, '.git'), 'gitdir: ' + join(base, 'store-' + name) + '\n');
    writeFileSync(join(tree, 'src', 'x.ts'), 'a\n');
    return tree;
  };
  const tree = make('wt');
  const clean = make('clean');
  const worker = { YOKOTEN_ROLE: 'worker', HOME: home };
  const links = process.platform !== 'win32';
  if (links) {
    symlinkSync('../../.config/yokoten', join(tree, 'link'));
    symlinkSync('../../../../.config/yokoten', join(tree, 'a', 'b', 'deep'));
  }
  const refused = (command: string, cwd = tree) => assert.equal(checkCommand(command, { cwd, env: worker })?.id, 'worker-mark', command);
  // Refused in any worktree: modes and paths the guard does not follow.
  for (const command of [
    'pushd src && popd && gzip -f x',
    'popd',
    'cd -P src',
    'set -P; cd src',
    'set -o physical; cd src',
    'gzip -f ~root/x',
    'gzip -f /proc/self/cwd/x',
    'gzip -f /proc/1/root/x',
    'cat /dev/null > /dev/fd/3',
  ]) refused(command, clean);
  if (links) {
    for (const command of [
      // An unknown part may be empty or any name.
      'gzip -f $9link/workers',
      'gzip -f l${9}ink/workers',
      'gzip -f ${u:-link}/workers',
      'gzip -f $nothing$PWD/link/workers',
      'gzip -f $(echo link)/workers',
      'gzip -f `echo link`/workers',
      'for d in link; do gzip -f $d/workers; done',
      'sort --output=$PWD/link/workers /dev/null',
      // A link made in the same command, read from the folder it sits in.
      'ln -s ../link src/l2 && gzip -f src/l2/workers',
      'ln -s ../../.config/yokoten',
      'ln -s -t src ../link',
      'ln -st src ../link',
      'ln -s -tsrc ../link',
      'cp -st src ../link',
      'ln -s --target-directory=src ../link',
      // A recursive writer over a folder holding a link more than one level down, or -a.
      'gzip -rf a',
      'rsync -aK src/ a',
      'cp -a a out',
    ]) refused(command);
  }
  // A worktree without such a link: ordinary commands, variables and recursion still pass.
  for (const command of [
    'for f in src/*.ts; do sed -i s/a/b/ $f; done',
    'rm -rf $OUT_DIR',
    'cd src && npm test',
    'cd -L src',
    'rm -rf node_modules',
    'cp -r src build',
    'cp -a src build',
    'rm -f **/*.log',
    'ln -s src/x.ts y.ts',
    'ln -s ~/dev/clean/src/x.ts y.ts',
    'ln -sf $PWD/src/x.ts y.ts',
    'cat /proc/self/status',
    'grep -rn dev/fd src',
    'gzip -rf a',
    'cat /proc/cpuinfo',
    'npm test 2>/dev/null',
  ]) assert.equal(checkCommand(command, { cwd: clean, env: worker }), null, `should allow: ${command}`);
});
