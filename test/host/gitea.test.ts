// Tests for src/host/gitea.ts, the Gitea adapter (#505).

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type GiteaGet, giteaGet, readGiteaServer } from '../../src/host/gitea.ts';
import { hostOf } from '../../src/host/hosts.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { doctor } from '../../src/setup/doctor/index.ts';
import { ROAD } from '../../src/setup/road.ts';
import { serverChecks, walk } from '../../src/setup/road.ts';
import { LABELS } from '../../src/setup/plan.ts';
import { at, makeTempDir } from '../repo/helpers.ts';

const HOST = { repo: 'me/repo', api: 'https://gitea.example.com/api/v1' };
// Built at run time, so the file holds no key-shaped string for a scanner to flag (#849).
const TOKEN = { GITEA_TOKEN: ['placeholder', 'token'].join('-') };

/** A fake Gitea: route by path, ignore the paging query, and record what was asked. */
function fakeGitea(routes: Record<string, unknown>, seen: string[] = []): GiteaGet {
  return async (path) => {
    const clean = path.split('?')[0];
    seen.push(clean);
    if (!(clean in routes)) return { status: 404, body: null };
    return { status: 200, body: routes[clean] };
  };
}

const GOOD: Record<string, unknown> = {
  '/repos/me/repo': {
    default_branch: 'main',
    private: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_after_merge: true,
  },
  '/repos/me/repo/branch_protections': [
    { branch_name: 'main', enable_status_check: true, status_check_contexts: ['ci'], required_approvals: 1, require_code_owner_approval: true },
  ],
  '/repos/me/repo/tag_protections': [{ name_pattern: 'v*' }],
  '/repos/me/repo/labels': LABELS.map((label) => ({ name: label.name, color: label.color, description: label.description })),
  '/repos/me/repo/milestones': [{ title: 'First release', state: 'open' }],
  '/repos/me/repo/branches': [{ name: 'main' }, { name: 'fix/cart' }],
  '/repos/me/repo/pulls': [{ head: { label: 'me:fix/cart', ref: 'fix/cart' } }],
};

test('gitea: reads the server into the neutral shape, and the road judges each forge step (#505)', async () => {
  const seen: string[] = [];
  const server = await readGiteaServer(HOST, TOKEN, fakeGitea(GOOD, seen));
  assert.ok(!('unread' in server), JSON.stringify(server));
  if ('unread' in server) return;
  assert.equal(server.defaultBranch, 'main');
  assert.equal(server.isPrivate, false);
  assert.deepEqual(server.mergeMethods, ['squash']);
  assert.equal(server.deleteBranchOnMerge, true);
  assert.deepEqual(server.branch, {
    pullRequest: true,
    codeOwnerReview: true,
    mergeMethods: [],
    requiredChecks: ['ci'],
    noForcePush: true,
    noDeletion: true,
    approvals: 1,
  });
  assert.equal(server.tags, true);
  assert.equal(Array.isArray(server.forgotten) ? server.forgotten.length : -1, 0);
  assert.equal(server.planning && !('unread' in server.planning) ? server.planning.milestones[0].title : '', 'First release');

  // Each forge step the host can judge is done; the security switches are unknown, never off.
  const checks = serverChecks(server);
  for (const id of ['main-rules', 'required-checks', 'code-owner-review', 'squash-only', 'delete-branch', 'tag-rules']) {
    assert.equal(checks.find((c) => c.id === id)?.mark, 'ok', id);
  }
  assert.equal(checks.find((c) => c.id === 'security-switches')?.mark, "can't check", 'Gitea core has no secret scanning');

  // The planning and review steps read it too; none is "can't check".
  for (const key of ['labels', 'milestone']) {
    const step = ROAD.find((s) => s.key === key)!;
    assert.equal(step.check('.', {}, server), true, key);
  }
  const review = ROAD.find((s) => s.key === 'review')!;
  assert.equal(review.check('.', {}, server), null, 'Gitea has no Actions approval switch to read');
  assert.match(review.unchecked?.(server) ?? '', /Gitea has no Actions approval switch/, 'the reason is Gitea\'s, not GitHub\'s');
  // At most a step yokoten did read can be "can't check"; the byHand list is not used.
  assert.ok(!seen.includes('/repos/me/repo/actions/permissions/workflow'), 'no GitHub-only endpoint is asked');
});

test('gitea: a repo with no protection, no labels and no milestone fails the steps it should (#505)', async () => {
  const server = await readGiteaServer(HOST, TOKEN, fakeGitea({
    ...GOOD,
    '/repos/me/repo/branch_protections': [],
    '/repos/me/repo/labels': [],
    '/repos/me/repo/milestones': [],
    '/repos/me/repo/tag_protections': [],
  }));
  assert.ok(!('unread' in server), JSON.stringify(server));
  if ('unread' in server) return;
  const marks = serverChecks(server);
  assert.equal(marks.find((c) => c.id === 'main-rules')?.mark, 'MISSING');
  assert.equal(marks.find((c) => c.id === 'required-checks')?.mark, 'MISSING');
  assert.equal(marks.find((c) => c.id === 'code-owner-review')?.mark, 'MISSING');
  assert.equal(marks.find((c) => c.id === 'tag-rules')?.mark, 'MISSING');
  assert.equal(ROAD.find((s) => s.key === 'labels')!.check('.', {}, server), false);
  assert.equal(ROAD.find((s) => s.key === 'milestone')!.check('.', {}, server), false);
  assert.equal(ROAD.find((s) => s.key === 'review')!.check('.', {}, server), false, 'no approval required');
});

