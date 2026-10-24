import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { checkCommand, runsCheck } from '../../../../../src/rules/guards/index.ts';
import { blocked, allowed, pythonBlocked, force } from '../../../../../test/repo/helpers.ts';
import { assertLinear, assertLinearEach } from '../../../../../scripts/linear.ts';

test('bash: a command of 100k words is read in linear time (#226)', () => {
  const commands: [string, (n: number) => string][] = [
    ['echo a', (n) => `echo ${'a '.repeat(n)}`],
    ['then', (n) => `${'then '.repeat(n)}echo`],
    ['env', (n) => `${'env '.repeat(n)}echo`],
    ['sudo', (n) => `${'sudo '.repeat(n)}echo`],
    ['GIT_CONFIG_PARAMETERS', (n) => `${'GIT_CONFIG_PARAMETERS=x '.repeat(n)}git status`],
  ];
  // From 3125 words to 8 times that.
  assertLinearEach(
    commands.map(([name, make]) => ({
      name: `${name} words`,
      make,
      read: (command: string) => assert.equal(checkCommand(command, { cwd: process.cwd(), env: {}, config: pythonBlocked }), null, name),
    })),
    3125,
  );
  blocked(`echo ${'a '.repeat(100000)}; ${force}`);
});

test('bash: an unclosed $( is read once, not again at each level (#226)', () => {
  blocked(`${'echo $(a '.repeat(30)}; ${force}`);
  // From 1250 repeats to 10k, the work grows like the text.
  for (const shape of ['echo $(a ', 'echo "$(a ', 'cat <(a ', '((', 'echo `a ']) {
    assertLinear(`${shape} unclosed`, (n) => `${shape.repeat(n)}; ${force}`, (command) => assert.ok(checkCommand(command, { cwd: process.cwd(), env: {} }), `${shape} unclosed then a force push should block`), 1250);
  }
  // What an unclosed $( holds is still read: a force push inside it blocks, a read passes.
  blocked(`echo $(${force}`);
  allowed('echo $(git status');
});

test('bash: a heredoc pipeline is read in linear time (#226)', () => {
  // From 1000 heredocs to 8000.
  const pipeline = (reader: string, body: string, n: number) => `${'cat <<E | '.repeat(n)}${reader}\n${`${body}\nE\n`.repeat(n)}`;
  assertLinear('a heredoc pipeline into cat', (n) => pipeline('cat', force, n), (command) => assert.equal(checkCommand(command, { cwd: process.cwd(), env: {} }), null, 'bodies piped into cat are data'), 1000);
  assertLinear('a heredoc pipeline into bash', (n) => pipeline('bash', force, n), (command) => assert.equal(checkCommand(command, { cwd: process.cwd(), env: {} })?.id, 'force-push', 'bodies piped into bash are commands'), 1000);
});

test('bash: nested constructs are read in linear time and never throw (#226)', () => {
  // From 256 repeats to 2048. A loop that reads the text again for each character
  // counts many times over 8x here.
  assertLinearEach(nestedCases, 256);
});

test('bash: nested constructs up to 1000 repeats never throw, and a force push before them blocks (#226)', () => {
  // At 1000 repeats some shapes already run out of the work budget and are refused (more do at
  // 8000, which took 10 s here): that path, too, must not throw. The reader goes only 8 levels
  // deep (MAX_DEPTH), so more repeats than this test the budget again, not the stack. One read
  // each; the work is proved at the sizes above.
  for (const { make, read } of nestedCases) read(make(1000));
});

