// Tests for src/run/cli.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  at,
  CLI,
  makeSandbox,
  manifest,
  MISSING_NODE,
  MISSING_PROJECT,
  pick,
  PLUGIN_ROOT,
  makeTempDir,
} from '../repo/helpers.ts';
import { invoke } from '../repo/invoke.ts';
import {
  closestWord,
  COMMANDS,
  editDistance,
  guardCommand,
  HELP_OPTIONS,
  PLUGIN_COPY_GONE,
  PLUGIN_GUARD_MISSING,
  PLUGIN_SESSION_MISSING,
  runs,
  subcommand,
} from '../../src/run/cli.ts';

// The line goes into a single-quoted echo, and into JSON for Gemini CLI, as it is (#204).
test('guardCommand: refuses a missing-runtime line with a quote or a backslash (#204)', () => {
  for (const line of ["it's gone", 'say "gone"', 'a\\b']) assert.throws(() => guardCommand('p', 'hook', line), /quote or a backslash/, line);
  assert.doesNotThrow(() => guardCommand('p', 'hook', 'yokoten: gone; run the install again'));
});

test('hooks: a missing runtime says one plain line with no path, never a stack trace (#204)', async () => {
  const sandbox = makeSandbox();
  // A hook from before #204 is updated in place, never added twice.
  const old = 'node "$HOME/.local/share/yokoten/bin/yokoten.ts" doctor --session';
  mkdirSync(join(sandbox.home, '.claude'));
  // Codex and Gemini CLI get user hooks only when their folders exist (#211).
  mkdirSync(join(sandbox.home, '.codex'));
  mkdirSync(join(sandbox.home, '.gemini'));
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: old }] }] } }));
  assert.match((await sandbox.call(['install'])).stdout, /^updated the SessionStart doctor$/m);
  assert.equal((await sandbox.call(['init'])).status, 0);
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
  for (const command of [...project.PreToolUse, ...project.Stop, ...project.SubagentStop, ...codexProject.PreToolUse.slice(-1), ...codexProject.Stop, ...geminiProject.BeforeTool, ...geminiProject.AfterAgent]) {
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
// written down once (docs/guide.md, "Exit codes") and held here. The hook runs as a real
// child of bin/yokoten.ts, end to end; the rest runs in-process (#475).
test('exit codes: 0 ok, 1 problems or a usage error, 2 the hook blocked (#42)', async () => {
  const sandbox = makeSandbox();
  // The hook reads stdin, so it runs as a child.
  const run = async (words: string[]) => {
    if (words[0] !== 'hook') return invoke(words, { env: sandbox.env, cwd: sandbox.repo });
    const child = sandbox.run(words, { input: '{}' });
    return { code: child.status, stdout: child.stdout, stderr: child.stderr };
  };
  const hook = (command: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  assert.equal((await run(['check'])).code, 0);
  assert.equal(hook('git status').status, 0);
  assert.equal((await run(['doctor', '--session'])).code, 0, 'a session always starts');
  assert.equal((await run(['explain', 'release'])).code, 0);
  assert.equal((await run(['doctor'])).code, 1, 'nothing is installed on this machine: a problem');
  sandbox.write('b.md', `me${at}gmail.com\n`);
  sandbox.git('add', '.');
  assert.equal((await run(['check'])).code, 1);
  assert.equal((await run(['explain', 'nope'])).code, 1);
  assert.equal(hook('git push --tags').status, 2);
  // A usage error is refused, never ignored: no fake success.
  for (const args of [['nope'], ['check', '--stagd'], ['check', '--staged', '--pr'], ['check', 'extra'], ['doctor', '--sesion'], ['hook', '--agent'], ['explain', 'a', 'b']]) {
    const r = await run(args);
    assert.equal(r.code, 1, args.join(' '));
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
    const r = await run(args);
    assert.equal(r.code, 1, args.join(' '));
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
  const crashed = await run(['check', '--json']);
  assert.equal(crashed.code, 1);
  assert.deepEqual({ ...JSON.parse(crashed.stdout), error: 'x' }, { command: 'check', ok: false, error: 'x' });
  assert.match(JSON.parse(crashed.stdout).error, /^yokoten\.json: [^\n]+$/);
  assert.match(crashed.stderr, /^yokoten check: yokoten\.json: /);
});

test('help: every command has --help, -h and `help <command>`; each exits 0 and writes nothing (#207)', async () => {
  const sandbox = makeSandbox();
  const run = (words: string[]) => invoke(words, { env: sandbox.env, cwd: sandbox.repo });
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const before = () => [sandbox.git('status', '--porcelain', '--ignored').stdout, readdirSync(sandbox.home, { recursive: true }).sort()];
  const start = before();
  for (const command of COMMANDS) {
    for (const args of [[command.name, '--help'], [command.name, '-h'], ['help', command.name], [command.name, '--nope', '--help']]) {
      const r = await run(args);
      assert.deepEqual([r.code, r.stderr], [0, ''], args.join(' '));
      assert.match(r.stdout, new RegExp(`^Usage: yokoten ${command.name}\\b`), args.join(' '));
      for (const option of [...command.options.map((o) => o.name), ...HELP_OPTIONS]) assert.ok(r.stdout.includes(option), `${args.join(' ')}: names ${option}`);
      assert.match(r.stdout, /\nExample:\n {2}\S/, `${args.join(' ')}: one example`);
    }
  }
  assert.deepEqual(before(), start, '--help writes nothing');
  // The command list names every command, and -h and -v work alone.
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const r = await run(args);
    assert.equal(r.code, 0, args.join(' '));
    for (const command of COMMANDS) assert.match(r.stdout, new RegExp(`^ {2}${command.name} `, 'm'), `${args.join(' ')}: lists ${command.name}`);
  }
  assert.equal((await run(['-v'])).stdout, (await run(['--version'])).stdout);
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

// #408: the agent hooks now run yokoten.mjs; hooks an older yokoten wrote run yokoten.ts.
// Setup and doctor find both, so init updates an old hook in place.
test('hooks: a hook that runs yokoten.ts or yokoten.mjs is yokoten\'s (#408)', () => {
  for (const file of ['yokoten.ts', 'yokoten.mjs']) {
    const command = `node "$CLAUDE_PROJECT_DIR/.yokoten/bin/${file}" hook --stop`;
    assert.equal(subcommand(command), 'hook', file);
    assert.ok(runs('hook').test(command), file);
  }
  assert.equal(subcommand('node bin/yokoten.mts hook'), undefined);
});

// #298: a package runner that starts the published yokoten counts, with its flags.
test('runs: a package runner with flags runs yokoten; another command does not (#298, #431)', () => {
  for (const command of ['npx yokoten check', 'npx --yes yokoten check', 'npx -y yokoten@0.1.0 check', '  bunx yokoten check', 'pnpm dlx yokoten check', 'npm exec -- yokoten check', 'run: |\n  npx -y yokoten check\n']) {
    assert.ok(runs('check').test(command), command);
  }
  for (const command of ['echo npx yokoten check', 'npx yokoten-check', 'npx yokoten checker', 'npx -yyokoten check', 'npxyokoten check']) {
    assert.ok(!runs('check').test(command), command);
  }
  assert.ok(runs('check --pr').test('npx -y yokoten check --pr'));
  assert.ok(!runs('check(?!\\s+--(?:pr|issue))').test('npx -y yokoten check --pr'));
});

// #431: the flags are read one word at a time. A regex that repeated a group over the line
// threw a RangeError here. About 40 MB per line: one byte a character.
test('runs: a 40,000,000-character line of flags does not throw (#431)', () => {
  const flags = ' -y'.repeat(40_000_000 / 3);
  assert.equal(runs('check').test(`npx${flags} yokoten check`), true);
  assert.equal(runs('check').test(`npx${flags} other check`), false);
});

// #408: the hooks run bin/yokoten.mjs, which keeps the compile cache in the user's cache
// folder: a restart may empty the temp folder. NODE_COMPILE_CACHE still names another.
test('compile cache: bin/yokoten.mjs keeps it in the user cache folder, or in NODE_COMPILE_CACHE (#408)', () => {
  const sandbox = makeSandbox();
  const entry = join(dirname(CLI), 'yokoten.mjs');
  const cache = join(sandbox.home, 'xdg-cache');
  const env: Record<string, string | undefined> = { ...sandbox.env };
  delete env.NODE_COMPILE_CACHE;
  const run = (extra: Record<string, string>) => spawnSync(process.execPath, [entry, '--version'], { cwd: sandbox.repo, env: { ...env, ...extra }, encoding: 'utf8' });
  let r = run({ XDG_CACHE_HOME: cache });
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  if (process.platform === 'linux') assert.ok(readdirSync(join(cache, 'yokoten')).length > 0, 'the cache is in $XDG_CACHE_HOME/yokoten');
  const named = join(sandbox.home, 'named-cache');
  r = run({ XDG_CACHE_HOME: cache, NODE_COMPILE_CACHE: named });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(named), 'NODE_COMPILE_CACHE wins');
});

test('help: the help table and the parser list the same commands and options (#207)', async () => {
  // The dispatch is in bin/main.ts; each command's parse call is in its module under src/commands/ (#330), subfolders too.
  const commandsDir = join(dirname(CLI), '..', 'src', 'commands');
  const source = [join(dirname(CLI), 'main.ts'), ...readdirSync(commandsDir, { recursive: true }).map(String).filter((file) => file.endsWith('.ts')).map((file) => join(commandsDir, file))].map((file) => readFileSync(file, 'utf8')).join('\n');
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
      const r = await invoke([command.name, option.name, ...(option.value ? ['x'] : []), '--not-an-option'], { env: sandbox.env, cwd: sandbox.repo });
      // `marks` never repeats an unknown word, which may be a mark (#447): it says "an unknown option".
      assert.match(r.stderr, command.name === 'marks' ? /an unknown option/ : /unknown option --not-an-option/, `${command.name} ${option.name}`);
    }
  }
});

test('help: a typo in a command or an option names the closest one; a far one lists the commands (#207)', async () => {
  const sandbox = makeSandbox();
  const run = (words: string[]) => invoke(words, { env: sandbox.env, cwd: sandbox.repo });
  const cases: [string[], string][] = [
    [['docter'], 'yokoten: unknown command "docter". Did you mean "doctor"? Run `yokoten help`.\n'],
    [['help', 'chek'], 'yokoten: unknown command "chek". Did you mean "check"? Run `yokoten help`.\n'],
    [['check', '--stagd'], 'yokoten check: unknown option --stagd. Did you mean --staged? Run `yokoten check --help`.\n'],
    [['doctor', '--hepl'], 'yokoten doctor: unknown option --hepl. Did you mean --help? Run `yokoten doctor --help`.\n'],
  ];
  for (const [args, stderr] of cases) {
    const r = await run(args);
    assert.deepEqual([r.code, r.stdout, r.stderr], [1, '', stderr], args.join(' '));
  }
  const far = await run(['zzzzzz']);
  assert.deepEqual([far.code, far.stdout], [1, '']);
  assert.match(far.stderr, /^yokoten: unknown command "zzzzzz"\. Commands: install, init, .*version\. Run `yokoten help`\.\n$/);
  assert.equal(editDistance('docter', 'doctor'), 1);
  assert.equal(closestWord('xyz', ['doctor', 'check']), undefined, 'more than two edits: no guess');
});

// A guard that crashes, runs out of memory or is killed must refuse the call: the agents
// run a call on any exit but 2 (#260). Each direct tool-call hook runs through sh, with its
// runtime replaced by a script that ends one way. The plugin guard goes through runLaunch.
test('hooks: a tool-call guard that fails refuses the call; the stop check does not (#260)', async () => {
  const sandbox = makeSandbox();
  // Codex and Gemini CLI are installed, so install writes their home hooks too.
  for (const dir of ['.codex', '.gemini']) mkdirSync(join(sandbox.home, dir), { recursive: true });
  assert.equal((await sandbox.call(['install'])).status, 0);
  assert.equal((await sandbox.call(['init'])).status, 0);
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
  // The shell runs the six direct guards. The plugin guard is runLaunch, below.
  const directCalls = calls.filter((command) => command !== plugin);
  // The project, the home and the plugin all sit under a path with a space.
  const base = join(sandbox.home, 'a b');
  const repo = join(base, 'my repo');
  const home = join(base, 'home');
  const pluginRoot = join(base, 'plugin');
  mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  // The agent hooks run yokoten.mjs (#408).
  const runtimes = [join(repo, '.yokoten', 'bin', 'yokoten.mjs'), join(home, '.local', 'share', 'yokoten', 'bin', 'yokoten.mjs'), join(pluginRoot, 'bin', 'yokoten.mjs')];
  const runtime = (body: string) => {
    for (const file of runtimes) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
  };
  const env = { ...sandbox.env, HOME: home, CLAUDE_PROJECT_DIR: repo, GEMINI_PROJECT_DIR: repo, PLUGIN: pluginRoot };
  // The plugin command runs bin/launch.mjs, which then runs yokoten.mjs (#706).
  mkdirSync(join(pluginRoot, 'bin'), { recursive: true });
  writeFileSync(join(pluginRoot, 'bin', 'launch.mjs'), readFileSync(join(dirname(CLI), 'launch.mjs')));
  // The plugin guard is runLaunch with this temp home. A machine install stays outside this check (#706).
  const launch = await import(pathToFileURL(join(dirname(CLI), 'launch.mjs')).href);
  const pluginBinary = join(pluginRoot, 'bin', 'yokoten.mjs');
  const pluginRun = () => launch.runLaunch({ mode: 'tool', fallback: pluginBinary, args: ['hook', '--commands-only'], env, input: '{}', cwd: repo, accountHome: home });
  const expectPlugin = (expected: unknown[]) => assert.deepEqual(pick(pluginRun()), expected, 'plugin');
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
  each(directCalls, [2, '', refused(1)]);
  expectPlugin([2, '', refused(1)]);
  runtime("process.stderr.write('/a/path\\n'); process.kill(process.pid, 'SIGKILL');\n");
  each(directCalls, [2, '', refused(137)]);
  expectPlugin([2, '', refused(137)]);
  // A guard's own answer passes as it is, stdout and stderr byte for byte.
  runtime("process.stdout.write('{\"a\":1}\\n\\n'); process.stderr.write('note\\n\\n'); process.exit(0);\n");
  each(directCalls, [0, '{"a":1}\n\n', 'note\n\n']);
  expectPlugin([0, '{"a":1}\n\n', 'note\n\n']);
  runtime("process.stdout.write('{}'); process.stderr.write('no\\n'); process.exit(2);\n");
  each(directCalls, [2, '{}', 'no\n']);
  expectPlugin([2, '{}', 'no\n']);
  // A runaway read stops at the small heap and is refused, without swapping, and without
  // the heap trace V8 writes.
  runtime('const a = []; for (;;) a.push(new Array(1e6).fill(1));\n');
  each([project.PreToolUse[0]], [2, '', refused(134)]);
  expectPlugin([2, '', refused(134)]);
  // No node on the agent's PATH: one line, and the call goes on, so `yokoten doctor` can run.
  const noNode = join(base, 'no-node');
  mkdirSync(noNode);
  symlinkSync(spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(noNode, 'git'));
  runtime('process.exit(0);\n');
  for (const sh of shells) for (const command of directCalls) assert.deepEqual(pick(shell(command, sh, { PATH: noNode })), [1, '', `${MISSING_NODE}\n`], `${sh}: ${command}`);
  // The plugin command is `node bin/launch.mjs`. With no node, the shell cannot print MISSING_NODE.
  // Exit is not 2, so the call still goes on.
  for (const sh of shells) {
    const result = shell(plugin, sh, { PATH: noNode });
    assert.notEqual(result.status, 0, sh);
    assert.notEqual(result.status, 2, `${sh}: a missing node does not block every call`);
  }
  // The stop check and the session doctor pass a failure on: exit 2 at stop would send the
  // agent back to work on a guard that cannot run.
  runtime('process.exit(1);\n');
  for (const command of [...project.Stop, ...project.SubagentStop, ...codex.Stop, ...gemini.AfterAgent, ...user.SessionStart, ...codexUser.SessionStart, ...geminiUser.SessionStart]) {
    assert.deepEqual(pick(shell(command)), [1, '', ''], command);
  }
  // A missing runtime still says its line and goes on, as before.
  for (const file of runtimes) rmSync(file);
  const machineLine = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again\n';
  each([...project.PreToolUse, ...codex.PreToolUse.slice(-1), ...gemini.BeforeTool.slice(-1)], [1, '', `${MISSING_PROJECT}\n`]);
  each([...user.PreToolUse, ...codexUser.PreToolUse, ...geminiUser.BeforeTool], [1, '', machineLine]);
});

// The plugin hook reads installed_plugins.json on every call (#706). A path is used only
// when it is a real file inside Claude's plugin cache. Anything else falls back to the
// session copy, or refuses when that file is gone too. The checks live in bin/launch.mjs.
test('plugin launcher: a safe cache copy runs, and any other path does not (#706)', async () => {
  const sandbox = makeSandbox();
  const home = sandbox.home;
  const rootDir = join(sandbox.repo, 'plugin-root');
  const rootBinary = join(rootDir, 'bin', 'yokoten.mjs');
  const launchFile = join(dirname(CLI), 'launch.mjs');
  const pluginsDir = join(home, '.claude', 'plugins');
  const pluginsFile = join(pluginsDir, 'installed_plugins.json');
  const cache = join(pluginsDir, 'cache', 'yokoten', 'yokoten', 'abc123');
  const cacheBinary = join(cache, 'bin', 'yokoten.mjs');
  const marker = join(sandbox.repo, 'marker');
  const outside = join(sandbox.repo, 'placed', 'yokoten', 'yokoten', 'abc123');
  const hooks = manifest('plugin.json').hooks as { PreToolUse: { hooks: { command: string }[] }[]; SessionStart: { hooks: { command: string }[] }[] };
  const toolCommand = hooks.PreToolUse[0].hooks[0].command;
  const sessionCommand = hooks.SessionStart[0].hooks[0].command;
  const launchText = readFileSync(launchFile, 'utf8');
  const launchLines = launchText.endsWith('\n') ? launchText.split('\n').length - 1 : launchText.split('\n').length;
  assert.ok(launchLines < 150, `bin/launch.mjs is ${launchLines} lines`);
  const script = (file: string, token: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `process.stdout.write(${JSON.stringify(token)} + ' ' + process.argv.slice(2).join(' '));\n`);
  };
  const writePlugins = (text: string) => {
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(pluginsFile, text);
  };
  const install = (entry: unknown, id = 'yokoten@yokoten') => writePlugins(JSON.stringify({ plugins: { [id]: [entry] } }));
  const reset = () => {
    rmSync(join(home, '.claude'), { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(marker, { force: true });
    rmSync(join(sandbox.repo, 'placed'), { recursive: true, force: true });
    rmSync(join(sandbox.repo, 'linked'), { recursive: true, force: true });
    rmSync(join(sandbox.repo, 'evil.mjs'), { force: true });
    rmSync(join(sandbox.repo, 'fake-home'), { recursive: true, force: true });
    rmSync(join(sandbox.repo, 'fake-marker'), { force: true });
  };
  // Resolver cases call runLaunch in this process (#475). The shell below is a child:
  // only a shell runs the hook command.
  const launch = await import(pathToFileURL(launchFile).href);
  const run = (command: string) => {
    const mode = command === sessionCommand ? 'session' : 'tool';
    const yokotenArgs = mode === 'session' ? ['doctor', '--session'] : ['hook', '--commands-only'];
    return launch.runLaunch({ mode, fallback: rootBinary, args: yokotenArgs, env: sandbox.env, input: '{}', cwd: sandbox.repo, accountHome: home });
  };
  const shell = (command: string, sh = '/bin/sh', extra: Record<string, string> = {}) => spawnSync(command, { shell: sh, cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PLUGIN_ROOT: rootDir, ...extra }, input: '{}', encoding: 'utf8', timeout: 15000 });
  const withRoot = () => script(rootBinary, 'root');
  const withCache = () => script(cacheBinary, 'cache');
  const fakeHome = join(sandbox.repo, 'fake-home');
  const fakeMarker = join(sandbox.repo, 'fake-marker');
  const plantFake = () => {
    const fakePlugins = join(fakeHome, '.claude', 'plugins');
    const fakeCache = join(fakePlugins, 'cache', 'yokoten', 'yokoten', 'v1');
    mkdirSync(join(fakeCache, 'bin'), { recursive: true });
    writeFileSync(join(fakeCache, 'bin', 'yokoten.mjs'), `require('node:fs').writeFileSync(${JSON.stringify(fakeMarker)}, 'ran');\nprocess.stdout.write('fake hook --commands-only');\n`);
    writeFileSync(join(fakePlugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'yokoten@yokoten': [{ scope: 'user', installPath: fakeCache, version: 'v1' }] } }));
  };

  reset();
  withRoot();
  withCache();
  install({ scope: 'user', installPath: cache, version: 'abc123', gitCommitSha: 'abc123' });
  assert.deepEqual(pick(run(toolCommand)), [0, 'cache hook --commands-only', ''], 'safe install path');
  assert.deepEqual(pick(run(sessionCommand)), [0, 'cache doctor --session', ''], 'safe session');

  reset();
  withRoot();
  assert.deepEqual(pick(run(toolCommand)), [0, 'root hook --commands-only', ''], 'no install file');

  reset();
  withRoot();
  withCache();
  install({ scope: 'user', version: 'abc123' });
  assert.equal(run(toolCommand).stdout, 'cache hook --commands-only', 'version only');

  reset();
  withRoot();
  const other = join(pluginsDir, 'cache', 'other', 'yokoten', 'abc123');
  script(join(other, 'bin', 'yokoten.mjs'), 'other');
  install({ scope: 'user', installPath: other, version: 'abc123' }, 'yokoten@other');
  assert.equal(run(toolCommand).stdout, 'other hook --commands-only', 'marketplace from the id');

  reset();
  withRoot();
  withCache();
  script(join(outside, 'bin', 'yokoten.mjs'), 'outside');
  writePlugins(JSON.stringify({ plugins: { 'yokoten@yokoten': [{ scope: 'project', installPath: outside, version: 'abc123' }, { scope: 'user', installPath: cache, version: 'abc123' }] } }));
  assert.equal(run(toolCommand).stdout, 'cache hook --commands-only', 'user scope wins');

  reset();
  withRoot();
  script(join(cache, 'bin', 'inner.mjs'), 'inner');
  symlinkSync(join(cache, 'bin', 'inner.mjs'), cacheBinary);
  install({ scope: 'user', installPath: cache, version: 'abc123' });
  assert.equal(run(toolCommand).stdout, 'inner hook --commands-only', 'symlink that stays in the cache');

  // A path outside the cache is not run. With a real version folder, that folder is used.
  reset();
  withRoot();
  withCache();
  script(join(outside, 'bin', 'yokoten.mjs'), 'outside');
  install({ scope: 'user', installPath: outside, version: 'abc123' });
  assert.equal(run(toolCommand).stdout, 'cache hook --commands-only', 'outside path yields to the version folder');
  rmSync(cacheBinary);
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'outside path falls back');

  reset();
  withRoot();
  const linked = join(sandbox.repo, 'linked');
  script(join(linked, 'bin', 'yokoten.mjs'), 'linked');
  mkdirSync(dirname(cache), { recursive: true });
  symlinkSync(linked, cache);
  install({ scope: 'user', installPath: cache, version: 'abc123' });
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'directory symlink leaves the cache');

  reset();
  withRoot();
  mkdirSync(join(cache, 'bin'), { recursive: true });
  const evil = join(sandbox.repo, 'evil.mjs');
  writeFileSync(evil, "process.stdout.write('evil hook --commands-only');\n");
  symlinkSync(evil, cacheBinary);
  install({ scope: 'user', installPath: cache, version: 'abc123' });
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'file symlink leaves the cache');

  reset();
  withRoot();
  script(join(pluginsDir, 'cache', 'yokoten', 'bin', 'yokoten.mjs'), 'escaped');
  install({ scope: 'user', version: '..' });
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'version dotdot');
  // Kept as text: path.join would remove the ".." before the launcher ever saw it.
  install({ scope: 'user', installPath: `${cache}/../..`, version: '..' });
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'install path dotdot');

  reset();
  withRoot();
  install({ scope: 'user', installPath: `${cache}"; touch ${marker}; echo "`, version: 'abc123' });
  let result = run(toolCommand);
  assert.equal(result.stdout, 'root hook --commands-only', 'quote in installPath');
  assert.equal(existsSync(marker), false, 'a quote does not run');
  install({ scope: 'user', installPath: `${cache}\n; touch ${marker}`, version: 'abc123' });
  result = run(toolCommand);
  assert.equal(result.stdout, 'root hook --commands-only', 'newline in installPath');
  assert.equal(existsSync(marker), false, 'a newline does not run');

  reset();
  withRoot();
  writePlugins(`{\ntouch ${marker}\n`);
  assert.deepEqual(pick(run(toolCommand)), [0, 'root hook --commands-only', ''], 'broken json');
  assert.equal(existsSync(marker), false, 'broken json does not run');

  reset();
  withRoot();
  mkdirSync(cache, { recursive: true });
  install({ scope: 'user', installPath: cache, version: 'abc123' });
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'missing mjs');

  reset();
  withRoot();
  withCache();
  install({ scope: 'project', installPath: cache, version: 'abc123', projectPath: sandbox.repo });
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'project scope is not used');

  reset();
  withRoot();
  install({ scope: 'user', installPath: 4, version: 4 });
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'odd entry');

  // A segment is a name. A colon or a Windows device name is refused (#706).
  reset();
  withRoot();
  const badVersion = (version: string, label: string) => {
    const folder = join(pluginsDir, 'cache', 'yokoten', 'yokoten', version);
    script(join(folder, 'bin', 'yokoten.mjs'), 'bad');
    install({ scope: 'user', installPath: folder, version });
    assert.equal(run(toolCommand).stdout, 'root hook --commands-only', label);
  };
  badVersion('ab:c', 'colon in a segment');
  badVersion('CON', 'device name CON');
  badVersion('nul', 'device name nul');
  badVersion('NUL.txt', 'device name with an extension');
  badVersion('COM1', 'device name COM1');
  badVersion('LPT9', 'device name LPT9');
  badVersion('aux', 'device name aux');
  badVersion('PRN', 'device name PRN');
  badVersion('CON ', 'device name with a trailing space');
  badVersion('CON.', 'device name with a trailing dot');
  reset();
  withRoot();
  const conFolder = join(pluginsDir, 'cache', 'CON', 'yokoten', 'yokoten', 'abc123');
  script(join(conFolder, 'bin', 'yokoten.mjs'), 'device');
  install({ scope: 'user', installPath: conFolder, version: 'abc123' });
  assert.equal(run(toolCommand).stdout, 'root hook --commands-only', 'CON segment inside the cache');

  // HOME is not the plugin root. The account home still supplies the cache copy (#706).
  reset();
  withRoot();
  withCache();
  install({ scope: 'user', installPath: cache, version: 'abc123' });
  plantFake();
  const attacked = launch.runLaunch({ mode: 'tool', fallback: rootBinary, args: ['hook', '--commands-only'], env: { ...sandbox.env, HOME: fakeHome }, input: '{}', cwd: sandbox.repo, accountHome: home });
  assert.equal(attacked.stdout, 'cache hook --commands-only', 'HOME is not the plugin root');
  assert.equal(existsSync(fakeMarker), false, 'a fake HOME does not run');

  reset();
  script(join(outside, 'bin', 'yokoten.mjs'), 'outside');
  install({ scope: 'user', installPath: outside, version: 'abc123' });
  result = run(toolCommand);
  assert.deepEqual([result.status, result.stdout, result.stderr], [2, '', `${PLUGIN_GUARD_MISSING}\n`], 'no safe binary refuses');
  assert.equal(result.stderr.includes(home), false, 'the refusal names no home');
  assert.equal(result.stderr.includes('~'), false, 'the refusal names no home mark');
  result = run(sessionCommand);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, `${PLUGIN_SESSION_MISSING}\n`, ''], 'no safe binary still starts');
  assert.equal(result.stdout.includes(home), false, 'the session line names no home');
  assert.equal(result.stdout.includes('/'), false, 'the session line names no path');
  assert.equal(result.stdout.includes('outside'), false, 'the outside copy did not run');

  reset();
  mkdirSync(dirname(rootBinary), { recursive: true });
  writeFileSync(rootBinary, 'process.stderr.write("session-down\\n"); process.exit(1);\n');
  assert.deepEqual(pick(run(sessionCommand)), [1, '', 'session-down\n'], 'a session failure is not a refusal');

  // The hook command itself: a deleted plugin folder has no launcher, so it fails closed.
  reset();
  const gone = `${PLUGIN_COPY_GONE}\n`;
  for (const sh of ['/bin/sh', '/bin/bash'].filter((name) => existsSync(name))) {
    const tool = shell(toolCommand, sh);
    assert.deepEqual([tool.status, tool.stdout, tool.stderr], [2, '', gone], `${sh}: deleted folder refuses`);
    assert.equal(tool.stderr.includes(home), false, 'the restart line names no home');
    const session = shell(sessionCommand, sh);
    assert.deepEqual([session.status, session.stdout, session.stderr], [0, gone, ''], `${sh}: deleted folder still starts`);
    assert.equal(session.stdout.includes('/'), false, 'the restart line names no path');
  }
  // The same command runs the file when the folder is still there.
  withRoot();
  writeFileSync(join(rootDir, 'bin', 'launch.mjs'), launchText);
  plantFake();
  const started = shell(toolCommand, '/bin/sh', { HOME: fakeHome });
  // No readable account plugin: the session copy. An account install: that copy. Never the fake home.
  assert.equal(existsSync(fakeMarker), false, 'the hook entry does not follow HOME');
  assert.notEqual(started.stdout, 'fake hook --commands-only', 'the hook entry does not run the fake copy');
  assert.equal(`${started.stdout}${started.stderr}`.includes('this plugin copy is gone'), false, 'the short command runs the launcher file');
  assert.ok(started.status === 0 || started.status === 2, `status ${started.status}`);
  // The plugin root is the account home. The text must not read HOME (#706).
  assert.doesNotMatch(launchText, /env\.HOME|USERPROFILE/, 'the launcher does not read HOME');
  assert.match(launchText, /userInfo\(\)\.homedir/, 'the account home comes from the password file');
});

