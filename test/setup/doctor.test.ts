// Tests for src/setup/doctor.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fakeGh,
  GOOD,
  makeSandbox,
  planningFound,
  REPO,
  ROOT,
  said,
  serverGh,
  stepMark,
  withPlanning,
} from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import {
  type Gh,
  readPlanning,
  readServer,
  type ServerSettings,
  type Unread,
} from '../../src/host/github.ts';
import {
  coreRulesCheck,
  coreRulesControl,
  doctor,
  listBoardSteps,
  privacyNotes,
  selfTest,
  upstreamNote,
} from '../../src/setup/doctor.ts';
import { LABELS } from '../../src/setup/plan.ts';
import {
  road,
  ROAD,
  serverChecks,
  stepFinding,
} from '../../src/setup/road.ts';

const marks = (s: ServerSettings | Unread) => Object.fromEntries(serverChecks(s).map((c) => [c.id, c.mark]));

const SERVER_KEYS = ['protection', 'merge-settings', 'security-settings'];

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
    'delete-branch': 'ok', 'tag-rules': 'ok', 'security-switches': 'ok', 'forgotten-branches': 'note',
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
    [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'deletion' }] },
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
  for (const id of ['main-rules', 'required-checks', 'code-owner-review', 'squash-only', 'delete-branch', 'tag-rules', 'security-switches']) {
    assert.equal(checks.find((c) => c.id === id)?.mark, "can't check", id);
  }
  assert.match(checks.find((c) => c.id === 'tag-rules')?.finding.fix ?? '', /GitHub Pro/);
  assert.match(checks.find((c) => c.id === 'delete-branch')?.finding.what ?? '', /only a repo admin/);
});

test('road: the server steps are stage 5, and pass a repo with every setting on (#7)', () => {
  assert.deepEqual(serverSteps().map((s) => [s.key, s.stage]), SERVER_KEYS.map((key) => [key, 5]));
  assert.deepEqual(serverFound(readServer(serverGh(GOOD).gh, REPO)), { protection: true, 'merge-settings': true, 'security-settings': true });
});

test('road: each server step catches its setting off, and says what and the fix (#7)', () => {
  const each: [string, Record<string, unknown>, RegExp][] = [
    ['protection', { [`repos/${REPO}/rules/branches/main`]: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }] }, /no rule for no force push, no deletion; no CI check must pass before a merge; code owner review is not required/],
    ['protection', { [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'deletion' }] } }, /^no active tag ruleset on v\*/],
    ['merge-settings', { [`repos/${REPO}`]: { ...(GOOD[`repos/${REPO}`] as object), delete_branch_on_merge: false } }, /^merged branches are not deleted$/],
    ['merge-settings', { [`repos/${REPO}/rules/branches/main`]: [{ type: 'pull_request', parameters: { require_code_owner_review: true, allowed_merge_methods: ['squash', 'rebase'] } }, ...(GOOD[`repos/${REPO}/rules/branches/main`] as object[]).slice(1)] }, /not only by squash/],
    ['security-settings', { [`repos/${REPO}/private-vulnerability-reporting`]: { enabled: false } }, /^private vulnerability reporting is off$/],
  ];
  for (const [key, change, what] of each) {
    const server = readServer(serverGh({ ...GOOD, ...change }).gh, REPO);
    const found = serverFound(server);
    assert.equal(found[key], false, `${key} lets ${Object.keys(change)[0]} through`);
    assert.equal(Object.values(found).filter((f) => f === false).length, 1, `only ${key} fails`);
    const f = stepFinding(ROAD.find((s) => s.key === key)!, '.', {}, server);
    assert.match(f.what, what);
    assert.match(f.fix, /^in Settings, /);
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
  for (const server of unreads) assert.deepEqual(serverFound(server), { protection: null, 'merge-settings': null, 'security-settings': null });
  const protection = ROAD.find((s) => s.key === 'protection')!;
  assert.equal(protection.unchecked?.(undefined), 'a session never calls the network; run `yokoten doctor`');
  assert.match(protection.unchecked?.(unreads[1]) ?? '', /^gh is not installed; get it from https:\/\/cli\.github\.com/);
  // A setting only an admin can see is can't check too, not done.
  const hidden = readServer(serverGh({ ...GOOD, [`repos/${REPO}`]: { default_branch: 'main' } }).gh, REPO);
  assert.equal(serverFound(hidden)['merge-settings'], null);
});

