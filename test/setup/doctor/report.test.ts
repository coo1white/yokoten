// Tests for src/setup/doctor/report.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { at, fakeGh, GOOD, makeSandbox, makeTempDir, planningFound, REPO, said, serverGh, stepMark, stopCheckoutWalk, withPlanning } from '../../repo/helpers.ts';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { type BranchRules, type Gh, ghIn, readPlanning, readServer, type ServerSettings, type Unread } from '../../../src/host/github/index.ts';
import { blocksToSay, doctor, listBoardSteps, saveHostCache, SERVER_TIMEOUT_MS, SESSION_UNSAVED_BUDGET, sessionsDir, sessionUnsaved, STOPPED_EARLY, UNSAVED_OFFER, noCiNote, privacyNotes, upstreamNote } from '../../../src/setup/doctor/index.ts';
import { LABELS } from '../../../src/setup/plan.ts';
import { missingPaths, road, ROAD, serverChecks, stepFinding } from '../../../src/setup/road.ts';
import { fakeMachine, GB, NOW } from '../../repo/helpers.ts';

const marks = (s: ServerSettings | Unread) => Object.fromEntries(serverChecks(s).map((c) => [c.id, c.mark]));

const SERVER_KEYS = ['protection', 'merge-settings', 'security-settings', 'tag-bypass', 'release-reviewer', 'release-tag-rule'];

const serverSteps = () => ROAD.filter((s) => SERVER_KEYS.includes(s.key));

const serverFound = (server: Parameters<typeof road>[3]) => Object.fromEntries(road('.', {}, serverSteps(), server).map((r) => [r.step.key, r.found]));

// The review step (#59): one approval before a merge, judged from the repo's rules and visibility.
const review = ROAD.find((s) => s.key === 'review')!;

const RULES = `repos/${REPO}/rules/branches/main`;

const withApprovals = (count: number) => [{ type: 'pull_request', parameters: { required_approving_review_count: count } }, ...(GOOD[RULES] as object[]).slice(1)];

// An admin's read: the old branch protection and the Actions setting are visible.
const ACTIONS = `repos/${REPO}/actions/permissions/workflow`;

const ADMIN = { ...GOOD, [`repos/${REPO}`]: { ...(GOOD[`repos/${REPO}`] as object), permissions: { admin: true } }, [ACTIONS]: { can_approve_pull_request_reviews: false } };

test('server: a repo with every setting on is ok, and doctor only reads (#7)', () => {
  const fake = serverGh(GOOD);
  const s = readServer(fake.gh, REPO);
  assert.deepEqual(marks(s), {
    'main-rules': 'ok', 'required-checks': 'ok', 'code-owner-review': 'ok', 'squash-only': 'ok',
    'delete-branch': 'ok', 'tag-rules': 'ok', 'tag-bypass': 'ok', 'release-reviewer': 'ok', 'release-tag-rule': 'ok', 'security-switches': 'ok', 'forgotten-branches': 'note',
  });
  const note = serverChecks(s).find((c) => c.id === 'forgotten-branches');
  assert.match(note?.finding.what ?? '', /^1 branch\(es\) with no open pull request \(old\/b\)$/, 'a branch of a fork with the same name does not count');
  assert.match(note?.finding.fix ?? '', /never deletes/);
  for (const c of fake.calls) {
    assert.equal(c[0], 'api', c.join(' '));
    // A GraphQL read sends its query with -f (#156); a mutation would be a write.
    const isGraphqlRead = c[1] === 'graphql' && c.some((a) => a.startsWith('query=query')) && !c.some((a) => /mutation/.test(a));
    if (isGraphqlRead) assert.ok(!c.some((a) => /^(-X|--method|--input)$/.test(a)), `a write: ${c.join(' ')}`);
    else assert.ok(!c.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(a)), `a write: ${c.join(' ')}`);
  }
  assert.ok(fake.calls.some((c) => c[1] === 'graphql'), 'the linked boards are read too (#156)');
});

test('server: each setting off is MISSING, with what and the fix (#7)', () => {
  const routes = {
    ...GOOD,
    [`repos/${REPO}`]: { default_branch: 'trunk', allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false, delete_branch_on_merge: false, security_and_analysis: { secret_scanning: { status: 'disabled' } } },
    [`repos/${REPO}/rules/branches/trunk`]: [{ type: 'pull_request', parameters: {} }],
    [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'deletion' }], bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole' }] },
    [`repos/${REPO}/private-vulnerability-reporting`]: { enabled: false },
    [`repos/${REPO}/vulnerability-alerts`]: undefined,
    [`repos/${REPO}/branches?per_page=100`]: 'trunk\nfeat/a\n',
  };
  const checks = serverChecks(readServer(serverGh(routes).gh, REPO));
  const by = (id: string) => checks.find((c) => c.id === id);
  for (const id of ['main-rules', 'required-checks', 'code-owner-review', 'squash-only', 'delete-branch', 'tag-rules', 'security-switches']) assert.equal(by(id)?.mark, 'MISSING', id);
  assert.equal(by('forgotten-branches'), undefined, 'no note when every branch has a pull request');
  assert.equal(by('main-rules')?.finding.what, 'the default branch (trunk) has no rule for no force push, no deletion');
  assert.equal(by('security-switches')?.finding.what, 'secret scanning, private vulnerability reporting, Dependabot alerts are off', 'push protection is unknown, not off');
});

test("server: gh missing, signed out or refused is \"can't check\" with the fix, never a crash (#7)", () => {
  const missing = readServer(() => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, REPO);
  assert.deepEqual(serverChecks(missing).map((c) => [c.id, c.mark, c.finding.what]), [['server-settings', "can't check", 'gh is not installed']]);
  assert.match(serverChecks(readServer(() => { throw said(401); }, REPO))[0].finding.fix, /`gh auth login`/);
  // A free private repo, read by someone who is not an admin: rulesets refused, settings hidden.
  const refused = { ...GOOD, [`repos/${REPO}`]: { default_branch: 'main' }, [`repos/${REPO}/rules/branches/main`]: said(403), [`repos/${REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`]: said(403), [`repos/${REPO}/private-vulnerability-reporting`]: said(403), [`repos/${REPO}/vulnerability-alerts`]: undefined };
  const checks = serverChecks(readServer(serverGh(refused).gh, REPO));
  for (const id of ['main-rules', 'required-checks', 'code-owner-review', 'squash-only', 'delete-branch', 'tag-rules', 'tag-bypass', 'security-switches']) {
    assert.equal(checks.find((c) => c.id === id)?.mark, "can't check", id);
  }
  assert.match(checks.find((c) => c.id === 'tag-rules')?.finding.fix ?? '', /GitHub Pro/);
  assert.match(checks.find((c) => c.id === 'delete-branch')?.finding.what ?? '', /code host did not say/);
});

test('road: the server steps are stage 5, and pass a repo with every setting on (#7)', () => {
  assert.deepEqual(serverSteps().map((s) => [s.key, s.stage]), SERVER_KEYS.map((key) => [key, 5]));
  assert.deepEqual(serverFound(readServer(serverGh(GOOD).gh, REPO)), { protection: true, 'merge-settings': true, 'security-settings': true, 'tag-bypass': true, 'release-reviewer': true, 'release-tag-rule': true });
});

test('road: each server step catches its setting off, and says what and the fix (#7)', () => {
  const each: [string, Record<string, unknown>, RegExp][] = [
    ['protection', { [`repos/${REPO}/rules/branches/main`]: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }] }, /no rule for no force push, no deletion; no CI check must pass before a merge; code owner review is not required/],
    ['protection', {
      // Ruleset 7 blocks deletion only, and 8 blocks creation with a bypass: tag-rules fails, tag-bypass passes.
      [`repos/${REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`]: [{ id: 7, target: 'tag', enforcement: 'active' }, { id: 8, target: 'tag', enforcement: 'active' }],
      [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'deletion' }], bypass_actors: [] },
      [`repos/${REPO}/rulesets/8`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }], bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole' }] },
    }, /^no active tag ruleset on v\*/],
    ['merge-settings', { [`repos/${REPO}`]: { ...(GOOD[`repos/${REPO}`] as object), delete_branch_on_merge: false } }, /^merged branches are not deleted$/],
    ['merge-settings', { [`repos/${REPO}/rules/branches/main`]: [{ type: 'pull_request', parameters: { require_code_owner_review: true, allowed_merge_methods: ['squash', 'rebase'] } }, ...(GOOD[`repos/${REPO}/rules/branches/main`] as object[]).slice(1)] }, /not only by squash/],
    ['security-settings', { [`repos/${REPO}/private-vulnerability-reporting`]: { enabled: false } }, /^private vulnerability reporting is off$/],
    ['tag-bypass', { [`repos/${REPO}/rulesets/7`]: { ...(GOOD[`repos/${REPO}/rulesets/7`] as object), bypass_actors: [] } }, /bypass list does not name Repository admin/],
    ['tag-bypass', { [`repos/${REPO}/rulesets/7`]: { ...(GOOD[`repos/${REPO}/rulesets/7`] as object), bypass_actors: [{ actor_id: 99, actor_type: 'Integration' }] } }, /bypass list names the bot/],
    // Two v* rulesets both block tag creation, and a push meets both: a bypass on one is not enough (#850).
    ['tag-bypass', {
      [`repos/${REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`]: [{ id: 7, target: 'tag', enforcement: 'active' }, { id: 8, target: 'tag', enforcement: 'active' }],
      [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }], bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole' }] },
      [`repos/${REPO}/rulesets/8`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }], bypass_actors: [] },
    }, /bypass list does not name Repository admin/],
    // A bypass on another v* ruleset, one that does not block tag creation, is no way to push a tag (#537).
    ['tag-bypass', {
      [`repos/${REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`]: [{ id: 7, target: 'tag', enforcement: 'active' }, { id: 8, target: 'tag', enforcement: 'active' }],
      [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }], bypass_actors: [] },
      [`repos/${REPO}/rulesets/8`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'required_signatures' }], bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole' }] },
    }, /bypass list does not name Repository admin/],
    ['release-reviewer', { [`repos/${REPO}/environments/release`]: { protection_rules: [] } }, /^the release environment has no required reviewer/],
    ['release-tag-rule', { [`repos/${REPO}/environments/release/deployment-branch-policies`]: { branch_policies: [] } }, /^the release environment has no tag rule for v\*$/],
    ['release-tag-rule', { [`repos/${REPO}/environments/release/deployment-branch-policies`]: { branch_policies: [{ id: 1, name: 'v*', type: 'branch' }] } }, /v\* rule is a branch rule/],
    // A tag rule and a branch rule named v* together let a branch deploy (#537).
    ['release-tag-rule', { [`repos/${REPO}/environments/release/deployment-branch-policies`]: { branch_policies: [{ id: 1, name: 'v*', type: 'tag' }, { id: 2, name: 'v*', type: 'branch' }] } }, /also accepts a branch named v\*/],
  ];
  for (const [key, change, what] of each) {
    const server = readServer(serverGh({ ...GOOD, ...change }).gh, REPO);
    const found = serverFound(server);
    assert.equal(found[key], false, `${key} lets ${Object.keys(change)[0]} through`);
    assert.equal(Object.values(found).filter((f) => f === false).length, 1, `only ${key} fails`);
    const f = stepFinding(ROAD.find((s) => s.key === key)!, '.', {}, { server });
    assert.match(f.what, what);
    assert.match(f.fix, /^in Settings, /);
  }
});