// A spawn that sets `error`, or that has no exit status, did not run the guard (#706).
test('plugin launcher: a spawn error, or no exit status, refuses the tool call (#706)', async () => {
  const sandbox = makeSandbox();
  const rootBinary = join(sandbox.repo, 'plugin-root', 'bin', 'yokoten.mjs');
  mkdirSync(dirname(rootBinary), { recursive: true });
  writeFileSync(rootBinary, "process.stdout.write('root hook --commands-only');\n");
  const launch = await import(pathToFileURL(join(dirname(CLI), 'launch.mjs')).href);
  const refused = "yokoten's guard failed (exit 1), so the command is refused; run `yokoten doctor`\n";
  const run = (child: { status: number | null; signal: null; error?: Error; stdout: Buffer; stderr: Buffer }) => launch.runLaunch({
    mode: 'tool', fallback: rootBinary, args: ['hook', '--commands-only'], env: sandbox.env, input: '{}', cwd: sandbox.repo, accountHome: sandbox.home, spawn: () => child,
  });
  const error = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  const bytes = { signal: null, stdout: Buffer.from('ran'), stderr: Buffer.from('') } as const;
  assert.deepEqual(pick(run({ status: 0, error, ...bytes })), [2, '', refused], 'status 0 with a spawn error');
  assert.deepEqual(pick(run({ status: null, ...bytes })), [2, '', refused], 'no exit status');
  assert.deepEqual(pick(run({ status: 2, error, ...bytes, stderr: Buffer.from('no\n') })), [2, '', refused], 'status 2 with a spawn error');
});

