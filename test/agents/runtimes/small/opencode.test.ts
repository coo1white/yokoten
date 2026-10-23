// Tests for src/agents/runtimes/small/opencode.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { guardCommand } from '../../../../src/run/cli.ts';
import { GUARD_FAILED, PLUGIN_FILE, addUserPlugin, formatDenial, hasUserDir, pluginSource, projectPluginState, readToolCall, userPluginFile, userPluginState } from '../../../../src/agents/runtimes/small/opencode.ts';
import { agentHooks, userAgentHooks } from '../../../../src/setup/doctor/index.ts';
import { USER_CLI, USER_MISSING } from '../../../../src/setup/install.ts';
import { CLI, makeSandbox } from '../../../repo/helpers.ts';

const worker = { YOKOTEN_ROLE: 'worker' };

/** Run the generated plugin in a child, the way OpenCode would load it. */
const runPlugin = (repo: string, env: Record<string, string | undefined>, source: string, call: { tool: string; args: Record<string, unknown> }) => {
  const plugin = join(repo, 'plugin.mjs');
  const runner = join(repo, 'runner.mjs');
  writeFileSync(plugin, source);
  writeFileSync(
    runner,
    [
      "import { pathToFileURL } from 'node:url';",
      'const plugin = await import(pathToFileURL(process.argv[2]).href);',
      'const call = JSON.parse(process.argv[3]);',
      'const hooks = await plugin.Yokoten({ directory: process.argv[4] });',
      'try {',
      "  await hooks['tool.execute.before']({ tool: call.tool }, { args: call.args });",
      "  console.log('ALLOWED');",
      '} catch (err) {',
      "  console.log('REFUSED');",
      '  console.log(err instanceof Error ? err.message : String(err));',
      '}',
      '',
    ].join('\n'),
  );
  return spawnSync(process.execPath, [runner, plugin, JSON.stringify(call), repo], { cwd: repo, env: { ...env, YOKOTEN_ROLE: 'worker' }, encoding: 'utf8' });
};

test('hook --agent opencode: a force push and a .git edit match Claude Code; ls passes', async () => {
  const sandbox = makeSandbox();
  const idOf = async (agent: string, input: unknown) => {
    const result = await sandbox.call(['hook', '--json', '--agent', agent], { input: JSON.stringify(input), extra: worker });
    assert.equal(result.status, 2, result.stderr);
    return JSON.parse(result.stdout).finding.id as string;
  };
  const push = 'git push --force origin main';
  const claudePush = { cwd: sandbox.repo, tool_name: 'Bash', tool_input: { command: push } };
  const claudeEdit = { cwd: sandbox.repo, tool_name: 'Edit', tool_input: { file_path: '.git/config' } };
  const claudePushId = await idOf('claude-code', claudePush);
  const claudeEditId = await idOf('claude-code', claudeEdit);
  assert.equal(claudePushId, 'force-push');
  assert.equal(claudeEditId, 'worker-mark');
  for (const tool of ['shell', 'bash']) {
    assert.equal(await idOf('opencode', { tool, args: { command: push }, directory: sandbox.repo }), claudePushId, tool);
  }
  for (const tool of ['write', 'edit', 'patch']) {
    assert.equal(await idOf('opencode', { tool, args: { filePath: '.git/config' }, directory: sandbox.repo }), claudeEditId, tool);
  }
  const allowed = await sandbox.call(['hook', '--json', '--agent', 'opencode'], {
    input: JSON.stringify({ tool: 'shell', args: { command: 'ls' }, directory: sandbox.repo }),
    extra: worker,
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).blocked, false);
  const plain = await sandbox.call(['hook', '--agent', 'opencode'], {
    input: JSON.stringify({ tool: 'bash', args: { command: push }, directory: sandbox.repo }),
    extra: worker,
  });
  assert.equal(plain.status, 2);
  assert.equal(plain.stdout, '');
  assert.deepEqual(formatDenial('because'), { stdout: '', exitCode: 2 });

  const source = pluginSource(guardCommand(`"${CLI}"`, 'hook --agent opencode', 'missing runtime', { isToolCall: true }));
  const refused = runPlugin(sandbox.repo, sandbox.env, source, { tool: 'shell', args: { command: push } });
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(refused.stdout.split('\n')[0], 'REFUSED');
  assert.equal(refused.stdout.split('\n').slice(1).join('\n').trim(), plain.stderr.trim());
  const edited = runPlugin(sandbox.repo, sandbox.env, source, { tool: 'edit', args: { filePath: '.git/config' } });
  assert.match(edited.stdout, /^REFUSED\n/);
  const listed = runPlugin(sandbox.repo, sandbox.env, source, { tool: 'shell', args: { command: 'ls' } });
  assert.equal(listed.stdout.trim(), 'ALLOWED');
});