test('doctor: reads the server of a GitHub origin into the road; a step not done fails, a note does not (#7)', () => {
  const root = mkdtempSync(join(tmpdir(), 'yokoten-server-'));
  execFileSync('git', ['init', '-q', root]);
  const run = (routes: Record<string, unknown>) => doctor(root, { env: { HOME: root }, config: DEFAULTS, gh: serverGh(routes).gh });
  let result = run(GOOD);
  const text = () => result.lines.join('\n');
  // No origin remote at all: say so, and say "can't check" once (#208).
  assert.match(text(), /^ {2}can't check server-settings: there is no origin remote yet; add one on GitHub to check the server settings/m);
  assert.match(text(), /^ {4}can't check protection \(Scorecard: Branch-Protection\): there is no origin remote yet/m);
  assert.ok(!/can't check.*can't check/.test(text()), 'no line says "can\'t check" twice');
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitea.example.com/me/repo.git'], { cwd: root });
  result = run(GOOD);
  assert.match(text(), /^ {2}can't check server-settings: the origin remote is not on a host yokoten knows/m);
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: root });
  assert.ok(result.lines.some((l) => /secret scanning with push protection/.test(l)), 'the by-hand list when nothing is read');
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
  const session = doctor(root, { env: { HOME: root }, config: DEFAULTS, session: true, gh: () => { throw new Error('a session called gh'); } });
  assert.notEqual(session.report.next?.id, 'protection');
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
  const f = stepFinding(review, '.', {}, readServer(serverGh(ADMIN).gh, REPO));
  assert.equal(f.what, 'a merge to the default branch needs no approving review');
  assert.match(f.fix, /"Required approvals" to 1/);
  assert.match(f.fix, /can't approve your own pull request, so let the bot open them/);
  assert.match(f.fix, /keep "Allow GitHub Actions to create and approve pull requests" off/);
});

test('road: the review step is not done while a workflow may approve a pull request (#59)', () => {
  // With the Actions setting on, a workflow the bot pushes could approve the bot's own pull request.
  const on = readServer(serverGh({ ...ADMIN, [RULES]: withApprovals(1), [ACTIONS]: { can_approve_pull_request_reviews: true } }).gh, REPO);
  assert.equal(review.check('.', {}, on), false);
  const f = stepFinding(review, '.', {}, on);
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
  const root = mkdtempSync(join(tmpdir(), 'yokoten-review-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: root });
  const full = doctor(root, { env: { HOME: root }, config: DEFAULTS, gh: serverGh({ ...ADMIN, [RULES]: withApprovals(1) }).gh });
  assert.deepEqual(full.report.steps?.find((s) => s.id === 'review'), { id: 'review', stage: 4, mark: 'done', standard: 'Scorecard: Code-Review' });
  assert.deepEqual(full.report.selfTest, { ok: true, failed: [] }, 'the server control still passes no step');
  const session = doctor(root, { env: { HOME: root }, config: DEFAULTS, session: true, gh: () => { throw new Error('a session called gh'); } });
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
  const root = mkdtempSync(join(tmpdir(), 'yokoten-board-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: root });
  const plain = serverGh(GOOD).gh;
  const withBoard: Gh = (args) => (args[1] === 'graphql' ? JSON.stringify({ data: { repository: { projectsV2: { nodes: [{ number: 1, title: 'demo' }] } } } }) : plain(args));
  assert.deepEqual((readServer(withBoard, REPO) as ServerSettings).boards, [{ number: 1, title: 'demo' }]);
  const plainResult = doctor(root, { env: { HOME: root }, config: DEFAULTS, gh: plain });
  const boardResult = doctor(root, { env: { HOME: root }, config: DEFAULTS, gh: withBoard });
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
  assert.equal(stepFinding(ROAD.find((s) => s.key === 'labels')!, '.', {}, lacking).what, 'the standard labels are not all on the server (no hotfix)');
  // A session, no gh, or a server read without them: can't check, never done.
  for (const server of [undefined, readServer(() => { throw said(401); }, REPO), withPlanning(undefined), withPlanning({ unread: 'gh is not signed in', fix: 'run `gh auth login`' })]) {
    assert.deepEqual(planningFound(server), { labels: null, milestone: null });
  }
  assert.equal(ROAD.find((s) => s.key === 'labels')!.unchecked?.(undefined), 'a session never calls the network; run `yokoten doctor`');
});

test('doctor: the no-build-output step looks at the tracked files (#56)', () => {
  const sandbox = makeSandbox();
  const line = () => sandbox.run(['doctor']).stdout.split('\n').find((l) => / no-build-output/.test(l)) ?? '';
  assert.match(line(), /^ +done +no-build-output/);
  sandbox.write('build/a.js', 'x\n');
  sandbox.write('lib/x.so', 'x\n');
  sandbox.git('add', '.');
  assert.match(line(), /^ +to do +no-build-output \(Scorecard: Binary-Artifacts\): build output in the repo \(build\/a\.js, lib\/x\.so\)/);
  sandbox.write('yokoten.json', JSON.stringify({ allowBuild: ['build/**', 'lib/**'] }));
  assert.match(line(), /^ +done +no-build-output/);
});

test('doctor: shows check\'s notes, worded as check words them, and they never change the exit code (#228)', () => {
  const sandbox = makeSandbox();
  const before = sandbox.run(['doctor']);
  assert.doesNotMatch(before.stdout, /note +yokoten\.json|is behind en\.md/);
  // An unknown yokoten.json key.
  sandbox.write('yokoten.json', '{ "colour": "blue" }');
  const unknownKey = /^ {2}note +yokoten\.json: "colour" is not a key this version of yokoten knows/m;
  assert.match(sandbox.run(['check']).stdout, /^yokoten check: note: yokoten\.json: "colour" is not a key this version of yokoten knows/m);
  let result = sandbox.run(['doctor']);
  assert.match(result.stdout, unknownKey);
  assert.equal(result.status, before.status, 'a note never changes the exit code');
  result = sandbox.run(['doctor', '--json']);
  assert.ok(JSON.parse(result.stdout).notes.some((f: { file?: string; what: string }) => f.file === 'yokoten.json' && /"colour"/.test(f.what)));
  assert.doesNotMatch(sandbox.run(['doctor', '--session']).stdout, /colour/, 'a session stays short');
  // A translation behind its English source.
  sandbox.write('en.md', '# Guide\n\nStep one.\n');
  sandbox.write('zh.md', '<!-- source: en.md -->\n# 指南\n\n第一步。\n');
  sandbox.git('add', 'en.md', 'zh.md');
  sandbox.git('commit', '-q', '-m', 'docs: add the guide');
  sandbox.write('en.md', '# Guide\n\nStep one.\nStep two.\n');
  sandbox.git('commit', '-q', '-am', 'docs: add step two');
  result = sandbox.run(['doctor']);
  assert.match(result.stdout, /^ {2}note +zh\.md:1: is behind en\.md by 1 commit/m);
  assert.match(result.stdout, unknownKey);
  assert.equal(result.status, before.status);
  assert.ok(JSON.parse(sandbox.run(['doctor', '--json']).stdout).notes.some((f: { id: string }) => f.id === 'translation-behind'));
});

// git skips a hook without the execute bit, so the check in it never runs (#239).
test('doctor: a hook in the project\'s folder that is not executable is not checked, and init makes it executable (#239)', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'core.hooksPath', 'tools/hooks');
  assert.equal(sandbox.run(['init']).status, 0);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  const mergeHook = join(sandbox.repo, 'tools/hooks/pre-merge-commit');
  chmodSync(mergeHook, 0o644);
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done', 'the check is in the file, but git does not run it');
  let doctor = sandbox.run(['doctor']).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): merge commits are not checked: tools\/hooks\/pre-merge-commit is not executable, so git skips it/);
  assert.match(doctor, /run `chmod \+x tools\/hooks\/pre-merge-commit`, or `yokoten init`/);
  const result = sandbox.run(['init']);
  assert.match(result.stdout, /made executable tools\/hooks\/pre-merge-commit/);
  assert.ok(statSync(mergeHook).mode & 0o100, 'executable');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  // A pre-commit without the check and without the execute bit: add the line, and chmod.
  const preCommit = join(sandbox.repo, 'tools/hooks/pre-commit');
  writeFileSync(preCommit, '#!/bin/sh\necho own\n');
  chmodSync(preCommit, 0o644);
  doctor = sandbox.run(['doctor']).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): commits are not checked: tools\/hooks\/pre-commit does not run yokoten; `yokoten init` adds the check to tools\/hooks\/pre-commit,/);
  assert.match(doctor, /or do it yourself: add the line below to tools\/hooks\/pre-commit, after its `#!` line; run `chmod \+x tools\/hooks\/pre-commit`\. The line: /);
});

