// Tests for src/run/cli.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  at,
  CLI,
  makeSandbox,
  manifest,
  MISSING_NODE,
  MISSING_PROJECT,
  pick,
  PLUGIN_ROOT,
} from '../repo/helpers.ts';
import {
  closestWord,
  COMMANDS,
  editDistance,
  guardCommand,
  HELP_OPTIONS,
} from '../../src/run/cli.ts';

// The line goes into a single-quoted echo, and into JSON for Gemini CLI, as it is (#204).
test('guardCommand: refuses a missing-runtime line with a quote or a backslash (#204)', () => {
  for (const line of ["it's gone", 'say "gone"', 'a\\b']) assert.throws(() => guardCommand('p', 'hook', line), /quote or a backslash/, line);
  assert.doesNotThrow(() => guardCommand('p', 'hook', 'yokoten: gone; run the install again'));
});

test('hooks: a missing runtime says one plain line with no path, never a stack trace (#204)', () => {
  const sandbox = makeSandbox();
  // A hook from before #204 is updated in place, never added twice.
  const old = 'node "$HOME/.local/share/yokoten/bin/yokoten.ts" doctor --session';
  mkdirSync(join(sandbox.home, '.claude'));
  // Codex and Gemini CLI get user hooks only when their folders exist (#211).
  mkdirSync(join(sandbox.home, '.codex'));
  mkdirSync(join(sandbox.home, '.gemini'));
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: old }] }] } }));
  assert.match(sandbox.run(['install']).stdout, /^updated the SessionStart doctor$/m);
  assert.equal(sandbox.run(['init']).status, 0);
  rmSync(join(sandbox.home, '.local', 'share', 'yokoten'), { recursive: true });
  rmSync(join(sandbox.repo, '.yokoten'), { recursive: true });
  const shell = (command: string, extra: Record<string, string> = {}) =>
    spawnSync(command, { shell: '/bin/sh', cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PROJECT_DIR: sandbox.repo, GEMINI_PROJECT_DIR: sandbox.repo, ...extra }, input: '{}', encoding: 'utf8' });
  const commands = (file: string) => {
    const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks as Record<string, { hooks: { command: string }[] }[]>;
    return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups.flatMap((g) => g.hooks.map((h) => h.command))]));
  };
  const user = commands(join(sandbox.home, '.claude', 'settings.json'));
  assert.equal(user.SessionStart.length, 1);
  const machineLine = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again\n';
  // At session start the line goes to the agent; a tool call goes on, with the line shown.
  assert.deepEqual(pick(shell(user.SessionStart[0])), [0, machineLine, '']);
  assert.deepEqual(pick(shell(user.PreToolUse[0])), [1, '', machineLine]);
  // The same for Codex and Gemini CLI (#211).
  const codexUser = commands(join(sandbox.home, '.codex', 'hooks.json'));
  const geminiUser = commands(join(sandbox.home, '.gemini', 'settings.json'));
  for (const command of codexUser.SessionStart) assert.deepEqual(pick(shell(command)), [0, machineLine, ''], command);
  // Gemini CLI reads only JSON at session start.
  const geminiStart = shell(geminiUser.SessionStart[0]);
  assert.equal(geminiStart.status, 0, geminiStart.stderr);
  assert.deepEqual(JSON.parse(geminiStart.stdout), { hookSpecificOutput: { additionalContext: machineLine.trimEnd() } });
  for (const command of [...codexUser.PreToolUse, ...geminiUser.BeforeTool]) assert.deepEqual(pick(shell(command)), [1, '', machineLine], command);
  const project = commands(join(sandbox.repo, '.claude', 'settings.json'));
  const projectLine = `${MISSING_PROJECT}\n`;
  const codexProject = commands(join(sandbox.repo, '.codex', 'hooks.json'));
  const geminiProject = commands(join(sandbox.repo, '.gemini', 'settings.json'));
  for (const command of [...project.PreToolUse, ...project.Stop, ...codexProject.PreToolUse.slice(-1), ...codexProject.Stop, ...geminiProject.BeforeTool, ...geminiProject.AfterAgent]) {
    assert.deepEqual(pick(shell(command)), [1, '', projectLine], command);
  }
  // A project path with a space: the `[` test's own error, with the full path, is not shown.
  for (const command of [...geminiProject.BeforeTool, ...geminiProject.AfterAgent]) {
    assert.deepEqual(pick(shell(command, { GEMINI_PROJECT_DIR: join(sandbox.home, 'a b') })), [1, '', projectLine], command);
  }
  // The commit check stops the commit, with one plain line: a commit now would delete .yokoten/.
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', 'a.md');
  const commit = sandbox.git('commit', '-qm', 'a');
  assert.deepEqual(pick(commit), [1, '', 'yokoten: the commit check cannot run, because .yokoten/bin/yokoten.ts is missing. Restore it from git, or run yokoten init again\n']);
  for (const out of [commit.stderr, projectLine, machineLine]) assert.ok(!out.includes(sandbox.home) && !out.includes(sandbox.repo), 'no absolute path');
});

