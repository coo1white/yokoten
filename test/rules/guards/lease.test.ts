// Tests for src/rules/lease.ts, and for the guard's read of the conflict map (#911).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { type LeaseMap, leaseFor } from '../../../src/rules/guards/lease.ts';
import { formatRefusal } from '../../../src/rules/message.ts';
import { judge } from '../../../src/run/hook.ts';

/** A map with one open change moving src/app.ts, and a draft that leases nothing. */
const MAP: LeaseMap = {
  changes: [
    { id: 'pr:12', label: 'PR #12', branch: 'feature-move', draft: false },
    { id: 'branch:wip', label: 'branch wip', branch: 'wip', draft: true },
  ],
  leased: { 'src/app.ts': 'pr:12', 'src/draft.ts': 'branch:wip' },
};

/** What the conflict map (#909) writes, with the shared shape (#914). */
function mapJson(map: LeaseMap, builtAt = new Date().toISOString(), version = 1): string {
  return JSON.stringify({ version, builtAt, main: 'abc12345', changes: map.changes, collisions: [], leased: map.leased, hot: [] });
}

/** The guard options of a fresh sandbox, where main is checked out. */
function options(sandbox: ReturnType<typeof makeSandbox>) {
  return { root: sandbox.repo, config: DEFAULTS, env: {}, cwd: sandbox.repo };
}

test('lease: a path an open change moves is leased to that change, by name (#911)', () => {
  assert.deepEqual(leaseFor('src/app.ts', 'other', MAP), { by: 'pr:12', label: 'PR #12' });
  assert.deepEqual(leaseFor('./src/app.ts', 'other', MAP), { by: 'pr:12', label: 'PR #12' }, 'a leading ./ reads the same');
  assert.deepEqual(leaseFor('src\\app.ts', 'other', MAP), { by: 'pr:12', label: 'PR #12' }, 'a Windows separator reads the same');
});

test('lease: the change\'s own branch, a free path, a draft and no map all pass (#911)', () => {
  assert.equal(leaseFor('src/app.ts', 'feature-move', MAP), null, 'the moving change edits its own file');
  assert.equal(leaseFor('src/other.ts', 'other', MAP), null, 'a path no change moves is free');
  assert.equal(leaseFor('src/draft.ts', 'other', MAP), null, 'a draft holds no lease');
  assert.equal(leaseFor('src/app.ts', 'other', null), null, 'a missing map allows');
  assert.equal(leaseFor('src/app.ts', 'other', { changes: MAP.changes, leased: { 'src/app.ts': 'pr:99' } }), null, 'a lease that names no change allows');
});

test('lease: the guard refuses an edit to a moved file, and the refusal names the change (#911)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.git/yokoten/conflicts.json', mapJson(MAP));
  const found = judge({ paths: ['src/app.ts'], worker: false }, options(sandbox));
  assert.equal(found?.id, 'file-lease');
  assert.equal(found?.what, 'PR #12 is moving src/app.ts. An edit here now will conflict when it merges');
  assert.equal(formatRefusal(found!), [
    'yokoten stopped this: PR #12 is moving src/app.ts. An edit here now will conflict when it merges [file-lease]',
    'Why: Two changes to a file that is being moved cannot both go in cleanly.',
    'Do instead: Work on something else until PR #12 merges, or ask the lead to put this task after it.',
    'More: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#blocked-commands',
  ].join('\n'));
  assert.equal(judge({ paths: ['src/other.ts'], worker: false }, options(sandbox)), null, 'another path passes');
});

test('lease: the moving change\'s own branch edits the file, and a missing or old map allows (#911)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.git/yokoten/conflicts.json', mapJson(MAP));
  writeFileSync(join(sandbox.repo, '.git', 'HEAD'), 'ref: refs/heads/feature-move\n');
  assert.equal(judge({ paths: ['src/app.ts'], worker: false }, options(sandbox)), null, 'its own branch passes');
  writeFileSync(join(sandbox.repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(judge({ paths: ['src/app.ts'], worker: false }, options(sandbox))?.id, 'file-lease', 'another branch stops');

  // A fresh clone with no map allows; so does a map built two hours ago, and one whose
  // version this reader does not know.
  const bare = makeSandbox();
  assert.equal(judge({ paths: ['src/app.ts'], worker: false }, options(bare)), null, 'a missing map allows');
  const old = makeSandbox();
  old.write('.git/yokoten/conflicts.json', mapJson(MAP, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()));
  assert.equal(judge({ paths: ['src/app.ts'], worker: false }, options(old)), null, 'an old map allows, and the doctor says it is old');
  const newer = makeSandbox();
  newer.write('.git/yokoten/conflicts.json', mapJson(MAP, new Date().toISOString(), 2));
  assert.equal(judge({ paths: ['src/app.ts'], worker: false }, options(newer)), null, 'an unknown version is a missing map');
});

test('lease: a 1,000-file map and 100 lookups stay well under the guard budget (#911, record 0013)', () => {
  const changes = Array.from({ length: 1000 }, (_, at) => ({ id: `pr:${at}`, label: `PR #${at}`, branch: `feature-${at}`, draft: false }));
  const leased: Record<string, string> = {};
  for (let at = 0; at < 1000; at++) leased[`src/file-${at}.ts`] = `pr:${at}`;
  const text = JSON.stringify({ version: 1, builtAt: new Date().toISOString(), main: 'abc12345', changes, collisions: [], leased, hot: [] });
  // The guard's cost: one parse of the map per call, then one lookup for each edited file.
  const started = performance.now();
  const map = JSON.parse(text) as LeaseMap;
  let leasedHits = 0;
  for (let at = 0; at < 100; at++) if (leaseFor(`src/file-${at}.ts`, 'other', map) !== null) leasedHits++;
  const elapsed = performance.now() - started;
  assert.equal(leasedHits, 100, 'each lookup found its lease');
  assert.ok(elapsed < 44, `100 lookups on a 1,000-file map took ${elapsed.toFixed(1)} ms, over half the 88 ms guard budget`);
});
