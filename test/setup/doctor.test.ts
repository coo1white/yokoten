// Tests for src/setup/doctor.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
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
  makeTempDir,
} from '../repo/helpers.ts';
import { DEFAULTS } from '../../src/rules/config.ts';
import { launcherDir, machineStateFile, setUpLauncher } from '../../src/setup/install.ts';
import {
  type BranchRules,
  type Gh,
  readPlanning,
  readServer,
  type ServerSettings,
  type Unread,
} from '../../src/host/github.ts';
import { unsavedNotes } from '../../src/setup/advice/unsaved.ts';
import {
  agentTempDirCheck,
  blocksToSay,
  coreRulesCheck,
  coreRulesControl,
  diskSpaceChecks,
  doctor,
  findDriveMount,
  isLowOnSpace,
  isShellControlCaught,
  isUnsavedControlCaught,
  isWsl,
  launcherCheck,
  leftoverControl,
  leftoverTempCheck,
  listBoardSteps,
  type MachineProbe,
  machineControl,
  parseLxss,
  privacyNotes,
  quoteForShell,
  REAL_MACHINE,
  readHostDisk,
  saveHostCache,
  selfTest,
  SESSION_UNSAVED_BUDGET,
  sessionsDir,
  sessionUnsaved,
  STOPPED_EARLY,
  UNSAVED_OFFER,
  noCiNote,
  upstreamNote,
} from '../../src/setup/doctor.ts';
import { LABELS } from '../../src/setup/plan.ts';
import {
  missingPaths,
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
    const f = stepFinding(ROAD.find((s) => s.key === key)!, '.', {}, { server });
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
  assert.match(text(), /^ {4}can't check [a-z, -]*protection[a-z, -]*: there is no origin remote yet, so doctor can't read the server; run `git remote add origin <url>`/m);
  assert.ok(!/can't check.*can't check/.test(text()), 'no line says "can\'t check" twice');
  assert.equal(result.report.steps?.find((s) => s.id === 'protection')?.mark, "can't check", 'the data still has each step');
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
  const session = doctor(root, { env: { HOME: root, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, session: true, gh: () => { throw new Error('a session called gh'); } });
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
  // Outside a repo it says nothing (unless yokoten itself is broken).
  assert.equal((await sandbox.call(['doctor', '--session'], { cwd: sandbox.home })).stdout, '');
});

test('doctor --session: "not now" skips a step, by the names yokoten.json already uses', async () => {
  const sandbox = makeSandbox();
  const next = async () => (await sandbox.call(['doctor', '--session'])).stdout.split('\n')[0];
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'our rules live in the wiki for now' } }));
  assert.match(await next(), /stage 1 of 5, safety net\. Next: no tool-call guard/);
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e' } }));
  assert.match(await next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run/, 'a stage with every step not now is passed');
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e', ci: 'no remote yet', issues: 'f' } }));
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
  assert.match(result.stdout, /\n +next +codeowners[^]*\n +to do +bot/, 'later steps are left');
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

test('doctor: the plugin, when on, stands in for install', async () => {
  const sandbox = makeSandbox();
  const machine = async () => (await sandbox.call(['doctor'])).stdout;
  assert.match(await machine(), /MISSING session-doctor: sessions do not start with doctor; run `yokoten install`, or install the Claude Code plugin/);
  assert.match(await machine(), /MISSING runtime: no runtime installed/);
  mkdirSync(join(sandbox.home, '.claude'));
  const settings = (enabledPlugins: unknown) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }));
  settings({ 'yokoten@yokoten': false });
  assert.match(await machine(), /MISSING session-doctor/, 'off is off');
  settings({ 'yokoten@yokoten': true });
  const out = await machine();
  assert.match(out, /ok {6}session-doctor/);
  assert.match(out, /ok {6}runtime/);
  assert.match(out, /^ +(done|to do|next) +skills$/m);
  assert.doesNotMatch(out, /skills: the yokoten skills are not in/);
  assert.doesNotMatch(out, /plugin-and-install/, 'no install pieces, no note');
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), 'not json');
  assert.match(await machine(), /MISSING session-doctor/, 'a broken settings file enables nothing');
});

test('doctor: the plugin and install both on is a note that says to uninstall (#300)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install'])).status, 0);
  const file = join(sandbox.home, '.claude', 'settings.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), enabledPlugins: { 'yokoten@yokoten': true } }));
  const out = (await sandbox.call(['doctor'])).stdout;
  assert.match(out, /^ {2}note {4}plugin-and-install: the yokoten plugin is on, and `yokoten install` put these here too: the SessionStart doctor and the command guard in ~\/\.claude\/settings\.json; the skills in ~\/\.claude\/skills and ~\/\.agents\/skills; the agents in ~\/\.claude\/agents; ~\/\.local\/share\/yokoten; remove them with `yokoten uninstall`/m);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /^yokoten: the yokoten plugin is on, and `yokoten install` put these here too: .*Remove them with `yokoten uninstall`/m);
  // An older runtime from install, with the plugin on: remove it, never install again.
  writeFileSync(join(sandbox.home, '.local/share/yokoten/VERSION'), '0.0.1\n');
  assert.match((await sandbox.call(['doctor'])).stdout, /MISSING runtime: the installed runtime is 0\.0\.1, this yokoten is \S+; remove it with `yokoten uninstall`; the plugin brings its own/);
  // After uninstall the note is gone, and the plugin stands in for everything.
  assert.equal((await sandbox.call(['uninstall'])).status, 0);
  const after = (await sandbox.call(['doctor'])).stdout;
  assert.doesNotMatch(after, /plugin-and-install/);
  assert.match(after, /ok {6}runtime/);
  assert.match(after, /ok {6}session-doctor/);
});