test('OpenCode readToolCall: shell and bash by command, write edit and patch by filePath; a read is neither', () => {
  assert.deepEqual(readToolCall({ tool: 'shell', args: { command: 'ls' }, directory: '/work' }), { command: 'ls', paths: [], cwd: '/work', worker: false });
  assert.deepEqual(readToolCall({ tool: 'bash', args: { command: 'pwd' } }), { command: 'pwd', paths: [], cwd: undefined, worker: false });
  for (const tool of ['write', 'edit', 'patch']) {
    assert.deepEqual(readToolCall({ tool, args: { filePath: '.git/config' }, directory: '/work' }), { command: undefined, paths: ['.git/config'], cwd: '/work', worker: false });
  }
  assert.deepEqual(readToolCall({ tool: 'read', args: { filePath: '.git/config' }, directory: '/work' }), { command: undefined, paths: [], cwd: '/work', worker: false });
  for (const input of [null, 'x', [], { tool: 'shell', args: [] }]) {
    assert.deepEqual(readToolCall(input), { command: undefined, paths: [], cwd: undefined, worker: false });
  }
});

test('the OpenCode plugin refuses the call when the guard fails or times out', () => {
  const sandbox = makeSandbox();
  const fail = join(sandbox.repo, 'fail.mjs');
  writeFileSync(fail, 'process.exit(1);\n');
  const crashed = runPlugin(sandbox.repo, sandbox.env, pluginSource(guardCommand(`"${fail}"`, 'ignored', 'missing runtime', { isToolCall: true })), {
    tool: 'shell',
    args: { command: 'ls' },
  });
  assert.match(crashed.stdout, /^REFUSED\n/);
  assert.match(crashed.stdout, /guard failed/);
  const timed = runPlugin(sandbox.repo, sandbox.env, pluginSource('sleep 5', 300), { tool: 'shell', args: { command: 'ls' } });
  assert.equal(timed.stdout.split('\n')[0], 'REFUSED');
  assert.ok(timed.stdout.includes(GUARD_FAILED), timed.stdout);
});

test('init writes the OpenCode plugin, and doctor notes a project that has OpenCode without it', async () => {
  const sandbox = makeSandbox();
  const cli = '.yokoten/bin/yokoten.mjs';
  assert.deepEqual(agentHooks(sandbox.repo, sandbox.env).filter((item) => item.name === 'opencode-hook'), []);
  sandbox.write('opencode.json', '{}\n');
  let noted = agentHooks(sandbox.repo, sandbox.env).filter((item) => item.name === 'opencode-hook');
  assert.equal(noted.length, 1);
  assert.equal(noted[0]?.ok, false);
  assert.equal(noted[0]?.finding.id, 'opencode-hook');
  const before = await sandbox.call(['doctor']);
  assert.match(before.stdout, /note +opencode-hook: OpenCode is set up here/);
  mkdirSync(join(sandbox.repo, '.opencode'));
  const init = await sandbox.call(['init']);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /added the OpenCode tool-call plugin in \.opencode\/plugins\/yokoten\.ts/);
  assert.equal(projectPluginState(sandbox.repo, cli), 'same');
  const after = await sandbox.call(['doctor']);
  assert.doesNotMatch(after.stdout, /opencode-hook/);
  const again = await sandbox.call(['init']);
  assert.match(again.stdout, /same the OpenCode tool-call plugin in \.opencode\/plugins\/yokoten\.ts/);
  sandbox.write(PLUGIN_FILE, 'old\n');
  noted = agentHooks(sandbox.repo, sandbox.env).filter((item) => item.name === 'opencode-hook');
  assert.match(noted[0]?.finding.what ?? '', /out of date/);
  rmSync(join(sandbox.repo, PLUGIN_FILE));
  mkdirSync(join(sandbox.repo, PLUGIN_FILE));
  const unreadable = projectPluginState(sandbox.repo, cli);
  assert.equal(typeof unreadable, 'object');
});

test('install writes the user plugin when OpenCode is installed, and skips it otherwise', async () => {
  const sandbox = makeSandbox();
  const skipped = await sandbox.call(['install']);
  assert.match(skipped.stdout, /skipped OpenCode: ~\/\.config\/opencode not found/);
  assert.equal(userAgentHooks(sandbox.env).some((item) => item.name === 'opencode-user-hook'), false);
  mkdirSync(join(sandbox.home, '.config', 'opencode'));
  assert.equal(hasUserDir(sandbox.env), true);
  const xdg = join(sandbox.home, 'xdg');
  assert.equal(hasUserDir({ HOME: sandbox.home, XDG_CONFIG_HOME: xdg }), false);
  mkdirSync(join(xdg, 'opencode'), { recursive: true });
  assert.equal(hasUserDir({ ...sandbox.env, XDG_CONFIG_HOME: xdg }), true);
  assert.equal(userPluginFile({ ...sandbox.env, XDG_CONFIG_HOME: xdg }), '$XDG_CONFIG_HOME/opencode/plugins/yokoten.ts');
  const wrote = await sandbox.call(['install']);
  assert.match(wrote.stdout, /added the OpenCode command guard in ~\/\.config\/opencode\/plugins\/yokoten\.ts/);
  assert.equal(userPluginState(sandbox.env, USER_CLI, USER_MISSING), 'same');
  const hooks = userAgentHooks(sandbox.env).filter((item) => item.name === 'opencode-user-hook');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]?.ok, true);
  assert.equal(addUserPlugin(sandbox.env, USER_CLI, USER_MISSING), 'same');
});
