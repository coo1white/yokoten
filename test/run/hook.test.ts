// Tests for src/run/hook.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
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
  pick,
} from '../helpers.ts';
import { guardDeadline } from '../../src/run/hook.ts';

test('hook: blocks with exit 2 and a reason, allows with exit 0', () => {
  const sandbox = makeSandbox();
  const call = (tool_input: object, extra?: Record<string, string>) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input }), extra });
  let result = call({ command: 'git push --tags' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /owner decides when to release/);
  assert.equal(call({ command: 'git status' }).status, 0);
  // A heredoc body is data, unless a shell reads it (#105).
  assert.equal(call({ command: "ego-browser nodejs <<'EOF'\nawait page.fill('#q', 'npm publish');\nEOF" }).status, 0);
  assert.equal(call({ command: 'bash <<EOF\nnpm publish\nEOF' }).status, 2);
  assert.equal(call({ file_path: join(sandbox.repo, 'AGENTS.md') }).status, 0);
  result = call({ file_path: join(sandbox.repo, 'AGENTS.md') }, { YOKOTEN_ROLE: 'worker' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  // A worker subagent is a worker even in a lead session.
  result = sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, agent_type: 'worker', tool_input: { file_path: 'CLAUDE.md' } }) });
  assert.equal(result.status, 2);
  // The user-level guard leaves files to the project.
  result = sandbox.run(['hook', '--commands-only'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { file_path: 'CLAUDE.md' } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 0);
  assert.equal(sandbox.run(['hook'], { input: 'not json' }).status, 0);
});

