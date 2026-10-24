// Tests for src/host/hosts.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostOf, isNoAdapter, noAdapter } from '../../src/host/hosts.ts';
import { at } from '../repo/helpers.ts';

test('hostOf: GitHub in each remote form, another host by name, and no remote (#504)', () => {
  for (const remote of ['https://github.com/me/repo.git\n', 'git@github.com:me/repo.git', 'ssh://git@github.com/me/repo', 'https://github.com/me/repo']) {
    assert.deepEqual(hostOf(remote), { kind: 'github', repo: 'me/repo' }, remote);
  }
  const other = (name: string, label = 'this host') => ({ kind: 'other', name, label });
  assert.deepEqual(hostOf('https://forgebox.example.com/me/repo.git'), other('forgebox.example.com'));
  assert.deepEqual(hostOf(`https://user${at}Forgebox.Example.com:3000/me/repo.git`), other('forgebox.example.com'));
  assert.deepEqual(hostOf(`ssh://git${at}forgebox.example.com:2222/me/repo.git`), other('forgebox.example.com'));
  assert.deepEqual(hostOf(`git${at}forgebox.example.com:me/repo.git`), other('forgebox.example.com'));
  assert.deepEqual(hostOf('forgebox.example.com:me/repo.git'), other('forgebox.example.com'));
  assert.deepEqual(hostOf('https://gitlab.com/me/repo.git'), other('gitlab.com', 'GitLab'));
  assert.deepEqual(hostOf('git@codeberg.org:me/repo.git'), other('codeberg.org', 'Codeberg'));
  // A host named like an object key is still a host, not a value from the label table (#849).
  for (const key of ['__proto__', 'constructor']) assert.deepEqual(hostOf(`https://${key}/me/repo`), other(key), key);
  // A folder on this machine is a host with no adapter, and no name.
  for (const folder of ['/srv/git/repo.git', '../repo', 'file:///srv/git/repo.git', 'C:\\git\\repo']) assert.deepEqual(hostOf(folder), other(''), folder);
  assert.deepEqual(hostOf(''), { kind: 'none' });
  assert.deepEqual(hostOf(' \n'), { kind: 'none' });
});

test('noAdapter: an unread that names the host as doctor says it, never its address (#504)', () => {
  const host = hostOf('https://forgebox.example.com/me/repo.git');
  assert.equal(host.kind, 'other');
  if (host.kind !== 'other') return;
  const read = noAdapter(host);
  assert.ok(isNoAdapter(read));
  assert.equal(read.otherHost, 'this host');
  assert.ok(!JSON.stringify(read).includes('forgebox'));
  assert.ok(!isNoAdapter({ unread: 'there is no origin remote yet', fix: 'x' }));
  assert.ok(!isNoAdapter(undefined));
});