test('server: a bypass counts only where a push meets it, and both tag-bypass faults are named (#850)', () => {
  const list = `repos/${REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`;
  const vTags = { conditions: { ref_name: { include: ['refs/tags/v*'] } } };
  const admin = [{ actor_id: 5, actor_type: 'RepositoryRole' }];
  // A bot on a v* ruleset that does not block creation cannot push a tag, so it is no fault (#850).
  const outside = readServer(serverGh({
    ...GOOD,
    [list]: [{ id: 7, target: 'tag', enforcement: 'active' }, { id: 8, target: 'tag', enforcement: 'active' }],
    [`repos/${REPO}/rulesets/7`]: { ...vTags, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }], bypass_actors: admin },
    [`repos/${REPO}/rulesets/8`]: { ...vTags, rules: [{ type: 'update' }], bypass_actors: [{ actor_id: 99, actor_type: 'Integration' }] },
  }).gh, REPO);
  assert.equal(marks(outside)['tag-bypass'], 'ok');
  // When the owner cannot push and a bot can, the line names both, not only the bot.
  const both = readServer(serverGh({
    ...GOOD,
    [`repos/${REPO}/rulesets/7`]: { ...vTags, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }], bypass_actors: [{ actor_id: 99, actor_type: 'Integration' }] },
  }).gh, REPO);
  const f = stepFinding(ROAD.find((s) => s.key === 'tag-bypass')!, '.', {}, { server: both });
  assert.match(f.what, /does not name Repository admin.*; .*names the bot/);
});

test('doctor: the tag bypass and the release environment each show one line with the place to click (#537)', () => {
  const root = makeTempDir('yokoten-release-');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: root });
  const run = (routes: Record<string, unknown>) => doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: serverGh(routes).gh });
  const lineOf = (routes: Record<string, unknown>, key: string) => run(routes).lines.find((line) => new RegExp(`^ {4}(done|to do) +${key}\\b`).test(line)) ?? '';
  // All set: no line for these asks the owner for anything.
  for (const key of ['tag-bypass', 'release-reviewer', 'release-tag-rule']) assert.match(lineOf(GOOD, key), /^ {4}done /, key);
  // Positive control: each known-bad setting is caught, with its own line and GitHub's menu.
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['tag-bypass', { [`repos/${REPO}/rulesets/7`]: { ...(GOOD[`repos/${REPO}/rulesets/7`] as object), bypass_actors: [] } }, /Repository admin/],
    ['tag-bypass', { [`repos/${REPO}/rulesets/7`]: { ...(GOOD[`repos/${REPO}/rulesets/7`] as object), bypass_actors: [{ actor_id: 9, actor_type: 'Integration' }] } }, /names the bot/],
    // A bypass on another v* ruleset, one that does not block tag creation, leaves the owner unable to push a tag (#537).
    ['tag-bypass', {
      [`repos/${REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`]: [{ id: 7, target: 'tag', enforcement: 'active' }, { id: 8, target: 'tag', enforcement: 'active' }],
      [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }], bypass_actors: [] },
      [`repos/${REPO}/rulesets/8`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'required_signatures' }], bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole' }] },
    }, /Repository admin/],
    ['release-reviewer', { [`repos/${REPO}/environments/release`]: { protection_rules: [] } }, /no required reviewer/],
    ['release-tag-rule', { [`repos/${REPO}/environments/release/deployment-branch-policies`]: { branch_policies: [{ id: 1, name: 'v*', type: 'branch' }] } }, /branch rule/],
    // A tag rule with a branch rule named v* lets a branch deploy (#537).
    ['release-tag-rule', { [`repos/${REPO}/environments/release/deployment-branch-policies`]: { branch_policies: [{ id: 1, name: 'v*', type: 'tag' }, { id: 2, name: 'v*', type: 'branch' }] } }, /also accepts a branch named v\*/],
  ];
  for (const [key, change, what] of cases) {
    const line = lineOf({ ...GOOD, ...change }, key);
    assert.match(line, new RegExp(`^ {4}to do +${key}: `), key);
    assert.match(line, what, key);
    assert.match(line, /; in Settings, (Rules|Environments), /, `${key}: says where to click`);
  }
});

test("road: with no gh, no network, a non-GitHub remote or a session, the server steps are can't check, never done (#7)", () => {
  const unreads = [
    undefined, // a session
    readServer(() => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, REPO),
    readServer(() => { throw said(401); }, REPO),
    readServer(() => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); }, REPO),
    { unread: 'the origin remote is not on a host yokoten knows (GitHub for now)', fix: 'add a GitHub origin remote, or check these settings by hand' },
  ];
  for (const server of unreads) assert.deepEqual(serverFound(server), { protection: null, 'merge-settings': null, 'security-settings': null, 'tag-bypass': null, 'release-reviewer': null, 'release-tag-rule': null });
  const protection = ROAD.find((s) => s.key === 'protection')!;
  assert.equal(protection.unchecked?.(undefined), 'a session never calls the network; run `yokoten doctor`');
  assert.match(protection.unchecked?.(unreads[1]) ?? '', /^gh is not installed; get it from https:\/\/cli\.github\.com/);
  // A setting only an admin can see is can't check too, not done.
  const hidden = readServer(serverGh({ ...GOOD, [`repos/${REPO}`]: { default_branch: 'main' } }).gh, REPO);
  assert.equal(serverFound(hidden)['merge-settings'], null);
});

test('doctor: a workflow with a run line of 500,000 characters does not throw (#322)', () => {
  const root = makeTempDir('yokoten-long-run-');
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  const long = `on: pull_request\njobs:\n  t:\n    steps:\n      - run: npx${' -y'.repeat(83_000)} node${' -a'.repeat(83_000)}\n      - run: make${' -C x'.repeat(100_000)}\n`;
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), long);
  for (const session of [true, false]) {
    const result = doctor(root, { env: { HOME: root }, config: DEFAULTS, session, gh: () => { throw new Error('no network in this test'); } });
    for (const key of ['tests', 'ci', 'titles']) assert.notEqual(result.report.steps?.find((s) => s.id === key)?.mark, 'done', key);
  }
});

test('doctor: reads the server of a GitHub origin into the road; a step not done fails, a note does not (#7)', () => {
  const root = makeTempDir('yokoten-server-');
  execFileSync('git', ['init', '-q', root]);
  const run = (routes: Record<string, unknown>) => doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: serverGh(routes).gh });
  let result = run(GOOD);
  const text = () => result.lines.join('\n');
  // No origin remote at all: say so, in one line for every step that reads the server (#208, #502).
  const cant = result.lines.filter((l) => /can't check/.test(l));
  assert.equal(cant.length, 1, cant.join('\n'));
  assert.match(text(), /^ {4}can't check [a-z, -]*protection[a-z, -]*: there is no origin remote yet, so doctor can't read the server; make the repo on your code host, add it as origin with `git remote add origin <url>`, and push; then run `yokoten doctor` again/m);
  assert.ok(!/can't check.*can't check/.test(text()), 'no line says "can\'t check" twice');
  assert.equal(result.report.steps?.find((s) => s.id === 'protection')?.mark, "can't check", 'the data still has each step');
  assert.ok(result.lines.some((l) => /secret scanning with push protection/.test(l)), 'the by-hand list when nothing is read');
  execFileSync('git', ['remote', 'add', 'origin', 'https://forgebox.example.com/me/repo.git'], { cwd: root });
  result = run(GOOD);
  // Another host (#504): the doctor-other-host test has the rest.
  assert.match(text(), /^ {2}can't check server-settings: yokoten can't read the server settings on this host yet/m);
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: root });
  result = run(GOOD);
  for (const key of SERVER_KEYS) assert.equal(result.report.steps?.find((s) => s.id === key)?.mark, 'done', key);
  assert.ok(!result.lines.some((l) => /main-rules/.test(l)), 'the road shows the setting; the server list does not repeat it');
  assert.ok(result.report.notes?.some((n) => n.id === 'forgotten-branches'));
  assert.ok(!result.report.findings.some((f) => f.id.startsWith('server') || SERVER_KEYS.includes(f.id)));
  result = run({ ...GOOD, [`repos/${REPO}/rules/branches/main`]: [] });
  assert.equal(result.ok, false);
  assert.equal(result.report.steps?.find((s) => s.id === 'protection')?.mark, 'to do');
  assert.deepEqual(result.report.server?.find((s) => s.id === 'main-rules'), { id: 'main-rules', mark: 'MISSING' });
  assert.match(result.report.findings.find((f) => f.id === 'protection')?.what ?? '', /no CI check must pass before a merge/);
  // A session never calls gh, so the server steps never hold its stage.
  const session = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, session: true, gh: () => { throw new Error('a session called gh'); } });
  assert.notEqual(session.report.next?.id, 'protection');
});