test('doctor: a workflow of the project\'s own that init keeps gets the step to add, not "init adds it" (#256)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/workflows/pr.yml', 'name: pr\non: pull_request\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lint\n');
  sandbox.write('.github/workflows/yokoten.yml', 'name: yokoten\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo build\n');
  assert.equal(sandbox.run(['init']).status, 0);
  const doctor = sandbox.run(['doctor']).stdout;
  assert.ok(doctor.includes('titles (Conventional Commits 1.0.0): CI does not check pull requests (`yokoten check --pr`); add this step to .github/workflows/pr.yml, after actions/checkout with `fetch-depth: 0` and actions/setup-node, in a job that runs on pull_request (`yokoten init` keeps your file as it is): `- run: node .yokoten/bin/yokoten.ts check --pr`\n'), doctor);
  assert.ok(doctor.includes('ci (Scorecard: CI-Tests): CI does not run `yokoten check`; add this step to .github/workflows/yokoten.yml, after actions/checkout and actions/setup-node (`yokoten init` keeps your file as it is): `- run: node .yokoten/bin/yokoten.ts check`\n'), doctor);
  assert.doesNotMatch(doctor, /`yokoten init` adds \.github\/workflows/);
});

// The road (record 0004). A session hears three lines about one step; the marks file is
// set so that the private-marks note does not add a fourth.
test('doctor --session: exactly three lines, about the first step of the first stage not done', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const r = sandbox.run(['doctor', '--session'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  assert.equal(r.status, 0, 'a session always starts');
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'yokoten: stage 1 of 5, safety net. Next: no AGENTS.md, so the agents have no written rules here; `yokoten init` adds one.',
    'Why: an agent follows the rules it can read, and only those.',
    'Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).',
  ]);
  // Outside a repo it says nothing (unless yokoten itself is broken).
  assert.equal(sandbox.run(['doctor', '--session'], { cwd: sandbox.home }).stdout, '');
});