// The session copy is checked like the cache copy: a symlink may not leave the plugin folder (#706).
test('plugin launcher: a fallback symlink must stay inside the plugin folder (#706)', async () => {
  const sandbox = makeSandbox();
  const rootDir = join(sandbox.repo, 'plugin-root');
  const rootBinary = join(rootDir, 'bin', 'yokoten.mjs');
  const evil = join(sandbox.repo, 'evil.mjs');
  mkdirSync(dirname(rootBinary), { recursive: true });
  writeFileSync(evil, "process.stdout.write('evil hook --commands-only');\n");
  symlinkSync(evil, rootBinary);
  const launch = await import(pathToFileURL(join(dirname(CLI), 'launch.mjs')).href);
  const run = () => launch.runLaunch({
    mode: 'tool', fallback: rootBinary, args: ['hook', '--commands-only'], env: sandbox.env, input: '{}', cwd: sandbox.repo, accountHome: sandbox.home,
  });
  const leaked = run();
  assert.equal(leaked.stdout, '', 'a symlink out of the plugin folder does not run');
  assert.equal(leaked.status, 2, 'no safe fallback refuses the call');
  writeFileSync(join(rootDir, 'bin', 'inner.mjs'), "process.stdout.write('inner hook --commands-only');\n");
  rmSync(rootBinary);
  symlinkSync(join(rootDir, 'bin', 'inner.mjs'), rootBinary);
  assert.deepEqual(pick(run()), [0, 'inner hook --commands-only', ''], 'a symlink inside the plugin folder runs');
});

