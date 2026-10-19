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
  assert.deepEqual(pick(sandbox.run(['doctor', '--session', '--agent', 'codex'])), pick(plain));
  const result = sandbox.run(['doctor', '--session', '--agent', 'gemini']);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['additionalContext']);
  assert.equal(out.hookSpecificOutput.additionalContext, plain.stdout.trimEnd());
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // Outside a repo there is nothing to say, and no JSON either.
  assert.equal(sandbox.run(['doctor', '--session', '--agent', 'gemini'], { cwd: sandbox.home }).stdout, '');
  assert.equal(sandbox.run(['doctor', '--session', '--agent', 'cursor']).status, 1);
});