// #211: Codex's and Gemini CLI's user hooks, only once the CLI's folder exists; a note
// that never changes the exit code, and ok after `install`.
test('doctor: notes the Codex and Gemini CLI user hooks when that CLI is used (#211)', async () => {
  for (const [agent, dir, file] of [['codex', '.codex', 'hooks.json'], ['gemini', '.gemini', 'settings.json']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const before = await sandbox.call(['doctor']);
    assert.doesNotMatch(before.stdout, new RegExp(name), `${agent}: no ~/${dir}, no line`);
    mkdirSync(join(sandbox.home, dir));
    const noted = await sandbox.call(['doctor']);
    assert.match(noted.stdout, new RegExp(`^  note {4}${name}: no session-start doctor and no command guard in ~/${dir}/${file}; \`yokoten install\` adds them$`, 'm'));
    assert.equal(noted.status, before.status, `${agent}: a note never changes the exit code`);
    const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout);
    assert.ok(json.notes.some((n: { id: string }) => n.id === name), `${agent}: a note in --json, under its own id`);
    assert.ok(!json.notes.some((n: { id: string; what: string }) => n.id === `${agent}-hook` && n.what.includes(`~/${dir}`)), `${agent}: not under the project rule's id`);
    assert.ok(!json.findings.some((n: { id: string }) => n.id === name), `${agent}: not a finding`);
    // The folder exists by now, so install writes the hooks.
    assert.equal((await sandbox.call(['install'])).status, 0);
    assert.match((await sandbox.call(['doctor'])).stdout, new RegExp(`ok {6}${name}\\n`));
    const explain = (await sandbox.call(['explain', `${agent}-hook`])).stdout;
    assert.match(explain, /tool-call guard and stop check/);
    assert.match(explain, agent === 'codex' ? /a Stop hook/ : /an AfterAgent hook/);
    assert.doesNotMatch(explain, new RegExp(`~/${dir}`), `${agent}-hook is about the project only`);
    const explainUser = (await sandbox.call(['explain', name])).stdout;
    assert.match(explainUser, /session-start doctor and command guard/);
    assert.match(explainUser, new RegExp(`~/${dir}/${file}`));
  }
});

// #211 review: doctor compares each user hook with what install writes, so one missing,
// an old one, or a file it can't read each says so; a ~/.codex that is a file is no folder.
test('doctor: a missing, out-of-date or unreadable Codex or Gemini CLI user hook (#211)', async () => {
  for (const [agent, dir, file, guardEvent] of [['codex', '.codex', 'hooks.json', 'PreToolUse'], ['gemini', '.gemini', 'settings.json', 'BeforeTool']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const path = join(sandbox.home, dir, file);
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = (text: string) => new RegExp(`^  note {4}${name}: ${escape(text)}$`, 'm');
    mkdirSync(join(sandbox.home, dir));
    assert.equal((await sandbox.call(['install'])).status, 0);
    const written = readFileSync(path, 'utf8');
    type Hooks = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const edit = (change: (s: Hooks) => void) => {
      const settings: Hooks = JSON.parse(written);
      change(settings);
      writeFileSync(path, JSON.stringify(settings));
    };
    // Only the guard missing: its exact line, and "it".
    edit((s) => delete s.hooks[guardEvent]);
    assert.match((await sandbox.call(['doctor'])).stdout, line(`no command guard in ~/${dir}/${file}; \`npx yokoten install\` adds it`));
    // The doctor hook from an older runtime path: out of date, not ok.
    edit((s) => {
      const hook = s.hooks.SessionStart[0].hooks[0];
      hook.command = hook.command.replace('.local/share/yokoten', '.yokoten');
    });
    assert.match((await sandbox.call(['doctor'])).stdout, line(`the session-start doctor in ~/${dir}/${file} is out of date; \`npx yokoten install\` updates it`));
    // The guard on another matcher: out of date too.
    edit((s) => {
      s.hooks[guardEvent][0].matcher = 'other';
    });
    assert.match((await sandbox.call(['doctor'])).stdout, line(`the command guard in ~/${dir}/${file} is out of date; \`npx yokoten install\` updates it`));
    assert.match((await sandbox.call(['install'])).stdout, /^updated the .* command guard in /m);
    assert.match((await sandbox.call(['doctor'])).stdout, new RegExp(`^  ok {6}${name}$`, 'm'));
    // A file that won't parse: can't read it, never "missing".
    writeFileSync(path, '{ not json');
    const unread = await sandbox.call(['doctor']);
    assert.match(unread.stdout, line(`can't read ~/${dir}/${file}; make it valid JSON, then run \`npx yokoten install\``));
    assert.doesNotMatch(unread.stdout, new RegExp(`${name}: no `));
    // A ~/.codex that is a file: not a folder, so doctor says nothing and install skips it.
    rmSync(join(sandbox.home, dir), { recursive: true });
    writeFileSync(join(sandbox.home, dir), 'a file');
    assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, new RegExp(name));
    const install = await sandbox.call(['install']);
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, new RegExp(`^skipped .*: ~/\\${dir} not found`, 'm'));
    assert.equal(readFileSync(join(sandbox.home, dir), 'utf8'), 'a file');
  }
});