// #42: stdout is data and stderr is for people; --json prints pure JSON. Exit codes are
// written down once (docs/guide.md, "Exit codes") and held here.
test('exit codes: 0 ok, 1 problems or a usage error, 2 the hook blocked (#42)', () => {
  const sandbox = makeSandbox();
  const hook = (command: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  assert.equal(sandbox.run(['check']).status, 0);
  assert.equal(hook('git status').status, 0);
  assert.equal(sandbox.run(['doctor', '--session']).status, 0, 'a session always starts');
  assert.equal(sandbox.run(['explain', 'release']).status, 0);
  assert.equal(sandbox.run(['doctor']).status, 1, 'nothing is installed on this machine: a problem');
  sandbox.write('b.md', `me${at}gmail.com\n`);
  sandbox.git('add', '.');
  assert.equal(sandbox.run(['check']).status, 1);
  assert.equal(sandbox.run(['explain', 'nope']).status, 1);
  assert.equal(hook('git push --tags').status, 2);
  // A usage error is refused, never ignored: no fake success.
  for (const args of [['nope'], ['check', '--stagd'], ['check', '--staged', '--pr'], ['check', 'extra'], ['doctor', '--sesion'], ['hook', '--agent'], ['explain', 'a', 'b']]) {
    const r = sandbox.run(args, { input: '{}' });
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '', `${args.join(' ')}: nothing on stdout`);
    assert.notEqual(r.stderr, '', `${args.join(' ')}: says why on stderr`);
  }
  // With --json, the usage error is JSON on stdout too, and still said on stderr (#280).
  const jsonErrors = [
    ['check', '--json', '--bogus'],
    ['check', '--json', '--staged', '--pr'],
    ['check', '--json', 'extra'],
    ['doctor', '--json', '--bogus'],
    ['explain', '--json', 'a', 'b'],
    ['adopt', '--json', '--x'],
    ['hook', '--json', '--agent', 'nope'],
    ['hook', '--json', '--agent'],
  ];
  for (const args of jsonErrors) {
    const r = sandbox.run(args, { input: '{}' });
    assert.equal(r.status, 1, args.join(' '));
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ['command', 'ok', 'error'], args.join(' '));
    assert.equal(out.command, args[0]);
    assert.equal(out.ok, false);
    assert.match(out.error, /^[^\n]+$/, `${args.join(' ')}: one line`);
    assert.match(r.stderr, new RegExp(`^yokoten ${args[0]}: .+ Run \`yokoten ${args[0]} --help\`\\.\\n$`), args.join(' '));
  }
  // An error past the parser, caught at the top, is JSON too. A broken yokoten.json is
  // such an error: the config is read before any check runs.
  sandbox.write('yokoten.json', '{\n');
  const crashed = sandbox.run(['check', '--json']);
  assert.equal(crashed.status, 1);
  assert.deepEqual({ ...JSON.parse(crashed.stdout), error: 'x' }, { command: 'check', ok: false, error: 'x' });
  assert.match(JSON.parse(crashed.stdout).error, /^yokoten\.json: [^\n]+$/);
  assert.match(crashed.stderr, /^yokoten check: yokoten\.json: /);
});