test('doctor --session: "not now" skips a step, by the names yokoten.json already uses', () => {
  const sandbox = makeSandbox();
  const next = () => sandbox.run(['doctor', '--session']).stdout.split('\n')[0];
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'our rules live in the wiki for now' } }));
  assert.match(next(), /stage 1 of 5, safety net\. Next: no tool-call guard/);
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e' } }));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run/, 'a stage with every step not now is passed');
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e', ci: 'no remote yet', issues: 'f' } }));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: no issue templates and no pull request template/);
  const full = sandbox.run(['doctor']).stdout;
  assert.match(full, /^ +not now +ci \(Scorecard: CI-Tests\): no remote yet$/m, 'the full map shows the reason');
  assert.match(full, /^ +next +templates \(GitHub community profile\): /m);
  assert.match(full, /^ +to do +changelog \(Best Practices: release_notes\): /m);
  assert.match(full, /^ +to do +titles \(Conventional Commits 1\.0\.0\): CI does not check pull requests/m);
});

test('doctor: each stage boundary, from a fresh repo to the end of the road', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const key = join(sandbox.home, 'bot.pem');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks };
  const session = (more: Record<string, string> = {}) => sandbox.run(['doctor', '--session'], { extra: { ...extra, ...more } }).stdout.trimEnd().split('\n');
  const next = (more?: Record<string, string>) => session(more)[0];
  assert.match(next(), /stage 1 of 5, safety net\. Next: no AGENTS\.md/);
  // Stage 1 done, stage 2 not: init without its CI workflow.
  assert.equal(sandbox.run(['init']).status, 0);
  sandbox.withTests();
  rmSync(join(sandbox.repo, '.github', 'workflows', 'yokoten.yml'));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run `yokoten check`/, 'the pull request check alone is not the CI check');
  sandbox.write('TODO.md', '- one\n');
  sandbox.run(['init']);
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: a todo file \(TODO\.md\)/);
  rmSync(join(sandbox.repo, 'TODO.md'));
  // Stage 2 done. init wrote a changelog and changes/; without both, stage 3 is next.
  rmSync(join(sandbox.repo, 'CHANGELOG.md'));
  assert.match(next(), /stage 4 of 5/, 'changes/ alone passes the changelog step (#132)');
  rmSync(join(sandbox.repo, 'changes'), { recursive: true });
  assert.match(next(), /stage 3 of 5, release\. Next: no CHANGELOG\.md with an "Unreleased" section, and no changes\/ folder/);
  sandbox.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n');
  // Stage 3 done.
  assert.match(next(), /stage 4 of 5, a team of agents\. Next: \.github\/CODEOWNERS names no owner yet \(@YOUR_GITHUB_HANDLE\); put your GitHub handle in \.github\/CODEOWNERS/);
  // init wrote CODEOWNERS with the placeholder owner; a real owner finishes the step.
  sandbox.write('.github/CODEOWNERS', '* @octo\n');
  assert.match(next(), /stage 4 of 5, a team of agents\. Next: no bot on this machine/);
  writeFileSync(key, 'not a real key\n');
  const bot = { YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key };
  assert.match(next(bot), /stage 4 of 5, a team of agents\. Next: the yokoten skills are not in/);
  assert.equal(sandbox.run(['install']).status, 0);
  // Stage 4 done. init writes a security policy and Dependabot; the license is the owner's choice.
  assert.match(next(bot), /stage 5 of 5, going public\. Next: no license file; /);
  sandbox.write('LICENSE', 'placeholder license\n');
  assert.deepEqual(session(bot), ['yokoten: every step yokoten can check is done, or marked not now.']);
  // The order is advice, not a gate: a later step done early counts as done.
  rmSync(join(sandbox.repo, 'AGENTS.md'));
  assert.match(next(bot), /stage 1 of 5, safety net\. Next: no AGENTS\.md/);
  assert.match(sandbox.run(['doctor'], { extra: { ...extra, ...bot } }).stdout, /^ +done +security-files \(Scorecard: Security-Policy · OSPS-VM-02\.01\)$/m, 'full doctor names the outside standard (#58)');
});