// #198: a plugin older than this yokoten is a note, in full doctor and in a session. A fake
// install in the fake HOME, laid out as Claude Code keeps it; the real one is never read.
test('doctor: notes an installed plugin older than this yokoten (#198)', async () => {
  const sandbox = makeSandbox();
  const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const plugins = join(sandbox.home, '.claude', 'plugins');
  const folder = join(plugins, 'cache', 'yokoten', 'yokoten', 'abc123');
  mkdirSync(folder, { recursive: true });
  const enable = (on: boolean) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': on } }));
  const install = (entry: object) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'yokoten@yokoten': [{ scope: 'user', installPath: folder, version: 'abc123', ...entry }] } }));
  const pluginVersion = (v: string) => writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'yokoten', version: v }));
  const full = async () => (await sandbox.call(['doctor'])).stdout;
  const olderNote = /the yokoten plugin is older than this yokoten/;

  // Positive control: an old plugin is noted, with the one command, and doctor does not fail on it.
  enable(true);
  install({ gitCommitSha: 'abc123' });
  pluginVersion('0.0.1');
  const lines = (await full()).split('\n');
  const line = `  note    plugin: the yokoten plugin is older than this yokoten (0.0.1 < ${version}); update it: \`claude plugin update yokoten@yokoten\`, then restart Claude Code`;
  assert.ok(lines.includes(line), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('MISSING plugin')));
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, olderNote);
  const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout);
  const jsonNote = json.notes.find((n: { what: string }) => olderNote.test(n.what));
  assert.ok(jsonNote, 'a note in JSON');
  assert.equal(jsonNote.id, 'plugin-version', 'its own rule, so `yokoten explain` tells the right thing');
  assert.match(jsonNote.docs, /#the-claude-code-plugin$/);
  assert.match((await sandbox.call(['explain', jsonNote.id])).stdout, /plugin is not older than the yokoten/);
  assert.ok(!json.findings.some((f: { what: string }) => olderNote.test(f.what)), 'not a finding');

  // The same version, or a newer one: nothing.
  pluginVersion(version);
  assert.doesNotMatch(await full(), olderNote);
  pluginVersion('9999.0.0');
  assert.doesNotMatch(await full(), olderNote);
  // Off in the settings: the plugin does not run, so its age does not matter.
  pluginVersion('0.0.1');
  enable(false);
  assert.doesNotMatch(await full(), olderNote);
  enable(true);
  // A project install for another project is not this one's.
  install({ scope: 'project', projectPath: join(sandbox.home, 'elsewhere') });
  assert.doesNotMatch(await full(), olderNote);
  // No install file, or an odd one: no note, no crash.
  for (const text of [null, 'not json', '{"plugins": []}', '{"plugins": {"yokoten@yokoten": "odd"}}', '{"plugins": {"yokoten@yokoten": [null, 7]}}']) {
    rmSync(join(plugins, 'installed_plugins.json'), { force: true });
    if (text !== null) writeFileSync(join(plugins, 'installed_plugins.json'), text);
    const result = await sandbox.call(['doctor']);
    assert.ok(result.stdout.includes('machine:'), `${text}: doctor ran to the end`);
    assert.doesNotMatch(result.stdout, olderNote, String(text));
    assert.doesNotMatch(result.stderr, /Error/, String(text));
  }
  install({ gitCommitSha: 'abc123' });
  rmSync(join(folder, 'package.json'));
  assert.doesNotMatch(await full(), olderNote, 'outside a yokoten checkout, a commit alone tells nothing');
});

test('doctor: in a yokoten checkout, a plugin commit behind the default branch is a note (#198)', async () => {
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
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, olderNote, 'the plugin is main');
  // The plugin is main's tip and doctor runs on a feature branch ahead of main: up to date,
  // though HEAD descends from it. An update could not help, so nothing.
  sandbox.git('checkout', '-q', '-b', 'feature');
  commit('two');
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, olderNote, 'the plugin is main, HEAD is ahead');
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, olderNote);
  // Positive control: main moves on, so the plugin is one commit behind it, on any branch.
  sandbox.git('checkout', '-q', 'main');
  const tip = commit('three');
  sandbox.git('checkout', '-q', 'feature');
  const match = (await sandbox.call(['doctor'])).stdout.match(olderNote);
  assert.deepEqual(match?.slice(1), [first.slice(0, 12), tip.slice(0, 12)]);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, olderNote);
  // A commit this repo doesn't know: can't tell, so nothing.
  install('0'.repeat(40));
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, olderNote);
  // No origin/HEAD, origin/main or main: no default branch to compare with, so nothing.
  install(first);
  sandbox.git('branch', '-q', '-m', 'main', 'trunk');
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, olderNote, 'no main ref');
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

// Machine notes (record 0012): a fake machine, so no test reads the real disk or runs reg.exe.
const GB = 1024 ** 3;
const LXSS = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss',
  '    DefaultDistribution    REG_SZ    {0000}',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{0000}',
  '    State    REG_DWORD    0x1',
  '    DistributionName    REG_SZ    <distro>',
  '    Version    REG_DWORD    0x2',
  '    BasePath    REG_SZ    \\\\?\\D:\\WSL\\<distro>',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{1111}',
  '    DistributionName    REG_SZ    <other>',
  '    Version    REG_DWORD    0x1',
  '    BasePath    REG_SZ    C:\\WSL\\<other>',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{2222}',
  '    DistributionName    REG_SZ    <shared>',
  '    BasePath    REG_SZ    \\\\fileserver\\share\\<shared>',
  '',
].join('\r\n');
const MOUNTS = 'none / ext4 rw 0 0\nC:\\134 /mnt/c 9p rw 0 0\nD:\\134 /mnt/d 9p rw 0 0\n';
const NOW = new Date('2026-10-20T08:30:00Z');
const WSL = { WSL_DISTRO_NAME: '<distro>', HOME: '/home/<user>' };