test('help: every command has --help, -h and `help <command>`; each exits 0 and writes nothing (#207)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const before = () => [sandbox.git('status', '--porcelain', '--ignored').stdout, readdirSync(sandbox.home, { recursive: true }).sort()];
  const start = before();
  for (const command of COMMANDS) {
    for (const args of [[command.name, '--help'], [command.name, '-h'], ['help', command.name], [command.name, '--nope', '--help']]) {
      const r = sandbox.run(args, { input: '{}' });
      assert.deepEqual([r.status, r.stderr], [0, ''], args.join(' '));
      assert.match(r.stdout, new RegExp(`^Usage: yokoten ${command.name}\\b`), args.join(' '));
      for (const option of [...command.options.map((o) => o.name), ...HELP_OPTIONS]) assert.ok(r.stdout.includes(option), `${args.join(' ')}: names ${option}`);
      assert.match(r.stdout, /\nExample:\n {2}\S/, `${args.join(' ')}: one example`);
    }
  }
  assert.deepEqual(before(), start, '--help writes nothing');
  // The command list names every command, and -h and -v work alone.
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const r = sandbox.run(args);
    assert.equal(r.status, 0, args.join(' '));
    for (const command of COMMANDS) assert.match(r.stdout, new RegExp(`^ {2}${command.name} `, 'm'), `${args.join(' ')}: lists ${command.name}`);
  }
  assert.equal(sandbox.run(['-v']).stdout, sandbox.run(['--version']).stdout);
});

