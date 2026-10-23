// Tests for src/agents/runtimes/claude-code.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  makeSandbox,
  makeTempDir,
  manifest,
  PLUGIN_ROOT,
  ROOT,
} from '../../repo/helpers.ts';
import { addProjectSandbox, addProjectStopHook, formatRewrite, hasSessionInput, readSessionStart, readStop, sandboxProblem } from '../../../src/agents/runtimes/claude-code.ts';
import { pluginHookCommand } from '../../../src/run/cli.ts';

test('claude-code readStop: a Stop or SubagentStop event is checked; a worker subagent is a worker (#614)', () => {
  assert.deepEqual(readStop({ cwd: '/w', stop_hook_active: false }), { cwd: '/w', active: false, worker: false, subagent: false, sessionId: undefined });
  assert.deepEqual(readStop({ cwd: '/w', stop_hook_active: true, session_id: 'abc' }), { cwd: '/w', active: true, worker: false, subagent: false, sessionId: 'abc' });
  assert.deepEqual(readStop({ cwd: '/w', hook_event_name: 'SubagentStop', agent_type: 'worker', agent_id: 'agent-1' }), {
    cwd: '/w',
    active: false,
    worker: true,
    subagent: true,
    sessionId: 'agent-1',
  });
  assert.equal(readStop({ agent_type: 'yokoten:worker' })?.worker, true);
  assert.equal(readStop({ hook_event_name: 'SubagentStop', agent_type: 'reviewer' })?.worker, false);
  assert.equal(readStop({ hook_event_name: 'SubagentStop', agent_type: 'coworker' })?.worker, false);
  assert.equal(readStop({ agent_type: 'Worker' })?.worker, true);
  assert.equal(readStop(null), null);
  assert.equal(readStop([]), null);
});

test('claude-code addProjectStopHook: Stop and SubagentStop both run hook --stop (#614)', () => {
  const sandbox = makeSandbox();
  assert.equal(addProjectStopHook(sandbox.repo, '.yokoten/bin/yokoten.mjs'), 'added');
  const settings = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.Stop[0].hooks[0].command as string;
  assert.match(command, /hook --stop$/);
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 600);
  assert.equal(settings.hooks.SubagentStop[0].hooks[0].command, command);
  assert.equal(settings.hooks.SubagentStop[0].hooks[0].timeout, 600);
  assert.equal(addProjectStopHook(sandbox.repo, '.yokoten/bin/yokoten.mjs'), 'same');
});

test('plugin: the marketplace and the plugin have the documented fields', () => {
  const market = manifest('marketplace.json');
  const plugin = manifest('plugin.json');
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  assert.match(market.name, idPattern);
  assert.equal(typeof market.owner?.name, 'string');
  assert.ok(market.owner.name.length > 0);
  assert.equal(market.plugins.length, 1);
  const [entry] = market.plugins;
  assert.match(entry.name, idPattern);
  // The entry name and the manifest name are the same, or an install by name fails.
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.source, './', 'the repo root is the plugin');
  assert.match(plugin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case');
  // No version in either file: users get each commit, and package.json keeps the one version.
  assert.equal(plugin.version, undefined);
  assert.equal(entry.version, undefined);
});

test('plugin: every path it names exists inside the plugin, and the kit is not copied', () => {
  const plugin = manifest('plugin.json');
  const paths: string[] = [...plugin.skills, ...plugin.agents];
  for (const p of paths) {
    assert.ok(p.startsWith('./'), `${p} starts with ./`);
    assert.ok(!p.split('/').includes('..'), `${p} stays in the plugin`);
    assert.ok(existsSync(join(ROOT, p)), `${p} exists`);
  }
  // Skills are folders of <name>/SKILL.md: the ones install puts on a machine, and the
  // plugin's own, which run yokoten from the plugin. Agents are .md files, every kit agent.
  assert.deepEqual(plugin.skills, ['./kit/user/skills/', './kit/plugin/skills/']);
  for (const dir of plugin.skills) for (const name of readdirSync(join(ROOT, dir))) assert.ok(existsSync(join(ROOT, dir, name, 'SKILL.md')), `${dir}${name}`);
  assert.deepEqual(plugin.agents, readdirSync(join(ROOT, 'kit/user/agents')).sort().map((f) => `./kit/user/agents/${f}`), 'list every agent in kit/user/agents');
  // Every script a hook or a plugin skill runs is in the plugin, named from its root.
  const skills = readdirSync(join(ROOT, 'kit/plugin/skills')).map((name) => readFileSync(join(ROOT, 'kit/plugin/skills', name, 'SKILL.md'), 'utf8'));
  const text = [JSON.stringify(plugin.hooks), ...skills].join('\n');
  const scripts = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\ ]+)/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 4, 'the scan found the hooks and commands');
  for (const s of scripts) assert.ok(existsSync(join(ROOT, s)), s);
});