// A session started outside the repo, or a worker in a worktree elsewhere, loads no project
// hook: the user-level guard applies the file's own repo's rules, if yokoten is set up there (#307).
test('hook --commands-only: an edit in a yokoten repo gets its file rules wherever the session started (#307)', () => {
  const sandbox = makeSandbox();
  const away = mkdtempSync(join(tmpdir(), 'yokoten-away-'));
  const edit = (file_path: string, extra?: Record<string, string>) =>
    sandbox.run(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Edit', tool_input: { file_path } }), extra });
  const worker = { YOKOTEN_ROLE: 'worker' };
  // No yokoten.json: not a yokoten repo, so no file rules.
  assert.equal(edit(join(sandbox.repo, 'AGENTS.md'), worker).status, 0);
  sandbox.write('yokoten.json', '{}\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  let result = edit(join(sandbox.repo, 'AGENTS.md'), worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal(edit(join(sandbox.repo, '.githooks', 'pre-commit'), worker).status, 2, 'a file in a folder that does not exist yet');
  assert.equal(edit(join(sandbox.repo, 'AGENTS.md')).status, 0, 'the lead may');
  assert.equal(edit(join(sandbox.repo, 'src', 'a.ts'), worker).status, 0, 'a worker may edit code');
  // A worker subagent in a lead session.
  result = sandbox.run(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, agent_type: 'worker', tool_name: 'Edit', tool_input: { file_path: join(sandbox.repo, 'AGENTS.md') } }) });
  assert.equal(result.status, 2);
  // A relative path, from the session's folder.
  const parent = dirname(sandbox.repo);
  result = sandbox.run(['hook', '--commands-only'], { cwd: parent, input: JSON.stringify({ cwd: parent, tool_name: 'Edit', tool_input: { file_path: 'repo/AGENTS.md' } }), extra: worker });
  assert.equal(result.status, 2);
  // A worktree in another folder: its own checkout, the same rules.
  const tree = join(mkdtempSync(join(tmpdir(), 'yokoten-tree-')), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'task', tree);
  result = edit(join(tree, 'AGENTS.md'), worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal(edit(join(tree, 'AGENTS.md')).status, 0);
  // The full hook too, from a session outside the repo.
  result = sandbox.run(['hook'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Edit', tool_input: { file_path: join(tree, 'AGENTS.md') } }), extra: worker });
  assert.equal(result.status, 2);
  // Commands are unchanged.
  const bash = (command: string) => sandbox.run(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Bash', tool_input: { command } }), extra: worker });
  assert.equal(bash(`cat ${join(sandbox.repo, 'AGENTS.md')}`).status, 0);
  assert.equal(bash('git push --tags').status, 2);
  // A patch run through Codex's shell edits files too (#221): they get their repo's rules.
  const patch = (file: string) => `apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\nEOF\n`;
  const codex = (command: string) =>
    sandbox.run(['hook', '--agent', 'codex', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), extra: worker });
  result = codex(patch(join(sandbox.repo, 'AGENTS.md')));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal(codex(patch(join(sandbox.repo, 'src', 'a.ts'))).status, 0);
});

// The runtimes let a tool call through when the hook runs past their timeout, so a guard
// that reads too long is stopped and the call refused (#274).
test('hook: past the deadline the call is refused, in text and JSON (#274)', () => {
  const sandbox = makeSandbox();
  const input = JSON.stringify({ cwd: sandbox.repo, tool_input: { command: `npm run build -- ${'--flag value '.repeat(200)}` } });
  const late = { YOKOTEN_GUARD_DEADLINE_MS: '1' };
  let result = sandbox.run(['hook'], { input, extra: late });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^yokoten: the guard took longer than 1 ms to read this command\. .*Split the command into smaller ones\./);
  result = sandbox.run(['hook', '--json'], { input, extra: late });
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.blocked, true);
  assert.equal(out.finding.id, 'unreadable-command');
  // The default deadline: a plain command passes, and the guard still blocks.
  const call = (command: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  assert.equal(call('ls').status, 0);
  assert.equal(call('git push --force origin main').status, 2);
  assert.equal(sandbox.run(['hook'], { input, extra: { YOKOTEN_GUARD_DEADLINE_MS: 'soon' } }).status, 0, 'a bad value keeps the default');
  // The setting can never turn the deadline off, nor set a timer Node can't hold.
  for (const [value, ms] of [['', 5000], ['0', 5000], ['-5', 5000], ['0x10', 5000], ['1e9', 5000], ['2.5', 5000], ['Infinity', 5000], ['250', 250], ['90000', 30_000], ['3000000000', 30_000]] as const) {
    assert.equal(guardDeadline(value), ms, `YOKOTEN_GUARD_DEADLINE_MS=${value}`);
  }
});

test('hook: a command the guard reads too slowly is refused within the deadline (#274)', () => {
  const sandbox = makeSandbox();
  // A large command, still being read when a 1 ms deadline passes, however fast the reader:
  // the busy worker is stopped and the hook exits at once, in little memory.
  const input = JSON.stringify({ cwd: sandbox.repo, tool_input: { command: `find . ${'-exec env '.repeat(30000)}` } });
  const start = Date.now();
  const result = spawnSync('node', ['--max-old-space-size=256', CLI, 'hook'], { cwd: sandbox.repo, env: { ...sandbox.env, YOKOTEN_GUARD_DEADLINE_MS: '1' }, input, encoding: 'utf8', timeout: 20000 });
  const took = Date.now() - start;
  assert.ok(took < 10000, `the hook took ${took} ms`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /took longer than 1 ms/);
});

// The Stop event is shaped as Claude Code's hook docs show it (code.claude.com/docs/en/hooks#stop).
test('hook: bad JSON in yokoten.json gives the defaults and one line, and check still fails (#218)', () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{ "layout": ');
  const call = (command: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  const line = /^yokoten hook: yokoten\.json was ignored, so the defaults apply; the core checks still run\. yokoten\.json: [^\n]+\n/;
  let result = call('git push --force');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, line);
  assert.match(result.stderr, /\nyokoten: [^\n]*force/);
  assert.ok(!result.stderr.includes(sandbox.repo), 'no absolute path');
  result = call('git status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, line);
  assert.equal(result.stderr.split('\n').filter(Boolean).length, 1, 'one line');
  // check and doctor still see a config problem.
  result = sandbox.run(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /yokoten\.json:/);
});

test('hook: a key with the wrong shape gets its default and one line; check names the key; an unknown key is a note (#228)', () => {
  const sandbox = makeSandbox();
  // Positive control: before #228, this made the hook crash on an edit (exit 1, guard open).
  sandbox.write('yokoten.json', '{ "leadOnly": "x" }');
  const call = (toolInput: Record<string, string>) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: toolInput }), extra: { YOKOTEN_ROLE: 'worker' } });
  const line = /^yokoten hook: yokoten\.json "leadOnly" was ignored, so its default applies; the core checks still run\. yokoten\.json: "leadOnly" must be a list of text, such as [^\n]+\n/;
  for (const toolInput of [{ file_path: 'AGENTS.md' }, { command: 'git push --force' }] as Record<string, string>[]) {
    const result = call(toolInput);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, line);
    assert.equal(result.stderr.match(/^yokoten hook:/gm)?.length, 1, 'one line');
  }
  let result = sandbox.run(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check: yokoten\.json: "leadOnly" must be a list of text/);
  // An unknown key is a note, and check passes.
  sandbox.write('yokoten.json', '{ "colour": "blue" }');
  result = sandbox.run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten check: note: yokoten\.json: "colour" is not a key this version of yokoten knows/m);
  assert.equal(call({ command: 'git status' }).stderr, '', 'the hook says nothing');
  // Every wrong key in one run.
  sandbox.write('yokoten.json', '{ "leadOnly": "x", "tests": 5, "notNow": null }');
  result = sandbox.run(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check: yokoten\.json: 2 keys have the wrong shape:\n- "tests" must be [^\n]+\n- "leadOnly" must be /);
});

