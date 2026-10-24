// Tests for src/agents/desk/team/team.ts: the team folder, the roster and names (#674).

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { outboxNames } from '../../../../src/agents/desk/team/outbox.ts';
import { DESK_FILE, LEAD, makeTeam, modelOf, prepareDeskTeam, readRoster, teamFolderFor, teamName, vendorOf } from '../../../../src/agents/desk/team/team.ts';
import { makeTeamFixture, makeTempDir } from '../../../repo/helpers.ts';

test('teamFolderFor: the team sits next to the main checkout', () => {
  const { main, team } = makeTeamFixture();
  assert.equal(team, teamFolderFor(main));
  assert.equal(team, `${main}.team`);
});

test('teamName: a desk folder name made into a team name, or none', () => {
  assert.equal(teamName('g1'), 'g1');
  assert.equal(teamName('Grok_Desk 2'), 'grok-desk-2');
  assert.equal(teamName('-x-'), 'x');
  assert.equal(teamName('a'.repeat(40)), 'a'.repeat(32));
  assert.equal(teamName('...'), null);
  assert.equal(teamName('Lead'), null);
  for (const name of ['Owner', 'user', 'HUMAN', 'system', 'yokoten', 'admin', 'maintainer']) assert.equal(teamName(name), null, name);
});

test('readRoster: model and runtime are one plain line; a FIFO in the roster does not hang', () => {
  const { team } = makeTeamFixture();
  makeTeam(team);
  writeFileSync(join(team, 'agents', 'x1.json'), JSON.stringify({ runtime: 'grok\n--- end ---', model: `m\u2028\u202eodel${'z'.repeat(100)}`, desk: '/d' }));
  execFileSync('mkfifo', [join(team, 'agents', 'x2.json')]);
  const roster = readRoster(team);
  const x1 = roster.get('x1');
  assert.equal(x1?.runtime, 'grok --- end ---');
  assert.ok(x1?.model.startsWith('model') && x1.model.length <= 67, x1?.model);
  assert.equal(roster.has('x2'), false);
});

test('vendorOf and modelOf: the model names the vendor first, then the runtime', () => {
  assert.equal(vendorOf('codex', 'deepseek-v4.1-flash'), 'DeepSeek');
  assert.equal(vendorOf('codex', 'gpt-5.5'), 'OpenAI');
  assert.equal(vendorOf('claude-code', 'model not named'), 'Anthropic');
  assert.equal(vendorOf('muse', 'model not named'), 'Meta');
  assert.equal(vendorOf('grok', 'grok-4.7'), 'xAI');
  assert.equal(vendorOf('codex', 'flash', 'deepseek'), 'DeepSeek', 'a provider name counts when the model name does not (#748)');
  assert.equal(vendorOf('codex', 'gpt-6.1-sol', 'openai'), 'OpenAI');
  assert.equal(modelOf(['claude', '--model', 'claude-opus-5-5', '-p', 'x']), 'claude-opus-5-5');
  assert.equal(modelOf(['codex', '--model=deepseek-v4.1-flash']), 'deepseek-v4.1-flash');
  assert.equal(modelOf(['grok', '-m', 'grok-4.7']), 'grok-4.7');
  assert.equal(modelOf(['muse']), 'model not named');
});

test('prepareDeskTeam: the roster entry, an empty outbox, the desk file; a taken or bad name is refused', () => {
  const { desk, team } = makeTeamFixture();
  const paths = prepareDeskTeam({ team, name: 'g1', runtime: 'grok', model: 'grok-4.7', desk });
  assert.deepEqual(paths, { readable: team, writable: join(team, 'outbox', 'g1.jsonl'), locked: join(desk, '.git', DESK_FILE) });
  assert.equal(readFileSync(paths.writable, 'utf8'), '');
  assert.ok(existsSync(join(team, 'outbox', 'lead.jsonl')));
  assert.deepEqual(JSON.parse(readFileSync(paths.locked, 'utf8')), { name: 'g1' });
  const member = readRoster(team).get('g1');
  assert.equal(member?.vendor, 'xAI');
  assert.equal(member?.model, 'grok-4.7');
  // The same desk again is fine; another desk with the name is not.
  prepareDeskTeam({ team, name: 'g1', runtime: 'grok', model: 'grok-4.7', desk });
  assert.throws(() => prepareDeskTeam({ team, name: 'g1', runtime: 'grok', model: 'x', desk: `${desk}-2` }), /already has an agent named g1/);
  assert.throws(() => prepareDeskTeam({ team, name: LEAD, runtime: 'grok', model: 'x', desk }), /can't be a desk's name/);
  assert.throws(() => prepareDeskTeam({ team, name: '../x', runtime: 'grok', model: 'x', desk }), /can't be a desk's name/);
  assert.throws(() => prepareDeskTeam({ team, name: 'owner', runtime: 'grok', model: 'x', desk }), /can't be a desk's name/);
  // The roster keeps the desk relative to the team folder, so it names no home folder; it reads back whole.
  assert.equal(JSON.parse(readFileSync(join(team, 'agents', 'g1.json'), 'utf8')).desk, relative(team, desk));
  assert.equal(readRoster(team).get('g1')?.desk, desk);
  // A roster entry or an outbox under a reserved name is no one's.
  writeFileSync(join(team, 'agents', 'owner.json'), JSON.stringify({ runtime: 'grok', model: 'x', desk }));
  writeFileSync(join(team, 'outbox', 'owner.jsonl'), '');
  assert.equal(readRoster(team).has('owner'), false);
  assert.deepEqual(outboxNames(team), ['g1', LEAD]);
});

test('makeTeam: a link in place of a team part is refused', async () => {
  const { team } = makeTeamFixture();
  mkdirSync(team);
  const { symlinkSync } = await import('node:fs');
  symlinkSync(makeTempDir('elsewhere-'), join(team, 'outbox'));
  assert.throws(() => makeTeam(team), /is a link or not a folder/);
});