test('doctor: the tests step wants a test command and a CI step that runs it (#55)', () => {
  const sandbox = makeSandbox();
  const line = () => sandbox.run(['doctor']).stdout.split('\n').find((l) => / tests\b/.test(l)) ?? '';
  // No package.json: the message does not name it (#257).
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no workflow runs a test command/);
  // npm's placeholder script only fails: it is no test command.
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): CI does not run the tests/);
  sandbox.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npm run test\n');
  assert.match(line(), /^ +done +tests/);
  // A project with no package.json: CI that runs a test runner is enough.
  rmSync(join(sandbox.repo, 'package.json'));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no workflow runs a test command such as `go test`, `pytest` or `cargo test`/);
  sandbox.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: go test ./...\n');
  assert.match(line(), /^ +done +tests/);
});

// #208: steps left on the road are to do, not problems. Exit 1 is for a problem.
test('doctor: exits 0 on a set-up project with steps to do, and 1 on a problem (#208)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['install']).status, 0);
  writeFileSync(join(sandbox.home, '.config/yokoten/private-marks'), 'mycity\n');
  sandbox.withTests();
  assert.equal(sandbox.run(['init']).status, 0);
  let result = sandbox.run(['doctor']);
  assert.match(result.stdout, /\n +next +codeowners[^]*\n +to do +bot/, 'later steps are left');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(sandbox.run(['doctor', '--json']).stdout).ok, true);
  // A problem: a private mark in the tree.
  sandbox.write('notes.md', 'I live in MyCity\n');
  sandbox.git('add', 'notes.md');
  result = sandbox.run(['doctor']);
  assert.match(result.stdout, /MISSING tree: 1 problem/);
  assert.equal(result.status, 1);
  assert.equal(sandbox.run(['doctor', '--session']).status, 0, 'a session always starts');
});

test('doctor: the plugin, when on, stands in for install', () => {
  const sandbox = makeSandbox();
  const machine = () => sandbox.run(['doctor']).stdout;
  assert.match(machine(), /MISSING session-doctor: sessions do not start with doctor; run `yokoten install`, or install the Claude Code plugin/);
  assert.match(machine(), /MISSING runtime: no runtime installed/);
  mkdirSync(join(sandbox.home, '.claude'));
  const settings = (enabledPlugins: unknown) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }));
  settings({ 'yokoten@yokoten': false });
  assert.match(machine(), /MISSING session-doctor/, 'off is off');
  settings({ 'yokoten@yokoten': true });
  const out = machine();
  assert.match(out, /ok {6}session-doctor/);
  assert.match(out, /ok {6}runtime/);
  assert.match(out, /^ +(done|to do|next) +skills$/m);
  assert.doesNotMatch(out, /skills: the yokoten skills are not in/);
  assert.doesNotMatch(out, /plugin-and-install/, 'no install pieces, no note');
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), 'not json');
  assert.match(machine(), /MISSING session-doctor/, 'a broken settings file enables nothing');
});

test('doctor: the plugin and install both on is a note that says to uninstall (#300)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['install']).status, 0);
  const file = join(sandbox.home, '.claude', 'settings.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), enabledPlugins: { 'yokoten@yokoten': true } }));
  const out = sandbox.run(['doctor']).stdout;
  assert.match(out, /^ {2}note {4}plugin-and-install: the yokoten plugin is on, and `yokoten install` put these here too: the SessionStart doctor and the command guard in ~\/\.claude\/settings\.json; the skills in ~\/\.claude\/skills and ~\/\.agents\/skills; the agents in ~\/\.claude\/agents; ~\/\.local\/share\/yokoten; remove them with `yokoten uninstall`/m);
  assert.match(sandbox.run(['doctor', '--session']).stdout, /^yokoten: the yokoten plugin is on, and `yokoten install` put these here too: .*Remove them with `yokoten uninstall`/m);
  // An older runtime from install, with the plugin on: remove it, never install again.
  writeFileSync(join(sandbox.home, '.local/share/yokoten/VERSION'), '0.0.1\n');
  assert.match(sandbox.run(['doctor']).stdout, /MISSING runtime: the installed runtime is 0\.0\.1, this yokoten is \S+; remove it with `yokoten uninstall`; the plugin brings its own/);
  // After uninstall the note is gone, and the plugin stands in for everything.
  assert.equal(sandbox.run(['uninstall']).status, 0);
  const after = sandbox.run(['doctor']).stdout;
  assert.doesNotMatch(after, /plugin-and-install/);
  assert.match(after, /ok {6}runtime/);
  assert.match(after, /ok {6}session-doctor/);
});