// #561: a server read that hangs stops at its time cap, and the step says why. The cap's
// own message proves it fired; the test reads no clock, which a loaded machine slows (#436).
test("doctor: a slow server read stops in time, and each step says it can't be checked and why (#561)", { skip: process.platform === 'win32' && 'a shell stub needs an execute bit' }, () => {
  const dir = makeTempDir('yokoten-slow-gh-');
  const stub = join(dir, 'gh');
  // Answers the login read at once, and sleeps on every other read: only the server read is slow.
  writeFileSync(stub, '#!/bin/sh\nfor word in "$@"; do if [ "$word" = user ]; then echo \'{"login":"octo"}\'; exit 0; fi; done\nexec /bin/sleep 30\n');
  chmodSync(stub, 0o755);
  const root = makeTempDir('yokoten-slow-server-');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: root });
  const env = { HOME: root, YOKOTEN_TEMP_DIRS: '', PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` };
  const result = doctor(root, { env, config: DEFAULTS, gh: ghIn(root, env, SERVER_TIMEOUT_MS) });
  for (const key of SERVER_KEYS) assert.equal(result.report.steps?.find((s) => s.id === key)?.mark, "can't check", key);
  const line = result.lines.find((l) => /can't check/.test(l) && /protection/.test(l)) ?? '';
  assert.match(line, /GitHub took too long to answer/, 'the cap fired, not the stub');
  assert.match(line, /check the network, then run doctor again/);
});

// The steps that only the code host can judge (#504): on a host with no adapter, each says what it asks.
const FORGE_STEPS = ['tests', 'ci', 'labels', 'milestone', 'titles', 'codeowners', 'bot', 'review', 'protection', 'merge-settings', 'security-settings', 'tag-bypass', 'release-reviewer', 'release-tag-rule'];
// What only GitHub has: its menus, its CLI, init's GitHub flag, the GitHub App. A standard's name ("GitHub community profile") and yokoten's own docs are not instructions.
const GITHUB_ONLY = /github\.com(?!\/yokoten-labs\/yokoten\/)|\bgh\b|--github|in Settings, |GitHub App|Rulesets|Dependabot alerts/;

test('doctor: on another host, each forge step says once what it asks, with no GitHub instruction, and never holds the stage (#504)', () => {
  assert.deepEqual(ROAD.filter((step) => step.byHand).map((step) => step.key), FORGE_STEPS);
  const root = makeTempDir('yokoten-other-host-');
  execFileSync('git', ['init', '-q', root]);
  const noGh: Gh = () => { throw new Error('doctor called gh for a host with no adapter'); };
  const remotes: [string, string][] = [
    ['https://forgebox.example.com/me/repo.git', 'this host'],
    [`ssh://git${at}forgebox.example.com:2222/me/repo.git`, 'this host'],
    [`git${at}forgebox.example.com:me/repo.git`, 'this host'],
    ['https://gitlab.com/me/repo.git', 'GitLab'],
  ];
  for (const [remote, label] of remotes) {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    for (const session of [false, true]) {
      const result = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, session, gh: noGh });
      const text = result.lines.join('\n');
      assert.ok(!text.includes('forgebox'), `${remote}: a self-hosted server is never named`);
      assert.ok(!GITHUB_ONLY.test(text), `${remote}: no GitHub-only instruction: ${GITHUB_ONLY.exec(text)?.[0]}`);
      assert.ok(!FORGE_STEPS.includes(result.report.next?.id ?? ''), `${remote}: a forge step is never the next step`);
      assert.ok(!result.report.findings.some((f) => FORGE_STEPS.includes(f.id)), `${remote}: a forge step is never a finding`);
      if (session) continue;
      for (const key of FORGE_STEPS) {
        assert.equal(result.report.steps?.find((s) => s.id === key)?.mark, "can't check", `${remote}: ${key}`);
        const lines = result.lines.filter((line) => new RegExp(`^ {4}can't check ${key}\\b`).test(line));
        assert.equal(lines.length, 1, `${remote}: ${key} has one line`);
        assert.ok(lines[0].includes(`: yokoten can't check this on ${label} yet; do it by hand: `), `${remote}: ${key}`);
      }
      assert.ok(result.lines.some((line) => line.startsWith(`  can't check server-settings: yokoten can't read the server settings on ${label} yet; the steps marked can't check say`)), `${remote}: server-settings`);
      assert.ok(!text.includes('check these by hand') && !text.includes('not checked '), `${remote}: the GitHub by-hand lists are left out`);
    }
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: root });
  }
  // No remote is its own case: no line for another host.
  const none = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: noGh });
  assert.ok(!none.lines.some((line) => line.includes('yokoten can\'t check this on')), 'no remote: no other-host lines');
  // A GitHub remote: the steps are judged as before; codeowners is a file check there.
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: root });
  const github = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: serverGh(GOOD).gh });
  assert.equal(github.report.steps?.find((s) => s.id === 'protection')?.mark, 'done');
  assert.equal(github.report.steps?.find((s) => s.id === 'codeowners')?.mark, 'to do');
});

test('doctor: the command on a Gitea-like remote shows the forge steps as can\'t check (#504)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', `git${at}forgebox.example.com:me/repo.git`);
  const steps = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout).steps as { id: string; mark: string }[];
  for (const key of FORGE_STEPS) assert.equal(steps.find((step) => step.id === key)?.mark, "can't check", key);
  assert.equal(steps.find((step) => step.id === 'rules')?.mark, 'next', 'the core is judged as on any host');
});

test('road: the review step is stage 4, done when a merge needs at least one approval (#59)', () => {
  assert.equal(review.stage, 4);
  assert.equal(review.check('.', {}, readServer(serverGh({ ...ADMIN, [RULES]: withApprovals(1) }).gh, REPO)), true);
  assert.equal(review.check('.', {}, readServer(serverGh({ ...ADMIN, [RULES]: withApprovals(2) }).gh, REPO)), true);
  // The old branch protection counts too, when an admin can read it.
  const old = { ...ADMIN, [`repos/${REPO}/branches/main/protection/required_pull_request_reviews`]: { required_approving_review_count: 1 } };
  assert.equal(review.check('.', {}, readServer(serverGh(old).gh, REPO)), true);
});

test('road: the review step catches a merge with no approval, and says how to set one (#59)', () => {
  // Positive control: every other setting is on, and only the approval is missing.
  for (const rules of [GOOD[RULES], withApprovals(0), []]) {
    const server = readServer(serverGh({ ...ADMIN, [RULES]: rules }).gh, REPO);
    assert.equal(review.check('.', {}, server), false, JSON.stringify(rules));
  }
  const f = stepFinding(review, '.', {}, { server: readServer(serverGh(ADMIN).gh, REPO) });
  assert.equal(f.what, 'a merge to the default branch needs no approving review');
  assert.match(f.fix, /"Required approvals" to 1/);
  assert.match(f.fix, /can't approve your own pull request, so let the bot open them/);
  assert.match(f.fix, /keep "Allow GitHub Actions to create and approve pull requests" off/);
});

test('road: the review step is not done while a workflow may approve a pull request (#59)', () => {
  // With the Actions setting on, a workflow the bot pushes could approve the bot's own pull request.
  const on = readServer(serverGh({ ...ADMIN, [RULES]: withApprovals(1), [ACTIONS]: { can_approve_pull_request_reviews: true } }).gh, REPO);
  assert.equal(review.check('.', {}, on), false);
  const f = stepFinding(review, '.', {}, { server: on });
  assert.match(f.what, /^a workflow may approve a pull request/);
  assert.match(f.fix, /turn off "Allow GitHub Actions to create and approve pull requests"/);
  // Unreadable is can't check, never done.
  const hidden = readServer(serverGh({ ...ADMIN, [RULES]: withApprovals(1), [ACTIONS]: said(403) }).gh, REPO);
  assert.equal(review.check('.', {}, hidden), null);
  assert.match(review.unchecked?.(hidden) ?? '', /can be read only by an admin/);
});

test("road: a non-admin who can't read the old branch protection gets can't check, not to do (#59)", () => {
  // Rulesets ask for nothing, and the old protection answers 404, which to a non-admin says nothing.
  const server = readServer(serverGh({ ...GOOD, [RULES]: [] }).gh, REPO);
  assert.equal(review.check('.', {}, server), null);
  assert.match(review.unchecked?.(server) ?? '', /old branch protection can be read only by an admin/);
  // To an admin, the same 404 means there is no old protection.
  assert.equal(review.check('.', {}, readServer(serverGh({ ...ADMIN, [RULES]: [] }).gh, REPO)), false);
});

test("road: a private repo without rulesets waits for stage 5; nothing read is can't check (#59)", () => {
  const upgrade = Object.assign(new Error('gh failed'), { stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n' });
  const privateRepo = { ...GOOD, [`repos/${REPO}`]: { ...(GOOD[`repos/${REPO}`] as object), private: true }, [RULES]: upgrade };
  const server = readServer(serverGh(privateRepo).gh, REPO);
  assert.equal(review.check('.', {}, server), null, 'waiting never holds the stage');
  assert.match(review.unchecked?.(server) ?? '', /^rulesets need GitHub Pro on a private repo, so no rule can ask for an approval yet; this step waits for stage 5, when the repo goes public/);
  // The same refusal on a public repo is not a plan limit: it says what gh said.
  const publicRepo = readServer(serverGh({ ...GOOD, [RULES]: said(403) }).gh, REPO);
  assert.equal(review.check('.', {}, publicRepo), null);
  assert.doesNotMatch(review.unchecked?.(publicRepo) ?? '', /stage 5/);
  // A session, or nothing read, is can't check, never done.
  assert.equal(review.check('.', {}, undefined), null);
  assert.equal(review.unchecked?.(undefined), 'a session never calls the network; run `yokoten doctor`');
  const missing = readServer(() => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, REPO);
  assert.equal(review.check('.', {}, missing), null);
  assert.match(review.unchecked?.(missing) ?? '', /^gh is not installed/);
});

test('doctor: shows the review step in stage 4, and a session never asks gh about it (#59)', () => {
  const root = makeTempDir('yokoten-review-');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: root });
  const full = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: serverGh({ ...ADMIN, [RULES]: withApprovals(1) }).gh });
  assert.deepEqual(full.report.steps?.find((s) => s.id === 'review'), { id: 'review', stage: 4, mark: 'done', standard: 'Scorecard: Code-Review' });
  assert.deepEqual(full.report.selfTest, { ok: true, failed: [] }, 'the server control still passes no step');
  const session = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, session: true, gh: () => { throw new Error('a session called gh'); } });
  assert.notEqual(session.report.next?.id, 'review');
  rmSync(root, { recursive: true, force: true });
});

test('doctor: lists the board clicks by hand only when a board is linked, and never fails over them (#156)', () => {
  const server = readServer(serverGh(GOOD).gh, REPO) as ServerSettings;
  assert.ok('unread' in (server.boards as Unread), 'the fake answers no GraphQL: the boards are unread');
  assert.deepEqual(listBoardSteps(server), [], 'unread: no lines');
  assert.deepEqual(listBoardSteps({ ...server, boards: [] }), [], 'no board: no lines');
  assert.deepEqual(listBoardSteps(undefined), [], 'a session: no lines');
  const lines = listBoardSteps({ ...server, boards: [{ number: 1, title: 'demo' }] });
  assert.deepEqual(lines.map((l) => l.replace(/:.*/, '')), Array(4).fill('  by hand     board "demo"'));
  for (const part of [/views: a Board view grouped by Status/, /"Auto-add to project": on/, /"Item closed": sets Status to Done/, /"Pull request merged": sets Status to Done/]) assert.ok(lines.some((l) => part.test(l)), String(part));
  // Through readServer and doctor: the lines appear, and the result does not change.
  const root = makeTempDir('yokoten-board-');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: root });
  const plain = serverGh(GOOD).gh;
  const withBoard: Gh = (args) => (args[1] === 'graphql' ? JSON.stringify({ data: { repository: { projectsV2: { nodes: [{ number: 1, title: 'demo' }] } } } }) : plain(args));
  assert.deepEqual((readServer(withBoard, REPO) as ServerSettings).boards, [{ number: 1, title: 'demo' }]);
  const plainResult = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: plain });
  const boardResult = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: withBoard });
  assert.ok(!plainResult.lines.some((l) => /by hand {5}board/.test(l)));
  assert.equal(boardResult.lines.filter((l) => /^ {2}by hand {5}board "demo": /.test(l)).length, 4);
  assert.equal(boardResult.ok, plainResult.ok);
  assert.deepEqual(boardResult.report.findings, plainResult.report.findings);
});

