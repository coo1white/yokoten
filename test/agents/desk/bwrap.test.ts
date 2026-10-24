// Tests for src/agents/desk/bwrap.ts: the words bwrap gets. That the fence holds is
// checked by the contract test in start.test.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BWRAP, bwrapArgs, INSIDE_PORT, INSIDE_SOCKET, orderMounts } from '../../../src/agents/desk/bwrap.ts';
import type { DeskPlan } from '../../../src/agents/desk/desk.ts';

const PLAN: DeskPlan = {
  desk: '/work/projects/desk',
  state: ['/home/someone/.claude'],
  readable: ['/home/someone/.nvm/versions/node/v24', '/work/projects/yokoten/src'],
  hidden: ['/home', '/home/someone', '/work/projects'],
  locked: ['/work/projects/desk/.git/yokoten-worker'],
  hosts: ['api.example.com'],
  env: { YOKOTEN_ROLE: 'worker', TZ: 'UTC' },
  command: ['agent', '-p', 'hello'],
};

test('orderMounts: outer folders first; a folder is hidden before anything is shown in it', () => {
  assert.deepEqual(orderMounts(PLAN), [
    { kind: 'hide', path: '/home' },
    { kind: 'hide', path: '/home/someone' },
    { kind: 'hide', path: '/work/projects' },
    { kind: 'write', path: '/work/projects/desk' },
    { kind: 'write', path: '/home/someone/.claude' },
    { kind: 'read', path: '/work/projects/yokoten/src' },
    { kind: 'lock', path: '/work/projects/desk/.git/yokoten-worker' },
    { kind: 'read', path: '/home/someone/.nvm/versions/node/v24' },
  ]);
});

test('bwrapArgs: the system read-only, its own network, hidden folders read-only, then the desk', () => {
  const args = bwrapArgs(PLAN, '/tmp/scratch/proxy.sock');
  const text = args.join(' ');
  assert.ok(text.startsWith('--die-with-parent --new-session --unshare-all --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp'));
  assert.ok(text.includes('--bind /work/projects/desk /work/projects/desk'));
  assert.ok(text.includes('--ro-bind /work/projects/desk/.git/yokoten-worker /work/projects/desk/.git/yokoten-worker'));
  assert.ok(text.includes(`--bind /tmp/scratch/proxy.sock ${INSIDE_SOCKET}`));
  for (const folder of PLAN.hidden) assert.ok(text.includes(`--remount-ro ${folder} `), `${folder} is read-only`);
  assert.ok(!args.includes('--share-net'), 'no network but the proxy');
  assert.deepEqual(args.slice(-3), ['--chdir', PLAN.desk, '--']);
});

test('bwrapArgs: an OpenCode desk mounts its three XDG folders writable (#770)', () => {
  const state = ['/work/projects/desk.state/opencode/data', '/work/projects/desk.state/opencode/state', '/work/projects/desk.state/opencode/config'];
  const text = bwrapArgs({ ...PLAN, state }, '/tmp/scratch/proxy.sock').join(' ');
  for (const path of state) assert.ok(text.includes(`--bind ${path} ${path}`), path);
});

test('BWRAP.fence: the bridge starts first, then the agent, with the proxy names set', () => {
  const fenced = BWRAP.fence(PLAN, '/tmp/scratch/proxy.sock', '/tmp/scratch');
  assert.equal(fenced.file, 'bwrap');
  const start = fenced.args.indexOf(process.execPath);
  assert.match(fenced.args[start + 1], /yokoten\.mjs$/);
  assert.deepEqual(fenced.args.slice(start + 2, start + 4), ['desk', '--bridge']);
  assert.deepEqual(fenced.args.slice(start + 4), [INSIDE_SOCKET, String(INSIDE_PORT), '--', ...PLAN.command]);
  assert.equal(fenced.env.HTTPS_PROXY, `http://127.0.0.1:${INSIDE_PORT}`);
  assert.equal(fenced.env.NO_PROXY, '', 'an agent with no server of its own keeps every name on the proxy');
  assert.equal(fenced.env.YOKOTEN_ROLE, 'worker');
  // An OpenCode desk talks to itself on loopback, so its calls there skip the proxy (#770).
  assert.equal(BWRAP.fence({ ...PLAN, loopback: true }, '/tmp/scratch/proxy.sock', '/tmp/scratch').env.NO_PROXY, '127.0.0.1,localhost,::1');
  assert.equal(BWRAP.ownNetwork, true, 'bwrap gives the desk its own network, so loopback inside is the desk\'s');
});
