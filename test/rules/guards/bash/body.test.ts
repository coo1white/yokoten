import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandWords } from '../../../../src/rules/guards/index.ts';
import { blocked, allowed } from '../../../../test/repo/helpers.ts';

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
