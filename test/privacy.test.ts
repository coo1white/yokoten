import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hideHome, loadMarks, notUtc, POSITIVE_CONTROL, scanText } from '../src/rules/privacy.ts';
import { SECRET_CONTROL } from '../src/rules/secrets.ts';

// Samples are built from pieces so this file passes its own check.
const at = '@';
const ip = (...n: number[]) => n.join('.');

test('positive control: the known-bad sample is caught', () => {
  assert.equal(scanText(POSITIVE_CONTROL, { file: 'x' }).length, 2);
});

test('emails: personal ones are caught, noreply and examples are fine', () => {
  assert.equal(scanText(`me${at}gmail.com`, { file: 'a' }).length, 1);
  assert.match(scanText(`x\nmail me${at}mydomain.dev`, { file: 'a.md' })[0], /^a\.md:2: an email/);
  for (const ok of [`1+me${at}users.noreply.github.com`, `noreply${at}anthropic.com`, `you${at}example.com`, `a${at}host.test`]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  assert.deepEqual(scanText(`help${at}company.com`, { file: 'a', allow: [`help${at}company.com`] }), []);
});

test('emails: role addresses, forge SSH remotes and .local point at no person (#11)', () => {
  for (const ok of [
    `contact support${at}github.com`,
    `security${at}gitlab.com`,
    `remote: git${at}gitlab.com:owner/repo.git`,
    `git clone git${at}github.com:owner/repo`,
    `conf${at}test.local`,
    `1-me${at}users.noreply.gitlab.com`,
  ]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Still caught: a person at the same domains, and an SSH remote that names a private host.
  for (const bad of [`someone${at}gmail.com`, `someone${at}github.com`, `git${at}code.my-company.dev:team/app.git`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
});

test('IPs: real ones are caught, documentation ranges and versions are not', () => {
  for (const bad of [ip(100, 64, 1, 2), ip(10, 0, 0, 5), ip(8, 8, 8, 8), `host=${ip(203, 0, 114, 9)}:22`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
  for (const ok of [ip(127, 0, 0, 1), ip(192, 0, 2, 10), ip(198, 51, 100, 1), ip(0, 0, 0, 0), ip(999, 1, 1, 1), 'v1.2.3', '1.2.3.4.5']) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
});

test('private marks: matched without case, never echoed', () => {
  const problems = scanText('Deploy to Secret-Box tonight', { file: 'a', marks: ['secret-box'] });
  assert.equal(problems.length, 1);
  assert.ok(!/secret-box/i.test(problems[0]), 'the mark must not appear in the output');
});

test('private marks file: comments and blanks skipped, missing file is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const file = join(dir, 'marks');
  writeFileSync(file, '# header\n\nMyCity\n  myserver  \n');
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: file }), ['mycity', 'myserver']);
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: join(dir, 'none') }), []);
});

test('commit times: an ident with a non-UTC offset is caught (#40)', () => {
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 +0700`), true);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 -0500`), true);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 +0000`), false);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 -0000`), false);
  assert.equal(notUtc('no time here'), false);
});

test('output: the home folder shows as ~ (#25)', () => {
  assert.equal(hideHome('wrote /home/someone/.local/share/yokoten', { HOME: '/home/someone' }), 'wrote ~/.local/share/yokoten');
  assert.equal(hideHome('a /home/someone/ b /home/someone', { HOME: '/home/someone/' }), 'a ~/ b ~');
  assert.equal(hideHome('/x', { HOME: '/' }), '/x', 'a root home hides nothing');
});