test('plugin: install keeps a direct path, and the guard the plugin registers blocks (#706)', async () => {
  const sandbox = makeSandbox();
  const hooks = manifest('plugin.json').hooks as Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
  // install's entry, through the real binary. Its hooks stay a direct path (#706).
  assert.equal(sandbox.run(['install']).status, 0);
  const installed = JSON.parse(readFileSync(join(sandbox.home, '.claude', 'settings.json'), 'utf8')).hooks as typeof hooks;
  // The same events and hook types. The commands differ: the plugin resolves a cache copy on each call.
  const shape = (table: typeof hooks) => Object.fromEntries(Object.entries(table).map(([event, groups]) => [event, groups.map((group) => ({ matcher: group.matcher, types: group.hooks.map((hook) => hook.type) }))]));
  assert.deepEqual(shape(hooks), shape(installed));
  const direct = '"$HOME/.local/share/yokoten/bin/yokoten.mjs"';
  for (const event of ['SessionStart', 'PreToolUse'] as const) {
    assert.ok(installed[event][0].hooks[0].command.includes(direct), event);
    assert.notEqual(hooks[event][0].hooks[0].command, installed[event][0].hooks[0].command, event);
  }
  // The command as Claude Code runs it: the root filled in, through the shell.
  const run = (command: string, input?: string, extra: Record<string, string> = {}) =>
    spawnSync(command.replaceAll(PLUGIN_ROOT, ROOT), { shell: true, cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PLUGIN_ROOT: ROOT, ...extra }, input, encoding: 'utf8' });
  const guard = hooks.PreToolUse[0].hooks[0].command;
  const call = (command: string) => JSON.stringify({ cwd: sandbox.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const r = run(guard, call('git push --force origin main'));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /force/);
  assert.equal(run(guard, call('git status')).status, 0);
  // At session start, doctor tells the agent how to run yokoten from the plugin.
  const session = run(hooks.SessionStart[0].hooks[0].command);
  assert.equal(session.status, 0, session.stderr);
  assert.match(session.stdout, /^yokoten: stage 1 of 5/);
  assert.match(session.stdout, /runs as \/yokoten:init, \/yokoten:doctor and \/yokoten:update/);
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, /yokoten:init/, 'only from the plugin');
});

