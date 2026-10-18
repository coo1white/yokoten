import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { annotation, annotations, appJwt, botConfig, botEnv, type Gh, installationToken, readCommandTitle, readServer, repoOf, type ServerSettings, stepSummary, type Unread } from '../src/host/github.ts';
import { DEFAULTS } from '../src/rules/config.ts';
import { checkCommand } from '../src/rules/guards.ts';
import { doctor, serverChecks } from '../src/setup/doctor.ts';
import { LABELS, setUpPlanning } from '../src/setup/plan.ts';

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
  try {
    const token = await installationToken({ appId: '1', keyFile: join(dir, 'bot.pem'), api }, 'me/repo');
    assert.equal(token, 'ghs_test');
    assert.deepEqual(seen, ['GET /repos/me/repo/installation true', 'POST /app/installations/77/access_tokens true']);
  } finally {
    server.close();
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

// A fake gh that holds one repo's labels and milestones in memory. The real one is never run.
function fakeGh(labels: string[], milestones: string[] = []) {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'repo') return 'me/repo\n';
    if (a === 'label' && b === 'list') return labels.map((l) => `${l}\n`).join('');
    if (a === 'label' && b === 'create') {
      if (args[2] === 'docs') throw Object.assign(new Error('failed'), { stderr: 'HTTP 403: no access\n' });
      labels.push(args[2]);
      return '';
    }
    if (a === 'api' && args.includes('POST')) {
      milestones.push(`open ${args.at(-1)?.slice('title='.length)}`);
      return '';
    }
    if (a === 'api') return milestones.map((m) => `${m}\n`).join('');
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls, labels, milestones };
}

test('planning: says what it would make, and changes nothing without --yes (#10)', () => {
  const f = fakeGh(['bug', 'Enhancement', 'wontfix']);
  const r = setUpPlanning(f.gh, false);
  assert.ok(r.ok);
  assert.ok(r.lines.includes('- 1 of the 9 standard labels are there; kept'));
  assert.ok(r.lines.some((l) => l.startsWith('- not in the standard set: Enhancement, wontfix. yokoten never deletes')));
  assert.ok(r.lines.includes('- label "hotfix" (Urgent: fix and release soon)'));
  assert.ok(r.lines.includes('- milestone "First release"'));
  assert.deepEqual(f.calls.filter((c) => c.includes('create') || c.includes('POST')), [], 'nothing made');
});

test('planning: makes what is missing, keeps what is there, and a second run makes nothing (#10)', () => {
  const f = fakeGh(['BUG', 'owner'], ['closed v0.0.1']);
  let r = setUpPlanning(f.gh, true);
  assert.equal(r.ok, false, 'one label was refused');
  assert.ok(r.lines.includes('- could not make label "docs": HTTP 403: no access'));
  assert.ok(r.lines.includes('- made label "hotfix"'), 'the refusal did not stop the rest');
  assert.ok(r.lines.includes('- made milestone "First release"'));
  assert.equal(f.calls.filter((c) => c[1] === 'create').length, LABELS.length - 2, 'bug and owner kept, case ignored');
  assert.deepEqual(f.calls.find((c) => c.includes('docs')), ['label', 'create', 'docs', '--color', '0075ca', '--description', 'Documentation only']);
  f.labels.push('docs');
  const before = f.calls.length;
  r = setUpPlanning(f.gh, true);
  assert.ok(r.ok);
  assert.equal(r.lines.at(-1), 'Nothing to make.');
  assert.ok(f.calls.slice(before).every((c) => c[1] !== 'create' && !c.includes('POST')));
});

test('planning: gh missing or signed out is said, not thrown (#10)', () => {
  const missing = setUpPlanning(() => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, true);
  assert.equal(missing.ok, false);
  assert.match(missing.lines[0], /^GitHub: gh is not installed/);
  const out = setUpPlanning(() => { throw new Error('exit 4'); }, true);
  assert.match(out.lines[0], /run `gh auth login`/);
});