test('bash and hooks: loops that never spent the budget read a thousand repeats in linear time (#226)', () => {
  const guards = join(process.cwd(), 'src/rules/guards/index.ts');
  const linear = join(process.cwd(), 'scripts/linear.ts');
  type Part = string | [string];
  type Case = { mode: 'command' | 'hook'; parts: Part[]; want: string; size?: number };
  const cases: Case[] = [];
  const run = (mode: Case['mode'], parts: Part[], want: string, size?: number) => cases.push({ mode, parts, want, size });
  // The code is fixed text: every value goes in on stdin, so nothing is spliced into code.
  const code = [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "const { guards, linear, config, cwd, cases, repeats } = JSON.parse(readFileSync(0, 'utf8'));",
    'const { checkCommand, runsCheck } = await import(guards);',
    'const { assertLinearEach } = await import(linear);',
    "const make = (parts, n) => parts.map((part) => (typeof part === 'string' ? part : part[0].repeat(n))).join('');",
    "const read = (mode, text) => (mode === 'hook' ? String(runsCheck(text)) : (checkCommand(text, { env: {}, config, cwd })?.id ?? 'allow'));",
    'const name = (parts) => JSON.stringify(parts).slice(0, 60);',
    // The count is at `repeats` and at 8 times that. What 8n gives is checked on its own.
    'assertLinearEach(cases.map(({ mode, parts }) => ({ name: name(parts), make: (n) => make(parts, n), read: (text) => void read(mode, text) })), repeats);',
    'for (const { mode, parts, want, size } of cases) if (size === undefined) assert.equal(read(mode, make(parts, 8 * repeats)), want, name(parts));',
    'for (const { mode, parts, want, size } of cases) if (size !== undefined) assert.equal(read(mode, make(parts, size)), want, name(parts));',
  ].join('\n');
  const keys: Part = ['GIT_CONFIG_KEY_0=core.hooksPath '];
  const commands: [Part[], string, number?][] = [
    [[['-/env ']], 'allow'],
    [[`${force}; `, ['-/env ']], 'force-push'],
    [['find . ', ['-exec env ']], 'allow'],
    [[`${force}; find . `, ['-exec env ']], 'force-push'],
    [['find . ', ['-exec env -u ']], 'allow'],
    [['find . ', ['-exec timeout ']], 'allow'],
    [['find . ', ['-exec > ']], 'allow'],
    [[keys, 'GIT_CONFIG_VALUE_0=/x git status'], 'hooks-path'],
    // #283: each new reader.
    [[['{ echo a; '], ['} '], '| bash'], 'allow'],
    [[['if a; then echo a; '], ['fi; ']], 'allow'],
    [[['for a in b; do '], 'echo a', ['; done'], ' | cat'], 'allow'],
    // What 100k substitutions print, handed to a shell, is too many commands to read: refused, in time.
    [['bash ', ['<(echo a) ']], 'unreadable-command', 100_000],
    [['eval "', ['$(echo a)'], '"'], 'unreadable-command', 100_000],
    [['echo a | xargs ', ['-0 '], 'git status'], 'allow'],
    [["env -S'git status ", ['${X}'], "'"], 'allow'],
    // #308: a printf format said again for each argument, and substitutions printed into a pipe.
    [["printf '%s\\n' status ", ['a '], '| xargs git'], 'allow'],
    [["printf '", ['x'], "%s' status ", ['a '], '| xargs git'], 'allow'],
    [["printf '", ['%s'], "\\n' git status | bash"], 'allow'],
    [['cat ', ['<(echo a) '], '| bash'], 'unreadable-command', 100_000],
    [['echo "', ['$(echo a)'], '" | xargs git status'], 'allow'],
    // #314: a long chain of pass-throughs hands the first command's text to the shell.
    [['echo a ', ['| cat '], '| bash'], 'allow'],
    [[`echo '${force}' `, ['| cat '], '| bash'], 'force-push'],
    [[`cat <(echo '${force}') `, ['| tee f '], '| bash'], 'force-push'],
  ];
  for (const [parts, want, size] of commands) run('command', parts, want, size);
  // A line that opens more than it closes leaves the check inside a block; a pipe at the end
  // of each line joins the check to the pipeline.
  for (const open of ['$((((', '$(', '${']) run('hook', ['#!/bin/sh\n', [open], '\nnpx yokoten check\n'], 'false');
  run('hook', ['#!/bin/sh\n', ['a |\n'], 'npx yokoten check\n'], 'false');
  const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', code], { input: JSON.stringify({ guards: pathToFileURL(guards).href, linear: pathToFileURL(linear).href, config: pythonBlocked, cwd: tmpdir(), cases, repeats: 512 }), encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, `the linear reads failed: ${child.signal ?? child.error ?? child.stderr.slice(0, 1200)}`);
  // The linear reads keep what the old ones found: a closed $( and quotes cut no block.
  for (const line of ['x="(" y=\'{\' z=${a:-x} w=$(echo a) v=$((1 + (2)))', 'echo "a\\"(" \'"\'']) {
    assert.equal(runsCheck(`#!/bin/sh\n${line}\nnpx yokoten check\n`), true, line);
  }
  assert.equal(runsCheck('#!/bin/sh\necho "(" (\nnpx yokoten check\n'), false, 'a ( outside the quotes');
});

// Shapes that nest or chain, each alone, before a force push and after one.
const nestedShapes = [
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

const nestedForms: [string, (text: string) => string][] = [
  ['alone', (text) => text],
  ['then a force push', (text) => `${text}\n${force}`],
  ['after a force push', (text) => `${force}; ${text}`],
];
// Each read never throws, and a force push before the shapes blocks.

// Each read never throws, and a force push before the shapes blocks.
const nestedCases = nestedShapes.flatMap((shape) =>
  nestedForms.map(([form, wrap]) => {
    const name = `${JSON.stringify(shape)} ${form}`;
    const read = (command: string) => {
      let result: ReturnType<typeof checkCommand> = null;
      assert.doesNotThrow(() => {
        result = checkCommand(command, { cwd: process.cwd(), env: {}, config: pythonBlocked });
      }, name);
      if (command.startsWith(force)) assert.ok(result, `${name} should block`);
    };
    return { name, make: (n: number) => wrap(shape.repeat(n)), read };
  }),
);
