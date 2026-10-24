// Tests for src/agents/runtimes/runtime.ts: one contract, one conformance suite and one
// guide table for every agent adapter (#395).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { judge } from '../../../src/run/hook.ts';
import { ADAPTERS, GUIDE_AGENTS, adapterFor, denialOf, rewriteOf, stopReaderOf, worksWithTable } from '../../../src/agents/runtimes/runtime.ts';
import { ROOT } from '../../repo/helpers.ts';

const adapters = Object.values(ADAPTERS);
const options = { root: null, config: DEFAULTS, env: {}, cwd: '/repo' };

test('contract: every adapter fills the table, and its capabilities match its functions', () => {
  assert.ok(adapters.length >= 8, 'the scan found no adapters; the table is broken');
  for (const adapter of adapters) {
    assert.equal(ADAPTERS[adapter.name], adapter, `${adapter.name}: the registry key and the name differ`);
    assert.equal(adapterFor(adapter.name), adapter);
    assert.ok(adapter.label.length > 0 && adapter.projectHook.length > 0 && adapter.blocking.length > 0, `${adapter.name}: a contract field is empty`);
    assert.ok(adapter.userHook === null || adapter.userHook.startsWith('~'), `${adapter.name}: a user hook is not a home path`);
    assert.equal(adapter.capabilities.canRewrite, adapter.formatRewrite !== undefined, `${adapter.name}: canRewrite and formatRewrite differ`);
    assert.equal(adapter.capabilities.hasStopHook, adapter.readStop !== undefined, `${adapter.name}: hasStopHook and readStop differ`);
    assert.equal(adapter.capabilities.hasStopHook, stopReaderOf(adapter.name) !== undefined);
    assert.equal(typeof adapter.call('git status'), 'object', `${adapter.name}: the sample call is not an object`);
  }
});

test('conformance: every adapter reads a force push and a tag push, and the guard blocks both', () => {
  for (const adapter of adapters) {
    for (const command of ['git push --force origin main', 'git push --tags']) {
      const action = adapter.readToolCall(adapter.call(command));
      assert.equal(action.command, command, `${adapter.name} did not read the command`);
      assert.ok(judge(action, options), `${adapter.name} let through: ${command}`);
    }
  }
});

test('conformance: every adapter reads a plain read, and the guard allows it', () => {
  for (const adapter of adapters) {
    const action = adapter.readToolCall(adapter.call('git status'));
    assert.equal(action.command, 'git status', `${adapter.name} did not read the command`);
    assert.equal(judge(action, options), null, `${adapter.name} refused a plain read`);
  }
});

test('conformance: every adapter runs the posted-text scan, and the guard refuses the post', () => {
  // Built from pieces, so this file passes the repo's own privacy check.
  const email = `someone${'@'}personal-mail.com`;
  for (const adapter of adapters) {
    const action = adapter.readToolCall(adapter.call(`gh pr comment 3 --body "write to ${email}"`));
    assert.equal(judge(action, options)?.id, 'email', `${adapter.name} let a private address reach a post`);
  }
});

test('conformance: a rewrite is posted, and an adapter without one says so and keeps the refusal fallback', () => {
  const reason = 'yokoten: it may print your account';
  for (const adapter of adapters) {
    const input = adapter.call('cat ~/.config/yokoten/keys | head');
    const written = rewriteOf(adapter.name, input, 'cat ~/.config/yokoten/keys | yokoten redact', reason);
    if (!adapter.capabilities.canRewrite) {
      assert.equal(written, null, `${adapter.name} rewrites, but its table says it cannot`);
      continue;
    }
    assert.match(written ?? '', /updatedInput/, `${adapter.name} does not post the changed command`);
    assert.match(written ?? '', /yokoten redact/, `${adapter.name} lost the wrapped command`);
  }
});

test('conformance: each adapter has a refusal the agent obeys, or the core fallback', () => {
  for (const adapter of adapters) {
    const denial = denialOf(adapter.name, 'yokoten: denied');
    if (adapter.formatDenial === undefined) assert.deepEqual(denial, { stdout: '', exitCode: 2 }, `${adapter.name}: the fallback changed`);
    else assert.ok(denial.exitCode !== 0 || denial.stdout.includes('deny'), `${adapter.name}: a refusal exits 0 and says no deny`);
  }
});

test('conformance: a stop hook is there exactly when the table says, and it reads a turn end', () => {
  for (const adapter of adapters) {
    const read = stopReaderOf(adapter.name);
    if (!adapter.capabilities.hasStopHook) {
      assert.equal(read, undefined, `${adapter.name} has a stop reader, but its table says it has none`);
      continue;
    }
    assert.equal(read?.({ cwd: '/w', stop_hook_active: false })?.cwd, '/w', `${adapter.name} cannot read a turn end`);
  }
});

test('guide: every adapter has a row, and the Works with table is the generated one', () => {
  const covered = new Set(GUIDE_AGENTS.map((entry) => entry.adapter));
  assert.deepEqual([...covered].sort(), Object.keys(ADAPTERS).sort(), 'a guide row names an adapter that is not in the table, or an adapter has no row');
  const guide = readFileSync(join(ROOT, 'docs/guide.md'), 'utf8');
  assert.ok(guide.includes(worksWithTable()), 'docs/guide.md: the Works with table differs from the generated one');
  // Positive control: one changed capability must change the table.
  const changed = GUIDE_AGENTS.map((entry) => (entry.label === 'Codex CLI' ? { ...entry, changes: { canRewrite: true } } : entry));
  assert.notEqual(worksWithTable(changed), worksWithTable(), 'the generator ignores a capability; the table is not from the data');
});