// #211: Codex's and Gemini CLI's user hooks, only once the CLI's folder exists; a note
// that never changes the exit code, and ok after `install`.
test('doctor: notes the Codex and Gemini CLI user hooks when that CLI is used (#211)', () => {
  for (const [agent, dir, file] of [['codex', '.codex', 'hooks.json'], ['gemini', '.gemini', 'settings.json']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const before = sandbox.run(['doctor']);
    assert.doesNotMatch(before.stdout, new RegExp(name), `${agent}: no ~/${dir}, no line`);
    mkdirSync(join(sandbox.home, dir));
    const noted = sandbox.run(['doctor']);
    assert.match(noted.stdout, new RegExp(`^  note {4}${name}: no session-start doctor and no command guard in ~/${dir}/${file}; \`yokoten install\` adds them$`, 'm'));
    assert.equal(noted.status, before.status, `${agent}: a note never changes the exit code`);
    const json = JSON.parse(sandbox.run(['doctor', '--json']).stdout);
    assert.ok(json.notes.some((n: { id: string }) => n.id === name), `${agent}: a note in --json, under its own id`);
    assert.ok(!json.notes.some((n: { id: string; what: string }) => n.id === `${agent}-hook` && n.what.includes(`~/${dir}`)), `${agent}: not under the project rule's id`);
    assert.ok(!json.findings.some((n: { id: string }) => n.id === name), `${agent}: not a finding`);
    // The folder exists by now, so install writes the hooks.
    assert.equal(sandbox.run(['install']).status, 0);
    assert.match(sandbox.run(['doctor']).stdout, new RegExp(`ok {6}${name}\\n`));
    const explain = sandbox.run(['explain', `${agent}-hook`]).stdout;
    assert.match(explain, /tool-call guard and stop check/);
    assert.match(explain, agent === 'codex' ? /a Stop hook/ : /an AfterAgent hook/);
    assert.doesNotMatch(explain, new RegExp(`~/${dir}`), `${agent}-hook is about the project only`);
    const explainUser = sandbox.run(['explain', name]).stdout;
    assert.match(explainUser, /session-start doctor and command guard/);
    assert.match(explainUser, new RegExp(`~/${dir}/${file}`));
  }
});

// #211 review: doctor compares each user hook with what install writes, so one missing,
// an old one, or a file it can't read each says so; a ~/.codex that is a file is no folder.
test('doctor: a missing, out-of-date or unreadable Codex or Gemini CLI user hook (#211)', () => {
  for (const [agent, dir, file, guardEvent] of [['codex', '.codex', 'hooks.json', 'PreToolUse'], ['gemini', '.gemini', 'settings.json', 'BeforeTool']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const path = join(sandbox.home, dir, file);
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = (text: string) => new RegExp(`^  note {4}${name}: ${escape(text)}$`, 'm');
    mkdirSync(join(sandbox.home, dir));
    assert.equal(sandbox.run(['install']).status, 0);
    const written = readFileSync(path, 'utf8');
    type Hooks = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const edit = (change: (s: Hooks) => void) => {
      const settings: Hooks = JSON.parse(written);
      change(settings);
      writeFileSync(path, JSON.stringify(settings));
    };
    // Only the guard missing: its exact line, and "it".
    edit((s) => delete s.hooks[guardEvent]);
    assert.match(sandbox.run(['doctor']).stdout, line(`no command guard in ~/${dir}/${file}; \`yokoten install\` adds it`));
    // The doctor hook from an older runtime path: out of date, not ok.
    edit((s) => {
      const hook = s.hooks.SessionStart[0].hooks[0];
      hook.command = hook.command.replace('.local/share/yokoten', '.yokoten');
    });
    assert.match(sandbox.run(['doctor']).stdout, line(`the session-start doctor in ~/${dir}/${file} is out of date; \`yokoten install\` updates it`));
    // The guard on another matcher: out of date too.
    edit((s) => {
      s.hooks[guardEvent][0].matcher = 'other';
    });
    assert.match(sandbox.run(['doctor']).stdout, line(`the command guard in ~/${dir}/${file} is out of date; \`yokoten install\` updates it`));
    assert.match(sandbox.run(['install']).stdout, /^updated the .* command guard in /m);
    assert.match(sandbox.run(['doctor']).stdout, new RegExp(`^  ok {6}${name}$`, 'm'));
    // A file that won't parse: can't read it, never "missing".
    writeFileSync(path, '{ not json');
    const unread = sandbox.run(['doctor']);
    assert.match(unread.stdout, line(`can't read ~/${dir}/${file}; make it valid JSON, then run \`yokoten install\``));
    assert.doesNotMatch(unread.stdout, new RegExp(`${name}: no `));
    // A ~/.codex that is a file: not a folder, so doctor says nothing and install skips it.
    rmSync(join(sandbox.home, dir), { recursive: true });
    writeFileSync(join(sandbox.home, dir), 'a file');
    assert.doesNotMatch(sandbox.run(['doctor']).stdout, new RegExp(name));
    const install = sandbox.run(['install']);
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, new RegExp(`^skipped .*: ~/\\${dir} not found`, 'm'));
    assert.equal(readFileSync(join(sandbox.home, dir), 'utf8'), 'a file');
  }
});

// #198: a plugin older than this yokoten is a note, in full doctor and in a session. A fake
// install in the fake HOME, laid out as Claude Code keeps it; the real one is never read.
test('doctor: notes an installed plugin older than this yokoten (#198)', () => {
  const sandbox = makeSandbox();
  const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const plugins = join(sandbox.home, '.claude', 'plugins');
  const folder = join(plugins, 'cache', 'yokoten', 'yokoten', 'abc123');
  mkdirSync(folder, { recursive: true });
  const enable = (on: boolean) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': on } }));
  const install = (entry: object) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'yokoten@yokoten': [{ scope: 'user', installPath: folder, version: 'abc123', ...entry }] } }));
  const pluginVersion = (v: string) => writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'yokoten', version: v }));
  const full = () => sandbox.run(['doctor']).stdout;
  const olderNote = /the yokoten plugin is older than this yokoten/;

  // Positive control: an old plugin is noted, with the one command, and doctor does not fail on it.
  enable(true);
  install({ gitCommitSha: 'abc123' });
  pluginVersion('0.0.1');
  const lines = full().split('\n');
  const line = `  note    plugin: the yokoten plugin is older than this yokoten (0.0.1 < ${version}); update it: \`claude plugin update yokoten@yokoten\`, then restart Claude Code`;
  assert.ok(lines.includes(line), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('MISSING plugin')));
  assert.match(sandbox.run(['doctor', '--session']).stdout, olderNote);
  const json = JSON.parse(sandbox.run(['doctor', '--json']).stdout);
  const jsonNote = json.notes.find((n: { what: string }) => olderNote.test(n.what));
  assert.ok(jsonNote, 'a note in JSON');
  assert.equal(jsonNote.id, 'plugin-version', 'its own rule, so `yokoten explain` tells the right thing');
  assert.match(jsonNote.docs, /#the-claude-code-plugin$/);
  assert.match(sandbox.run(['explain', jsonNote.id]).stdout, /plugin is not older than the yokoten/);
  assert.ok(!json.findings.some((f: { what: string }) => olderNote.test(f.what)), 'not a finding');

  // The same version, or a newer one: nothing.
  pluginVersion(version);
  assert.doesNotMatch(full(), olderNote);
  pluginVersion('9999.0.0');
  assert.doesNotMatch(full(), olderNote);
  // Off in the settings: the plugin does not run, so its age does not matter.
  pluginVersion('0.0.1');
  enable(false);
  assert.doesNotMatch(full(), olderNote);
  enable(true);
  // A project install for another project is not this one's.
  install({ scope: 'project', projectPath: join(sandbox.home, 'elsewhere') });
  assert.doesNotMatch(full(), olderNote);
  // No install file, or an odd one: no note, no crash.
  for (const text of [null, 'not json', '{"plugins": []}', '{"plugins": {"yokoten@yokoten": "odd"}}', '{"plugins": {"yokoten@yokoten": [null, 7]}}']) {
    rmSync(join(plugins, 'installed_plugins.json'), { force: true });
    if (text !== null) writeFileSync(join(plugins, 'installed_plugins.json'), text);
    const result = sandbox.run(['doctor']);
    assert.ok(result.stdout.includes('machine:'), `${text}: doctor ran to the end`);
    assert.doesNotMatch(result.stdout, olderNote, String(text));
    assert.doesNotMatch(result.stderr, /Error/, String(text));
  }
  install({ gitCommitSha: 'abc123' });
  rmSync(join(folder, 'package.json'));
  assert.doesNotMatch(full(), olderNote, 'outside a yokoten checkout, a commit alone tells nothing');
});