test('road: the labels and milestone steps are stage 2; missing labels or no open milestone is not done (#10)', () => {
  assert.deepEqual(ROAD.filter((s) => ['labels', 'milestone'].includes(s.key)).map((s) => s.stage), [2, 2]);
  const all = readPlanning(fakeGh([...LABELS], ['open v1']).gh, 'me/repo');
  assert.deepEqual(planningFound(withPlanning(all)), { labels: true, milestone: true });
  const lacking = withPlanning(readPlanning(fakeGh(LABELS.filter((l) => l.name !== 'hotfix'), ['closed v1']).gh, 'me/repo'));
  assert.deepEqual(planningFound(lacking), { labels: false, milestone: false });
  assert.equal(stepFinding(ROAD.find((s) => s.key === 'labels')!, '.', {}, { server: lacking }).what, 'the standard labels are not all on the server (no hotfix)');
  // A session, no gh, or a server read without them: can't check, never done.
  for (const server of [undefined, readServer(() => { throw said(401); }, REPO), withPlanning(undefined), withPlanning({ unread: 'gh is not signed in', fix: 'run `gh auth login`' })]) {
    assert.deepEqual(planningFound(server), { labels: null, milestone: null });
  }
  assert.equal(ROAD.find((s) => s.key === 'labels')!.unchecked?.(undefined), 'a session never calls the network; run `yokoten doctor`');
});

test('doctor: the no-build-output step looks at the tracked files (#56)', async () => {
  const sandbox = makeSandbox();
  const line = async () => (await sandbox.call(['doctor'])).stdout.split('\n').find((l) => / no-build-output/.test(l)) ?? '';
  assert.match(await line(), /^ +done +no-build-output/);
  sandbox.write('build/a.js', 'x\n');
  sandbox.write('lib/x.so', 'x\n');
  sandbox.git('add', '.');
  assert.match(await line(), /^ +to do +no-build-output \(Scorecard: Binary-Artifacts\): build output in the repo \(build\/a\.js, lib\/x\.so\)/);
  sandbox.write('yokoten.json', JSON.stringify({ allowBuild: ['build/**', 'lib/**'] }));
  assert.match(await line(), /^ +done +no-build-output/);
});

test('doctor: shows check\'s notes, worded as check words them, and they never change the exit code (#228)', async () => {
  const sandbox = makeSandbox();
  const before = await sandbox.call(['doctor']);
  assert.doesNotMatch(before.stdout, /note +yokoten\.json|is behind en\.md/);
  // An unknown yokoten.json key.
  sandbox.write('yokoten.json', '{ "colour": "blue" }');
  const unknownKey = /^ {2}note +yokoten\.json: "colour" is not a key this version of yokoten knows/m;
  assert.match((await sandbox.call(['check'])).stdout, /^yokoten check: note: yokoten\.json: "colour" is not a key this version of yokoten knows/m);
  let result = await sandbox.call(['doctor']);
  assert.match(result.stdout, unknownKey);
  assert.equal(result.status, before.status, 'a note never changes the exit code');
  result = await sandbox.call(['doctor', '--json']);
  assert.ok(JSON.parse(result.stdout).notes.some((f: { file?: string; what: string }) => f.file === 'yokoten.json' && /"colour"/.test(f.what)));
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, /colour/, 'a session stays short');
  // A translation behind its English source.
  sandbox.write('en.md', '# Guide\n\nStep one.\n');
  sandbox.write('zh.md', '<!-- source: en.md -->\n# 指南\n\n第一步。\n');
  sandbox.git('add', 'en.md', 'zh.md');
  sandbox.git('commit', '-q', '-m', 'docs: add the guide');
  sandbox.write('en.md', '# Guide\n\nStep one.\nStep two.\n');
  sandbox.git('commit', '-q', '-am', 'docs: add step two');
  result = await sandbox.call(['doctor']);
  assert.match(result.stdout, /^ {2}note +zh\.md:1: is behind en\.md by 1 commit/m);
  assert.match(result.stdout, unknownKey);
  assert.equal(result.status, before.status);
  assert.ok(JSON.parse((await sandbox.call(['doctor', '--json'])).stdout).notes.some((f: { id: string }) => f.id === 'translation-behind'));
});

// git skips a hook without the execute bit, so the check in it never runs (#239).
test('doctor: a hook in the project\'s folder that is not executable is not checked, and init makes it executable (#239)', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'core.hooksPath', 'tools/hooks');
  assert.equal((await sandbox.call(['init'])).status, 0);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  const mergeHook = join(sandbox.repo, 'tools/hooks/pre-merge-commit');
  chmodSync(mergeHook, 0o644);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done', 'the check is in the file, but git does not run it');
  let doctor = (await sandbox.call(['doctor'])).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): merge commits are not checked: tools\/hooks\/pre-merge-commit is not executable, so git skips it/);
  assert.match(doctor, /run `chmod \+x tools\/hooks\/pre-merge-commit`, or `yokoten init`/);
  const result = await sandbox.call(['init']);
  assert.match(result.stdout, /made executable tools\/hooks\/pre-merge-commit/);
  assert.ok(statSync(mergeHook).mode & 0o100, 'executable');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // A pre-commit without the check and without the execute bit: add the line, and chmod.
  const preCommit = join(sandbox.repo, 'tools/hooks/pre-commit');
  writeFileSync(preCommit, '#!/bin/sh\necho own\n');
  chmodSync(preCommit, 0o644);
  doctor = (await sandbox.call(['doctor'])).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): commits are not checked: tools\/hooks\/pre-commit does not run yokoten; `yokoten init` adds the check to tools\/hooks\/pre-commit,/);
  assert.match(doctor, /or do it yourself: add the line below to tools\/hooks\/pre-commit, after its `#!` line; run `chmod \+x tools\/hooks\/pre-commit`\. The line: /);
});

test('doctor: a workflow of the project\'s own that init keeps gets the step to add, not "init adds it" (#256)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/workflows/pr.yml', 'name: pr\non: pull_request\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lint\n');
  sandbox.write('.github/workflows/yokoten.yml', 'name: yokoten\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo build\n');
  assert.equal((await sandbox.call(['init'])).status, 0);
  const doctor = (await sandbox.call(['doctor'])).stdout;
  assert.ok(doctor.includes('titles (Conventional Commits 1.0.0): CI does not check pull requests (`yokoten check --pr`); add this step to .github/workflows/pr.yml, after actions/checkout with `fetch-depth: 0` and actions/setup-node, in a job that runs on pull_request (`yokoten init` keeps your file as it is): `- run: node .yokoten/bin/yokoten.ts check --pr`\n'), doctor);
  assert.ok(doctor.includes('ci (Scorecard: CI-Tests): CI does not run `yokoten check`; add this step to .github/workflows/yokoten.yml, after actions/checkout and actions/setup-node (`yokoten init` keeps your file as it is): `- run: node .yokoten/bin/yokoten.ts check`\n'), doctor);
  assert.doesNotMatch(doctor, /`yokoten init` adds \.github\/workflows/);
});

// The road (record 0004). A session hears three lines about one step; the marks file is
// set so that the private-marks note does not add a fourth.
test('doctor --session: exactly three lines, about the first step of the first stage not done', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const r = await sandbox.call(['doctor', '--session'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  assert.equal(r.status, 0, 'a session always starts');
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'yokoten: stage 1 of 5, safety net. Next: no AGENTS.md, so the agents have no written rules here; `yokoten init` adds one.',
    'Why: an agent follows the rules it can read, and only those.',
    'Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).',
  ]);
  // Outside a repo it says nothing (unless yokoten itself is broken). A stop marker keeps
  // the walk from finding the repo around this folder when TMPDIR lives inside one.
  stopCheckoutWalk(sandbox.home);
  assert.equal((await sandbox.call(['doctor', '--session'], { cwd: sandbox.home })).stdout, '');
});

test('doctor --session: "not now" skips a step, by the names yokoten.json already uses', async () => {
  const sandbox = makeSandbox();
  const next = async () => (await sandbox.call(['doctor', '--session'])).stdout.split('\n')[0];
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'our rules live in the wiki for now' } }));
  assert.match(await next(), /stage 1 of 5, safety net\. Next: no tool-call guard/);
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e', remote: 'no remote yet' } }));
  assert.match(await next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run/, 'a stage with every step not now is passed');
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e', remote: 'no remote yet', ci: 'no remote yet', issues: 'f' } }));
  assert.match(await next(), /stage 2 of 5, issues and pull requests\. Next: no issue templates and no pull request template/);
  const full = (await sandbox.call(['doctor'])).stdout;
  assert.match(full, /^ +not now +ci \(Scorecard: CI-Tests\): no remote yet$/m, 'the full map shows the reason');
  assert.match(full, /^ +next +templates \(GitHub community profile\): /m);
  assert.match(full, /^ +to do +changelog \(Best Practices: release_notes\): /m);
  // "notNow" ci covers the steps that need CI (#377): titles waits too, and says what to run instead.
  assert.match(full, /^ +not now +titles \(Conventional Commits 1\.0\.0\): no remote yet \(notNow ci\); run `yokoten check --pr <number>` before each merge$/m);
});

