// Tests for src/agents/runtimes/claude-code.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  makeSandbox,
  manifest,
  PLUGIN_ROOT,
  ROOT,
} from '../../repo/helpers.ts';
import { formatRewrite, hasSessionInput, readSessionStart } from '../../../src/agents/runtimes/claude-code.ts';
import { refuseOnFailure } from '../../../src/run/cli.ts';

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

test('plugin: its hooks are the ones install adds, and the guard it registers blocks', () => {
  const sandbox = makeSandbox();
  const hooks = manifest('plugin.json').hooks as Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
  // install's user-level hooks, with the plugin's root in place of the machine copy.
  assert.equal(sandbox.run(['install']).status, 0);
  const installed = JSON.parse(readFileSync(join(sandbox.home, '.claude', 'settings.json'), 'utf8')).hooks;
  // Claude Code keeps the plugin's copy, so only install's commands check that the copy is there (#204).
  const unguard = (command: string) => command.replace(/^\[ -f .*?; \}; (?=node |command -v node )/, '');
  const shape = (h: typeof hooks, cli: string) => Object.fromEntries(Object.entries(h).map(([event, groups]) => [event, groups.map((g) => ({ matcher: g.matcher, commands: g.hooks.map((x) => `${x.type}: ${unguard(x.command).replace(cli, 'CLI')}`) }))]));
  assert.deepEqual(shape(hooks, `"${PLUGIN_ROOT}/bin/yokoten.ts"`), shape(installed, '"$HOME/.local/share/yokoten/bin/yokoten.ts"'));
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
  assert.doesNotMatch(sandbox.run(['doctor', '--session']).stdout, /yokoten:init/, 'only from the plugin');
});

// /yokoten:update (#142). The skill runs the plugin's own yokoten, which may be newer
// than the project's .yokoten/ copy: the preview first, the write only when asked.
test('plugin: /yokoten:update previews from the plugin, then writes with --write; a .yokoten/ copy without its kit cannot compare', () => {
  const sandbox = makeSandbox();
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

// The plugin's guard is the text the builder makes, so the two cannot drift (#260).
test('plugin: its tool-call guard is the command refuseOnFailure builds', () => {
  assert.equal(manifest('plugin.json').hooks.PreToolUse[0].hooks[0].command, refuseOnFailure(`"${PLUGIN_ROOT}/bin/yokoten.ts"`, 'hook --commands-only'));
});

test('hook: a Copilot CLI call, in the Claude-format shape it sends from .claude/settings.json, is refused with the reason on stdout too (#30)', () => {
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
  const result = sandbox.run(['hook'], { input });
  assert.equal(result.status, 2, 'Claude Code reads exit 2 and stderr');
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags\./);
  // Copilot CLI shows the agent only "hook exited with code 2" unless stdout names the reason.
  assert.deepEqual(JSON.parse(result.stdout), { permissionDecision: 'deny', permissionDecisionReason: result.stderr.trimEnd() });
  const create = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: sandbox.repo, tool_name: 'Write', tool_input: { path: join(sandbox.repo, 'AGENTS.md'), file_text: 'x' } });
  assert.equal(sandbox.run(['hook'], { input: create, extra: { YOKOTEN_ROLE: 'worker' } }).status, 2, "Copilot's create tool names the file in `path`");
});

test('formatRewrite: allow, with the whole tool input, only the command changed (#390)', () => {
  const out = JSON.parse(formatRewrite({ tool_name: 'Bash', tool_input: { command: 'git log', description: 'Log', timeout: 5 } }, 'wrapped', 'why'));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'why', updatedInput: { command: 'wrapped', description: 'Log', timeout: 5 } } });
  assert.deepEqual(JSON.parse(formatRewrite(null, 'w', 'r')).hookSpecificOutput.updatedInput, { command: 'w' });
});

test('session start: the id and the source, and stdin only in a hook (#405)', () => {
  assert.deepEqual(readSessionStart({ session_id: 'a1-b2_c3', source: 'compact', hook_event_name: 'SessionStart' }), { sessionId: 'a1-b2_c3', source: 'compact' });
  assert.deepEqual(readSessionStart({ session_id: 'a1' }), { sessionId: 'a1', source: '' });
  for (const input of [null, [], 'x', {}, { session_id: '' }, { session_id: '../a' }, { session_id: 7 }]) assert.equal(readSessionStart(input), null, JSON.stringify(input));
  assert.equal(hasSessionInput({ CLAUDE_PROJECT_DIR: '/p' }, false), true);
  assert.equal(hasSessionInput({ CLAUDE_PROJECT_DIR: '/p' }, true), false, 'a terminal is never read');
  assert.equal(hasSessionInput({}, false), false, 'not a Claude Code hook');
});