test('doctor: in a yokoten checkout, a plugin commit behind the default branch is a note (#198)', () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', JSON.stringify({ name: 'yokoten', version: '0.0.1' }));
  sandbox.write('bin/yokoten.ts', '');
  sandbox.git('add', '.');
  sandbox.git('commit', '-q', '-m', 'feat: one');
  const first = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const plugins = join(sandbox.home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  // No installPath and no package.json: only the commit can tell.
  const install = (sha: string) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'yokoten@yokoten': [{ scope: 'user', version: sha.slice(0, 12), gitCommitSha: sha }] } }));
  const olderNote = /the yokoten plugin is older than this yokoten \(([0-9a-f]{12}) < ([0-9a-f]{12})\)/;
  const commit = (name: string) => {
    sandbox.write(`${name}.md`, `${name}\n`);
    sandbox.git('add', '.');
    sandbox.git('commit', '-q', '-m', `feat: ${name}`);
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  install(first);
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, olderNote, 'the plugin is main');
  // The plugin is main's tip and doctor runs on a feature branch ahead of main: up to date,
  // though HEAD descends from it. An update could not help, so nothing.
  sandbox.git('checkout', '-q', '-b', 'feature');
  commit('two');
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, olderNote, 'the plugin is main, HEAD is ahead');
  assert.doesNotMatch(sandbox.run(['doctor', '--session']).stdout, olderNote);
  // Positive control: main moves on, so the plugin is one commit behind it, on any branch.
  sandbox.git('checkout', '-q', 'main');
  const tip = commit('three');
  sandbox.git('checkout', '-q', 'feature');
  const match = sandbox.run(['doctor']).stdout.match(olderNote);
  assert.deepEqual(match?.slice(1), [first.slice(0, 12), tip.slice(0, 12)]);
  assert.match(sandbox.run(['doctor', '--session']).stdout, olderNote);
  // A commit this repo doesn't know: can't tell, so nothing.
  install('0'.repeat(40));
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, olderNote);
  // No origin/HEAD, origin/main or main: no default branch to compare with, so nothing.
  install(first);
  sandbox.git('branch', '-q', '-m', 'main', 'trunk');
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, olderNote, 'no main ref');
});

