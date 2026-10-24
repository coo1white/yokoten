import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand, checkWorkerMarkEdit, useHostCommands } from '../../../../src/rules/guards/index.ts';
import { makeTempDir, allowed } from '../../../../test/repo/helpers.ts';
import { DEFAULTS } from '../../../../src/rules/config.ts';
import { judge } from '../../../../src/run/hook.ts';

test('checkWorkerMarkEdit: yokoten config folder by path or real path (#591)', () => {
  const base = makeTempDir('yokoten-config-edit-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  const env = { HOME: home };
  const tree = join(base, 'wt');
  mkdirSync(tree);
  assert.equal(checkWorkerMarkEdit(join(home, '.config', 'yokoten', 'workers'), tree, env)?.id, 'worker-mark');
  assert.equal(checkWorkerMarkEdit(join(home, '.config', 'yokoten', 'keys.env'), tree, env)?.id, 'worker-mark');
  assert.match(checkWorkerMarkEdit(join(home, '.config', 'yokoten', 'workers'), tree, env)?.what ?? '', /config folder/);
  // Negative controls: other files in home, the worktree, and no home folder known.
  assert.equal(checkWorkerMarkEdit(join(home, '.config', 'other', 'workers'), tree, env), null);
  assert.equal(checkWorkerMarkEdit(join(home, '.config', 'yokoten-old'), tree, env), null);
  assert.equal(checkWorkerMarkEdit(join(tree, 'a.ts'), tree, env), null);
  assert.equal(checkWorkerMarkEdit(join(home, '.config', 'yokoten', 'workers'), tree), null);
  // Case aside, as in the command check.
  assert.equal(checkWorkerMarkEdit(join(home, '.CONFIG', 'Yokoten', 'workers'), tree, env)?.id, 'worker-mark', 'another case');
  assert.equal(checkWorkerMarkEdit(join(home, '.CONFIG', 'Yokoten-old'), tree, env), null);
  if (process.platform === 'win32') return;
  symlinkSync(join(home, '.config', 'yokoten'), join(tree, 'link'));
  assert.equal(checkWorkerMarkEdit(join(tree, 'link', 'workers'), tree, env)?.id, 'worker-mark', 'a symlink to the config folder');
  // Through the hook: a worker's Write to the list is refused; the lead's passes.
  const paths = [join(home, '.config', 'yokoten', 'workers')];
  assert.equal(judge({ paths, cwd: tree, worker: true }, { root: null, config: DEFAULTS, env, cwd: tree })?.id, 'worker-mark');
  assert.equal(judge({ paths, cwd: tree, worker: false }, { root: null, config: DEFAULTS, env, cwd: tree }), null);
});

// #591, third review: the guard stops reading bash grammar for a worker's command that points
// at a .config folder or moves git's work folder. It passes only when every program reads.

test('guard: a worker command that points at a config folder runs only plain reads (#591)', () => {
  const base = makeTempDir('yokoten-blunt-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  const worker = { YOKOTEN_ROLE: 'worker', HOME: home };
  const lead = { HOME: home };
  for (const command of [
    'git config core.worktree ~/.config/yokoten',
    'git -c core.worktree=/tmp/x clean -fdx',
    'GIT_WORK_TREE=~/.config/"yokoten" git clean -fdx',
    'GIT_WORK_TREE=~/.con\\fig/yokoten git clean -fdx',
    'env -C ~/.config/yokoten git clean -fdx',
    'env --chdir=/tmp/x git clean -fdx',
    'read GIT_WORK_TREE <<< ~/.config/yokoten; export GIT_WORK_TREE; git clean -fdx',
    'printf -v GIT_WORK_TREE %s /tmp/x; git clean -fdx',
    'echo ~/.config/yokoten | xargs -I{} git -C {} clean -fdx',
    'cat ~/.CONFIG/yokoten/workers > /tmp/w',
    'cat "$(echo ~/.config/yokoten/workers)"',
    'cp ~/.config/yokoten/workers /tmp/w',
    'git -C ~/.config/yokoten status',
    "find ~/.config -exec cat {} +",
    // Writes elsewhere under .config: the blunt rule refuses them too.
    'mkdir -p ~/.config/other',
    'echo x > ~/.config/other/file',
    'npm test --prefix ~/.config/x',
    // Blunt: any git next to GIT_WORK_TREE, even one that points at the worktree.
    'GIT_WORK_TREE=. git status',
  ]) {
    const found = checkCommand(command, { cwd: process.cwd(), env: worker });
    assert.equal(found?.id, 'worker-mark', command);
    assert.notEqual(checkCommand(command, { cwd: process.cwd(), env: lead })?.id, 'worker-mark', `the lead may: ${command}`);
  }
  assert.match(checkCommand('git config core.worktree x', { cwd: process.cwd(), env: worker })?.fix ?? '', /ask the lead/);
  for (const command of [
    'cat ~/.config/yokoten/workers',
    'ls ~/.config',
    'grep x ~/.config/yokoten/workers',
    'cat ~/.config/yokoten/workers | grep wt',
    'git log -- ~/.config/yokoten',
    'grep -rn GIT_WORK_TREE src',
    'git status',
    'cd src && git status',
    'npm test',
    "sed -i 's/a/b/' src/config.ts",
    'rm -rf config/',
    'cat .configrc',
    'find ~/.config -name workers -print0',
    'cat webpack.config.js',
  ]) allowed(command, worker);
  // #828: git clean deletes every untracked file, so it is not everyday work.
  assert.equal(checkCommand('git clean -fdx', { cwd: process.cwd(), env: worker })?.id, 'discard-work');
});

// #591, round 5: the worker is boxed instead of its bash read word by word. A cd takes one
// plain path inside the worktree; no $'...' or ${...@...}; settings only from a short list;
// git with no option before its subcommand and no --output; less and file write no file.

test('useHostCommands: a second, different registration is refused (#650)', () => {
  assert.throws(() => useHostCommands({ hostRunRemoval: () => undefined, hostAlias: () => undefined, hostHiddenCommand: () => undefined, hostTokenReveal: () => undefined, hostWorkflowOff: () => undefined }), /already registered/);
});