// The server settings (#7), read through a fake gh. Each route is an API path; a missing
// route answers 404, as GitHub does. The real gh is never run.
const R = 'octo/demo';
const said = (code: number) => Object.assign(new Error('gh failed'), { stderr: `gh: request failed (HTTP ${code})\n` });
const GOOD: Record<string, unknown> = {
  [`repos/${R}`]: {
    default_branch: 'main',
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
  },
  [`repos/${R}/rules/branches/main`]: [
    { type: 'pull_request', parameters: { require_code_owner_review: true, allowed_merge_methods: ['squash'] } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
    { type: 'non_fast_forward' },
    { type: 'deletion' },
  ],
  [`repos/${R}/rulesets?targets=tag&includes_parents=true&per_page=100`]: [{ id: 7, target: 'tag', enforcement: 'active' }],
  [`repos/${R}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] },
  [`repos/${R}/private-vulnerability-reporting`]: { enabled: true },
  [`repos/${R}/vulnerability-alerts`]: '',
  [`repos/${R}/pulls?state=open&per_page=100`]: 'octo:feat/a\nsomeone:main\n',
  [`repos/${R}/branches?per_page=100`]: 'main\nfeat/a\nold/b\n',
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
  const s = readServer(f.gh, R);
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
    [`repos/${R}`]: { default_branch: 'trunk', allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false, delete_branch_on_merge: false, security_and_analysis: { secret_scanning: { status: 'disabled' } } },
    [`repos/${R}/rules/branches/trunk`]: [{ type: 'pull_request', parameters: {} }],
    [`repos/${R}/rulesets/7`]: { conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'deletion' }] },
    [`repos/${R}/private-vulnerability-reporting`]: { enabled: false },
    [`repos/${R}/vulnerability-alerts`]: undefined,
    [`repos/${R}/branches?per_page=100`]: 'trunk\nfeat/a\n',
  };
  const checks = serverChecks(readServer(serverGh(routes).gh, R));
  const by = (id: string) => checks.find((c) => c.id === id);
  for (const id of ['main-rules', 'required-checks', 'code-owner-review', 'squash-only', 'delete-branch', 'tag-rules', 'security-switches']) assert.equal(by(id)?.mark, 'MISSING', id);
  assert.equal(by('forgotten-branches'), undefined, 'no note when every branch has a pull request');
  assert.equal(by('main-rules')?.finding.what, 'the default branch (trunk) has no rule for no force push, no deletion');
  assert.equal(by('security-switches')?.finding.what, 'secret scanning, private vulnerability reporting, Dependabot alerts are off', 'push protection is unknown, not off');
});

test("server: gh missing, signed out or refused is \"can't check\" with the fix, never a crash (#7)", () => {
  const missing = readServer(() => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, R);
  assert.deepEqual(serverChecks(missing).map((c) => [c.id, c.mark, c.finding.what]), [['server-settings', "can't check", "can't check: gh is not installed"]]);
  assert.match(serverChecks(readServer(() => { throw said(401); }, R))[0].finding.fix, /`gh auth login`/);
  // A free private repo, read by someone who is not an admin: rulesets refused, settings hidden.
  const refused = { ...GOOD, [`repos/${R}`]: { default_branch: 'main' }, [`repos/${R}/rules/branches/main`]: said(403), [`repos/${R}/rulesets?targets=tag&includes_parents=true&per_page=100`]: said(403), [`repos/${R}/private-vulnerability-reporting`]: said(403), [`repos/${R}/vulnerability-alerts`]: undefined };
  const checks = serverChecks(readServer(serverGh(refused).gh, R));
  for (const id of ['main-rules', 'required-checks', 'code-owner-review', 'squash-only', 'delete-branch', 'tag-rules', 'security-switches']) {
    assert.equal(checks.find((c) => c.id === id)?.mark, "can't check", id);
  }
  assert.match(checks.find((c) => c.id === 'tag-rules')?.finding.fix ?? '', /GitHub Pro/);
  assert.match(checks.find((c) => c.id === 'delete-branch')?.finding.what ?? '', /only a repo admin/);
});

test('doctor: reads the server of a GitHub origin; a MISSING setting fails, a note does not (#7)', () => {
  const root = mkdtempSync(join(tmpdir(), 'yokoten-server-'));
  execFileSync('git', ['init', '-q', root]);
  const run = (routes: Record<string, unknown>) => doctor(root, { env: { HOME: root }, config: DEFAULTS, gh: serverGh(routes).gh });
  let r = run(GOOD);
  assert.match(r.lines.join('\n'), /^ {2}can't check server-settings: can't check: the origin remote is not on a host yokoten knows/m);
  assert.ok(r.lines.some((l) => /secret scanning with push protection/.test(l)), 'the by-hand list when nothing is read');
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${R}.git`], { cwd: root });
  r = run(GOOD);
  assert.ok(r.lines.includes('  ok          main-rules'));
  assert.ok(r.report.notes?.some((n) => n.id === 'forgotten-branches'));
  assert.ok(!r.report.findings.some((f) => f.id.startsWith('server') || f.id === 'main-rules'));
  r = run({ ...GOOD, [`repos/${R}/rules/branches/main`]: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.report.server?.find((s) => s.id === 'main-rules'), { id: 'main-rules', mark: 'MISSING' });
  assert.ok(r.report.findings.some((f) => f.id === 'required-checks'));
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