/**
 * A machine with `free` bytes on every disk. Files live in `files`, /proc/mounts is MOUNTS,
 * and running a program throws unless `programs` answers it.
 */
function fakeMachine(free: number, more: Partial<MachineProbe> & { programs?: Record<string, string>; ran?: string[]; files?: Map<string, string> } = {}): MachineProbe {
  const { programs = {}, ran = [], files = new Map<string, string>(), ...rest } = more;
  return {
    readDiskSpace: () => ({ free, size: 250 * GB }),
    readOwner: () => null,
    runProgram: (file) => {
      ran.push(file);
      if (file in programs) return programs[file];
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
    readText: (path) => (path === '/proc/mounts' ? MOUNTS : (files.get(path) ?? null)),
    writeText: (path, text) => void files.set(path, text),
    uid: 1000,
    now: () => NOW,
    ...rest,
  };
}

/** The names of the checks, and whether each is ok. */
const marksOf = (checks: { name: string; ok: boolean }[]) => checks.map((c) => [c.name, c.ok]);

test('machine: a disk is low below 20 GB when that is also under 10%; YOKOTEN_MIN_FREE_GB is the one limit when set', () => {
  assert.ok(isLowOnSpace({ free: 0, size: 250 * GB }, {}), 'nothing free on a 250 GB drive');
  assert.ok(isLowOnSpace({ free: 10 * GB, size: 250 * GB }, {}));
  assert.ok(!isLowOnSpace({ free: 150 * GB, size: 2048 * GB }, {}), '150 GB on a 2 TB drive is room enough');
  assert.ok(!isLowOnSpace({ free: 15 * GB, size: 64 * GB }, {}), 'a small disk with a quarter free');
  assert.ok(isLowOnSpace({ free: 40 * GB, size: 2048 * GB }, { YOKOTEN_MIN_FREE_GB: '50' }));
  assert.ok(!isLowOnSpace({ free: 0, size: 250 * GB }, { YOKOTEN_MIN_FREE_GB: '0' }), '0 turns it off');
  assert.ok(isLowOnSpace({ free: 0, size: 250 * GB }, { YOKOTEN_MIN_FREE_GB: 'lots' }), 'a value that is not a number keeps the default');
});

test('machine: the registry and the mounts give the Windows drive of a distro', () => {
  assert.deepEqual(parseLxss(LXSS), [
    { name: '<distro>', basePath: '\\\\?\\D:\\WSL\\<distro>', version: 2 },
    { name: '<other>', basePath: 'C:\\WSL\\<other>', version: 1 },
    { name: '<shared>', basePath: '\\\\fileserver\\share\\<shared>', version: 2 },
  ]);
  assert.equal(findDriveMount('d', MOUNTS), '/mnt/d');
  assert.equal(findDriveMount('E', MOUNTS), null, 'never a guess: /mnt/e would be the Linux disk');
  assert.equal(findDriveMount('C', 'C:\\134 /mnt/my\\040drive 9p rw 0 0\n'), '/mnt/my drive');
});

test('machine: WSL is found by WSL_DISTRO_NAME or by the interop file alone', () => {
  assert.ok(isWsl({ WSL_DISTRO_NAME: '<distro>' }, fakeMachine(GB)));
  assert.ok(isWsl({}, fakeMachine(GB, { files: new Map([['/proc/sys/fs/binfmt_misc/WSLInterop', 'enabled\n']]) })));
  assert.ok(!isWsl({}, fakeMachine(GB)));
});

test('machine: reading the Windows drive in WSL, and each way it fails, never a crash', () => {
  const read = (machine: MachineProbe, env: Record<string, string> = WSL) => readHostDisk(env, machine);
  const asked: string[] = [];
  const space = (path: string) => {
    asked.push(path);
    return { free: GB, size: 250 * GB };
  };
  assert.deepEqual(read(fakeMachine(0, { programs: { 'reg.exe': LXSS }, readDiskSpace: space })), { space: { free: GB, size: 250 * GB }, distro: '<distro>', version: 2 });
  assert.deepEqual(asked, ['/mnt/d'], 'the drive that holds the disk file, not the Linux disk');
  // reg.exe not on the PATH: the copy on the system drive.
  const ran: string[] = [];
  assert.ok('space' in read(fakeMachine(0, { ran, programs: { '/mnt/c/Windows/System32/reg.exe': LXSS } })));
  assert.deepEqual(ran, ['reg.exe', '/mnt/c/Windows/System32/reg.exe']);
  const timedOut = fakeMachine(0, {
    runProgram: () => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    },
  });
  assert.deepEqual(read(timedOut), { unread: 'reg.exe failed or took too long' });
  assert.deepEqual(read(fakeMachine(0)), { unread: 'reg.exe is not on the PATH' });
  assert.deepEqual(read(fakeMachine(0), {}), { unread: 'WSL_DISTRO_NAME is not set' });
  const registry = { programs: { 'reg.exe': LXSS } };
  assert.deepEqual(read(fakeMachine(0, registry), { WSL_DISTRO_NAME: '<gone>' }), { unread: 'the registry does not list this distro' });
  assert.deepEqual(read(fakeMachine(0, registry), { WSL_DISTRO_NAME: '<shared>' }), { unread: 'its disk file is not on a drive letter' }, 'a UNC path');
  assert.deepEqual(read(fakeMachine(0, { ...registry, readText: () => 'none / ext4 rw 0 0\n' })), { unread: 'drive D: is not mounted in Linux' });
  const broken = () => {
    throw new Error('statfs failed');
  };
  assert.deepEqual(read(fakeMachine(0, { ...registry, readDiskSpace: broken })), { unread: "can't read drive D:" }, 'the mounted drive');
});