// /yokoten:update (#142). The skill runs the plugin's own yokoten, which may be newer
// than the project's .yokoten/ copy: the preview first, the write only when asked.
test('plugin: /yokoten:update previews from the plugin, then writes with --write; a .yokoten/ copy without its kit cannot compare', () => {
  const sandbox = makeSandbox();
  // init's entry, through the real binary: the .yokoten/ copy it makes runs below.
  assert.equal(sandbox.run(['init']).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  const old = fresh.replace('Plain English, close to', 'Plain words, close to');
  assert.notEqual(old, fresh);
  writeFileSync(path, old);
  const skill = readFileSync(join(ROOT, 'kit/plugin/skills/update/SKILL.md'), 'utf8');
  const commands = [...skill.matchAll(/^ *(node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/yokoten\.ts" update.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(commands, [`node "${PLUGIN_ROOT}/bin/yokoten.ts" update`, `node "${PLUGIN_ROOT}/bin/yokoten.ts" update --write`], 'preview, then write');
  assert.doesNotMatch(skill, /\.yokoten\/bin/, 'the skill never runs the copy in .yokoten/');
  const run = (command: string) => spawnSync(command.replaceAll(PLUGIN_ROOT, ROOT), { shell: true, cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PLUGIN_ROOT: ROOT }, encoding: 'utf8' });

  // The control: a .yokoten/ copy without its kit file can't compare and writes nothing.
  rmSync(join(sandbox.repo, '.yokoten', 'kit'), { recursive: true });
  const vendored = spawnSync('node', ['.yokoten/bin/yokoten.ts', 'update', '--write'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(vendored.status, 1);
  assert.match(vendored.stderr, /can't compare AGENTS\.md with the kit: this copy of yokoten has no kit.*\/yokoten:update/);
  assert.equal(readFileSync(path, 'utf8'), old);

  let result = run(commands[0]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^- Plain words, close to/m);
  assert.match(result.stdout, /^\+ Plain English, close to/m);
  assert.equal(readFileSync(path, 'utf8'), old, 'the preview writes nothing');
  result = run(commands[1]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /replaced the core rules in AGENTS\.md/);
  assert.equal(readFileSync(path, 'utf8'), fresh);
  assert.match(run(commands[0]).stdout, /up to date/);
});

// The plugin's hooks are the text the builder makes, so the two cannot drift (#260, #706).
test('plugin: its hooks are the commands pluginHookCommand builds (#706)', () => {
  const hooks = manifest('plugin.json').hooks;
  assert.equal(hooks.PreToolUse[0].hooks[0].command, pluginHookCommand(false));
  assert.equal(hooks.SessionStart[0].hooks[0].command, pluginHookCommand(true));
});

// Claude Code prints the hook command in front of a refusal, so the line stays short (#706).
test('plugin: the longest hook command is under 400 characters (#706)', () => {
  const hooks = manifest('plugin.json').hooks;
  const commands = [hooks.PreToolUse[0].hooks[0].command, hooks.SessionStart[0].hooks[0].command] as string[];
  const longest = Math.max(...commands.map((command) => command.length));
  assert.ok(longest < 400, `the longest hook command is ${longest} characters`);
  for (const command of commands) assert.equal(command.includes('\n'), false, 'one line');
});

test('hook: a Copilot CLI call, in the Claude-format shape it sends from .claude/settings.json, is refused with the reason on stdout too (#30)', async () => {
  const sandbox = makeSandbox();
  // As Copilot CLI 1.0.98 sent it in a real run: PascalCase PreToolUse, snake_case fields.
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'e71070b2-5aa7-4ae3-a471-9ceb55032d19',
    timestamp: '2026-10-19T16:19:43.817Z',
    cwd: sandbox.repo,
    tool_name: 'Bash',
    tool_input: { command: 'git push --tags origin', description: 'Push all tags to origin' },
  });
  const result = await sandbox.call(['hook'], { input });
  assert.equal(result.status, 2, 'Claude Code reads exit 2 and stderr');
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags\./);
  // Copilot CLI shows the agent only "hook exited with code 2" unless stdout names the reason.
  assert.deepEqual(JSON.parse(result.stdout), { permissionDecision: 'deny', permissionDecisionReason: result.stderr.trimEnd() });
  const create = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: sandbox.repo, tool_name: 'Write', tool_input: { path: join(sandbox.repo, 'AGENTS.md'), file_text: 'x' } });
  assert.equal((await sandbox.call(['hook'], { input: create, extra: { YOKOTEN_ROLE: 'worker' } })).status, 2, "Copilot's create tool names the file in `path`");
});

test('formatRewrite: allow, with the whole tool input, only the command changed (#390)', () => {
  const out = JSON.parse(formatRewrite({ tool_name: 'Bash', tool_input: { command: 'git log', description: 'Log', timeout: 5 } }, 'wrapped', 'why'));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'why', updatedInput: { command: 'wrapped', description: 'Log', timeout: 5 } } });
  assert.deepEqual(JSON.parse(formatRewrite(null, 'w', 'r')).hookSpecificOutput.updatedInput, { command: 'w' });
});

test('session start: the id and the source, and stdin only in a hook (#405)', () => {
  assert.deepEqual(readSessionStart({ session_id: 'a1-b2_c3', source: 'compact', hook_event_name: 'SessionStart' }), { sessionId: 'a1-b2_c3', source: 'compact' });
  assert.deepEqual(readSessionStart({ session_id: 'a1' }), { sessionId: 'a1', source: '' });
  assert.deepEqual(readSessionStart({ session_id: 'a1', transcript_path: '/tmp/lead.jsonl' }), { sessionId: 'a1', source: '', transcriptPath: '/tmp/lead.jsonl' });
  assert.deepEqual(readSessionStart({ session_id: 'a1', transcript_path: '' }), { sessionId: 'a1', source: '' });
  for (const input of [null, [], 'x', {}, { session_id: '' }, { session_id: '../a' }, { session_id: 7 }]) assert.equal(readSessionStart(input), null, JSON.stringify(input));
  assert.equal(hasSessionInput({ CLAUDE_PROJECT_DIR: '/p' }, false), true);
  assert.equal(hasSessionInput({ CLAUDE_PROJECT_DIR: '/p' }, true), false, 'a terminal is never read');
  assert.equal(hasSessionInput({}, false), false, 'not a Claude Code hook');
});

