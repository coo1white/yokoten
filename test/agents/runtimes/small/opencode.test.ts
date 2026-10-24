// Tests for src/agents/runtimes/small/opencode.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { guardCommand } from '../../../../src/run/cli.ts';
import { GUARD_FAILED, PLUGIN_FILE, UNREADABLE_CALL, addUserPlugin, formatDenial, hasUserDir, pluginSource, projectPluginState, readToolCall, userPluginFile, userPluginState } from '../../../../src/agents/runtimes/small/opencode.ts';
import { agentHooks, userAgentHooks } from '../../../../src/setup/doctor/index.ts';
import { USER_CLI, USER_MISSING } from '../../../../src/setup/install.ts';
import { CLI, makeSandbox } from '../../../repo/helpers.ts';

const worker = { YOKOTEN_ROLE: 'worker' };

/** A fake `@opencode/plugin`, so the emitted plugin can load outside OpenCode. */
const writeHost = (repo: string, source: string): string => {
  const folder = join(repo, 'node_modules', '@opencode', 'plugin');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), '{"type":"module","main":"./index.js","exports":{".":"./index.js"}}\n');
  writeFileSync(join(folder, 'index.js'), 'export const Plugin = { define(value) { return value; } };\n');
  const plugin = join(repo, 'plugin.mjs');
  writeFileSync(plugin, source);
  return plugin;
};

const runChild = (repo: string, env: Record<string, string | undefined>, runner: string, plugin: string, payload: string) =>
  spawnSync(process.execPath, [runner, plugin, payload, repo], {
    cwd: repo,
    env: { ...env, YOKOTEN_ROLE: 'worker' },
    encoding: 'utf8',
    timeout: 90000,
  });