test('machine: full doctor keeps the Windows drive reading, and a session repeats it without running a program', () => {
  const files = new Map<string, string>();
  const full = diskSpaceChecks('/repo', WSL, fakeMachine(0, { files, programs: { 'reg.exe': LXSS } }), false);
  assert.deepEqual(marksOf(full), [['disk-space', false], ['host-disk', false]]);
  const host = full[1].finding;
  assert.equal(host.what, 'the Windows drive that holds this Linux disk has 0.0 GB free of 250 GB');
  assert.match(host.fix, /Back up your work to another drive first\. Then free space on the Windows drive, or shrink or move the disk file: https:\/\/learn\.microsoft\.com\/windows\/wsl\/disk-space$/);
  assert.doesNotMatch(host.fix, /sparse|allow-unsafe/, 'never the flag WSL marks unsafe');
  assert.deepEqual(JSON.parse(files.get(machineStateFile(WSL)) ?? '{}').hostDisk, { free: 0, size: 250 * GB, readAt: NOW.toISOString(), distro: '<distro>', version: 2 });
  // A session: no program runs, and the kept reading is repeated with its time.
  const ran: string[] = [];
  const session = (machine: MachineProbe) => diskSpaceChecks('/repo', WSL, machine, true);
  const later = session(fakeMachine(100 * GB, { ran, files, now: () => new Date('2026-10-26T08:30:00Z') }));
  assert.deepEqual(ran, []);
  assert.deepEqual(marksOf(later), [['disk-space', true], ['host-disk', false]]);
  assert.match(later[1].finding.what, /\(read 2026-10-20 08:30 UTC\) has 0\.0 GB free/);
  assert.match(later[1].finding.fix, /Then run `yokoten doctor` to read the drive again$/);
  // Older than 7 days, broken, from a time to come, or not there: nothing is repeated.
  assert.deepEqual(marksOf(session(fakeMachine(100 * GB, { files, now: () => new Date('2026-10-28T08:30:00Z') }))), [['disk-space', true]], 'a week old');
  const saved = (text: string) => new Map([[machineStateFile(WSL), text]]);
  const hostDisk = { free: 0, size: 250 * GB, distro: '<distro>', version: 2 };
  for (const text of ['{ broken', JSON.stringify({ hostDisk: { ...hostDisk, readAt: 'yesterday' } }), JSON.stringify({ hostDisk: { ...hostDisk, readAt: '2026-11-20T00:00:00Z' } })]) {
    assert.deepEqual(marksOf(session(fakeMachine(100 * GB, { files: saved(text) }))), [['disk-space', true]], text);
  }
  assert.deepEqual(marksOf(session(fakeMachine(100 * GB))), [['disk-space', true]], 'no reading yet');
  // A reg.exe that fails is "can't read", a note and never ok.
  const unread = diskSpaceChecks('/repo', WSL, fakeMachine(100 * GB), false);
  assert.deepEqual(marksOf(unread), [['disk-space', true], ['host-disk', false]]);
  assert.match(unread[1].finding.what, /^can't read the Windows drive that holds this Linux disk: reg\.exe is not on the PATH$/);
});

test('machine: no host-disk line outside WSL, on WSL 1, or without WSL_DISTRO_NAME', () => {
  const machine = fakeMachine(0, { programs: { 'reg.exe': LXSS }, files: new Map([['/proc/sys/fs/binfmt_misc/WSLInterop', 'enabled\n']]) });
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', { HOME: '/home/<user>' }, fakeMachine(0), false)), [['disk-space', false]], 'not WSL');
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', { HOME: '/home/<user>' }, machine, false)), [['disk-space', false]], 'WSL under sudo: no distro name, no nagging note');
  // WSL 1 has no disk file: the repo's disk is the Windows drive, so one note, not two.
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', { ...WSL, WSL_DISTRO_NAME: '<other>' }, machine, false)), [['disk-space', false]]);
  const files = new Map([[machineStateFile(WSL), JSON.stringify({ hostDisk: { free: 0, size: 250 * GB, readAt: NOW.toISOString(), distro: '<other>', version: 1 } })]]);
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', WSL, fakeMachine(100 * GB, { files }), true)), [['disk-space', true]], 'a kept WSL 1 reading');
});

test("machine: the repo's disk that can't be read is a note, never a crash", () => {
  const broken = fakeMachine(0, {
    readDiskSpace: () => {
      throw new Error('statfs failed');
    },
  });
  const checks = diskSpaceChecks('/repo', {}, broken, false);
  assert.deepEqual(marksOf(checks), [['disk-space', false]]);
  assert.match(checks[0].finding.what, /^can't read the free space of the disk that holds this repo$/);
});

test('machine: a home that is read-only keeps no reading, and doctor goes on', () => {
  const machine = fakeMachine(0, {
    programs: { 'reg.exe': LXSS },
    writeText: () => {
      throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    },
  });
  assert.doesNotThrow(() => saveHostCache(WSL, machine, { free: 0, size: 1, readAt: NOW.toISOString(), distro: '<distro>', version: 2 }));
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', WSL, machine, false)), [['disk-space', false], ['host-disk', false]]);
});

test('machine: the real machine writes its reading under the home it is given, and a read-only one is left', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'no read-only folder for root or on Windows' }, () => {
  const home = makeTempDir('yokoten-machine-');
  try {
    const env = { HOME: home };
    const cache = { free: 1, size: 2, readAt: NOW.toISOString(), distro: '<distro>', version: 2 };
    chmodSync(home, 0o500);
    saveHostCache(env, REAL_MACHINE, cache);
    assert.equal(REAL_MACHINE.readText(machineStateFile(env)), null);
    chmodSync(home, 0o700);
    saveHostCache(env, REAL_MACHINE, cache);
    assert.deepEqual(JSON.parse(REAL_MACHINE.readText(machineStateFile(env)) ?? '{}').hostDisk, cache);
  } finally {
    chmodSync(home, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test("machine: Claude Code's temp folder owned by another user is a note with the command to run, never run", () => {
  const ownedBy = (owner: number | null, dir = join('/tmp', 'claude-1000')) => fakeMachine(GB, { readOwner: (path) => (path === dir ? owner : null) });
  const note = agentTempDirCheck({}, ownedBy(0));
  assert.equal(note?.ok, false);
  assert.equal(note?.finding.what, "/tmp/claude-1000 belongs to uid 0, not to you (uid 1000), so Claude Code won't start");
  assert.match(note?.finding.fix ?? '', /^run `sudo rm -rf '\/tmp\/claude-1000'` yourself/);
  assert.equal(agentTempDirCheck({}, ownedBy(1000))?.ok, true);
  assert.equal(agentTempDirCheck({}, ownedBy(null)), null, 'no folder yet');
  assert.equal(agentTempDirCheck({}, { ...ownedBy(0), uid: null }), null, 'Windows has no uid');
  // CLAUDE_CODE_TMPDIR, then TMPDIR, moves the folder.
  const asked: string[] = [];
  const machine = fakeMachine(GB, { readOwner: (path) => (asked.push(path), null) });
  agentTempDirCheck({ CLAUDE_CODE_TMPDIR: '/scratch', TMPDIR: '/other' }, machine);
  agentTempDirCheck({ TMPDIR: '/other' }, machine);
  assert.deepEqual(asked, [join('/scratch', 'claude-1000'), join('/other', 'claude-1000')]);
});

test('machine: the printed command quotes the temp folder, so a space or $(...) in TMPDIR deletes nothing else', () => {
  const fixFor = (tmp: string) => agentTempDirCheck({ TMPDIR: tmp }, fakeMachine(GB, { readOwner: () => 0 }))?.finding.fix ?? '';
  assert.match(fixFor('/my temp'), /^run `sudo rm -rf '\/my temp\/claude-1000'` yourself/);
  assert.match(fixFor('/t/$(id)'), /^run `sudo rm -rf '\/t\/\$\(id\)\/claude-1000'` yourself/);
  assert.match(fixFor("/it's"), /^run `sudo rm -rf '\/it'\\''s\/claude-1000'` yourself/);
  assert.equal(quoteForShell("a'b"), "'a'\\''b'");
  // A newline can't be pasted safely: the folder is named, and no command is printed.
  const newline = agentTempDirCheck({ TMPDIR: '/t\nrm' }, fakeMachine(GB, { readOwner: () => 0 }))?.finding;
  assert.equal(newline?.fix, 'remove the folder "/t\\nrm/claude-1000" yourself, with sudo; Claude Code makes a new one when it starts');
  assert.doesNotMatch(newline?.what ?? '', /\n/);
});

test('machine: the notes show in full doctor and never change the exit code; a session hears a low disk', () => {
  const sandbox = makeSandbox();
  const env = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' };
  const machine = fakeMachine(0, { readOwner: () => 0 });
  const full = doctor(sandbox.repo, { env, config: DEFAULTS, machine });
  const quiet = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB) });
  assert.equal(full.ok, quiet.ok, 'a note never fails doctor');
  assert.ok(full.lines.includes('  note    disk-space: the disk that holds this repo has 0.0 GB free of 250 GB; free some space: delete caches and build outputs you do not need, or move data to another disk'), full.lines.join('\n'));
  assert.ok(full.lines.some((line) => line.startsWith('  note    agent-temp-dir: ')));
  assert.deepEqual(full.report.notes?.filter((n) => ['disk-space', 'agent-temp-dir'].includes(n.id)).length, 2);
  assert.ok(quiet.lines.includes('  ok      disk-space: 100 GB free of 250 GB'));
  const session = doctor(sandbox.repo, { env, config: DEFAULTS, machine, session: true });
  assert.ok(session.lines.some((line) => line.startsWith('yokoten: the disk that holds this repo has 0.0 GB free')));
  // The agent-temp-dir note's own text, so a temp path that happens to hold claude-1000 does not matter.
  const agentTemp = full.report.notes?.find((n) => n.id === 'agent-temp-dir');
  assert.ok(agentTemp, 'full doctor has the agent-temp-dir note');
  assert.ok(!session.lines.some((line) => line.includes(agentTemp.what)), 'the temp folder is full doctor only');
  assert.ok(!doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB), session: true }).lines.some((line) => line.includes('disk')), 'room enough: nothing');
});

