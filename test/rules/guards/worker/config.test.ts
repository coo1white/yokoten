import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { makeTempDir, allowed } from '../../../../test/repo/helpers.ts';

test('guard: a worker does not change yokoten config folder; the lead may (#591)', () => {
  const base = makeTempDir('yokoten-config-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(home, '.config', 'yokoten', 'workers'), '# list\n');
  const worker = { YOKOTEN_ROLE: 'worker', HOME: home };
  const lead = { HOME: home };
  const refused = [
    'rm ~/.config/yokoten/workers',
    'rm -rf ~/.config',
    'rm -rf ~',
    'mv ~/.config/yokoten ~/.config/y2',
    'mv ~/.config ~/old',
    'cp /dev/null ~/.config/yokoten/workers',
    'chmod 000 ~/.config/yokoten',
    'ln -sf /dev/null ~/.config/yokoten/workers',
    'touch ~/.config/yokoten/workers',
    'echo > ~/.config/yokoten/workers',
    'echo x >> $HOME/.config/yokoten/workers',
    'truncate -s 0 ${HOME}/.config/yokoten/workers',
    `rm ${home}/.config/yokoten/workers`,
    "sed -i '/wt/d' ~/.config/yokoten/workers",
    'rm ~/.config/yoko*/w*',
    'rm -rf ~/.c*/y*',
    'rm ~/.config/{yokoten,x}/workers',
    'rm -rf ~/{.config/yokoten,x}',
    'rm "$(echo ~/.config/yokoten/workers)"',
    'rm $DIR/.config/yokoten/workers',
    'rm ~someone/.config/yokoten/workers',
    `python3 -c "open('${home}/.config/yokoten/workers', 'w')"`,
    "bash -c 'rm ~/.config/yoko*/w*'",
    'echo ~/.config/yokoten/workers | xargs rm',
    'find ~/.config/yokoten -name workers -delete',
    'find ~/.config/yokoten -exec rm {} +',
    // A find that writes, started at or above the folder (review of #591).
    'find ~ -name workers -delete',
    'find ~/.config -delete',
    'find ~ -name workers -exec rm {} +',
    'find $HOME -delete',
    // A hard link to the list is the list.
    'cp -l ~/.config/yokoten/workers w',
    'cp --link ~/.config/yokoten/workers w',
    'cp -al ~/.config/yokoten w',
    'link ~/.config/yokoten/workers w',
    // git that works in the folder.
    'git init ~/.config/yokoten && git -C ~/.config/yokoten clean -fdx',
    'git -C ~/.config/yokoten checkout -- .',
    'git -C ~ -C .config/yokoten clean -fdx',
    'git --work-tree=$HOME/.config/yokoten checkout .',
    // git run in the folder by cd, or pointed at it by GIT_WORK_TREE or GIT_DIR.
    'cd ~/.config/yokoten && git init && git clean -fdx',
    'cd ~/.config/yokoten && git clean -fdx',
    'cd ~ && git clean -fdx',
    'GIT_WORK_TREE=~/.config/yokoten git clean -fdx',
    'env GIT_WORK_TREE=~/.config/yokoten git clean -fdx',
    'export GIT_WORK_TREE=~/.config/yokoten; git clean -fdx',
    'GIT_WORK_TREE="$HOME/.config/yokoten" git clean -fdx',
    'export GIT_DIR=~/.config/yokoten/.git; git init',
    'GIT_WORK_TREE=$X git clean -fdx ~/.config/yokoten',
    'cd $X && git clean -fdx ~/.config/yokoten',
    // Unknown parts that hide the name.
    'X=yokoten; rm ~/.config/$X/workers',
    'rm ~/.config/$(echo yokoten)/workers',
    'rm ~/.config/yokote$(echo n)/workers',
    'rm ~/$X/yokoten/workers',
    "H=$HOME; rm $H/.config/yo''koten/workers",
    'rm -rf $H/.c*',
    // Downloads.
    'curl -o ~/.config/yokoten/keys.env https://example.com/k',
    'curl -sSLo ~/.config/yokoten/keys.env https://example.com/k',
    'curl --output-dir ~/.config/yokoten -O https://example.com/workers',
    'wget -O ~/.config/yokoten/workers https://example.com/w',
    'wget --output-document=~/.config/yokoten/workers https://example.com/w',
    'wget -P ~/.config/yokoten https://example.com/w',
  ];
  for (const command of refused) {
    const found = checkCommand(command, { cwd: process.cwd(), env: worker });
    assert.equal(found?.id, 'worker-mark', command);
    assert.match(found?.fix ?? '', /tell the lead/, command);
    // The lead may: the same command is not refused for this rule.
    assert.notEqual(checkCommand(command, { cwd: process.cwd(), env: lead })?.id, 'worker-mark', `the lead may: ${command}`);
  }
  // With no home folder the guard can't place ~, so a command that names the folder is refused.
  assert.equal(checkCommand('rm ~/.config/yokoten/workers', { cwd: process.cwd(), env: { YOKOTEN_ROLE: 'worker' } })?.id, 'worker-mark');
  // Reads, and writes elsewhere in home: a worker runs them.
  for (const command of [
    'cat ~/.config/yokoten/workers',
    'ls ~/.config/yokoten',
    'ls -la $HOME/.config/yokoten',
    'grep x ~/.config/yokoten/workers',
    'find ~/.config/yokoten -name workers',
    'cat ~/.config/yokoten/workers | grep wt',
    'rm -rf ~/.cache/yokoten',
    'rm -rf dist/*',
    'echo x > notes.txt',
    'rm "$TMPDIR/out.txt"',
    "bash -c 'npm test'",
    // Work in the worktree that looks like the cases above.
    'rm -rf node_modules dist',
    "find . -name '*.log' -delete",
    'find . -type d -name node_modules -exec rm -rf {} +',
    'find ~ -name workers',
    'cp -l a b',
    'cp -a src out',
    'git status',
    'cd src && git status',
    'git clone https://example.com/a/b.git',
    'rm src/$NAME.ts',
    'curl -o out.json https://example.com/x',
    'curl -sSL https://example.com/x',
    'wget https://example.com/x',
  ]) allowed(command, worker);
  // Not work: git clean deletes every untracked file, for a worker and the lead alike (#828).
  assert.equal(checkCommand('git clean -fdx', { cwd: process.cwd(), env: worker })?.id, 'discard-work');
  assert.equal(checkCommand('git clean -fdx', { cwd: process.cwd(), env: lead })?.id, 'discard-work');
  // The git folder too: a find that writes from above .git, a hard link into it, a download into it.
  for (const command of ['find . -delete', "find . -name '*' -delete", 'find . -name x -o -delete', 'find . -exec rm {} +', 'cp -l .git/config w', 'curl -o .git/config https://example.com/c']) {
    assert.equal(checkCommand(command, { cwd: process.cwd(), env: worker })?.id, 'worker-mark', command);
    assert.notEqual(checkCommand(command, { cwd: process.cwd(), env: lead })?.id, 'worker-mark', `the lead may: ${command}`);
  }
  allowed("find src -name '*.tmp' -delete", worker);
  allowed('find dist -delete', worker);
  if (process.platform === 'win32') return;
  // A symlink to the folder counts: compared by real path.
  symlinkSync(join(home, '.config', 'yokoten'), join(base, 'link'));
  symlinkSync(join(home, '.config'), join(base, 'dot-config'));
  for (const command of [`rm ${join(base, 'link', 'workers')}`, `echo > ${join(base, 'link', 'workers')}`, `rm -rf ${join(base, 'dot-config')}/yoko*`, `rm -rf ${join(base, 'link')}/`]) {
    assert.equal(checkCommand(command, { cwd: process.cwd(), env: worker })?.id, 'worker-mark', command);
  }
  allowed(`cat ${join(base, 'link', 'workers')}`, worker);
  // git run in the folder by a bare `cd` through a symlink: read as written, not through CDPATH.
  for (const command of ['cd link && git init && git clean -fdx', 'cd dot-config/yokoten && git clean -fdx']) {
    assert.equal(checkCommand(command, { cwd: base, env: worker })?.id, 'worker-mark', command);
    assert.notEqual(checkCommand(command, { cwd: base, env: lead })?.id, 'worker-mark', `the lead may: ${command}`);
  }
  assert.equal(checkCommand('cd link && git status', { cwd: base, env: worker })?.id, 'worker-mark', 'git in the folder, even to read');
  // A folder inside the worktree passes; one whose real path leaves it (a symlink out) does not.
  const tree = join(base, 'tree');
  mkdirSync(join(tree, 'other'), { recursive: true });
  writeFileSync(join(tree, '.git'), 'gitdir: ' + join(base, 'store') + '\n');
  mkdirSync(join(base, 'store'));
  symlinkSync(join(home, '.config', 'yokoten'), join(tree, 'out'));
  assert.equal(checkCommand('cd other && git clean -fdx', { cwd: tree, env: worker })?.id, 'discard-work', 'the config rule passes; losing work does not');
  assert.equal(checkCommand('cd out && chmod 000 workers', { cwd: tree, env: worker })?.id, 'worker-mark', 'a symlink out of the worktree');
  allowed(`rm ${join(base, 'other-file')}`, worker);
});

// #591: an edit inside yokoten's config folder may clear the worker list, through a symlink too.