/** Run the OpenCode 1 hook: server()['tool.execute.before']. */
const runPlugin = (repo: string, env: Record<string, string | undefined>, source: string, call: { tool: string; args: Record<string, unknown> }) => {
  const plugin = writeHost(repo, source);
  const runner = join(repo, 'runner.mjs');
  writeFileSync(
    runner,
    [
      "import { pathToFileURL } from 'node:url';",
      'const plugin = await import(pathToFileURL(process.argv[2]).href);',
      'const call = JSON.parse(process.argv[3]);',
      'const loaded = plugin.default;',
      'const hooks = await loaded.server({ directory: process.argv[4] });',
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
  return runChild(repo, env, runner, plugin, JSON.stringify(call));
};

/**
 * Run setup against a fake ctx. Each hook() returns a promise that never settles, so a
 * setup that waits on it does not return. Steps then call the recorded handlers.
 */
const runSetup = (repo: string, env: Record<string, string | undefined>, source: string, steps: { label: string; hook: string; event: Record<string, unknown> }[]) => {
  const plugin = writeHost(repo, source);
  const runner = join(repo, 'setup-runner.mjs');
  writeFileSync(
    runner,
    [
      "import { writeSync } from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      'const plugin = await import(pathToFileURL(process.argv[2]).href);',
      'const steps = JSON.parse(process.argv[3]);',
      'const loaded = plugin.default;',
      'const handlers = new Map();',
      'const seen = [];',
      'const pending = new Promise(() => {});',
      'const register = (kind) => (name, fn) => {',
      "  seen.push(kind + ':' + name);",
      "  handlers.set(kind + ':' + name, fn);",
      '  return pending;',
      '};',
      'const ctx = {',
      '  directory: process.argv[4],',
      '  permission: { hook: register("permission") },',
      '  shell: { hook: register("shell") },',
      '  tool: { hook: register("tool") },',
      '};',
      'let setupResult;',
      'try {',
      '  setupResult = loaded.setup(ctx);',
      '} catch (err) {',
      '  console.error(err instanceof Error ? err.stack : String(err));',
      '  process.exit(1);',
      '}',
      "writeSync(1, 'SETUP_RETURNED\\n');",
      'const results = [];',
      'for (const step of steps) {',
      '  const event = step.event;',
      "  let thrown = '';",
      '  try {',
      "    const handler = handlers.get(step.hook);",
      "    if (typeof handler !== 'function') throw new Error('missing ' + step.hook);",
      '    await handler(event);',
      '  } catch (err) {',
      '    thrown = err instanceof Error ? err.message : String(err);',
      '  }',
      '  results.push({ label: step.label, effect: event.effect ?? null, message: event.message ?? null, thrown });',
      '}',
      'console.log(JSON.stringify({ id: loaded.id, seen, setupIsPromise: setupResult instanceof Promise, results }));',
      '',
    ].join('\n'),
  );
  return runChild(repo, env, runner, plugin, JSON.stringify(steps));
};

const allow = (action: string, extra: Record<string, unknown> = {}) => ({ action, resources: [], metadata: {}, effect: 'allow', message: '', ...extra });

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

test('OpenCode 1 server() refuses command and code on any tool, and a git path under path or file_path', () => {
  const sandbox = makeSandbox();
  const push = 'git push --force origin main';
  const source = pluginSource(guardCommand(`"${CLI}"`, 'hook --agent opencode', 'missing runtime', { isToolCall: true }));
  const run = (tool: string, args: Record<string, unknown>) => runPlugin(sandbox.repo, sandbox.env, source, { tool, args });
  const refused = (tool: string, args: Record<string, unknown>) => {
    const ran = run(tool, args);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.split('\n')[0], 'REFUSED', tool);
    return ran.stdout;
  };
  const reasonOf = async (input: unknown) => {
    const plain = await sandbox.call(['hook', '--agent', 'opencode'], { input: JSON.stringify(input), extra: worker });
    assert.equal(plain.status, 2, plain.stderr);
    return plain.stderr.trim();
  };
  const pushReason = reasonOf({ tool: 'bash', args: { command: push }, directory: sandbox.repo });
  const editReason = reasonOf({ tool: 'edit', args: { filePath: '.git/config' }, directory: sandbox.repo });
  return Promise.all([pushReason, editReason]).then(([pushText, editText]) => {
    assert.ok(refused('code', { code: push }).includes(pushText), 'code');
    assert.ok(refused('task', { command: push }).includes(pushText), 'task');
    assert.ok(refused('write', { path: '.git/config' }).includes(editText), 'path');
    assert.ok(refused('edit', { file_path: '.git/config' }).includes(editText), 'file_path');
    assert.ok(refused('shell', {}).includes(UNREADABLE_CALL));
    assert.equal(run('shell', { command: 'ls' }).stdout.trim(), 'ALLOWED');
    assert.equal(run('read', { filePath: '.git/config' }).stdout.trim(), 'ALLOWED');
  });
});

test('the plugin refuses the tag push the issue names, and a subagent call it cannot read', () => {
  const sandbox = makeSandbox();
  const source = pluginSource(guardCommand(`"${CLI}"`, 'hook --agent opencode', 'missing runtime', { isToolCall: true }));
  const tagPush = runPlugin(sandbox.repo, sandbox.env, source, { tool: 'bash', args: { command: 'git push --tags' } });
  assert.equal(tagPush.status, 0, tagPush.stderr);
  assert.equal(tagPush.stdout.split('\n')[0], 'REFUSED');
  assert.match(tagPush.stdout, /pushes tags/, 'the owner-only tag reason reaches the model');
  // A subagent launch carries a prompt, not a command or a path. The plugin cannot read
  // it, so it refuses (#337): a subagent never runs outside the guard.
  const subagent = runPlugin(sandbox.repo, sandbox.env, source, {
    tool: 'task',
    args: { description: 'count lines', prompt: 'Run wc -l on README.md', subagent_type: 'general' },
  });
  assert.equal(subagent.status, 0, subagent.stderr);
  assert.equal(subagent.stdout.split('\n')[0], 'REFUSED');
  assert.ok(subagent.stdout.includes(UNREADABLE_CALL), subagent.stdout);
});

test('OpenCode readToolCall: v1 tools, and an evaluate event read from resources then metadata', () => {
  assert.deepEqual(readToolCall({ tool: 'shell', args: { command: 'ls' }, directory: '/work' }), { command: 'ls', paths: [], cwd: '/work', worker: false });
  assert.deepEqual(readToolCall({ tool: 'bash', args: { command: 'pwd' } }), { command: 'pwd', paths: [], cwd: undefined, worker: false });
  for (const tool of ['write', 'edit', 'patch']) {
    assert.deepEqual(readToolCall({ tool, args: { filePath: '.git/config' }, directory: '/work' }), { command: undefined, paths: ['.git/config'], cwd: '/work', worker: false });
  }
  assert.deepEqual(readToolCall({ tool: 'read', args: { filePath: '.git/config' }, directory: '/work' }), { command: undefined, paths: [], cwd: '/work', worker: false });
  assert.deepEqual(readToolCall({ tool: 'code', args: { code: 'git push --force origin main' } }), { command: 'git push --force origin main', paths: [], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ tool: 'task', args: { command: 'git push --force origin main' } }), { command: 'git push --force origin main', paths: [], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ tool: 'write', args: { path: '.git/config' } }), { command: undefined, paths: ['.git/config'], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ tool: 'edit', args: { file_path: '.git/config' } }), { command: undefined, paths: ['.git/config'], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ tool: 'shell', args: {} }), { command: undefined, paths: [], cwd: undefined, worker: false });
  for (const input of [null, 'x', [], { tool: 'shell', args: [] }]) {
    assert.deepEqual(readToolCall(input), { command: undefined, paths: [], cwd: undefined, worker: false });
  }

  const push = 'git push --force origin main';
  assert.deepEqual(readToolCall({ action: 'bash', resources: [push], directory: '/work' }), { command: push, paths: [], cwd: '/work', worker: false });
  assert.deepEqual(readToolCall({ action: 'Shell', resources: ['git', 'push', '--force', 'origin', 'main'] }), { command: push, paths: [], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ action: 'bash', resources: [], metadata: { command: 'pwd' } }), { command: 'pwd', paths: [], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ action: 'bash', metadata: { input: 'pwd' } }), { command: 'pwd', paths: [], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ action: 'bash', metadata: { input: { command: 'pwd' } } }), { command: 'pwd', paths: [], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ action: 'edit', resources: ['a.ts', 'b.ts'], directory: '/work' }), { command: undefined, paths: ['a.ts', 'b.ts'], cwd: '/work', worker: false });
  assert.deepEqual(readToolCall({ action: 'write', resources: [], metadata: { input: { filePath: '.git/config' } }, directory: '/work' }), {
    command: undefined,
    paths: ['.git/config'],
    cwd: '/work',
    worker: false,
  });
  assert.deepEqual(readToolCall({ action: 'edit', resources: [push], directory: '/work' }), { command: push, paths: [push], cwd: '/work', worker: false });
  // Code in an edit is judged too, as in any other call (rb16 review).
  assert.deepEqual(readToolCall({ action: 'edit', resources: ['a.ts'], metadata: { input: { code: push } } }), { command: push, paths: ['a.ts'], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ action: 'read', resources: ['.git/config'], directory: '/work' }), { command: undefined, paths: [], cwd: '/work', worker: false });
  assert.deepEqual(readToolCall({ action: 'custom', resources: ['.git/config'], directory: '/work' }), { command: '.git/config', paths: ['.git/config'], cwd: '/work', worker: false });
  assert.deepEqual(readToolCall({ action: 'code', resources: ['main.ts'], metadata: { input: { code: push } } }), {
    command: undefined,
    commands: [push, 'main.ts'],
    paths: [],
    cwd: undefined,
    worker: false,
  });
  assert.deepEqual(readToolCall({ action: 'custom', metadata: {} }), { command: undefined, paths: [], cwd: undefined, worker: false });
  assert.deepEqual(readToolCall({ action: 'bash', resources: [] }), { command: undefined, paths: [], cwd: undefined, worker: false });

  const source = pluginSource('true');
  assert.match(source, /import \{ Plugin \} from '@opencode\/plugin'/);
  assert.match(source, /Plugin\.define\(\{/);
  assert.match(source, /id: 'yokoten'/);
  assert.match(source, /permission\.hook\('evaluate'/);
  assert.match(source, /shell\.hook\('create\.before'/);
  assert.match(source, /'tool\.execute\.before'/);
  assert.equal(source.includes('await'), false);
  assert.equal(source.includes('tool.hook'), false);
});

test("OpenCode 2 setup: a force push is denied, ls stays allowed, a failing guard denies", async () => {
  const sandbox = makeSandbox();
  const push = 'git push --force origin main';
  const plain = await sandbox.call(['hook', '--agent', 'opencode'], {
    input: JSON.stringify({ action: 'bash', resources: [push], directory: sandbox.repo }),
    extra: worker,
  });
  assert.equal(plain.status, 2, plain.stderr);
  const reason = plain.stderr.trim();
  const edited = await sandbox.call(['hook', '--agent', 'opencode'], {
    input: JSON.stringify({ action: 'edit', resources: ['.git/config'], directory: sandbox.repo }),
    extra: worker,
  });
  assert.equal(edited.status, 2, edited.stderr);
  const source = pluginSource(guardCommand(`"${CLI}"`, 'hook --agent opencode', 'missing runtime', { isToolCall: true }));
  const ran = runSetup(sandbox.repo, sandbox.env, source, [
    { label: 'push', hook: 'permission:evaluate', event: allow('bash', { resources: [push] }) },
    { label: 'meta', hook: 'permission:evaluate', event: allow('shell', { metadata: { command: push } }) },
    { label: 'input', hook: 'permission:evaluate', event: allow('bash', { metadata: { input: push }, effect: 'ask' }) },
    { label: 'nested', hook: 'permission:evaluate', event: allow('bash', { metadata: { input: { command: push } } }) },
    { label: 'argv', hook: 'permission:evaluate', event: allow('shell', { resources: ['git', 'push', '--force', 'origin', 'main'] }) },
    { label: 'ls', hook: 'permission:evaluate', event: allow('bash', { resources: ['ls'] }) },
    { label: 'ask', hook: 'permission:evaluate', event: allow('shell', { resources: ['ls'], effect: 'ask' }) },
    { label: 'edit', hook: 'permission:evaluate', event: allow('edit', { resources: ['.git/config'] }) },
    { label: 'mislabeled', hook: 'permission:evaluate', event: allow('write', { resources: [push] }) },
    { label: 'read', hook: 'permission:evaluate', event: allow('read', { resources: ['.git/config'] }) },
    { label: 'opaque', hook: 'permission:evaluate', event: allow('custom') },
    { label: 'empty-shell', hook: 'permission:evaluate', event: allow('bash') },
    { label: 'shell-push', hook: 'shell:create.before', event: { command: push, cwd: sandbox.repo, env: {} } },
    { label: 'shell-ls', hook: 'shell:create.before', event: { command: 'ls', cwd: sandbox.repo } },
    { label: 'shell-empty', hook: 'shell:create.before', event: { cwd: sandbox.repo } },
  ]);
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  assert.match(ran.stdout, /SETUP_RETURNED/);
  const line = ran.stdout.split('\n').find((item) => item.startsWith('{'));
  assert.ok(line, ran.stdout);
  const body = JSON.parse(line) as { id: string; seen: string[]; setupIsPromise: boolean; results: { label: string; effect: string | null; message: string | null; thrown: string }[] };
  assert.equal(body.id, 'yokoten');
  assert.equal(body.setupIsPromise, false);
  assert.deepEqual(body.seen, ['permission:evaluate', 'shell:create.before']);
  const step = (label: string) => {
    const found = body.results.find((item) => item.label === label);
    assert.ok(found, label);
    return found;
  };
  for (const label of ['push', 'meta', 'input', 'nested', 'argv', 'mislabeled']) {
    const item = step(label);
    assert.equal(item.effect, 'deny', label);
    assert.equal(item.message, reason, label);
    assert.equal(item.thrown, '', label);
  }
  const listed = step('ls');
  assert.equal(listed.effect, 'allow');
  assert.equal(listed.message, '');
  const asked = step('ask');
  assert.equal(asked.effect, 'ask');
  assert.equal(asked.message, '');
  const edit = step('edit');
  assert.equal(edit.effect, 'deny');
  assert.equal(edit.message, edited.stderr.trim());
  const reading = step('read');
  assert.equal(reading.effect, 'allow');
  assert.equal(reading.message, '');
  for (const label of ['opaque', 'empty-shell']) {
    const item = step(label);
    assert.equal(item.effect, 'deny', label);
    assert.equal(item.message, UNREADABLE_CALL, label);
  }
  const shellPush = step('shell-push');
  assert.equal(shellPush.thrown, reason);
  assert.equal(step('shell-ls').thrown, '');
  assert.equal(step('shell-empty').thrown, UNREADABLE_CALL);

  const fail = join(sandbox.repo, 'fail.mjs');
  writeFileSync(fail, 'process.exit(1);\n');
  const crashed = runSetup(sandbox.repo, sandbox.env, pluginSource(guardCommand(`"${fail}"`, 'ignored', 'missing runtime', { isToolCall: true })), [
    { label: 'fail', hook: 'permission:evaluate', event: allow('bash', { resources: ['ls'] }) },
  ]);
  assert.equal(crashed.status, 0, crashed.stderr);
  const failedLine = crashed.stdout.split('\n').find((item) => item.startsWith('{'));
  assert.ok(failedLine, crashed.stdout);
  const failed = JSON.parse(failedLine) as { results: { effect: string; message: string }[] };
  assert.equal(failed.results[0]?.effect, 'deny');
  assert.match(failed.results[0]?.message ?? '', /guard failed/);
});

test('OpenCode 2 refuses an unknown action when any command field is refused', async () => {
  const sandbox = makeSandbox();
  const push = 'git push --force origin main';
  const event = { action: 'code', resources: ['main.ts'], metadata: { input: { code: push } }, directory: sandbox.repo };
  const plain = await sandbox.call(['hook', '--agent', 'opencode'], { input: JSON.stringify(event), extra: worker });
  assert.equal(plain.status, 2, plain.stderr);
  const source = pluginSource(guardCommand(`"${CLI}"`, 'hook --agent opencode', 'missing runtime', { isToolCall: true }));
  const ran = runSetup(sandbox.repo, sandbox.env, source, [
    { label: 'code', hook: 'permission:evaluate', event: allow('code', { resources: ['main.ts'], metadata: { input: { code: push } } }) },
    { label: 'ls-code', hook: 'permission:evaluate', event: allow('code', { resources: ['main.ts'], metadata: { input: { code: 'ls' } } }) },
    { label: 'ls', hook: 'permission:evaluate', event: allow('bash', { resources: ['ls'] }) },
    { label: 'read', hook: 'permission:evaluate', event: allow('read', { resources: ['.git/config'] }) },
  ]);
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  const line = ran.stdout.split('\n').find((item) => item.startsWith('{'));
  assert.ok(line, ran.stdout);
  const body = JSON.parse(line) as { results: { label: string; effect: string | null; message: string | null }[] };
  const step = (label: string) => {
    const found = body.results.find((item) => item.label === label);
    assert.ok(found, label);
    return found;
  };
  assert.equal(step('code').effect, 'deny');
  assert.equal(step('code').message, plain.stderr.trim());
  assert.equal(step('ls-code').effect, 'allow');
  assert.equal(step('ls').effect, 'allow');
  assert.equal(step('read').effect, 'allow');
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
  assert.match(again.stdout, /kept the OpenCode tool-call plugin in \.opencode\/plugins\/yokoten\.ts/);
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