test('self-test: the machine control passes the real checks and fails broken ones (record 0012)', () => {
  assert.deepEqual(machineControl(), []);
  assert.ok(!selfTest().some((name) => name.includes('disk space') || name.includes('temp dir') || name.includes('host drive')));
  assert.deepEqual(machineControl(() => [], () => null), ['disk space check', 'host drive check', 'agent temp dir check']);
  // A host-drive reading that never finds the drive: the Windows drive is missed.
  const noHost: typeof diskSpaceChecks = (root, env, probe, session) => diskSpaceChecks(root, env, { ...probe, runProgram: () => '' }, session);
  assert.deepEqual(machineControl(noHost), ['host drive check']);
});

// #400: old yokoten-* folders in the temp folder. A note with the command; doctor never deletes.
const DAY = 24 * 60 * 60 * 1000;
function makeTempFolder(folders: Record<string, number>): string {
  const temp = makeTempDir('yokoten-tmp-');
  for (const [name, ageMs] of Object.entries(folders)) {
    mkdirSync(join(temp, name));
    writeFileSync(join(temp, name, 'data'), 'x'.repeat(2048));
    const when = new Date(NOW.getTime() - ageMs);
    utimesSync(join(temp, name), when, when);
  }
  return temp;
}

test('machine: yokoten-* folders older than a day are a note with their count and the command to remove them (#400)', () => {
  const temp = makeTempFolder({ 'yokoten-a1': 2 * DAY, 'yokoten-adopt-b2': 3 * DAY, 'yokoten-new': DAY / 2, 'other-old': 5 * DAY });
  writeFileSync(join(temp, 'yokoten-file'), 'not a folder');
  const note = leftoverTempCheck({ YOKOTEN_TEMP_DIRS: temp }, fakeMachine(GB));
  assert.equal(note?.ok, false);
  assert.equal(note?.name, 'leftover-temp-folders');
  assert.equal(note?.finding.what, `2 yokoten-* folders older than a day in ${temp}`);
  assert.equal(note?.finding.fix, `run \`find '${temp}' -maxdepth 1 -name 'yokoten-*' -mmin +1440 -exec rm -rf {} +\` yourself; it removes only the ones older than a day`);
  assert.equal(readFileSync(join(temp, 'yokoten-a1', 'data'), 'utf8').length, 2048, 'doctor deletes nothing');
  // Clean: only new folders, or none, or no temp folder to read: no note.
  assert.equal(leftoverTempCheck({ YOKOTEN_TEMP_DIRS: makeTempFolder({ 'yokoten-new': DAY / 2 }) }, fakeMachine(GB)), null);
  assert.equal(leftoverTempCheck({ YOKOTEN_TEMP_DIRS: join(temp, 'missing') }, fakeMachine(GB)), null, 'fails open');
  assert.equal(leftoverTempCheck({ YOKOTEN_TEMP_DIRS: '' }, fakeMachine(GB)), null, 'empty turns it off');
});