test('self-test: the core-rules control passes the real check and fails a broken one (#170)', () => {
  assert.deepEqual(coreRulesControl(), []);
  assert.ok(!selfTest().some((name) => name.startsWith('core rules')));
  const always = (mark: 'ok' | 'MISSING' | 'note') => (root: string) => ({ mark, finding: { ...coreRulesCheck(root)!.finding } });
  assert.deepEqual(coreRulesControl(always('ok')), ['core rules check (edited by hand)', 'core rules check (newer kit)'], 'a check that passes everything');
  assert.deepEqual(coreRulesControl(always('MISSING')), ['core rules check (newer kit)'], 'a check that calls a newer kit MISSING');
  assert.deepEqual(coreRulesControl(always('note')), ['core rules check (edited by hand)'], 'a check that only gives notes');
  // A compare that never sees a version: the newer kit looks hand-edited, so MISSING.
  const noVersion = (root: string) => {
    const result = coreRulesCheck(root)!;
    return result.mark === 'note' ? { mark: 'MISSING' as const, finding: result.finding } : result;
  };
  assert.deepEqual(coreRulesControl(noVersion), ['core rules check (newer kit)']);
});

test('privacyNotes: the mailmap, and the kinds of mark yokoten cannot find; never a value (#390)', () => {
  const home = mkdtempSync(join(tmpdir(), 'yokoten-privacy-'));
  const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const notes = () => privacyNotes(env, null).map((note) => `${note.name}: ${note.finding.what}; ${note.finding.fix}`);
  assert.deepEqual(notes(), [
    'mailmap: git log and git show print your name and email as they are; run `yokoten install`; it sets a git mailmap outside every repo',
    `private-mark-kinds: your private marks may lack your real name, your city, your domains; add them to ${join(home, '.config', 'yokoten', 'private-marks')}, one per line`,
  ]);
  execFileSync('git', ['config', '--global', 'mailmap.file', '~/.config/yokoten/mailmap'], { env: { ...process.env, ...env } });
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
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

// #392: lessons from other projects wait in ~/.config/yokoten/upstream. Only yokoten's own
// repo, found by its package name, hears about them; another repo hears nothing.
test('doctor: in the yokoten repo, the session and doctor count the notes from other projects; elsewhere nothing', () => {
  const sandbox = makeSandbox();
  const inbox = join(sandbox.home, '.config', 'yokoten', 'upstream');
  mkdirSync(inbox, { recursive: true });
  for (const id of ['20261020-120000-aaaa', '20261020-130000-bbbb', '20261020-140000-cccc']) writeFileSync(join(inbox, `${id}.md`), 'when: 2026-10-20T12:00:00Z\npart: unknown\nwhat: x\n');
  const line = 'yokoten: 3 lessons from other projects wait to become issues: yokoten learn --upstream --list';
  // Another repo: not a word, though the notes are there.
  assert.ok(!sandbox.run(['doctor', '--session']).stdout.includes('lessons from other projects'));
  assert.equal(upstreamNote(sandbox.repo, { HOME: sandbox.home }), null);
  // A fake yokoten repo: the count, as the session's last line.
  sandbox.write('package.json', JSON.stringify({ name: 'yokoten' }));
  sandbox.write('bin/yokoten.ts', '');
  const session = sandbox.run(['doctor', '--session']);
  assert.equal(session.status, 0, session.stderr);
  assert.equal(session.stdout.trimEnd().split('\n').at(-1), line);
  const note = upstreamNote(sandbox.repo, { HOME: sandbox.home });
  assert.equal(note?.id, 'upstream-inbox');
  assert.equal(note?.what, line.replace(/^yokoten: /, ''));
  // An empty home: no inbox, no line.
  const empty = mkdtempSync(join(tmpdir(), 'yokoten-empty-'));
  assert.equal(upstreamNote(sandbox.repo, { HOME: empty }), null);
  assert.ok(!sandbox.run(['doctor', '--session'], { extra: { HOME: empty } }).stdout.includes('lessons from other projects'));
  rmSync(empty, { recursive: true, force: true });
});