// A Windows account cache is `C:\Users\...\cache\<marketplace>\yokoten\<version>` (#706).
test('plugin launcher: a drive-letter cache path is safe, and a colon elsewhere is not (#706)', async () => {
  const launch = await import(pathToFileURL(join(dirname(CLI), 'launch.mjs')).href);
  const windowsPath = (...parts: string[]) => parts.join('\\');
  const cache = windowsPath('C:', 'Users', 'account', '.claude', 'plugins', 'cache', 'yokoten', 'yokoten', 'abc123');
  assert.equal(launch.isSafeFolder(cache, 'yokoten', 'abc123'), true, 'the account cache on a drive letter');
  assert.equal(launch.isSafeFolder(cache.replaceAll('\\', '/'), 'yokoten', 'abc123'), true, 'the same cache with slashes');
  assert.equal(launch.isSafeFolder(windowsPath('C:', 'Users', 'account', 'notes.txt'), 'yokoten', 'abc123'), false, 'a drive path that is not the cache');
  assert.equal(launch.isSafeFolder(windowsPath('C:', 'Users', 'ac:count', '.claude', 'plugins', 'cache', 'yokoten', 'yokoten', 'abc123'), 'yokoten', 'abc123'), false, 'a colon in a later segment');
  assert.equal(launch.isSafeFolder(windowsPath('C:', 'Users', 'account', '.claude', 'plugins', 'cache', 'yokoten', 'yokoten', 'ab:c'), 'yokoten', 'ab:c'), false, 'a colon in the version');
});

// #174: the pitch demo runs end to end, offline, in a temp folder it removes, and never
// touches this repo's kit.
test('demo: scripts/demo/loop.ts walks the loop from an incident to a doctor note, and leaves nothing', () => {
  const temp = makeTempDir();
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

test('sandbox: call runs a command in this process with the same result as run (#475)', async () => {
  const sandbox = makeSandbox();
  for (const words of [['help'], ['check'], ['no-such-command']]) {
    const child = sandbox.run(words);
    const same = await sandbox.call(words);
    assert.deepEqual({ status: same.status, stdout: same.stdout, stderr: same.stderr }, { status: child.status, stdout: child.stdout, stderr: child.stderr }, `yokoten ${words.join(' ')}`);
  }
});