test('machine: the leftover note shows in full doctor only, and never changes the exit code (#400)', () => {
  const sandbox = makeSandbox();
  const temp = makeTempFolder({ 'yokoten-a1': 2 * DAY });
  const env = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: temp };
  const full = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB) });
  const clean = doctor(sandbox.repo, { env: { ...env, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, machine: fakeMachine(100 * GB) });
  assert.equal(full.ok, clean.ok, 'a note never fails doctor');
  assert.ok(full.lines.some((line) => line === `  note    leftover-temp-folders: 1 yokoten-* folder older than a day in ${temp}; run \`find '${temp}' -maxdepth 1 -name 'yokoten-*' -mmin +1440 -exec rm -rf {} +\` yourself; it removes only the ones older than a day`), full.lines.join('\n'));
  assert.ok(!clean.lines.some((line) => line.includes('leftover-temp-folders')), 'a clean temp folder: no note');
  const session = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB), session: true });
  assert.ok(!session.lines.some((line) => line.includes('yokoten-*')), 'full doctor only');
});

test('self-test: the leftover control passes the real check and fails a broken one (#400)', () => {
  assert.deepEqual(leftoverControl(), []);
  assert.deepEqual(leftoverControl(() => null), ['leftover temp folder check']);
  // A check that counts the new folder too is caught.
  assert.deepEqual(leftoverControl((env, probe, read) => leftoverTempCheck(env, { ...probe, now: () => new Date(Date.now() + 365 * DAY) }, read)), ['leftover temp folder check']);
});

// #365: work only on this machine. Full doctor lists it all; a session hears what is at
// risk, three items at most. The cases themselves are tested in test/setup/advice/unsaved.test.ts.
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
  assert.deepEqual((await session()).slice(3), ['yokoten: . has 1 uncommitted file, the oldest changed 2 days ago; commit them: `git -C . add -A && git -C . commit`, then push.', UNSAVED_OFFER]);
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