test('doctor: each stage boundary, from a fresh repo to the end of the road', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const key = join(sandbox.home, 'bot.pem');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks };
  const session = async (more: Record<string, string> = {}) => (await sandbox.call(['doctor', '--session'], { extra: { ...extra, ...more } })).stdout.trimEnd().split('\n');
  const next = async (more?: Record<string, string>) => (await session(more))[0];
  assert.match(await next(), /stage 1 of 5, safety net\. Next: no AGENTS\.md/);
  // Stage 1 done, stage 2 not: init without its CI workflow.
  assert.equal((await sandbox.call(['init'])).status, 0);
  sandbox.withTests();
  // The remote comes first (#655): make the repo, add it as origin, and push.
  assert.match(await next(), /stage 2 of 5, issues and pull requests\. Next: there is no origin remote/);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  sandbox.git('commit', '--allow-empty', '-qm', 'first');
  sandbox.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  rmSync(join(sandbox.repo, '.github', 'workflows', 'yokoten.yml'));
  assert.match(await next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run `yokoten check`/, 'the pull request check alone is not the CI check');
  sandbox.write('TODO.md', '- one\n');
  await sandbox.call(['init']);
  assert.match(await next(), /stage 2 of 5, issues and pull requests\. Next: a todo file \(TODO\.md\)/);
  rmSync(join(sandbox.repo, 'TODO.md'));
  // Stage 2 done. init wrote a changelog and changes/; without both, stage 3 is next.
  rmSync(join(sandbox.repo, 'CHANGELOG.md'));
  assert.match(await next(), /stage 4 of 5/, 'changes/ alone passes the changelog step (#132)');
  rmSync(join(sandbox.repo, 'changes'), { recursive: true });
  assert.match(await next(), /stage 3 of 5, release\. Next: no CHANGELOG\.md with an "Unreleased" section, and no changes\/ folder/);
  sandbox.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n');
  // Stage 3 done.
  assert.match(await next(), /stage 4 of 5, a team of agents\. Next: \.github\/CODEOWNERS names no owner yet \(@YOUR_GITHUB_HANDLE\); put your GitHub handle in \.github\/CODEOWNERS/);
  // init wrote CODEOWNERS with the placeholder owner; a real owner finishes the step.
  sandbox.write('.github/CODEOWNERS', '* @octo\n');
  assert.match(await next(), /stage 4 of 5, a team of agents\. Next: the bot is not set up on this machine: YOKOTEN_BOT_APP_ID is not set, in the environment or in ~\/\.config\/yokoten\/keys\.env;/);
  // The key file in its default place, but no App ID anywhere: the step names what is missing (#364).
  const config = join(sandbox.home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'bot.pem'), 'not a real key\n');
  assert.match(await next(), /Next: the bot is not set up on this machine: the bot's key file is here, but YOKOTEN_BOT_APP_ID is not set/);
  // The App ID in the keys file, as `yokoten bot` reads it, and none in the session (#405).
  writeFileSync(join(config, 'keys.env'), 'OTHER_KEY=x\nexport YOKOTEN_BOT_APP_ID="1"\n');
  assert.match(await next(), /stage 4 of 5, a team of agents\. Next: the yokoten skills are not in/, 'the keys file counts: no "no bot"');
  for (const file of ['bot.pem', 'keys.env']) rmSync(join(config, file));
  writeFileSync(key, 'not a real key\n');
  const bot = { YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key };
  assert.match(await next(bot), /stage 4 of 5, a team of agents\. Next: the yokoten skills are not in/);
  assert.equal((await sandbox.call(['install'])).status, 0);
  // Stage 4 done. init writes a security policy and Dependabot; the license is the owner's choice.
  assert.match(await next(bot), /stage 5 of 5, going public\. Next: no license file; /);
  sandbox.write('LICENSE', 'placeholder license\n');
  assert.deepEqual(await session(bot), ['yokoten: every step yokoten can check is done, or marked not now.']);
  // The order is advice, not a gate: a later step done early counts as done.
  rmSync(join(sandbox.repo, 'AGENTS.md'));
  assert.match(await next(bot), /stage 1 of 5, safety net\. Next: no AGENTS\.md/);
  assert.match((await sandbox.call(['doctor'], { extra: { ...extra, ...bot } })).stdout, /^ +done +security-files \(Scorecard: Security-Policy · OSPS-VM-02\.01\)$/m, 'full doctor names the outside standard (#58)');
});

test('doctor: a stage that jumped says which stages it passed, once (#514)', async () => {
  const sandbox = makeSandbox();
  const jumpLine = /^stage \d (is done too|counts as done): /m;
  // The first run has nothing to compare with: stage 1 is next, and no line.
  const first = await sandbox.call(['doctor']);
  assert.match(first.stdout, /^the road: stage 1 of 5/m);
  assert.doesNotMatch(first.stdout, jumpLine);
  // The stage file sits next to the lessons state, in the git folder, not one folder deeper (#514).
  const stagePath = join(sandbox.repo, '.git/yokoten/stage.json');
  assert.ok(existsSync(stagePath), `the stage file is ${stagePath}`);
  assert.deepEqual(JSON.parse(readFileSync(stagePath, 'utf8')), { lastStage: 1 });
  assert.equal(existsSync(join(sandbox.repo, '.git/yokoten/yokoten')), false, 'no nested yokoten folder');
  // Stage 1 to stage 4 at once: init writes the rules, hooks and changelog, and the
  // remote, the test workflow and the templates finish stages 2 and 3.
  assert.equal((await sandbox.call(['init'])).status, 0);
  sandbox.withTests();
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  sandbox.git('commit', '--allow-empty', '-qm', 'first');
  sandbox.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const jumpedRun = await sandbox.call(['doctor']);
  assert.match(jumpedRun.stdout, /^the road: stage 4 of 5/m);
  // Each passed stage says its own reason: stage 2 has steps only the server can check,
  // while stage 3 was already in place.
  assert.match(jumpedRun.stdout, /^stage 2 counts as done: \d+ of its steps were already in place and 2 can't be checked yet$/m);
  assert.match(jumpedRun.stdout, /^stage 3 is done too: its steps were already in place$/m);
  // The lines are told once: the next run starts from stage 4.
  const later = await sandbox.call(['doctor']);
  assert.match(later.stdout, /^the road: stage 4 of 5/m);
  assert.doesNotMatch(later.stdout, jumpLine);
  // A session stays short: it never prints the lines.
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, jumpLine);
});

test('doctor: a jump over one stage says that stage, in the singular (#514)', async () => {
  const sandbox = makeSandbox();
  // Stage 1 is done and stage 2 is next (no remote), so this run records stage 2.
  assert.equal((await sandbox.call(['init'])).status, 0);
  sandbox.withTests();
  const atTwo = await sandbox.call(['doctor']);
  assert.match(atTwo.stdout, /^the road: stage 2 of 5/m);
  // The remote finishes stage 2, and stage 3 was already in place: only stage 3 was
  // passed, so the line names one stage and not "stages 3 are".
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  sandbox.git('commit', '--allow-empty', '-qm', 'first');
  sandbox.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const jumped = await sandbox.call(['doctor']);
  assert.match(jumped.stdout, /^the road: stage 4 of 5/m);
  assert.match(jumped.stdout, /^stage 3 is done too: its steps were already in place$/m);
  assert.doesNotMatch(jumped.stdout, /^stages /m);
});

test('doctor: the tests step wants a test command and a CI step that runs it (#55)', async () => {
  const sandbox = makeSandbox();
  const line = async () => (await sandbox.call(['doctor'])).stdout.split('\n').find((l) => / tests\b/.test(l)) ?? '';
  // No package.json: the message does not name it (#257).
  assert.match(await line(), /^ +to do +tests \(Best Practices: test\): no workflow runs a test command/);
  // npm's placeholder script only fails: it is no test command.
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.match(await line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  assert.match(await line(), /^ +to do +tests \(Best Practices: test\): CI does not run the tests/);
  sandbox.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npm run test\n');
  assert.match(await line(), /^ +done +tests/);
  // A project with no package.json: CI that runs a test runner is enough.
  rmSync(join(sandbox.repo, 'package.json'));
  assert.match(await line(), /^ +to do +tests \(Best Practices: test\): no workflow runs a test command such as `go test`, `pytest` or `cargo test`/);
  sandbox.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: go test ./...\n');
  assert.match(await line(), /^ +done +tests/);
});

// #208: steps left on the road are to do, not problems. Exit 1 is for a problem.
test('doctor: exits 0 on a set-up project with steps to do, and 1 on a problem (#208)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install'])).status, 0);
  writeFileSync(join(sandbox.home, '.config/yokoten/private-marks'), 'mycity\n');
  sandbox.withTests();
  assert.equal((await sandbox.call(['init'])).status, 0);
  // The doctor calls here are real children: the exit code 0 and 1 come through the entry point.
  let result = sandbox.run(['doctor']);
  assert.match(result.stdout, /\n +next +remote[^]*\n +to do +codeowners/, 'later steps are left');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse((await sandbox.call(['doctor', '--json'])).stdout).ok, true);
  // A problem: a private mark in the tree.
  sandbox.write('notes.md', 'I live in MyCity\n');
  sandbox.git('add', 'notes.md');
  result = sandbox.run(['doctor']);
  assert.match(result.stdout, /MISSING tree: 1 problem/);
  assert.equal(result.status, 1);
  assert.equal(sandbox.run(['doctor', '--session']).status, 0, 'a session always starts');
});

test('doctor: lists the work only on this machine; a session hears at most three items (#365)', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks };
  const session = async () => (await sandbox.call(['doctor', '--session'], { extra })).stdout.trimEnd().split('\n');
  // A fresh change is work going on now: the session does not hear it.
  sandbox.write('a.txt', 'a\n');
  assert.equal((await session()).length, 3, 'only the road');
  assert.match((await sandbox.call(['doctor'], { extra })).stdout, /^unsaved work \(only on this machine\):\n {2}note {4}uncommitted-changes: \. has 1 uncommitted file, the oldest changed 1 minute ago; /m);
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(join(sandbox.repo, 'a.txt'), old, old);
  assert.deepEqual((await session()).slice(3), ['yokoten: . has 1 uncommitted file, the oldest changed 2 days ago; commit them: `git add -A && git commit -m "chore: save work"`; once the repo has a remote, push it.', UNSAVED_OFFER]);
  const json = JSON.parse((await sandbox.call(['doctor', '--session', '--json'], { extra })).stdout);
  assert.deepEqual(json.notes.map((n: { id: string }) => n.id), ['uncommitted-changes']);
  assert.equal(json.ok, true, 'a note never fails doctor');
  // Commit, then four worktrees with old changes: five items, three shown.
  sandbox.git('add', '-A');
  sandbox.git('commit', '-qm', 'first');
  for (const name of ['w1', 'w2', 'w3', 'w4']) {
    const tree = join(sandbox.home, name);
    sandbox.git('worktree', 'add', '-q', '-b', name, tree);
    writeFileSync(join(tree, 'b.txt'), 'b\n');
    utimesSync(join(tree, 'b.txt'), old, old);
  }
  const lines = (await session()).slice(3);
  assert.equal(lines.length, 5, lines.join('\n'));
  assert.equal(lines[3], 'yokoten: 2 more like this; `yokoten doctor` lists them all.');
  assert.ok(lines.every((line) => !line.includes(sandbox.home)), 'never the full home path');
  const full = await sandbox.call(['doctor'], { extra });
  assert.equal(full.stdout.match(/^ {2}note {4}(uncommitted-changes|unpushed-commits): /gm)?.length, 5);
  assert.match(full.stdout, /uncommitted-changes: ~\/w1 has 1 uncommitted file/, 'a worktree outside the repo shows from ~');
});

