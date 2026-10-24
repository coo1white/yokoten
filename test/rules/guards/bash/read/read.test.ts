import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { checkCommand, commandWords } from '../../../../../src/rules/guards/index.ts';
import { blocked, allowed, force, hookEnvironment, refusedAs, isBlockedByList, py, shouldPass } from '../../../../../test/repo/helpers.ts';
import { invoke } from '../../../../../test/repo/invoke.ts';

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

test('bash: a command the reader cannot read is refused with exit 2, not let through (#226)', async () => {
  // So many commands in one shell string that reading them throws (too many to spread).
  const tooBig = `bash -c "${':;'.repeat(300000)}"`;
  assert.equal(checkCommand(tooBig, { cwd: process.cwd(), env: {} })?.id, 'unreadable-command');
  const done = await invoke(['hook'], {
    env: hookEnvironment(),
    cwd: tmpdir(),
    stdin: JSON.stringify({ cwd: tmpdir(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: tooBig } }),
  });
  const hook = { status: done.code, stderr: done.stderr };
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

test('bash: xargs hands what comes in to its program (#283)', () => {
  const pushForce = force.split(' ').slice(1).join(' ');
  refusedAs(`xargs -0 git <<'E'\n${pushForce}\nE`, 'force-push');
  refusedAs(`echo ${pushForce} | xargs git`, 'force-push');
  refusedAs(`echo ${pushForce} | xargs -n 9 -P 2 git`, 'force-push');
  allowed(`xargs git add <<'E'\na.ts\nE`);
  allowed('echo a.ts | xargs git add');
  allowed(`echo ${pushForce} | xargs echo`);
});
