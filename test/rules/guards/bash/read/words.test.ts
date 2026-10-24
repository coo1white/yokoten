import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommand, commandWords, findHeavyJob } from '../../../../../src/rules/guards/index.ts';
import { blocked, allowed, pythonBlocked, force, isBlockedByList, py, shouldBlock, shouldPass } from '../../../../../test/repo/helpers.ts';
import { assertLinear, assertWallSmoke } from '../../../../../scripts/linear.ts';

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
  const found = checkCommand('python3 --version', { cwd: process.cwd(), env: {}, config: pythonBlocked });
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
    assert.equal(checkCommand(command, { cwd: process.cwd(), env: {} }), null, command);
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

test('blocked commands: a find inside a find is read once, fast, and a huge list is refused (#226)', () => {
  // Read once. The work grows with the depth, from 18 finds deep to 144.
  const chain = (inner: string, depth: number) => `find . ${'-exec find . '.repeat(depth)}${inner}${'\\; '.repeat(depth + 1)}`;
  assertLinear('a find chain then a force push', (depth) => `${chain('', depth)}&& ${force}`, (command) => blocked(command), 18);
  assertLinear('a find chain that ends in python', (depth) => chain(`-exec ${py} {} `, depth), (command) => assert.ok(isBlockedByList(command), 'the program at the end of the chain'), 18);
  assertLinear('a find chain of echo', (depth) => chain('-exec echo {} ', depth), (command) => assert.equal(isBlockedByList(command), false, 'a chain that runs no blocked program'), 18);
  shouldBlock([`find . -exec nice ${py} {} +`, `find . -exec echo {} \\; -ok ${py} {} \\;`]);
  const many = `find . ${'-exec echo {} \\; '.repeat(300)}`;
  assert.equal(checkCommand(many, { cwd: process.cwd(), env: {}, config: pythonBlocked })?.id, 'unreadable-command');
  assert.equal(checkCommand(many, { cwd: process.cwd(), env: {} }), null, 'without a block list, nothing to look for');
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

test('blocked commands: one find chain stays under a wide wall-clock budget (#754)', () => {
  // The other linear checks count steps. This one reads the clock, so a hang or a
  // 100x blow-up still fails. The small chain is read enough times to take tens of ms.
  const chain = (inner: string, depth: number) => `find . ${'-exec find . '.repeat(depth)}${inner}${'\\; '.repeat(depth + 1)}`;
  const repeats = 40;
  assertWallSmoke(
    'a find chain then a force push',
    (depth) => `${chain('', depth)}&& ${force}`,
    (command) => {
      for (let i = 0; i < repeats; i++) blocked(command);
    },
    64,
  );
});

test('guard: a build, a test suite, a package install or a container build is a heavy job (#401)', () => {
  for (const command of ['npm test', 'npm ci', 'npm install', 'npm run build', 'nice npm run -s typecheck', 'pnpm test', 'yarn run test', 'bun install', 'node --test test/a.test.ts', 'make', 'cargo build', 'go test ./...', 'docker build .', 'docker compose build', 'tsc -p .', 'pytest -q']) {
    assert.ok(findHeavyJob(command), `should be heavy: ${command}`);
  }
  for (const command of ['git status', 'echo npm test', 'cat build.log', 'npm --version', 'docker ps', 'go version', 'cargo --version', 'npm run dev', 'npm run format', 'node app.js']) {
    assert.equal(findHeavyJob(command), null, `should be light: ${command}`);
  }
});