test('doctor: a clean, pushed repo has no unsaved-work note (#365)', async () => {
  const sandbox = makeSandbox();
  const origin = join(sandbox.home, 'origin.git');
  sandbox.git('init', '-q', '--bare', '-b', 'main', origin);
  sandbox.write('a.txt', 'a\n');
  sandbox.git('add', '-A');
  sandbox.git('commit', '-qm', 'first');
  sandbox.git('remote', 'add', 'origin', origin);
  sandbox.git('push', '-q', '-u', 'origin', 'main');
  const full = (await sandbox.call(['doctor'])).stdout;
  assert.match(full, /^unsaved work \(only on this machine\):\n {2}ok {6}everything is committed and pushed$/m);
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, /only on this machine/);
});

test('doctor --session: the unsaved-work read stops at its time budget and says so; full doctor has none (#365)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.txt', 'a\n');
  sandbox.git('add', '-A');
  sandbox.git('commit', '-qm', 'first');
  let now = 0;
  // Each look at the clock is a second later: the first git call already finds the time up.
  const slow = sessionUnsaved(sandbox.repo, sandbox.env, () => (now += SESSION_UNSAVED_BUDGET));
  assert.deepEqual(slow.lines, [STOPPED_EARLY]);
  assert.deepEqual(slow.notes, [], 'no guess from what was not read');
  // A clock that stands still: the whole read, and here a repo with no remote.
  const fast = sessionUnsaved(sandbox.repo, sandbox.env, () => 0);
  assert.ok(!fast.lines.includes(STOPPED_EARLY));
  assert.deepEqual(fast.notes.map((f) => f.id), ['unpushed-commits']);
  assert.equal(fast.lines.at(-1), UNSAVED_OFFER);
});

test('privacyNotes: the mailmap, and the kinds of mark yokoten cannot find; never a value (#390)', () => {
  const home = makeTempDir('yokoten-privacy-');
  const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const notes = () => privacyNotes(env, null).map((note) => `${note.name}: ${note.finding.what}; ${note.finding.fix}`);
  // No marks at all: the private-marks check says so, and no offer adds a second answer (#522).
  assert.deepEqual(notes(), ['mailmap: git log and git show print your name and email as they are; run `yokoten install`; it writes ~/.config/yokoten/mailmap and sets `git config --global mailmap.file ~/.config/yokoten/mailmap`, so git prints a private address in place of your email']);
  execFileSync('git', ['config', '--global', 'mailmap.file', '~/.config/yokoten/mailmap'], { env: { ...process.env, ...env } });
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  // Only the name install found: the other kinds are an optional offer. The name is not asked for (#434).
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), '# added by yokoten from this machine: git name\nJane Example\n');
  assert.deepEqual(notes(), ["private-mark-kinds: optional: add your city or your domains too; yokoten can't find them on its own; run `yokoten marks add` and type one; it is not shown"]);
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), 'Jane Example\nFakeville\njanex.dev\n');
  assert.deepEqual(notes(), []);
  execFileSync('git', ['config', '--global', 'mailmap.file', '/elsewhere/mailmap'], { env: { ...process.env, ...env } });
  assert.deepEqual(notes(), ['mailmap: git uses your own mailmap file, not ~/.config/yokoten/mailmap; add the lines of ~/.config/yokoten/mailmap to your file']);
  // Another agent on this machine: its output is not filtered, and the note says how to opt in.
  mkdirSync(join(home, '.codex'));
  assert.equal(notes()[0], 'private-output: only Claude Code hides your details in command output; other agents show it as it is; to stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json');
  assert.equal(privacyNotes(env, null, 'stop').length, 1, 'with "stop", only the mailmap note is left');
  rmSync(home, { recursive: true, force: true });
});

// #681: outside a desk, Muse can send Claude Code's user rules to its model. A note, and
// the file is never read. One of the two files missing, and the note stays off.
test('doctor: notes when Muse, outside a desk, can send ~/.claude/CLAUDE.md to its model (#681)', async () => {
  const sandbox = makeSandbox();
  const body = 'not-sent-to-muse';
  const rules = join(sandbox.home, '.claude', 'CLAUDE.md');
  const hooks = join(sandbox.repo, '.muse', 'hooks.json');
  const env = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' };
  const noGh = () => {
    throw new Error('no network in this test');
  };
  const run = (session = false) => doctor(sandbox.repo, { env, config: DEFAULTS, session, gh: noGh });
  const noteOf = (report: ReturnType<typeof doctor>) => report.report.notes?.filter((note) => note.id === 'muse-claude-rules') ?? [];
  mkdirSync(dirname(rules), { recursive: true });
  writeFileSync(rules, `${body}\n`);
  mkdirSync(dirname(hooks), { recursive: true });
  writeFileSync(hooks, '{}\n');
  const what = "outside a desk, Muse can send ~/.claude/CLAUDE.md to Muse's model";
  const fix = 'run Muse in a desk (`yokoten desk muse`) so the home folder stays hidden';
  const line = `  note    muse-claude-rules: ${what}; ${fix}`;
  const full = run();
  assert.ok(full.lines.includes(line), full.lines.join('\n'));
  assert.deepEqual(noteOf(full).map((note) => [note.what, note.why, note.fix]), [[what, 'the file was written for one vendor', fix]]);
  assert.ok(!full.report.findings.some((note) => note.id === 'muse-claude-rules'));
  const session = run(true);
  assert.ok(session.lines.some((text) => text.startsWith(`yokoten: ${what}.`) && text.includes('`yokoten desk muse`') && text.includes('home folder stays hidden')));
  assert.deepEqual(noteOf(session).map((note) => note.what), [what]);
  assert.ok(!session.report.findings.some((note) => note.id === 'muse-claude-rules'));
  const noteLines = [...full.lines, ...session.lines].filter((text) => text.includes('muse-claude-rules') || text.includes('~/.claude/CLAUDE.md'));
  const noteText = JSON.stringify({ lines: noteLines, notes: [...noteOf(full), ...noteOf(session)] });
  assert.ok(noteLines.length >= 2, 'full doctor and the session each say it');
  assert.ok(!noteText.includes(body), 'the rules file is never read');
  assert.ok(!noteText.includes(sandbox.home), 'the note names no home path');
  const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout) as { ok: boolean; notes: { id: string }[] };
  assert.equal(json.ok, full.ok);
  assert.ok(json.notes.some((note) => note.id === 'muse-claude-rules'));
  assert.ok(!JSON.stringify(json).includes(body));
  const sessionJson = JSON.parse((await sandbox.call(['doctor', '--session', '--json'])).stdout) as { ok: boolean; notes: { id: string }[]; findings: { id: string }[] };
  assert.equal(sessionJson.ok, session.ok);
  assert.ok(sessionJson.notes.some((note) => note.id === 'muse-claude-rules'));
  assert.ok(!sessionJson.findings.some((note) => note.id === 'muse-claude-rules'));
  assert.ok(!JSON.stringify(sessionJson).includes(body));
  rmSync(rules);
  const noRules = run();
  const noRulesSession = run(true);
  assert.equal(full.ok, noRules.ok, 'a note never fails doctor');
  assert.equal(session.ok, noRulesSession.ok, 'a session note never fails doctor');
  assert.deepEqual(noteOf(noRules), [], 'no rules file');
  assert.deepEqual(noteOf(noRulesSession), [], 'no rules file in a session');
  writeFileSync(rules, `${body}\n`);
  rmSync(hooks);
  const noHooks = run();
  const noHooksSession = run(true);
  assert.equal(noHooks.ok, full.ok, 'the hooks file is not what fails doctor');
  assert.equal(noHooksSession.ok, session.ok);
  assert.deepEqual(noteOf(noHooks), [], 'no Muse hooks');
  assert.deepEqual(noteOf(noHooksSession), [], 'no Muse hooks in a session');
});

// #681: the same visible file, once the session names a desk. The note must not say
// "outside a desk", and must not tell the session to do what it is already doing.
// A home folder this process cannot see gives no note: the file is still on disk.
test('doctor: a desk that can see ~/.claude/CLAUDE.md hears that the home folder is visible (#681)', () => {
  const sandbox = makeSandbox();
  const body = 'not-sent-to-muse';
  const rules = join(sandbox.home, '.claude', 'CLAUDE.md');
  const claudeDir = dirname(rules);
  const hooks = join(sandbox.repo, '.muse', 'hooks.json');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(rules, `${body}\n`);
  mkdirSync(dirname(hooks), { recursive: true });
  writeFileSync(hooks, '{}\n');
  const desk = join(sandbox.home, 'desk');
  const team = join(sandbox.home, 'team');
  const base = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' };
  const inDesk = { ...base, YOKOTEN_DESK: desk, YOKOTEN_TEAM: team };
  const noGh = () => {
    throw new Error('no network in this test');
  };
  const noteOf = (env: Record<string, string>) => privacyNotes(env, sandbox.repo).filter((note) => note.finding.id === 'muse-claude-rules');
  const outside = noteOf(base);
  assert.equal(outside[0]?.finding.what, "outside a desk, Muse can send ~/.claude/CLAUDE.md to Muse's model");
  assert.match(outside[0]?.finding.fix ?? '', /run Muse in a desk/);
  const what = "the home folder is visible in this desk, so Muse can send ~/.claude/CLAUDE.md to Muse's model";
  const fix = 'the desk needs attention: hide the home folder (`yokoten desk muse`)';
  const inside = noteOf(inDesk);
  assert.deepEqual(inside.map((note) => [note.finding.what, note.finding.why, note.finding.fix]), [[what, 'the file was written for one vendor', fix]]);
  assert.doesNotMatch(`${inside[0]?.finding.what} ${inside[0]?.finding.fix}`, /outside a desk/);
  assert.doesNotMatch(inside[0]?.finding.fix ?? '', /run Muse in a desk/);
  // YOKOTEN_DESK alone is enough. The session already says it is in a desk.
  assert.equal(noteOf({ ...base, YOKOTEN_DESK: desk })[0]?.finding.what, what);
  assert.equal(noteOf({ ...base, YOKOTEN_TEAM: team })[0]?.finding.what, what);
  const report = doctor(sandbox.repo, { env: inDesk, config: DEFAULTS, gh: noGh });
  const session = doctor(sandbox.repo, { env: inDesk, config: DEFAULTS, session: true, gh: noGh });
  assert.ok(report.lines.includes(`  note    muse-claude-rules: ${what}; ${fix}`), report.lines.join('\n'));
  assert.ok(!report.report.findings.some((note) => note.id === 'muse-claude-rules'));
  assert.deepEqual(report.report.notes?.filter((note) => note.id === 'muse-claude-rules').map((note) => [note.what, note.fix]), [[what, fix]]);
  const sessionLine = session.lines.find((text) => text.includes('~/.claude/CLAUDE.md'));
  assert.ok(sessionLine?.startsWith(`yokoten: ${what}.`), sessionLine);
  assert.match(sessionLine ?? '', /desk needs attention/);
  assert.doesNotMatch(sessionLine ?? '', /outside a desk/);
  assert.ok(!session.report.findings.some((note) => note.id === 'muse-claude-rules'));
  assert.equal(report.ok, doctor(sandbox.repo, { env: base, config: DEFAULTS, gh: noGh }).ok, 'a desk note never fails doctor');
  assert.equal(session.ok, doctor(sandbox.repo, { env: base, config: DEFAULTS, session: true, gh: noGh }).ok);
  const noteLines = [...report.lines, ...session.lines].filter((text) => text.includes('muse-claude-rules') || text.includes('~/.claude/CLAUDE.md'));
  const shown = JSON.stringify({ lines: noteLines, notes: [...(report.report.notes ?? []), ...(session.report.notes ?? [])].filter((note) => note.id === 'muse-claude-rules') });
  assert.ok(noteLines.length >= 2, 'full doctor and the session each say it');
  assert.ok(!shown.includes(body), 'the rules file is never read');
  assert.ok(!shown.includes(sandbox.home), 'the note names no home path');
  assert.ok(!shown.includes(desk) && !shown.includes(team), 'the note names no desk path');
  // Mode 0 stands in for a fence that hides the home folder. The file stays on disk.
  chmodSync(claudeDir, 0);
  try {
    assert.equal(noteOf(inDesk).length, 0, 'a home folder this process cannot see gives no note');
    assert.equal(doctor(sandbox.repo, { env: inDesk, config: DEFAULTS, session: true, gh: noGh }).lines.some((text) => text.includes('~/.claude/CLAUDE.md')), false);
  } finally {
    chmodSync(claudeDir, 0o700);
  }
});

