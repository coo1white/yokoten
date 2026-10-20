// Tests for src/run/hook.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CLI,
  makeSandbox,
} from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { guardDeadline, judge, startGuard } from '../../src/run/hook.ts';

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

// #408: the hook starts the guard's worker before it reads the call, so the two overlap.
test('hook: a guard started before the call judges it as judge does; one never used lets the process end (#408)', async () => {
  const action = { command: 'git push --tags', paths: [], worker: false };
  const options = { root: null, config: DEFAULTS, env: {} };
  const guard = startGuard();
  await new Promise((wait) => setTimeout(wait, 50));
  const found = await guard.judge(action, options, 5000);
  assert.equal(found?.id, 'release');
  assert.deepEqual(found, judge(action, options));
  assert.equal(await startGuard().judge({ ...action, command: 'git status' }, options, 5000), null);
  // An unused worker does not keep node running: a hook that ends early just exits. A file,
  // not `-e`: a worker takes node's options, and `--input-type` would change how it starts.
  const sandbox = makeSandbox();
  const script = join(sandbox.home, 'unused-guard.mjs');
  writeFileSync(script, `(await import(${JSON.stringify(new URL('../../src/run/hook.ts', import.meta.url).href)})).startGuard();\n`);
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000 });
  assert.deepEqual([result.status, result.signal, result.stderr], [0, null, '']);
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
