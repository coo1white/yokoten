// Tests for src/agents/desk/team/team.ts: the team folder, who is who, and the fence (#674).

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DESK_FILE, isFenced, LEAD, mainCheckout, makeTeam, modelOf, prepareDeskTeam, readRoster, teamFolderFor, vendorOf, whoAmI } from '../../../../src/agents/desk/team/team.ts';
import { fence, makeTeamFixture, makeTempDir } from '../../../repo/helpers.ts';

test('teamFolderFor and mainCheckout: the team sits next to the main checkout, also from a worktree', () => {
  const { main, team } = makeTeamFixture();
  assert.equal(team, teamFolderFor(main));
  assert.equal(team, `${main}.team`);
  assert.equal(mainCheckout(join(main, 'src')), main);
  // A linked worktree's .git file names a folder in the main checkout's git folder.
  const worktree = join(main, '..', 'worktree');
  mkdirSync(join(main, '.git', 'worktrees', 'w'), { recursive: true });
  writeFileSync(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..\n');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'w')}\n`);
  assert.equal(mainCheckout(worktree), main);
  assert.equal(mainCheckout(makeTempDir('nowhere-')), null);
});

test('vendorOf and modelOf: the model names the vendor first, then the runtime', () => {
  assert.equal(vendorOf('codex', 'deepseek-v4.1-flash'), 'DeepSeek');
  assert.equal(vendorOf('codex', 'gpt-5.5'), 'OpenAI');
  assert.equal(vendorOf('claude-code', 'model not named'), 'Anthropic');
  assert.equal(vendorOf('muse', 'model not named'), 'Meta');
  assert.equal(vendorOf('grok', 'grok-4.7'), 'xAI');
  assert.equal(modelOf(['claude', '--model', 'claude-opus-5-5', '-p', 'x']), 'claude-opus-5-5');
  assert.equal(modelOf(['codex', '--model=deepseek-v4.1-flash']), 'deepseek-v4.1-flash');
  assert.equal(modelOf(['grok', '-m', 'grok-4.7']), 'grok-4.7');
  assert.equal(modelOf(['muse']), 'model not named');
});

test('whoAmI: the lead outside a desk; a worker outside a desk has no name', () => {
  const { main, team } = makeTeamFixture();
  const me = whoAmI(main, {});
  assert.ok(!('refuse' in me));
  assert.deepEqual(me, { name: LEAD, team, readState: join(team, 'lead', 'read.json'), inDesk: false });
  const worker = whoAmI(main, { YOKOTEN_ROLE: 'worker' });
  assert.ok('refuse' in worker);
  assert.match(worker.refuse, /worker outside a desk/);
});

test('prepareDeskTeam: the roster entry, an empty outbox, the desk file; a taken or bad name is refused', () => {
  const { desk, state, team } = makeTeamFixture();
  const paths = prepareDeskTeam({ team, name: 'g1', runtime: 'grok', model: 'grok-4.7', desk, state });
  assert.deepEqual(paths, { readable: team, writable: join(team, 'outbox', 'g1.jsonl'), locked: join(desk, '.git', DESK_FILE) });
  assert.equal(readFileSync(paths.writable, 'utf8'), '');
  assert.ok(existsSync(join(team, 'outbox', 'lead.jsonl')));
  assert.deepEqual(JSON.parse(readFileSync(paths.locked, 'utf8')), { team, name: 'g1', readState: join(state, 'yokoten-messages.json') });
  const member = readRoster(team).get('g1');
  assert.equal(member?.vendor, 'xAI');
  assert.equal(member?.model, 'grok-4.7');
  // The same desk again is fine; another desk with the name is not.
  prepareDeskTeam({ team, name: 'g1', runtime: 'grok', model: 'grok-4.7', desk, state });
  assert.throws(() => prepareDeskTeam({ team, name: 'g1', runtime: 'grok', model: 'x', desk: `${desk}-2`, state }), /already has an agent named g1/);
  assert.throws(() => prepareDeskTeam({ team, name: LEAD, runtime: 'grok', model: 'x', desk, state }), /can't be a desk's name/);
  assert.throws(() => prepareDeskTeam({ team, name: '../x', runtime: 'grok', model: 'x', desk, state }), /can't be a desk's name/);
});

test('whoAmI in a desk: the desk file names the agent, but only inside the fence', () => {
  const { desk, state, team } = makeTeamFixture();
  prepareDeskTeam({ team, name: 'g1', runtime: 'grok', model: 'grok-4.7', desk, state });
  // Outside the fence (the lead looking into the desk), the desk file is not the lead's identity.
  assert.equal(isFenced(team), false);
  const outside = whoAmI(desk, {});
  assert.ok('refuse' in outside);
  assert.match(outside.refuse, /outside its fence/);
  const open = fence(team);
  try {
    assert.equal(isFenced(team), true);
    // YOKOTEN_ROLE and any other variable change nothing: the file says who.
    assert.deepEqual(whoAmI(join(desk, 'src'), { YOKOTEN_ROLE: 'worker', YOKOTEN_AGENT: LEAD }), { name: 'g1', team, readState: join(state, 'yokoten-messages.json'), inDesk: true });
  } finally {
    open();
  }
});

test('makeTeam: a link in place of a team part is refused', async () => {
  const { team } = makeTeamFixture();
  mkdirSync(team);
  const { symlinkSync } = await import('node:fs');
  symlinkSync(makeTempDir('elsewhere-'), join(team, 'outbox'));
  assert.throws(() => makeTeam(team), /is a link or not a folder/);
});