// #758: a worker runs in a desk by default. Outside one, doctor says plainly that the
// guard, not a fence, holds the rules; the explicit YOKOTEN_NO_DESK=1 says it was a choice.
test('doctor: a worker outside a desk hears it, in a desk or by choice it says its own line (#758)', () => {
  const sandbox = makeSandbox();
  const base = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' };
  const noGh = () => {
    throw new Error('no network in this test');
  };
  const noteOf = (env: Record<string, string>) => privacyNotes(env, sandbox.repo).filter((note) => note.finding.id === 'worker-desk');
  assert.deepEqual(noteOf(base), [], 'the lead is not a worker');
  const outside = noteOf({ ...base, YOKOTEN_ROLE: 'worker' });
  assert.equal(outside[0]?.finding.what, 'this worker runs outside a desk, so your home and the network are open to it');
  assert.match(outside[0]?.finding.fix ?? '', /`yokoten desk`/);
  assert.match(outside[0]?.finding.fix ?? '', /YOKOTEN_NO_DESK=1/);
  assert.match(outside[0]?.finding.why ?? '', /not the boundary/);
  const chosen = noteOf({ ...base, YOKOTEN_ROLE: 'worker', YOKOTEN_NO_DESK: '1' });
  assert.equal(chosen[0]?.finding.what, 'this worker runs outside a desk by your choice, so your home and the network are open to it');
  assert.match(chosen[0]?.finding.fix ?? '', /keep its brief small/);
  // A desk says so itself. A desk started before YOKOTEN_DESK was always set has its state folder next to the clone.
  const inDesk = { ...base, YOKOTEN_ROLE: 'worker', YOKOTEN_DESK: join(sandbox.home, 'desk') };
  assert.deepEqual(noteOf(inDesk), []);
  mkdirSync(`${sandbox.repo}.state`, { recursive: true });
  assert.deepEqual(noteOf({ ...base, YOKOTEN_ROLE: 'worker' }), [], 'the state folder says this is a desk');
  rmSync(`${sandbox.repo}.state`, { recursive: true, force: true });
  const session = doctor(sandbox.repo, { env: { ...base, YOKOTEN_ROLE: 'worker' }, config: DEFAULTS, session: true, gh: noGh });
  const sessionLine = session.lines.find((text) => text.startsWith('yokoten: this worker runs outside a desk'));
  assert.ok(sessionLine, session.lines.join('\n'));
  assert.ok(session.report.notes?.some((note) => note.id === 'worker-desk'));
  assert.ok(!session.report.findings.some((note) => note.id === 'worker-desk'), 'a note never fails doctor');
});