test('doctor self-test: the unsaved-work check must name every kind, and a broken one is caught (#365)', () => {
  assert.equal(isUnsavedControlCaught(), true);
  assert.equal(isUnsavedControlCaught(() => []), false, 'a check that finds nothing');
  const deletesWhenUnsure: Parameters<typeof isUnsavedControlCaught>[0] = (facts, options) =>
    unsavedNotes(facts, options).map((f) => (f.id === 'stale-index-lock' ? { ...f, fix: 'delete it' } : f));
  assert.equal(isUnsavedControlCaught(deletesWhenUnsure), false, "a check that says to delete a lock it can't judge");
  assert.ok(!selfTest().includes('unsaved work check'));
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

test('self-test: a shell write from the plugin agent yokoten:worker is caught, and the lead passes (#402)', () => {
  assert.ok(isShellControlCaught());
  assert.ok(!selfTest().includes('lead-only shell guard'));
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

test('saveHostCache: keeps the other keys of machine.json, such as the Windows user names (#404)', () => {
  const files = new Map([[machineStateFile(WSL), JSON.stringify({ windowsUsers: { names: ['JaneD'], readAt: NOW.toISOString(), scanMs: 1 } })]]);
  saveHostCache(WSL, fakeMachine(GB, { files }), { free: 0, size: 1, readAt: NOW.toISOString(), distro: '<distro>', version: 2 });
  const state = JSON.parse(files.get(machineStateFile(WSL)) ?? '{}');
  assert.deepEqual(state.windowsUsers.names, ['JaneD']);
  assert.equal(state.hostDisk.size, 1);
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

test('doctor: a note when no yokoten on the PATH runs the installed copy (#433)', () => {
  const home = makeTempDir('yokoten-launcher-');
  const runtime = join(home, '.local', 'share', 'yokoten');
  const env = { HOME: home, PATH: dirname(process.execPath) };
  // No runtime installed: install's own checks say so, not this note.
  assert.equal(launcherCheck(env), null);
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin', 'yokoten.ts'), '\n');
  const note = launcherCheck(env);
  assert.equal(note?.what, 'the yokoten launcher is not on your PATH, so a bare yokoten command is not found');
  // No launcher yet: the one fix is install, run the way that works now. No line says to type the runtime's path (#500).
  assert.match(note?.fix ?? '', /^run \`npx yokoten install\`; it puts a launcher in .*\.local[\\/]bin/);
  // The launcher in ~/.local/bin, with that folder on the PATH: no note.
  setUpLauncher(env, runtime, home);
  const off = launcherCheck(env);
  assert.notEqual(off, null, 'a launcher off the PATH still gets the note');
  // The launcher is there: the fix is the one line for the PATH, and says npx works meanwhile.
  assert.match(off?.fix ?? '', /^add this line to your shell profile .* then open a new terminal: export PATH=.*; until then, \`npx yokoten\` runs yokoten$/);
  assert.doesNotMatch(`${off?.what} ${off?.fix} ${off?.why}`, /yokoten\.ts/);
  assert.equal(launcherCheck({ ...env, PATH: `${launcherDir(home)}:${env.PATH}` }), null);
  // With the plugin on, its own commands are used: no note.
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  assert.equal(launcherCheck(env), null);
});

// #453: full doctor in an empty repo started 31 child processes. git read the index three
// times, and several config keys twice. Each git read now runs once per run, and the
// config values come from one `git config --list`.
test('doctor: full doctor in an empty repo starts each git read once, nine child processes in all (#453)', () => {
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
  assert.equal(runs.length, 9, runs.join('\n'));
});

// #500: after a fresh install, every line that names a command uses one way to run yokoten.
test('doctor: with the launcher off the PATH, every command in the text is `npx yokoten`; on the PATH, `yokoten` (#500)', () => {
  const home = makeTempDir('yokoten-one-way-');
  const root = join(home, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  const runtime = join(home, '.local', 'share', 'yokoten');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin', 'yokoten.ts'), '\n');
  const gitDir = dirname(execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).trim().split('\n')[0]);
  const env = { HOME: home, PATH: [dirname(process.execPath), gitDir].join(delimiter), YOKOTEN_TEMP_DIRS: '' };
  setUpLauncher(env, runtime, home);
  const run = (e: Record<string, string>, session = false) => doctor(root, { env: e, config: DEFAULTS, session, gh: () => { throw new Error('no network'); } });
  for (const session of [false, true]) {
    const text = JSON.stringify(run(env, session));
    assert.doesNotMatch(text, /`yokoten[ `]/, 'no bare yokoten command while the launcher is off the PATH');
    assert.match(text, /`npx yokoten init`/);
    assert.doesNotMatch(text, /node [^"]*yokoten\.ts install/);
  }
  const full = run(env).lines.join('\n');
  assert.match(full, /note +command: the yokoten launcher is not on your PATH.*until then, `npx yokoten` runs yokoten/);
  // The launcher is on the PATH: the messages stay as written, and there is no note.
  const onPath = run({ ...env, PATH: `${launcherDir(home)}${delimiter}${env.PATH}` }).lines.join('\n');
  assert.match(onPath, /`yokoten init`/);
  assert.doesNotMatch(onPath, /npx yokoten|launcher is not on your PATH/);
  // Run by npx with nothing installed: `npx yokoten` too.
  const bare = makeTempDir('yokoten-npx-');
  const viaNpx = doctor(root, { env: { HOME: bare, npm_command: 'exec', PATH: env.PATH, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: () => { throw new Error('no network'); } });
  assert.match(viaNpx.lines.join('\n'), /`npx yokoten init`/);
});
