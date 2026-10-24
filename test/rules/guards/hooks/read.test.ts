import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand, hookFile, runsCheck } from '../../../../src/rules/guards/index.ts';
import { makeTempDir, writeHook, HUSKY_HOOK, HUSKY_H, makeHooksRepo, py, setHooks } from '../../../../test/repo/helpers.ts';
import { DEFAULTS } from '../../../../src/rules/config.ts';
import { judge } from '../../../../src/run/hook.ts';

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
  const judgeFrom = (cwd: string | undefined, root: string | null) => judge({ command, paths: [], cwd, worker: false }, { root, config: DEFAULTS, env: {}, cwd: process.cwd() });
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

test('hooks setting: one command asks git each question once, however often it sets the folder (#226)', { skip: process.platform === 'win32' }, () => {
  const cwd = makeHooksRepo();
  const bin = makeTempDir('yokoten-git-');
  const log = join(bin, 'log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeHook(join(bin, 'git'), `#!/bin/sh\necho x >> "${log}"\nexec "${real}" "$@"\n`);
  try {
    // The guard's git gets the env the guard is given: here, a PATH with the logging git first.
    assert.equal(checkCommand(`${setHooks('.husky/_')}; `.repeat(50), { env: { PATH: `${bin}:${process.env.PATH}` }, cwd }), null);
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(calls, 2, 'rev-parse --show-toplevel and config --get, once each');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