// Secrets (#8). Each sample is a prefix plus a body, joined here, so no token sits in
// this file whole.
const run = (chars: string, n: number) => chars.repeat(Math.ceil(n / chars.length)).slice(0, n);
const alnum = (n: number) => run('a1B2c3D4e5F6g7H8', n);
const upper = (n: number) => run('Q7W3R9T2Y5', n);
const pem = (kind: string) => `-----BEGIN ${kind}${'PRIVATE'} KEY-----`;
const SECRETS: [string, string][] = [
  ['GitHub token', `GITHUB_TOKEN=${'gh'}p_${alnum(36)}`],
  ['GitHub token', `"${'gh'}s_${alnum(36)}"`],
  ['GitHub token', `${'github'}_pat_${alnum(22)}_${alnum(59)}`],
  ['npm token', `//registry.npmjs.org/:_authToken=${'npm'}_${alnum(36)}`],
  ['AWS access key id', `aws_access_key_id = ${'AK'}IA${upper(16)}`],
  ['AWS access key id', `${'AS'}IA${upper(16)}`],
  ['Slack token', `${'xo'}xb-${'1234567890'}-${'0987654321'}-${alnum(24)}`],
  ['Stripe live key', `${'sk'}_live_${alnum(24)}`],
  ['Stripe live key', `${'rk'}_live_${alnum(99)}`],
  ['Google API key', `key=${'AI'}za${alnum(35)}`],
  ['Anthropic key', `ANTHROPIC_API_KEY=${'sk'}-ant-api03-${alnum(93)}AA`],
  ['OpenAI key', `${'sk'}-proj-${alnum(120)}`],
  ['OpenAI key', `${'sk'}-${alnum(20)}${'T3Blbk'}FJ${alnum(20)}`],
];

test('secrets: the positive control is caught', () => {
  assert.equal(scanText(SECRET_CONTROL, { file: 'x' }).length, 2);
});

test('secrets: each kind is caught, by place and kind, never by content (#8)', () => {
  for (const [kind, line] of SECRETS) {
    const problems = scanText(`intro\n${line}\n`, { file: 'conf.env' });
    // The whole output, word for word: the secret is not in it.
    assert.deepEqual(problems, [`conf.env:2: a secret (${kind}). Remove it, rotate it, and keep it outside the repo.`], line);
  }
});

test('secrets: PEM private keys with a body are caught, a header alone is not (#8)', () => {
  const body = 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn';
  for (const kind of ['', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ']) {
    assert.match(scanText(`${pem(kind)}\n${body}\n`, { file: 'k' }).join(), /^k:1: a secret \(private key\)/, kind);
  }
  assert.equal(scanText(`${pem('RSA ')}\nProc-Type: 4,ENCRYPTED\n`, { file: 'k' }).length, 1, 'an encrypted PEM');
  assert.equal(scanText(`{"key": "${pem('')}\\n${body}\\n"}`, { file: 'k.json' }).length, 1, 'a key inside a JSON string');
  assert.equal(scanText(`-----BEGIN PGP ${'PRIVATE'} KEY BLOCK-----\n\n${body}\n`, { file: 'k' }).length, 1, 'PGP, past its blank line');
  for (const ok of [
    `if (text.startsWith('${pem('RSA ')}')) {`,
    `-----BEGIN ... ${'PRIVATE'} KEY-----`,
    `-----BEGIN ${'PUBLIC'} KEY-----\n${body}`,
    `-----BEGIN CERTIFICATE-----\n${body}`,
  ]) {
    assert.deepEqual(scanText(ok, { file: 'k' }), [], ok);
  }
});

test('secrets: near-misses are not caught (#8)', () => {
  for (const ok of [
    `${'gh'}p_${alnum(20)}`, // too short
    `${'gh'}x_${alnum(36)}`, // not a GitHub prefix
    `my${'gh'}p_${alnum(36)}`, // inside a longer word
    `${'npm'}_${alnum(30)}`,
    `npm_config_registry`,
    `${'AK'}IA${upper(15)}`, // one short
    `${'AK'}IA${upper(17)}`, // inside a longer run
    `${'AK'}IA${'IOSFODNN7'}EXAMPLE`, // AWS's own docs example
    `${'AK'}IA${'abcdefghijklmnop'}`, // lowercase
    `${'xo'}xb-not-a-token`,
    `${'sk'}_test_${alnum(24)}`, // Stripe test key
    `${'sk'}_live_short`,
    `${'AI'}za${alnum(20)}`,
    `${'sk'}-ant-api03-short`,
    `${'sk'}-proj-short`,
    `${'sk'}-${alnum(48)}`, // no marker
    'const ghp_prefix = "ghp_"; // prefixes as words',
    'sha512-' + alnum(86) + '==', // a lockfile integrity hash
  ]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
});

test('secrets: privacy.allow lets a listed string through (#8)', () => {
  const key = `${'AI'}za${alnum(35)}`;
  assert.deepEqual(scanText(`maps key ${key}`, { file: 'a', allow: [key] }), []);
  assert.equal(scanText(`maps key ${key}`, { file: 'a', allow: ['something else'] }).length, 1);
});