test('hook --stop: sends the agent back once with the findings in changed files, never twice (#92)', () => {
  const sandbox = makeSandbox();
  const stop = (active = false, extra?: Record<string, string>) =>
    sandbox.run(['hook', '--stop'], { input: JSON.stringify({ session_id: 'abc123', cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: 'done' }), extra });
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  // Clean: the turn ends.
  let result = stop();
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  // A fake secret in a new, untracked file, written by a script the tool hook never saw.
  const key = `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}`;
  sandbox.write('scripts/out.txt', `${key}\n`);
  result = stop();
  assert.equal(result.status, 2, 'blocked');
  assert.match(result.stderr, /^yokoten: 1 problem\(s\) in the changed files\. Fix them before you end the turn:\n- scripts\/out\.txt:1: a secret \(AWS access key id\)\. .+\. .+\.\n  docs: https:\/\/\S+#privacy\n$/);
  assert.ok(!result.stderr.includes(key), 'the secret is never printed');
  assert.equal(result.stdout, '', 'stdout stays empty for the runtime');
  // Already sent back once: the turn ends, whatever is found. No loop.
  result = stop(true);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  // Staged and changed files count too; a lead-only file only for a worker.
  rmSync(join(sandbox.repo, 'scripts'), { recursive: true });
  sandbox.write('a.md', `mail me${at}gmail.com\n`);
  assert.match(stop().stderr, /a\.md:1: an email/);
  sandbox.write('a.md', 'fine\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', 'AGENTS.md');
  assert.equal(stop().status, 0);
  result = stop(false, { YOKOTEN_ROLE: 'worker' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  // --json: the same Finding shape.
  result = sandbox.run(['hook', '--stop', '--json'], { input: JSON.stringify({ cwd: sandbox.repo, stop_hook_active: false }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.deepEqual([out.blocked, out.stop, out.findings[0].id], [true, true, 'lead-only']);
  for (const k of ['what', 'why', 'fix']) assert.ok(out.findings[0][k]);
  // Not a Stop event, or not a repo: the turn ends.
  for (const input of ['not json', '', 'null', '[1]']) assert.equal(sandbox.run(['hook', '--stop'], { input }).status, 0, input);
  const away = mkdtempSync(join(tmpdir(), 'yokoten-away-'));
  assert.equal(sandbox.run(['hook', '--stop'], { input: JSON.stringify({ cwd: away }) }).status, 0);
  // Outside a repo the guard still stops a tag push, and git's own error stays hidden:
  // an agent read it as the result of the stopped command.
  result = sandbox.run(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Bash', tool_input: { command: 'git push --tags' } }) });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /fatal|not a git repository/);
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags\..*YOKOTEN_RELEASE_APPROVAL=1 claude/);
  // A broken config is an internal error: the turn ends, with one line on stderr.
  sandbox.write('yokoten.json', '{ broken');
  result = sandbox.run(['hook', '--stop'], { input: JSON.stringify({ cwd: sandbox.repo }) });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^yokoten hook --stop: skipped, [^\n]+\n$/);
  // --stop takes a known agent only, and never with --commands-only.
  assert.equal(sandbox.run(['hook', '--stop', '--agent', 'cursor'], { input: '{}' }).status, 1);
  assert.equal(sandbox.run(['hook', '--stop', '--commands-only'], { input: '{}' }).status, 1);
});

// Each end-of-turn event as the runtime sends it (#211): Codex's Stop (rust-v0.163.0
// schema) and Gemini CLI's AfterAgent (v0.64.0). Both send the agent back on exit 2.
test('hook --stop --agent codex|gemini: the end-of-turn event sends the agent back once (#211)', () => {
  const sandbox = makeSandbox();
  const events: Record<string, (active: boolean) => object> = {
    codex: (active) => ({
      session_id: 'thr_123',
      transcript_path: null,
      cwd: sandbox.repo,
      hook_event_name: 'Stop',
      model: 'gpt-5',
      permission_mode: 'default',
      turn_id: 'turn_1',
      stop_hook_active: active,
      last_assistant_message: 'done',
    }),
    gemini: (active) => ({
      session_id: 's1',
      transcript_path: join(sandbox.home, 't.json'),
      cwd: sandbox.repo,
      hook_event_name: 'AfterAgent',
      timestamp: '2026-10-19T00:00:00.000Z',
      prompt: 'fix it',
      prompt_response: 'done',
      stop_hook_active: active,
    }),
  };
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  for (const [agent, event] of Object.entries(events)) {
    const stop = (active: boolean) => sandbox.run(['hook', '--stop', '--agent', agent], { input: JSON.stringify(event(active)) });
    assert.deepEqual(pick(stop(false)), [0, '', ''], `${agent}: clean`);
    sandbox.write('a.md', `mail me${at}gmail.com\n`);
    const result = stop(false);
    assert.equal(result.status, 2, `${agent}: sent back`);
    assert.match(result.stderr, /^yokoten: 1 problem\(s\) in the changed files\. Fix them before you end the turn:\n- a\.md:1: an email/);
    assert.equal(result.stdout, '', `${agent}: stdout stays empty`);
    assert.deepEqual(pick(stop(true)), [0, '', ''], `${agent}: already sent back once`);
    sandbox.write('a.md', 'fine\n');
  }
  // The hooks init writes run the same check, from the vendored copy.
  assert.equal(sandbox.run(['init']).status, 0);
  sandbox.write('a.md', `mail me${at}gmail.com\n`);
  const command = (file: string, event: string) => JSON.parse(readFileSync(join(sandbox.repo, file), 'utf8')).hooks[event][0].hooks[0].command as string;
  const shell = (text: string, input: object) =>
    spawnSync(text, { shell: '/bin/sh', cwd: sandbox.repo, env: { ...sandbox.env, GEMINI_PROJECT_DIR: sandbox.repo }, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(shell(command('.codex/hooks.json', 'Stop'), events.codex(false)).status, 2, 'the Codex Stop hook');
  assert.equal(shell(command('.gemini/settings.json', 'AfterAgent'), events.gemini(false)).status, 2, 'the Gemini AfterAgent hook');
  assert.equal(shell(command('.codex/hooks.json', 'Stop'), events.codex(true)).status, 0);
  // doctor's codex-hook step wants the stop check too.
  const codexFile = join(sandbox.repo, '.codex', 'hooks.json');
  const hooks = JSON.parse(readFileSync(codexFile, 'utf8'));
  delete hooks.hooks.Stop;
  writeFileSync(codexFile, JSON.stringify(hooks));
  assert.match(sandbox.run(['doctor']).stdout, /note +codex-hook: no stop check in \.codex\/hooks\.json/);
});

test('hook: a repo reached through a symlink gets the same file rules (#1)', () => {
  const sandbox = makeSandbox();
  const link = join(sandbox.home, 'link');
  symlinkSync(sandbox.repo, link);
  const call = (file_path: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: link, tool_input: { file_path } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(call(join(link, 'AGENTS.md')).status, 2, 'absolute path through the link');
  assert.equal(call('AGENTS.md').status, 2, 'relative to a cwd through the link');
  assert.equal(call(join(link, '.github', 'new', 'x.yml')).status, 2, 'a file in a folder that does not exist yet');
  assert.equal(call(join(sandbox.home, 'elsewhere.md')).status, 0, 'outside the repo');
});