test('compile cache: a cache folder that cannot be made does not stop the command (#286)', () => {
  const sandbox = makeSandbox();
  // A file where the folder should be: Node can't create the cache there.
  const file = join(sandbox.home, 'not-a-folder');
  writeFileSync(file, '');
  const r = sandbox.run(['--version'], { extra: { NODE_COMPILE_CACHE: file } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('help: the help table and the parser list the same commands and options (#207)', () => {
  // The dispatch is in bin/main.ts; each command's parse call is in its module in src/commands/ (#330).
  const commandsDir = join(dirname(CLI), '..', 'src', 'commands');
  const source = [join(dirname(CLI), 'main.ts'), ...readdirSync(commandsDir).map((file) => join(commandsDir, file))].map((file) => readFileSync(file, 'utf8')).join('\n');
  // Every parse call names a command in the table; no option list is written outside it.
  const parsed = [...source.matchAll(/\bparse\('([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...parsed].sort(), COMMANDS.map((command) => command.name).sort(), 'each command parses its words by its help entry');
  assert.doesNotMatch(source, /flags: \[/, 'no option list outside the help table');
  const cases = [...source.matchAll(/^ {4}case '([a-z]+)':/gm)].map((m) => m[1]);
  assert.deepEqual([...cases].sort(), COMMANDS.map((command) => command.name).sort(), 'each command in the switch has a help entry, and the reverse');
  // Each option the help lists is accepted: with it, the parser gives no "unknown option".
  const sandbox = makeSandbox();
  for (const command of COMMANDS) {
    for (const option of command.options) {
      const r = sandbox.run([command.name, option.name, ...(option.value ? ['x'] : []), '--not-an-option']);
      assert.match(r.stderr, new RegExp(`unknown option --not-an-option`), `${command.name} ${option.name}`);
    }
  }
});

test('help: a typo in a command or an option names the closest one; a far one lists the commands (#207)', () => {
  const sandbox = makeSandbox();
  const cases: [string[], string][] = [
    [['docter'], 'yokoten: unknown command "docter". Did you mean "doctor"? Run `yokoten help`.\n'],
    [['help', 'chek'], 'yokoten: unknown command "chek". Did you mean "check"? Run `yokoten help`.\n'],
    [['check', '--stagd'], 'yokoten check: unknown option --stagd. Did you mean --staged? Run `yokoten check --help`.\n'],
    [['doctor', '--hepl'], 'yokoten doctor: unknown option --hepl. Did you mean --help? Run `yokoten doctor --help`.\n'],
  ];
  for (const [args, stderr] of cases) assert.deepEqual(pick(sandbox.run(args, { input: '{}' })), [1, '', stderr], args.join(' '));
  const far = sandbox.run(['zzzzzz']);
  assert.deepEqual([far.status, far.stdout], [1, '']);
  assert.match(far.stderr, /^yokoten: unknown command "zzzzzz"\. Commands: install, init, .*version\. Run `yokoten help`\.\n$/);
  assert.equal(editDistance('docter', 'doctor'), 1);
  assert.equal(closestWord('xyz', ['doctor', 'check']), undefined, 'more than two edits: no guess');
});

// A guard that crashes, runs out of memory or is killed must refuse the call: the agents
// run a call on any exit but 2 (#260). Each tool-call hook, as init, install and the plugin
// write it, runs through sh with its runtime replaced by a script that ends one way.
test('hooks: a tool-call guard that fails refuses the call; the stop check does not (#260)', () => {
  const sandbox = makeSandbox();
  // Codex and Gemini CLI are installed, so install writes their home hooks too.
  for (const dir of ['.codex', '.gemini']) mkdirSync(join(sandbox.home, dir), { recursive: true });
  assert.equal(sandbox.run(['install']).status, 0);
  assert.equal(sandbox.run(['init']).status, 0);
  const commands = (file: string) => {
    const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks as Record<string, { hooks: { command: string }[] }[]>;
    return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups.flatMap((g) => g.hooks.map((h) => h.command))]));
  };
  const project = commands(join(sandbox.repo, '.claude', 'settings.json'));
  const codex = commands(join(sandbox.repo, '.codex', 'hooks.json'));
  const gemini = commands(join(sandbox.repo, '.gemini', 'settings.json'));
  const user = commands(join(sandbox.home, '.claude', 'settings.json'));
  const codexUser = commands(join(sandbox.home, '.codex', 'hooks.json'));
  const geminiUser = commands(join(sandbox.home, '.gemini', 'settings.json'));
  const plugin = (manifest('plugin.json').hooks.PreToolUse[0].hooks[0].command as string).replaceAll(PLUGIN_ROOT, '$PLUGIN');
  const calls = [...project.PreToolUse, ...codex.PreToolUse.slice(-1), ...gemini.BeforeTool.slice(-1), ...user.PreToolUse, ...codexUser.PreToolUse, ...geminiUser.BeforeTool, plugin];
  assert.equal(calls.length, 7);
  // The project, the home and the plugin all sit under a path with a space.
  const base = join(sandbox.home, 'a b');
  const repo = join(base, 'my repo');
  const home = join(base, 'home');
  const pluginRoot = join(base, 'plugin');
  mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const runtimes = [join(repo, '.yokoten', 'bin', 'yokoten.ts'), join(home, '.local', 'share', 'yokoten', 'bin', 'yokoten.ts'), join(pluginRoot, 'bin', 'yokoten.ts')];
  const runtime = (body: string) => {
    for (const file of runtimes) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
  };
  const env = { ...sandbox.env, HOME: home, CLAUDE_PROJECT_DIR: repo, GEMINI_PROJECT_DIR: repo, PLUGIN: pluginRoot };
  // Gemini CLI puts $GEMINI_PROJECT_DIR in the command shell-quoted itself, as shell-quote writes it.
  const quoted = `'${repo.replaceAll("'", "'\\''")}'`;
  // dash (Linux's /bin/sh) and bash each print a job line for a killed child; bash's holds
  // the whole command, paths included. Each command runs under both.
  const shells = ['/bin/sh', '/bin/bash'].filter((sh) => existsSync(sh));
  const shell = (command: string, sh = '/bin/sh', extra: Record<string, string> = {}) =>
    spawnSync(command.replaceAll('$GEMINI_PROJECT_DIR', quoted), { shell: sh, cwd: repo, env: { ...env, ...extra }, input: '{}', encoding: 'utf8' });
  const each = (commands: string[], expected: unknown[]) => {
    for (const sh of shells) for (const command of commands) assert.deepEqual(pick(shell(command, sh)), expected, `${sh}: ${command}`);
  };
  const refused = (code: number) => `yokoten's guard failed (exit ${code}), so the command is refused; run \`yokoten doctor\`\n`;
  // A failure gives our one line on stderr and nothing else: node's own error is dropped.
  runtime("process.stderr.write('a trace with /a/path\\n'); process.exit(1);\n");
  each(calls, [2, '', refused(1)]);
  runtime("process.stderr.write('/a/path\\n'); process.kill(process.pid, 'SIGKILL');\n");
  each(calls, [2, '', refused(137)]);
  // A guard's own answer passes as it is, stdout and stderr byte for byte.
  runtime("process.stdout.write('{\"a\":1}\\n\\n'); process.stderr.write('note\\n\\n'); process.exit(0);\n");
  each(calls, [0, '{"a":1}\n\n', 'note\n\n']);
  runtime("process.stdout.write('{}'); process.stderr.write('no\\n'); process.exit(2);\n");
  each(calls, [2, '{}', 'no\n']);
  // A runaway read stops at the small heap and is refused, without swapping, and without
  // the heap trace V8 writes.
  runtime('const a = []; for (;;) a.push(new Array(1e6).fill(1));\n');
  each([project.PreToolUse[0], plugin], [2, '', refused(134)]);
  // No node on the agent's PATH: one line, and the call goes on, so `yokoten doctor` can run.
  const noNode = join(base, 'no-node');
  mkdirSync(noNode);
  symlinkSync(spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(noNode, 'git'));
  runtime('process.exit(0);\n');
  for (const sh of shells) for (const command of calls) assert.deepEqual(pick(shell(command, sh, { PATH: noNode })), [1, '', `${MISSING_NODE}\n`], `${sh}: ${command}`);
  // The stop check and the session doctor pass a failure on: exit 2 at stop would send the
  // agent back to work on a guard that cannot run.
  runtime('process.exit(1);\n');
  for (const command of [...project.Stop, ...codex.Stop, ...gemini.AfterAgent, ...user.SessionStart, ...codexUser.SessionStart, ...geminiUser.SessionStart]) {
    assert.deepEqual(pick(shell(command)), [1, '', ''], command);
  }
  // A missing runtime still says its line and goes on, as before.
  for (const file of runtimes) rmSync(file);
  const machineLine = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again\n';
  each([...project.PreToolUse, ...codex.PreToolUse.slice(-1), ...gemini.BeforeTool.slice(-1)], [1, '', `${MISSING_PROJECT}\n`]);
  each([...user.PreToolUse, ...codexUser.PreToolUse, ...geminiUser.BeforeTool], [1, '', machineLine]);
});

// #174: the pitch demo runs end to end, offline, in a temp folder it removes, and never
// touches this repo's kit.
test('demo: scripts/demo/loop.ts walks the loop from an incident to a doctor note, and leaves nothing', () => {
  const temp = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const kitTable = join(dirname(CLI), '..', 'kit', 'lessons', 'README.md');
  const before = readFileSync(kitTable, 'utf8');
  const result = spawnSync('node', [join(dirname(CLI), '..', 'scripts', 'demo', 'loop.ts')], { env: { PATH: process.env.PATH, HOME: join(temp, 'home'), TMPDIR: temp }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\n\$ yokoten learn https:\/\/github\.com\/octo-org\/project-a\/issues\/12\nyokoten learn: a check draft from issue #12, /);
  assert.match(result.stdout, /\nWrote:\n- lessons\/incident-12\/lesson\.ts\n/);
  assert.match(result.stdout, /\nyokoten learn --ship: 2 problem\(s\); nothing was moved:\n- lessons\/incident-12\/lesson\.ts still has 1 TODO\(reviewer\)/);
  assert.match(result.stdout, /\n\+ {2}what: 'a test calls a server on this machine and does not set NO_PROXY',\n/);
  // The lesson lands in the kit in its own folder, flat or under a group folder (#171).
  assert.match(result.stdout, /\nyokoten learn --ship: incident-12 is in kit\/lessons\/(?:[^/\s]+\/)?incident-12\//);
  assert.match(result.stdout, /\n {2}note {4}lesson incident-12: test\/api\.test\.js: a test calls a server on this machine and does not set NO_PROXY; set NO_PROXY/);
  assert.match(result.stdout, /\nDone in \d+\.\ds: /);
  assert.deepEqual(readdirSync(temp), [], 'the demo folder is gone');
  assert.equal(readFileSync(kitTable, 'utf8'), before, 'the real kit is not touched');
  rmSync(temp, { recursive: true, force: true });
});
