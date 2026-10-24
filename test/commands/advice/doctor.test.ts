// Tests for src/commands/advice/doctor.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { CLI, makeSandbox, pick } from '../../repo/helpers.ts';
import { runDoctor } from '../../../src/commands/advice/doctor.ts';
import type { Invocation, Output } from '../../../src/commands/shared.ts';

// Codex adds a SessionStart hook's plain stdout to the context; Gemini CLI reads JSON only (#211).
test('doctor --session --agent: plain text for Codex, hookSpecificOutput JSON for Gemini CLI (#211)', async () => {
  const sandbox = makeSandbox();
  // The entry, through the real binary; the rest runs in this process.
  const plain = sandbox.run(['doctor', '--session']);
  assert.match(plain.stdout, /^yokoten: stage 1 of 5/);
  // Codex and Gemini CLI also hear that they don't filter command output (#390).
  const unfiltered = 'yokoten: only Claude Code hides your details in command output; other agents show it as it is. To stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json.\n';
  assert.deepEqual(pick(await sandbox.call(['doctor', '--session', '--agent', 'codex'])), [plain.status, plain.stdout + unfiltered, plain.stderr]);
  const result = await sandbox.call(['doctor', '--session', '--agent', 'gemini']);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['additionalContext']);
  assert.equal(out.hookSpecificOutput.additionalContext, (plain.stdout + unfiltered).trimEnd());
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // Outside a repo there is nothing to say, and no JSON either.
  assert.equal((await sandbox.call(['doctor', '--session', '--agent', 'gemini'], { cwd: sandbox.home })).stdout, '');
  assert.equal((await sandbox.call(['doctor', '--session', '--agent', 'cursor'])).status, 1);
});

test('doctor --session: a desk names the real model and vendor first, and the board keeps the model (#748)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  const identity = 'yokoten: you are DeepSeek (deepseek-flash), served through codex; codex is your harness, and what it says about its own maker is the tool, not you.';
  const out = (await sandbox.call(['doctor', '--session', '--agent', 'codex'], { extra: { YOKOTEN_MODEL: 'deepseek-flash', YOKOTEN_VENDOR: 'DeepSeek' } })).stdout;
  assert.equal(out.split('\n')[0], identity, 'the brief starts with who the agent is');
  assert.equal(JSON.parse(readFileSync(join(sandbox.repo, '.yokoten-agent.json'), 'utf8')).model, 'deepseek-flash', 'the board reads the real model');
  // A model of the harness's own vendor needs no line: its prompt already tells the truth.
  const own = (await sandbox.call(['doctor', '--session', '--agent', 'codex'], { extra: { YOKOTEN_MODEL: 'gpt-6.1-sol', YOKOTEN_VENDOR: 'OpenAI' } })).stdout;
  assert.ok(!own.includes('you are'), 'no identity line for the harness own vendor');
});

test('doctor --session: an agent that cannot filter output hears it once, with the opt-in (#390)', async () => {
  const sandbox = makeSandbox();
  const line = 'yokoten: only Claude Code hides your details in command output; other agents show it as it is. To stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json.';
  assert.ok((await sandbox.call(['doctor', '--session', '--agent', 'codex'])).stdout.includes(line));
  assert.ok(!(await sandbox.call(['doctor', '--session'])).stdout.includes(line), 'Claude Code filters it');
  sandbox.write('yokoten.json', JSON.stringify({ privacy: { output: 'stop' } }));
  assert.ok(!(await sandbox.call(['doctor', '--session', '--agent', 'codex'])).stdout.includes(line), 'opted in to the stop');
});

test('doctor --session: after a compaction, Claude Code hears only what changed (#405)', async () => {
  const sandbox = makeSandbox();
  const today = (await sandbox.call(['doctor', '--session'])).stdout;
  const hook = { CLAUDE_PROJECT_DIR: sandbox.repo };
  const start = async (event: Record<string, string>) => (await sandbox.call(['doctor', '--session'], { input: JSON.stringify({ hook_event_name: 'SessionStart', ...event }), extra: hook })).stdout;
  assert.equal(await start({ session_id: 's-1', source: 'startup' }), today, 'a first start prints as today');
  assert.equal(await start({ session_id: 's-1', source: 'compact' }), '', 'a compaction start with nothing new prints nothing');
  sandbox.write('AGENTS.md', '# rules\n');
  const changed = await start({ session_id: 's-1', source: 'compact' });
  assert.match(changed, /^yokoten: stage 1 of 5, safety net\. Next: no tool-call guard/);
  assert.match(changed, /^Tell the user in plain words/m, 'a changed step keeps its offer line');
  assert.doesNotMatch(changed, /private-marks/, 'a note the session heard is not repeated');
  // No session id, or no hook: as today.
  assert.equal(await start({ source: 'compact' }), (await sandbox.call(['doctor', '--session'])).stdout);
  assert.equal((await sandbox.call(['doctor', '--session'], { input: JSON.stringify({ session_id: 's-1', source: 'compact' }) })).stdout, (await sandbox.call(['doctor', '--session'])).stdout, 'stdin is read only in a Claude Code hook');
});

