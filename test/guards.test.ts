import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, type Env } from '../src/rules/config.ts';
import { checkCommand, checkEdit, commandWords, hookFile, runsCheck } from '../src/rules/guards.ts';

const blocked = (command: string, env: Env = {}) => assert.ok(checkCommand(command, { env }), `should block: ${command}`);
const allowed = (command: string, env: Env = {}) => assert.equal(checkCommand(command, { env }), null, `should allow: ${command}`);

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

// The hooks setting in a project with its own hooks folder (#217). A repo with husky's
// pre-commit running the check, a folder without it, and core.hooksPath set to `hooks/own`.
function makeHooksRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'yokoten-hooks-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.hooksPath', 'hooks/own');
  mkdirSync(join(root, '.husky'));
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\nnpx lint-staged\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\n');
  mkdirSync(join(root, 'hooks', 'plain'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'plain', 'pre-commit'), '#!/bin/sh\n# yokoten check is not run here\nnpm test\n');
  return root;
}

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

test('hooks setting: only a line that runs yokoten check counts, not a comment (#217)', () => {
  assert.equal(runsCheck('#!/bin/sh\nnode "bin/yokoten.ts" check --staged\n'), true);
  assert.equal(runsCheck('npx yokoten check || exit 1\r\n'), true);
  assert.equal(runsCheck('#!/bin/sh\n# yokoten check\nnpm test\n'), false);
  assert.equal(runsCheck('node bin/yokoten.ts checkout\n'), false);
  assert.equal(hookFile('/repo', '.husky/_'), '.husky/pre-commit');
  assert.equal(hookFile('/repo', '../other'), null);
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
  for (const p of ['AGENTS.md', 'CLAUDE.md', 'yokoten.json', '.claude/settings.json', '.claude-plugin/plugin.json', '.codex/hooks.json', '.gemini/settings.json', '.github/workflows/ci.yml', '.githooks/pre-commit']) {
    assert.ok(checkEdit(p, { config: DEFAULTS, env: worker }), p);
    assert.equal(checkEdit(p, { config: DEFAULTS, env: {} }), null, p);
  }
  // A glob with a slash is the root's folder only; one without matches in any folder.
  assert.ok(checkEdit('kit/project/AGENTS.md', { config: DEFAULTS, env: worker }));
  assert.equal(checkEdit('kit/project/.github/workflows/x.yml', { config: DEFAULTS, env: worker }), null);
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
    "gh issue create --title x --body-file - <<'EOF'\ngh release create v1\nEOF",
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

// #192: a project blocks programs in yokoten.json "commands.block", each with its reason.
const pythonBlocked = { commands: { block: { python: 'TypeScript only', python3: 'this project is TypeScript only (AGENTS.md).' } } };
const isBlockedByList = (command: string, config: { commands: { block: Record<string, string> } } = pythonBlocked) => checkCommand(command, { env: {}, config })?.id === 'blocked-command';

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
