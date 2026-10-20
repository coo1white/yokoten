// Tests for src/commands/advice.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  makeSandbox,
  pick,
} from '../repo/helpers.ts';

// Codex adds a SessionStart hook's plain stdout to the context; Gemini CLI reads JSON only (#211).
test('doctor --session --agent: plain text for Codex, hookSpecificOutput JSON for Gemini CLI (#211)', () => {
  const sandbox = makeSandbox();
  const plain = sandbox.run(['doctor', '--session']);
  assert.match(plain.stdout, /^yokoten: stage 1 of 5/);
  // Codex and Gemini CLI also hear that they don't filter command output (#390).
  const unfiltered = 'yokoten: only Claude Code hides your details in command output; other agents show it as it is. To stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json.\n';
  assert.deepEqual(pick(sandbox.run(['doctor', '--session', '--agent', 'codex'])), [plain.status, plain.stdout + unfiltered, plain.stderr]);
  const result = sandbox.run(['doctor', '--session', '--agent', 'gemini']);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['additionalContext']);
  assert.equal(out.hookSpecificOutput.additionalContext, (plain.stdout + unfiltered).trimEnd());
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // Outside a repo there is nothing to say, and no JSON either.
  assert.equal(sandbox.run(['doctor', '--session', '--agent', 'gemini'], { cwd: sandbox.home }).stdout, '');
  assert.equal(sandbox.run(['doctor', '--session', '--agent', 'cursor']).status, 1);
});

test('doctor --session: an agent that cannot filter output hears it once, with the opt-in (#390)', () => {
  const sandbox = makeSandbox();
  const line = 'yokoten: only Claude Code hides your details in command output; other agents show it as it is. To stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json.';
  assert.ok(sandbox.run(['doctor', '--session', '--agent', 'codex']).stdout.includes(line));
  assert.ok(!sandbox.run(['doctor', '--session']).stdout.includes(line), 'Claude Code filters it');
  sandbox.write('yokoten.json', JSON.stringify({ privacy: { output: 'stop' } }));
  assert.ok(!sandbox.run(['doctor', '--session', '--agent', 'codex']).stdout.includes(line), 'opted in to the stop');
});

test('doctor --session: a worker hears that lead-only files are guarded; the lead hears nothing (#402)', () => {
  const sandbox = makeSandbox();
  const line = 'yokoten: this session is a worker: lead-only files are guarded.';
  const has = (result: { stdout: string }) => result.stdout.split('\n').includes(line);
  assert.ok(has(sandbox.run(['doctor', '--session'], { extra: { YOKOTEN_ROLE: 'worker' } })), 'YOKOTEN_ROLE=worker');
  assert.ok(!has(sandbox.run(['doctor', '--session'])), 'the lead');
  assert.ok(!has(sandbox.run(['doctor'], { extra: { YOKOTEN_ROLE: 'worker' } })), 'only at session start');
});