test('gitea: no token, a refused token and a plain-http address are unread, never done (#505)', async () => {
  const noToken = await readGiteaServer(HOST, {});
  assert.match('unread' in noToken ? noToken.unread : '', /GITEA_TOKEN is not set/);
  const refusedToken = await readGiteaServer(HOST, TOKEN, async () => ({ status: 401, body: { message: 'unauthorized' } }));
  assert.match('unread' in refusedToken ? refusedToken.unread : '', /refused the token/);
  const notFound = await readGiteaServer(HOST, TOKEN, async () => ({ status: 404, body: null }));
  assert.match('unread' in notFound ? notFound.unread : '', /did not find the repo/);
  const plain = await readGiteaServer({ repo: 'me/repo', api: 'http://gitea.example.com/api/v1' }, TOKEN);
  assert.match('unread' in plain ? plain.unread : '', /not https/);
  const silent = await readGiteaServer(HOST, TOKEN, async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  assert.match('unread' in silent ? silent.unread : '', /gave no answer/);
  // The guard sits beside the fetch too: an http address never gets the token, even
  // when a caller skips the read's own check (#849).
  await assert.rejects(giteaGet('http://gitea.example.com/api/v1', TOKEN.GITEA_TOKEN)('/repos/me/repo'), /not https/);
});

test('hosts: a declared Gitea and gitea.com are Gitea; the address of a self-hosted one is never printed (#505)', () => {
  const declared = hostOf(`git${at}gitea.example.com:me/repo.git`, 'gitea');
  assert.deepEqual(declared, { kind: 'gitea', repo: 'me/repo', api: 'https://gitea.example.com/api/v1' });
  const https = hostOf('https://gitea.example.com:8443/me/repo.git', 'gitea');
  assert.deepEqual(https, { kind: 'gitea', repo: 'me/repo', api: 'https://gitea.example.com:8443/api/v1' });
  assert.deepEqual(hostOf('https://gitea.com/me/repo.git'), { kind: 'gitea', repo: 'me/repo', api: 'https://gitea.com/api/v1' });
  // Without the key, a self-hosted server stays a host with no adapter.
  assert.deepEqual(hostOf(`git${at}gitea.example.com:me/repo.git`), { kind: 'other', name: 'gitea.example.com', label: 'this host' });
  assert.ok(!JSON.stringify(hostOf(`git${at}gitea.example.com:me/repo.git`, 'gitea')).includes('unread'));
});

// The walk is what doctor prints: with a Gitea read, the forge steps are judged, not by hand.
test('gitea: walk marks the forge steps done or to do, never can\'t check (#505)', async () => {
  const server = await readGiteaServer(HOST, TOKEN, fakeGitea(GOOD));
  assert.ok(!('unread' in server));
  if ('unread' in server) return;
  const found = ROAD.map((step) => ({ step, found: (step.byHand ? step.check('.', {}, server) : false) }));
  const walked = walk(found, {});
  for (const key of ['labels', 'milestone', 'protection', 'merge-settings']) {
    assert.notEqual(walked.steps.find((s) => s.step.key === key)?.mark, "can't check", key);
  }
});

test('gitea: a workflow in .gitea/workflows is read as CI, like .github/workflows (#505)', () => {
  const root = makeTempDir('yokoten-gitea-ci-');
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, '.gitea', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.gitea', 'workflows', 'ci.yml'), 'on: [push, pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node bin/yokoten.ts check\n');
  const ci = ROAD.find((step) => step.key === 'ci')!;
  assert.equal(ci.check(root, {}, undefined), true, 'Gitea reads .gitea/workflows');
});

test('gitea: doctor judges the forge steps through the adapter, not by hand (#505)', async () => {
  const root = makeTempDir('yokoten-gitea-');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `git${at}gitea.example.com:me/repo.git`], { cwd: root });
  const server = await readGiteaServer(HOST, TOKEN, fakeGitea(GOOD));
  assert.ok(!('unread' in server));
  if ('unread' in server) return;
  const result = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: { ...DEFAULTS, host: 'gitea' }, host: { kind: 'gitea', ...HOST }, server });
  const mark = (id: string) => result.report.steps?.find((s) => s.id === id)?.mark;
  assert.equal(mark('labels'), 'done');
  assert.equal(mark('milestone'), 'done');
  assert.equal(mark('protection'), 'done');
  assert.equal(mark('merge-settings'), 'done');
  assert.equal(mark('review'), "can't check", 'Gitea has no Actions approval switch to read');
  assert.equal(mark('security-settings'), "can't check", 'Gitea core has no security switches');
  const text = result.lines.join('\n');
  assert.ok(!text.includes("yokoten can't check this on"), 'the by-hand wording is for a host with no adapter');
  assert.ok(!text.includes('gitea.example.com'), 'a self-hosted address is never printed');
});
