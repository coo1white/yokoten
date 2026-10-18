import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appJwt, botConfig, botEnv, type Gh, installationToken, repoOf } from '../src/host/github.ts';
import { checkCommand } from '../src/rules/guards.ts';
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
