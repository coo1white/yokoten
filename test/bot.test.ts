import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { annotation, annotations, appJwt, botConfig, botEnv, type Gh, installationToken, type Label, readCommandTitle, readPlanning, readServer, repoOf, type ServerSettings, stepSummary, type Unread } from '../src/host/github.ts';
import { DEFAULTS } from '../src/rules/config.ts';
import { checkCommand } from '../src/rules/guards.ts';
import { doctor } from '../src/setup/doctor.ts';
import { road, ROAD, serverChecks, stepFinding } from '../src/setup/road.ts';
import { LABELS, pickNewMilestone, setUpPlanning } from '../src/setup/plan.ts';

// A throwaway key, made for this test run only.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

test('JWT: RS256, issued by the App, nine minutes, and the signature checks out', () => {
  const jwt = appJwt('12345', pem, 1_000_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), { iat: 999_940, exp: 1_000_540, iss: '12345' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
});

test('token: finds the installation from the repo, then exchanges the JWT', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.authorization ?? '')}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  writeFileSync(join(dir, 'bot.pem'), pem);
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // With NODE_USE_ENV_PROXY=1, fetch sends even a local call through the shell's proxy,
  // which closes it. The fake API is on this machine, so the call goes to it directly.
  // Node reads both spellings of the variable, so both are set, then put back.
  const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  try {
    const token = await installationToken({ appId: '1', keyFile: join(dir, 'bot.pem'), api }, 'me/repo');
    assert.equal(token, 'ghs_test');
    assert.deepEqual(seen, ['GET /repos/me/repo/installation true', 'POST /app/installations/77/access_tokens true']);
  } finally {
    server.close();
    for (const [name, value] of [['NO_PROXY', saved.upper], ['no_proxy', saved.lower]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('config: the App ID is required, the key has a default place', () => {
  assert.match(botConfig({}) as string, /YOKOTEN_BOT_APP_ID/);
  const c = botConfig({ YOKOTEN_BOT_APP_ID: '9', HOME: '/h' });
  assert.ok(typeof c !== 'string');
  assert.equal(c.keyFile, join('/h', '.config', 'yokoten', 'bot.pem'));
  assert.equal(c.api, 'https://api.github.com');
});

test('repo: read from https and ssh remotes', () => {
  assert.equal(repoOf('https://github.com/me/repo.git\n'), 'me/repo');
  assert.equal(repoOf('git@github.com:me/repo.git'), 'me/repo');
  assert.equal(repoOf('https://github.com/me/repo'), 'me/repo');
  assert.equal(repoOf('https://example.com/me/repo.git'), null);
});

test('env: gh gets the token, and git asks gh for github.com instead of the owner\'s login', () => {
  const e = botEnv({ PATH: '/bin', GIT_CONFIG_COUNT: '1' }, 'tok');
  assert.equal(e.GH_TOKEN, 'tok');
  assert.equal(e.GIT_CONFIG_COUNT, '3');
  assert.equal(e.GIT_CONFIG_VALUE_1, '');
  assert.equal(e.GIT_CONFIG_VALUE_2, '!gh auth git-credential');
  assert.equal(e.PATH, '/bin');
});

test('command title: the title gh issue or gh pr create or edit sets; null for anything else (#117)', () => {
  const read = (line: string) => readCommandTitle(line.split(' '));
  assert.deepEqual(read('gh issue create --title host:x --label feat,incident -l tier'), { kind: 'issue', title: 'host:x', labels: ['feat', 'incident', 'tier'] });
  assert.deepEqual(read('gh issue edit 5 --title=a --add-label incident'), { kind: 'issue', title: 'a', labels: ['incident'] });
  assert.deepEqual(read('gh pr create -t a --body b'), { kind: 'pr', title: 'a', labels: [] });
  assert.deepEqual(read('/usr/bin/gh pr edit 5 -ta'), { kind: 'pr', title: 'a', labels: [] }, 'a path to gh, and an attached short value');
  assert.equal(read('gh pr create -t a -t b')?.title, 'b', 'the last one wins, as in gh');
  assert.equal(read('gh pr create --body -t --title a')?.title, 'a', 'the value of another option is not read as an option');
  assert.equal(read('gh pr create --body -t'), null);
  assert.equal(read('gh pr create --fill'), null, 'no title: CI checks it');
  assert.equal(read('gh pr create -- --title a'), null, 'nothing after --');
  assert.equal(read('gh pr create --title'), null, 'no value');
  for (const line of ['gh pr view --title a', 'gh repo create --title a', 'git commit --title a', 'gh issue']) assert.equal(read(line), null, line);
});

test('the bot is not a way around the guard', () => {
  assert.ok(checkCommand('node .yokoten/bin/yokoten.ts bot -- git push --tags', { env: {} }));
  assert.ok(checkCommand('yokoten bot -- gh release create v1', { env: {} }));
});

// The server settings (#7), read through a fake gh. Each route is an API path; a missing
// route answers 404, as GitHub does. The real gh is never run.
const REPO = 'octo/demo';
const said = (code: number) => Object.assign(new Error('gh failed'), { stderr: `gh: request failed (HTTP ${code})\n` });
const GOOD: Record<string, unknown> = {
  [`repos/${REPO}`]: {
    default_branch: 'main',
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
  },
  [`repos/${REPO}/rules/branches/main`]: [
    { type: 'pull_request', parameters: { require_code_owner_review: true, allowed_merge_methods: ['squash'] } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
    { type: 'non_fast_forward' },
    { type: 'deletion' },
  ],
  [`repos/${REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`]: [{ id: 7, target: 'tag', enforcement: 'active' }],
  [`repos/${REPO}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] },
  [`repos/${REPO}/private-vulnerability-reporting`]: { enabled: true },
  [`repos/${REPO}/vulnerability-alerts`]: '',
  [`repos/${REPO}/pulls?state=open&per_page=100`]: 'octo:feat/a\nsomeone:main\n',
  [`repos/${REPO}/branches?per_page=100`]: 'main\nfeat/a\nold/b\n',
};

function serverGh(routes: Record<string, unknown>) {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    const route = routes[args.find((a) => a.startsWith('repos/')) ?? ''];
    if (route instanceof Error) throw route;
    if (route === undefined) throw said(404);
    return typeof route === 'string' ? route : JSON.stringify(route);
  };
  return { gh, calls };
}

const marks = (s: ServerSettings | Unread) => Object.fromEntries(serverChecks(s).map((c) => [c.id, c.mark]));

test('server: a repo with every setting on is ok, and doctor only reads (#7)', () => {
  const f = serverGh(GOOD);
  const s = readServer(f.gh, REPO);
  assert.deepEqual(marks(s), {
    'main-rules': 'ok', 'required-checks': 'ok', 'code-owner-review': 'ok', 'squash-only': 'ok',
    'delete-branch': 'ok', 'tag-rules': 'ok', 'security-switches': 'ok', 'forgotten-branches': 'note',
  });
  const note = serverChecks(s).find((c) => c.id === 'forgotten-branches');
  assert.match(note?.finding.what ?? '', /^1 branch\(es\) with no open pull request \(old\/b\)$/, 'a branch of a fork with the same name does not count');
  assert.match(note?.finding.fix ?? '', /never deletes/);
  for (const c of f.calls) {
    assert.equal(c[0], 'api', c.join(' '));
    assert.ok(!c.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(a)), `a write: ${c.join(' ')}`);
  }
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
  assert.deepEqual(serverChecks(missing).map((c) => [c.id, c.mark, c.finding.what]), [['server-settings', "can't check", "can't check: gh is not installed"]]);
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

const SERVER_KEYS = ['protection', 'merge-settings', 'security-settings'];
const serverSteps = () => ROAD.filter((s) => SERVER_KEYS.includes(s.key));
const serverFound = (server: Parameters<typeof road>[3]) => Object.fromEntries(road('.', {}, serverSteps(), server).map((r) => [r.step.key, r.found]));

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
  assert.match(text(), /^ {2}can't check server-settings: can't check: the origin remote is not on a host yokoten knows/m);
  assert.match(text(), /^ {4}can't check protection \(Scorecard: Branch-Protection\): the origin remote is not on a host yokoten knows/m);
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

// The review step (#59): one approval before a merge, judged from the repo's rules and visibility.
const review = ROAD.find((s) => s.key === 'review')!;
const RULES = `repos/${REPO}/rules/branches/main`;
const withApprovals = (count: number) => [{ type: 'pull_request', parameters: { required_approving_review_count: count } }, ...(GOOD[RULES] as object[]).slice(1)];
// An admin's read: the old branch protection and the Actions setting are visible.
const ACTIONS = `repos/${REPO}/actions/permissions/workflow`;
const ADMIN = { ...GOOD, [`repos/${REPO}`]: { ...(GOOD[`repos/${REPO}`] as object), permissions: { admin: true } }, [ACTIONS]: { can_approve_pull_request_reviews: false } };

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

// A fake gh that holds one repo's labels and milestones in memory. The real one is never run.
const REMOTE = 'https://github.com/me/repo.git';
function fakeGh(labels: (string | Label)[], milestones: string[] = []) {
  const calls: string[][] = [];
  const held: Label[] = labels.map((l) => (typeof l === 'string' ? { name: l, color: 'ededed', description: '' } : l));
  const option = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const gh: Gh = (args) => {
    calls.push(args);
    const [command, subcommand, name] = args;
    assert.ok(command === 'api' || args.includes('me/repo'), `every call names the repo: ${args.join(' ')}`);
    if (command === 'label' && args.includes('docs') && subcommand !== 'delete') throw Object.assign(new Error('failed'), { stderr: 'HTTP 403: no access\n' });
    if (command === 'label' && subcommand === 'create') held.push({ name, color: option(args, '--color'), description: option(args, '--description') });
    else if (command === 'label' && subcommand === 'edit') Object.assign(held.find((l) => l.name === name)!, { color: option(args, '--color'), description: option(args, '--description') });
    else if (command === 'label' && subcommand === 'delete') held.splice(held.findIndex((l) => l.name === name), 1);
    else if (command === 'api' && args.includes('POST')) milestones.push(`open ${args.at(-1)?.slice('title='.length)}`);
    else if (command === 'api' && args.includes('repos/me/repo/labels?per_page=100')) return held.map((l) => `${JSON.stringify(l)}\n`).join('');
    else if (command === 'api' && args.includes('repos/me/repo/milestones?state=all&per_page=100')) return milestones.map((m) => `${m}\n`).join('');
    else throw new Error(`unexpected gh ${args.join(' ')}`);
    return '';
  };
  return { gh, calls, held, milestones };
}
const writes = (calls: string[][]) => calls.filter((c) => c[0] === 'label' || c.includes('POST'));
const DRY = { apply: false, removeDefaults: false };
const APPLY = { apply: true, removeDefaults: false };

test('planning: says what it would do, and changes nothing without --yes (#10)', () => {
  const standardBug = LABELS.find((l) => l.name === 'bug')!;
  const f = fakeGh([standardBug, 'feat', 'Enhancement', 'wontfix']);
  const r = setUpPlanning(f.gh, REMOTE, DRY);
  assert.ok(r.ok);
  assert.ok(r.lines.includes('- 1 of the 9 standard labels are there; kept'));
  assert.ok(r.lines.includes('- not in the standard set: Enhancement, wontfix. yokoten deletes them only with --remove-default-labels'));
  assert.ok(r.lines.includes('- make label "hotfix" (Urgent: fix and release soon)'));
  assert.ok(r.lines.includes('- update label "feat" to the standard colour and description'));
  assert.ok(r.lines.includes('- make milestone "First release"'));
  assert.equal(r.lines.at(-1), 'Nothing changed. Run `yokoten init --github --yes` to do it.');
  assert.deepEqual(writes(f.calls), [], 'nothing changed');
});

test('planning: makes what is missing, updates what differs, and a second run changes nothing (#10)', () => {
  const fake = fakeGh(['BUG', 'owner', 'question'], ['closed v0.0.1']);
  let result = setUpPlanning(fake.gh, REMOTE, APPLY);
  assert.equal(result.ok, false, 'one label was refused');
  assert.ok(result.lines.includes('- could not make label "docs" (Documentation only): HTTP 403: no access'));
  assert.ok(result.lines.includes('- done: make label "hotfix" (Urgent: fix and release soon)'), 'the refusal did not stop the rest');
  assert.ok(result.lines.includes('- done: update label "BUG" to the standard colour and description'), 'case ignored; the name is kept');
  assert.ok(result.lines.includes('- done: make milestone "First release"'));
  assert.equal(fake.calls.filter((c) => c[1] === 'create').length, LABELS.length - 2);
  assert.deepEqual(fake.calls.find((c) => c.includes('docs')), ['label', 'create', 'docs', '-R', 'me/repo', '--color', '0075ca', '--description', 'Documentation only']);
  assert.ok(fake.held.some((l) => l.name === 'question'), 'a label outside the set is never deleted by default');
  fake.held.push(LABELS.find((l) => l.name === 'docs')!);
  // Run twice: no duplicate, no update, nothing made.
  const before = fake.calls.length;
  result = setUpPlanning(fake.gh, REMOTE, APPLY);
  assert.ok(result.ok);
  assert.equal(result.lines.at(-1), 'Nothing to change.');
  assert.deepEqual(writes(fake.calls.slice(before)), []);
  assert.equal(fake.held.filter((l) => l.name.toLowerCase() === 'bug').length, 1, 'no duplicate');
  assert.deepEqual(fake.milestones, ['closed v0.0.1', 'open First release']);
});

test('planning: deletes GitHub\'s default labels only with --remove-default-labels (#10)', () => {
  const fake = fakeGh([...LABELS, 'question', 'Wontfix', 'my-own'], ['open v1']);
  let result = setUpPlanning(fake.gh, REMOTE, { apply: false, removeDefaults: true });
  assert.ok(result.lines.includes('- delete label "question" (the host also takes it off every issue)'));
  assert.equal(result.lines.at(-1), 'Nothing changed. Run `yokoten init --github --yes --remove-default-labels` to do it.');
  assert.deepEqual(writes(fake.calls), []);
  result = setUpPlanning(fake.gh, REMOTE, { apply: true, removeDefaults: true });
  assert.ok(result.ok);
  assert.deepEqual(writes(fake.calls), [['label', 'delete', 'question', '-R', 'me/repo', '--yes'], ['label', 'delete', 'Wontfix', '-R', 'me/repo', '--yes']]);
  assert.ok(fake.held.some((l) => l.name === 'my-own'), 'a label the owner made is not a GitHub default');
});

test('planning: no gh, signed out, or no GitHub remote is a skip that says why, not a failure (#10)', () => {
  const missing = setUpPlanning(() => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, REMOTE, APPLY);
  assert.equal(missing.ok, true);
  assert.match(missing.lines[0], /^GitHub: skipped, because gh is not installed\. To set up labels and a milestone, get it from https:\/\/cli\.github\.com/);
  const out = setUpPlanning(() => { throw Object.assign(new Error('exit 4'), { stderr: 'HTTP 401: Bad credentials' }); }, REMOTE, APPLY);
  assert.deepEqual(out, { ok: true, lines: ['GitHub: skipped, because gh is not signed in. To set up labels and a milestone, run `gh auth login`, then run `yokoten init --github`'] });
  const elsewhere = setUpPlanning(() => { throw new Error('gh was called'); }, 'https://gitea.example.com/me/repo.git', APPLY);
  assert.deepEqual(elsewhere, { ok: true, lines: ['GitHub: skipped, because the origin remote is not on GitHub. Labels and a milestone need a GitHub repo'] });
  assert.equal(setUpPlanning(() => { throw new Error('gh was called'); }, '', APPLY).ok, true, 'no remote at all');
});

// The planning steps (#10): stage 2, read in full doctor only.
const planningFound = (server: Parameters<typeof road>[3]) => Object.fromEntries(road('.', {}, ROAD.filter((s) => ['labels', 'milestone'].includes(s.key)), server).map((r) => [r.step.key, r.found]));
const withPlanning = (planning: ServerSettings['planning']) => ({ ...(readServer(serverGh(GOOD).gh, REPO) as ServerSettings), planning });

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

test('milestone: init and the road use one rule, an open milestone; a closed one is never kept or reopened (#178)', () => {
  const milestoneStep = ROAD.find((s) => s.key === 'milestone')!;
  // Positive control: the old init rule kept a closed "First release", and the road stayed not done.
  const fake = fakeGh([...LABELS], ['closed First release']);
  const server = () => withPlanning(readPlanning(fake.gh, 'me/repo'));
  assert.equal(planningFound(server()).milestone, false);
  assert.equal(stepFinding(milestoneStep, '.', {}, server()).fix, '`yokoten init --github --yes` makes one called "Next release"', 'doctor names what init makes');
  const planned = setUpPlanning(fake.gh, REMOTE, DRY);
  assert.ok(planned.lines.includes('- make milestone "Next release"'), planned.lines.join('\n'));
  assert.ok(!planned.lines.includes('- a milestone is open; kept'));
  assert.equal(planningFound(server()).milestone, false, 'not done until the milestone exists');
  const applied = setUpPlanning(fake.gh, REMOTE, APPLY);
  assert.ok(applied.lines.includes('- done: make milestone "Next release"'));
  assert.deepEqual(fake.milestones, ['closed First release', 'open Next release'], 'the closed one stays closed');
  assert.equal(planningFound(server()).milestone, true);
  assert.equal(setUpPlanning(fake.gh, REMOTE, APPLY).lines.at(-1), 'Nothing to change.');
  // An open milestone: init keeps it and the road is done.
  const open = fakeGh([...LABELS], ['closed First release', 'open v2']);
  assert.ok(setUpPlanning(open.gh, REMOTE, DRY).lines.includes('- a milestone is open; kept'));
  assert.equal(planningFound(withPlanning(readPlanning(open.gh, 'me/repo'))).milestone, true);
  // Only other closed ones: "First release"; every name taken: the next free number.
  assert.equal(pickNewMilestone([{ title: 'v0.1', open: false }]), 'First release');
  assert.equal(pickNewMilestone([]), 'First release');
  assert.equal(pickNewMilestone(['first release', 'Next release', 'Next release 2'].map((title) => ({ title, open: false }))), 'Next release 3');
});

// #91: workflow commands, escaped as GitHub's runner decodes them
// (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands).
test('annotations: escape the message and the properties; a history place goes in the message (#91)', () => {
  const f = { id: 'layout', what: '100% full,\nline two\r', why: 'a: b', fix: 'see a, b', file: 'docs/a,b:c.md', line: 7 };
  assert.equal(annotation(f, 'error'), '::error file=docs/a%2Cb%3Ac.md,line=7,title=yokoten layout::100%25 full,%0Aline two%0D. A: b. See a, b.');
  assert.equal(annotation({ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }, 'warning'), '::warning title=yokoten large-diff::big. W. F.');
  assert.equal(annotation({ ...f, what: 'x', file: 'commit abc (message)', line: 1 }, 'error', false), '::error title=yokoten layout::commit abc (message):1: x. A: b. See a, b.');
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.equal(annotation(linked, 'error'), '::error file=a.md,line=1,title=yokoten email::an email. W. F.%0A  docs: https://example.com/guide#privacy', 'the link goes in the message (#94)');
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const lines = annotations(many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.equal(lines.length, 50, 'GitHub shows at most 50 per job');
  assert.ok(lines.every((l) => l.startsWith('::error ')), 'problems come before notes');
});

test('step summary: a heading with the result, a table, notes apart, at most 50 rows (#91)', () => {
  assert.equal(stepSummary('yokoten check', [], []), '### yokoten check: ok\n\n');
  // GitHub renders the summary as HTML: a `<` in a cell would hide the text after it.
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'an email', why: 'w', fix: 'f', file: '<draft>.md', line: 1 }], []), /\| &lt;draft>\.md:1 \|/);
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'a\\|b', why: 'w', fix: 'f' }], []), /\| a\\\\\\\|b \|/);
  const one = stepSummary('yokoten check --pr', [{ id: 'pr-title', what: 'title: a | b', why: 'why', fix: 'fix it' }], [{ id: 'long-sentence', what: 'long', why: 'w', fix: 'f', file: 'a.md', line: 2 }]);
  assert.equal(one, [
    '### yokoten check --pr: 1 problem',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '|  | pr-title | title: a \\| b | Why | Fix it |',
    '',
    '#### Notes (1): these never fail the check',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '| a.md:2 | long-sentence | long | W | F |',
    '',
    '',
  ].join('\n'));
  // The id links to its section (#94).
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.match(stepSummary('yokoten check', [linked], []), /\n\| a\.md:1 \| \[email\]\(https:\/\/example\.com\/guide#privacy\) \| an email \| W \| F \|\n/);
  const many = Array.from({ length: 53 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const text = stepSummary('yokoten check', many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.match(text, /^### yokoten check: 53 problems\n/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('| a.md:')).length, 50);
  assert.match(text, /\nAnd 3 more\. The job log lists them all\.\n/);
  assert.match(text, /#### Notes \(1\): these never fail the check\n\nThe job log lists them\.\n/);
});