// ---- The project's sandbox (#589) ----

/** A project folder with `.claude/settings.json` holding `settings`, as JSON text or an object. */
function settingsProject(settings: string | object): string {
  const root = makeTempDir('yokoten-claude-');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  return root;
}

test('sandbox write: the block is added, kept when yours, and skipped when the file is not JSON', () => {
  const root = makeTempDir('yokoten-claude-');
  assert.equal(addProjectSandbox(root), 'added');
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).sandbox, { enabled: true });
  assert.equal(addProjectSandbox(root), 'same');
  // A block without `enabled` takes it; the rest of the file stays.
  const partial = settingsProject({ hooks: {}, sandbox: { network: { allowedDomains: ['example.com'] } } });
  assert.equal(addProjectSandbox(partial), 'added');
  const merged = JSON.parse(readFileSync(join(partial, '.claude', 'settings.json'), 'utf8'));
  assert.equal(merged.sandbox.enabled, true);
  assert.deepEqual(merged.sandbox.network, { allowedDomains: ['example.com'] });
  assert.deepEqual(merged.hooks, {});
  // `false` is the user's explicit choice: init keeps it, and doctor names it.
  const off = settingsProject({ sandbox: { enabled: false } });
  assert.equal(addProjectSandbox(off), 'kept');
  assert.deepEqual(JSON.parse(readFileSync(join(off, '.claude', 'settings.json'), 'utf8')).sandbox, { enabled: false });
  assert.deepEqual(addProjectSandbox(settingsProject('not json {')), { kind: 'json' });
  assert.deepEqual(addProjectSandbox(settingsProject({ sandbox: 'yes' })), { kind: 'shape', hint: '`sandbox` should be an object' });
  assert.deepEqual(addProjectSandbox(settingsProject({ hooks: 'x' })), { kind: 'shape', hint: '`hooks` should be an object' });
  assert.deepEqual(addProjectSandbox(settingsProject({ env: 'x' })), { kind: 'shape', hint: '`env` should be an object' });
});

test('sandbox problem: missing, off, and wider, each with its one fix', () => {
  assert.deepEqual(sandboxProblem(makeTempDir('yokoten-claude-')), { what: 'no sandbox in .claude/settings.json', fix: '`yokoten init` adds it' });
  assert.equal(sandboxProblem(settingsProject({ sandbox: { enabled: true } })), null);
  assert.equal(sandboxProblem(settingsProject({ sandbox: { enabled: true, network: { allowedDomains: ['example.com'] } } })), null, 'named hosts are narrower');
  const problem = (settings: string | object) => sandboxProblem(settingsProject(settings));
  assert.deepEqual(problem({ hooks: {} }), { what: 'no sandbox in .claude/settings.json', fix: '`yokoten init` adds it' });
  assert.deepEqual(problem({ sandbox: { enabled: false } }), { what: 'the sandbox in .claude/settings.json is off', fix: 'set sandbox.enabled to true in .claude/settings.json' });
  assert.deepEqual(problem({ sandbox: { enabled: true, filesystem: { disabled: true } } })?.what, 'the sandbox in .claude/settings.json has filesystem isolation off');
  assert.deepEqual(problem({ sandbox: { enabled: true, network: { allowedDomains: ['*'] } } }), {
    what: 'the sandbox in .claude/settings.json allows every network host (*)',
    fix: 'list only the hosts the project needs in sandbox.network.allowedDomains in .claude/settings.json',
  });
  assert.deepEqual(problem('not json {'), { what: "can't read .claude/settings.json", fix: 'make it valid JSON, then run `yokoten init`' });
  assert.deepEqual(problem({ sandbox: 'yes' })?.what, '.claude/settings.json has an unexpected shape');
  assert.deepEqual(problem({ hooks: 'x' })?.what, '.claude/settings.json has an unexpected shape');
  assert.deepEqual(problem({ env: 'x' })?.what, '.claude/settings.json has an unexpected shape');
});