// #392: lessons from other projects wait in ~/.config/yokoten/upstream. Only yokoten's own
// repo, found by its package name, hears about them; another repo hears nothing.
test('doctor: in the yokoten repo, the session and doctor count the notes from other projects; elsewhere nothing', async () => {
  const sandbox = makeSandbox();
  const inbox = join(sandbox.home, '.config', 'yokoten', 'upstream');
  mkdirSync(inbox, { recursive: true });
  for (const id of ['20261020-120000-aaaa', '20261020-130000-bbbb', '20261020-140000-cccc']) writeFileSync(join(inbox, `${id}.md`), 'when: 2026-10-20T12:00:00Z\npart: unknown\nwhat: x\n');
  const line = 'yokoten: 3 lessons from other projects wait to become issues: yokoten learn --upstream --list';
  // Another repo: not a word, though the notes are there.
  assert.ok(!(await sandbox.call(['doctor', '--session'])).stdout.includes('lessons from other projects'));
  assert.equal(upstreamNote(sandbox.repo, { HOME: sandbox.home }), null);
  // A fake yokoten repo: the count, as the session's last line.
  sandbox.write('package.json', JSON.stringify({ name: 'yokoten' }));
  sandbox.write('bin/yokoten.ts', '');
  const session = await sandbox.call(['doctor', '--session']);
  assert.equal(session.status, 0, session.stderr);
  assert.equal(session.stdout.trimEnd().split('\n').at(-1), line);
  const note = upstreamNote(sandbox.repo, { HOME: sandbox.home });
  assert.equal(note?.id, 'upstream-inbox');
  assert.equal(note?.what, line.replace(/^yokoten: /, ''));
  // The session's JSON has the finding too, and full doctor a note line and a note.
  const noGh = () => {
    throw new Error('no network in this test');
  };
  const sessionReport = doctor(sandbox.repo, { env: { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, session: true, gh: noGh });
  assert.deepEqual(sessionReport.report.findings.filter((found) => found.id === 'upstream-inbox'), [note]);
  const full = doctor(sandbox.repo, { env: { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: noGh });
  assert.ok(full.lines.includes(`  note    upstream-inbox: ${note?.what}`), full.lines.join('\n'));
  assert.deepEqual(full.report.notes?.filter((found) => found.id === 'upstream-inbox'), [note]);
  // Elsewhere, full doctor has neither.
  const other = makeSandbox();
  assert.ok(!doctor(other.repo, { env: { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: noGh }).lines.some((text) => text.includes('upstream-inbox')));
  // An empty home: no inbox, no line.
  const empty = makeTempDir('yokoten-empty-');
  assert.equal(upstreamNote(sandbox.repo, { HOME: empty }), null);
  assert.ok(!(await sandbox.call(['doctor', '--session'], { extra: { HOME: empty } })).stdout.includes('lessons from other projects'));
  rmSync(empty, { recursive: true, force: true });
});

// #377: a repo that keeps CI off hears what that leaves out, and when to end it.
test('doctor: the no-ci note says what is not checked, and from stage 5 or on a public repo how to end it (#377)', () => {
  assert.equal(noCiNote({ tests: 'later' }, 2, undefined), null, 'no note without "notNow" ci');
  const early = noCiNote({ ci: 'private repo' }, 2, undefined);
  assert.match(early?.what ?? '', /nothing on the server checks pull requests, issue titles or the workflows, no code scanning such as CodeQL runs/);
  assert.equal(early?.fix, 'before each merge, run `yokoten check --pr <number>` and the tests');
  assert.match(noCiNote({ ci: 'private repo' }, 5, undefined)?.fix ?? '', /; when the repo goes public, remove "ci" from "notNow" in yokoten\.json, then run `yokoten init`/);
  assert.match(noCiNote({ ci: 'private repo' }, null, undefined)?.fix ?? '', /when the repo goes public/, 'the end of the road counts as stage 5');
  const server = readServer(serverGh(GOOD).gh, REPO);
  assert.ok(!('unread' in server));
  assert.match(noCiNote({ ci: 'private repo' }, 2, { ...server, isPrivate: false })?.fix ?? '', /^this repo is public now, and Actions cost no minutes on a public repo: remove "ci"/);
  // With CI off, no CI check can be required, so the server check leaves it out.
  const off: ServerSettings = { ...server, branch: { ...(server.branch as BranchRules), requiredChecks: [] } };
  assert.equal(marks(off)['required-checks'], 'MISSING');
  assert.ok(!serverChecks(off, { isCiOff: true }).some((c) => c.id === 'required-checks'));
});

test('doctor: a file on the default branch, missing on this one, is no "run init" (#405)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'chore: start');
  sandbox.git('branch', 'old');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.write('.claude/settings.json', '{}\n');
  // A workflow that runs no tests and no yokoten, and one security file of three.
  sandbox.write('.github/workflows/lint.yml', 'on: push\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx eslint .\n');
  sandbox.write('SECURITY.md', '# Security\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-q', '-m', 'docs: add the rules');
  const first = async (cwd = sandbox.repo) => (await sandbox.call(['doctor', '--session'], { cwd })).stdout.split('\n')[0];
  const plain = /Next: no AGENTS\.md, so the agents have no written rules here; `yokoten init` adds one\./;
  // No origin: init.defaultBranch, else main.
  assert.equal(sandbox.git('checkout', '-q', 'old').status, 0);
  assert.equal(await first(), 'yokoten: stage 1 of 5, safety net. Next: AGENTS.md is on main, not on this branch (old); work on a branch made from main, or merge main into this one.');
  const full = (await sandbox.call(['doctor'])).stdout;
  const line = (key: string) => full.split('\n').find((l) => new RegExp(` ${key}[ :]`).test(l)) ?? '';
  assert.match(line('rules'), /AGENTS\.md is on main, not on this branch \(old\)/);
  // A step that checks more than that a file exists keeps its own advice.
  assert.match(line('tool-hook'), /no tool-call guard in \.claude\/settings\.json; `yokoten init` adds it/);
  for (const key of ['tests', 'ci', 'titles', 'security-files']) assert.doesNotMatch(line(key), /on main, not on this branch/, key);
  assert.match(line('security-files'), /no Dependabot config, no license file/, 'SECURITY.md on main does not hide the other two');
  // A clone: origin/HEAD names the default branch, and the old branch is checked out.
  assert.equal(sandbox.git('checkout', '-q', 'main').status, 0);
  const clone = join(dirname(sandbox.repo), 'clone');
  const inClone = (...args: string[]) => spawnSync('git', args, { cwd: clone, env: sandbox.env }).status;
  assert.equal(spawnSync('git', ['clone', '-q', sandbox.repo, clone], { env: sandbox.env }).status, 0);
  assert.equal(inClone('checkout', '-q', 'old'), 0);
  assert.equal(await first(clone), 'yokoten: stage 1 of 5, safety net. Next: AGENTS.md is on origin/main, not on this branch (old); work on a branch made from origin/main, or merge origin/main into this one.');
  // On the default branch, or at its commit, the file was removed here: merging changes nothing.
  assert.equal(inClone('checkout', '-q', 'main'), 0);
  rmSync(join(clone, 'AGENTS.md'));
  assert.match(await first(clone), plain, 'on main');
  assert.equal(inClone('checkout', '-q', '-b', 'fresh'), 0);
  assert.match(await first(clone), plain, 'a new branch at the default commit');
  assert.equal(inClone('checkout', '-q', '--detach', 'origin/main'), 0);
  assert.match(await first(clone), plain, 'detached at the default commit');
  // The packed form of the refs reads the same.
  assert.equal(inClone('pack-refs', '--all'), 0);
  assert.equal(inClone('checkout', '-q', '-f', 'main'), 0);
  rmSync(join(clone, 'AGENTS.md'));
  assert.match(await first(clone), plain, 'on main, packed refs');
  // A reftable store keeps no ref in a file: then the plain advice, never a guess.
  assert.equal(inClone('checkout', '-q', '-f', 'old'), 0);
  mkdirSync(join(clone, '.git', 'reftable'));
  assert.match(await first(clone), plain, 'reftable');
  // Positive control: when the default branch lacks the file too, init is the fix.
  rmSync(join(sandbox.repo, 'AGENTS.md'));
  assert.match(await first(), plain);
});

test('doctor: a compaction start drops what the session was told; files older than a week go (#405)', () => {
  const home = makeTempDir('yokoten-sessions-');
  const env = { HOME: home };
  const blocks = [['a', 'a why'], ['b']];
  assert.deepEqual(blocksToSay(env, null, blocks), blocks, 'no session: all, and no file');
  assert.deepEqual(blocksToSay(env, { sessionId: 's1', source: 'startup' }, blocks), blocks, 'a first start says all');
  assert.deepEqual(blocksToSay(env, { sessionId: 's1', source: 'compact' }, blocks), [], 'nothing new: nothing');
  assert.deepEqual(blocksToSay(env, { sessionId: 's1', source: 'compact' }, [['a', 'a why'], ['c']]), [['c']], 'only the new block');
  assert.deepEqual(blocksToSay(env, { sessionId: 's1', source: 'compact' }, [['c']]), [], 'c was said');
  assert.deepEqual(blocksToSay(env, { sessionId: 's2', source: 'compact' }, blocks), blocks, 'a session with no file says all');
  assert.deepEqual(blocksToSay(env, { sessionId: 's1', source: 'resume' }, blocks), blocks, 'a resume starts over');
  // A start other than compaction removes the files of old sessions.
  const old = join(sessionsDir(env), 's2.json');
  const longAgo = new Date(Date.now() - 8 * 86_400_000);
  utimesSync(old, longAgo, longAgo);
  blocksToSay(env, { sessionId: 's3', source: 'startup' }, blocks);
  assert.deepEqual(readdirSync(sessionsDir(env)).sort(), ['s1.json', 's3.json']);
});

test('doctor: with no home folder, full and session say so in one note and do not crash (#404)', () => {
  const sandbox = makeSandbox();
  const root = sandbox.repo;
  try {
    const machine = fakeMachine(250 * GB);
    const note = /no home folder found; yokoten can't read or keep its settings/;
    const full = doctor(root, { env: { HOME: '' }, config: DEFAULTS, machine, fillMarks: true });
    assert.equal(full.lines.filter((line) => note.test(line)).length, 1, full.lines.join('\n'));
    assert.ok(!full.lines.some((line) => /private-marks|mailmap/.test(line)), 'the checks of files in the home are skipped');
    const session = doctor(root, { env: { HOME: 'relative' }, config: DEFAULTS, session: true, machine });
    assert.equal(session.lines.filter((line) => note.test(line)).length, 1, session.lines.join('\n'));
    // The kept reading of the host disk is neither read nor written without a home.
    saveHostCache({ HOME: '' }, machine, { free: 0, size: 1, readAt: NOW.toISOString(), distro: '<distro>', version: 2 });
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
});

test('doctor: with "notNow" ci the default-branch lookup leaves out the Dependabot config (#377, #405)', () => {
  const root = makeTempDir('yokoten-noci-paths-');
  const security = [ROAD.find((s) => s.key === 'security-files')!];
  const off = { ...DEFAULTS, notNow: { ci: 'private repo' } };
  assert.ok(missingPaths(root, security, DEFAULTS).includes('.github/dependabot.yml'), 'positive control: CI on asks for it');
  assert.ok(!missingPaths(root, security, off).some((path) => path.includes('dependabot')));
  assert.ok(missingPaths(root, security, off).includes('SECURITY.md'));
  rmSync(root, { recursive: true, force: true });
});

// #453: full doctor in an empty repo started 31 child processes. git read the index three
// times, and several config keys twice. Each git read now runs once per run, and the
// config values come from one `git config --list`.
test('doctor: full doctor in an empty repo starts each git read once, ten child processes in all (#453)', () => {
  const sandbox = makeSandbox();
  // As the command runs it: the environment is the process's own (src/commands/shared.ts).
  const saved = process.env.YOKOTEN_TEMP_DIRS;
  process.env.YOKOTEN_TEMP_DIRS = '';
  const runs: string[] = [];
  const originals = { ...childProcess };
  for (const name of ['execFileSync', 'spawnSync', 'execSync', 'execFile', 'spawn', 'exec'] as const) {
    const original = originals[name] as (...args: unknown[]) => unknown;
    (childProcess as Record<string, unknown>)[name] = (file: string, args?: unknown, options?: { cwd?: string }) => {
      runs.push(`${Array.isArray(args) ? [file, ...args].join(' ') : file} (in ${options?.cwd === sandbox.repo ? 'the repo' : options?.cwd})`);
      return original(file, args, options);
    };
  }
  syncBuiltinESMExports();
  try {
    const result = doctor(sandbox.repo, { env: process.env, config: DEFAULTS, gh: () => { throw new Error('no network in this test'); }, machine: fakeMachine(100 * GB) });
    assert.ok(result.lines.includes('unsaved work (only on this machine):'), result.lines.join('\n'));
  } finally {
    Object.assign(childProcess, originals);
    syncBuiltinESMExports();
    if (saved === undefined) delete process.env.YOKOTEN_TEMP_DIRS;
    else process.env.YOKOTEN_TEMP_DIRS = saved;
  }
  assert.deepEqual(runs.filter((run, i) => runs.indexOf(run) !== i), [], `a git read ran twice:\n${runs.join('\n')}`);
  assert.equal(runs.length, 10, runs.join('\n'));
});

// #760, #775: a repo with a default branch reads its merge history in one git process.
// A `for-each-ref` to pick the ref and a `log` to read it would be two (#453).
test('doctor: a repo with a default branch reads its merge history in one git process (#453, #760)', () => {
  const sandbox = makeSandbox();
  sandbox.write('one.md', 'one\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'one');
  // As the command runs it: the environment is the process's own (src/commands/shared.ts).
  const saved = process.env.YOKOTEN_TEMP_DIRS;
  process.env.YOKOTEN_TEMP_DIRS = '';
  const runs: string[] = [];
  const originals = { ...childProcess };
  for (const name of ['execFileSync', 'spawnSync', 'execSync', 'execFile', 'spawn', 'exec'] as const) {
    const original = originals[name] as (...args: unknown[]) => unknown;
    (childProcess as Record<string, unknown>)[name] = (file: string, args?: unknown, options?: { cwd?: string }) => {
      runs.push(`${Array.isArray(args) ? [file, ...args].join(' ') : file} (in ${options?.cwd === sandbox.repo ? 'the repo' : options?.cwd})`);
      return original(file, args, options);
    };
  }
  syncBuiltinESMExports();
  try {
    doctor(sandbox.repo, { env: process.env, config: DEFAULTS, gh: () => { throw new Error('no network in this test'); }, machine: fakeMachine(100 * GB) });
  } finally {
    Object.assign(childProcess, originals);
    syncBuiltinESMExports();
    if (saved === undefined) delete process.env.YOKOTEN_TEMP_DIRS;
    else process.env.YOKOTEN_TEMP_DIRS = saved;
  }
  const logs = runs.filter((run) => run.startsWith('git log'));
  assert.equal(logs.length, 1, runs.join('\n'));
  assert.ok(!runs.some((run) => run.includes('for-each-ref --format=%(refname) ')), runs.join('\n'));
});

// ---- The sandbox step (#589): doctor names the one missing or too-wide sandbox. ----

test('doctor: the sandbox step is to do, then done after init, then names a too-wide value (#589)', async () => {
  const sandbox = makeSandbox();
  assert.notEqual(await stepMark(sandbox, 'sandbox'), 'done');
  assert.match((await sandbox.call(['doctor'])).stdout, /^ {4}(next|to do) +sandbox: no sandbox in \.claude\/settings\.json; `yokoten init` adds it$/m);
  assert.equal((await sandbox.call(['init'])).status, 0);
  assert.equal(await stepMark(sandbox, 'sandbox'), 'done');
  assert.match((await sandbox.call(['doctor'])).stdout, /^ {4}done +sandbox$/m);
  sandbox.write('.gemini/settings.json', JSON.stringify({ security: { disableYoloMode: false } }));
  assert.notEqual(await stepMark(sandbox, 'sandbox'), 'done');
  const doctor = (await sandbox.call(['doctor'])).stdout;
  assert.match(doctor, /^ {4}(next|to do) +sandbox: Gemini YOLO mode is allowed in \.gemini\/settings\.json; set security\.disableYoloMode to true in \.gemini\/settings\.json$/m);
});

// #667: full doctor runs check, so a CODEOWNERS line that protects nothing is a finding.
test('doctor: a CODEOWNERS line that matches no file is a finding (#667)', () => {
  const sandbox = makeSandbox();
  sandbox.write('src/a.ts', 'a\n');
  sandbox.write('.github/CODEOWNERS', 'src/gone.ts @lead\n');
  sandbox.git('add', '.');
  const full = doctor(sandbox.repo, { env: { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: () => { throw new Error('no gh in this test'); } });
  const found = full.report.findings.find((f) => f.id === 'stale-codeowners');
  assert.equal(found?.line, 1);
  assert.match(found?.what ?? '', /protects nothing; point it at the new path/);
});

// #500: after a fresh install, every line that names a command uses one way to run yokoten.