test('doctor --session: a stdin pipe left open never holds the session start (#405)', async () => {
  const sandbox = makeSandbox();
  const today = (await sandbox.call(['doctor', '--session'])).stdout;
  // Like a hook runner that writes the event, or nothing, and never closes stdin.
  const start = (event?: Record<string, string>) =>
    new Promise<{ code: number | null; stdout: string }>((done, failed) => {
      const child = spawn('node', [CLI, 'doctor', '--session'], { cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PROJECT_DIR: sandbox.repo }, stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      const timer = setTimeout(() => {
        child.kill();
        failed(new Error('doctor --session waited on an open stdin'));
      }, 15_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        child.stdin.destroy();
        done({ code, stdout });
      });
      if (event) child.stdin.write(JSON.stringify(event));
    });
  assert.deepEqual(await start(), { code: 0, stdout: today }, 'no event: everything, as today');
  assert.deepEqual(await start({ session_id: 's-open', source: 'startup' }), { code: 0, stdout: today });
  assert.deepEqual(await start({ session_id: 's-open', source: 'compact' }), { code: 0, stdout: '' }, 'the event is read without an end of input');
});

test('doctor --session: a worker hears that lead-only files are guarded; the lead hears nothing (#402)', async () => {
  const sandbox = makeSandbox();
  const line = 'yokoten: this session is a worker: lead-only files are guarded.';
  const has = (result: { stdout: string }) => result.stdout.split('\n').includes(line);
  assert.ok(has(await sandbox.call(['doctor', '--session'], { extra: { YOKOTEN_ROLE: 'worker' } })), 'YOKOTEN_ROLE=worker');
  assert.ok(!has(await sandbox.call(['doctor', '--session'])), 'the lead');
  assert.ok(!has(await sandbox.call(['doctor'], { extra: { YOKOTEN_ROLE: 'worker' } })), 'only at session start');
  // A compaction drops what the session heard, never the worker's role (#405).
  const start = (source: string) => sandbox.call(['doctor', '--session'], { extra: { YOKOTEN_ROLE: 'worker', CLAUDE_PROJECT_DIR: sandbox.repo }, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'w-1', source }) });
  assert.ok(has(await start('startup')));
  assert.ok(has(await start('compact')), 'after a compaction too');
});

// #561: full doctor says one line while the slow reads run, on a terminal only. A session
// never reads the server, and --json keeps stdout to the report.
test('doctor: one progress line on a terminal; none off it, in a session, or with --json (#561)', () => {
  const sandbox = makeSandbox();
  const kept = (isTTY: boolean | undefined) => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _, done) { chunks.push(String(chunk)); done(); } });
    if (isTTY !== undefined) (stream as Writable & { isTTY: boolean }).isTTY = isTTY;
    return { stream: stream as Output, text: () => chunks.join('') };
  };
  const run = (isTTY: boolean | undefined, args: string[]): { code: number; stdout: string } => {
    const stdout = kept(isTTY);
    const stderr = kept(undefined);
    const invocation: Invocation = { command: 'doctor', args, env: { ...sandbox.env }, cwd: sandbox.repo, stdout: stdout.stream, stderr: stderr.stream, stdin: { fd: null, text: '', stream: Readable.from(['']) }, script: CLI };
    return { code: runDoctor(invocation), stdout: stdout.text() };
  };
  const line = 'reading GitHub settings...\n';
  const tty = run(true, []);
  assert.ok(tty.stdout.startsWith(line), 'the line comes first');
  const piped = run(undefined, []);
  assert.ok(!piped.stdout.includes('reading GitHub settings'), 'no line off a terminal');
  assert.ok(!run(true, ['--session']).stdout.includes('reading GitHub settings'), 'no line at session start');
  const json = run(true, ['--json']);
  assert.ok(!json.stdout.includes('reading GitHub settings'), 'stdout holds only the report');
  JSON.parse(json.stdout);
});
