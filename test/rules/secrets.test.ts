// Tests for src/rules/secrets.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DOCS_URL,
  formatFinding,
} from '../../src/rules/message.ts';
import { scanText } from '../../src/rules/privacy.ts';
import { SECRET_CONTROL } from '../../src/rules/secrets.ts';

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
  ['Meta key', `META_API_KEY=${'LL'}M_${'123456789012345'}_${alnum(40)}`],
];

test('secrets: the positive control is caught', () => {
  assert.equal(scanText(SECRET_CONTROL, { file: 'x' }).length, 2);
});

test('secrets: each kind is caught, by place and kind, never by content (#8)', () => {
  for (const [kind, line] of SECRETS) {
    const problems = scanText(`intro\n${line}\n`, { file: 'conf.env' });
    // The whole output, word for word: the secret is not in it.
    assert.deepEqual(problems, [{ id: 'secret', what: `a secret (${kind})`, why: 'a secret opens your accounts to anyone who can read the repo, and git keeps it after the file is gone', fix: 'remove it, rotate it, and keep it outside the repo', docs: `${DOCS_URL}#privacy`, file: 'conf.env', line: 2 }], line);
  }
});

test('secrets: PEM private keys with a body are caught, a header alone is not (#8)', () => {
  const body = 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn';
  for (const kind of ['', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ']) {
    assert.match(scanText(`${pem(kind)}\n${body}\n`, { file: 'k' }).map(formatFinding).join(), /^k:1: a secret \(private key\)/, kind);
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
    `${'LL'}M_${'12345'}_${alnum(40)}`, // Meta: app id too short
    `${'LL'}M_${'123456789012345'}_short`, // Meta: secret too short
    `${'LL'}M_app_${alnum(40)}`, // Meta: no numeric app id
    `MY_${'LL'}M_${'123456789012345'}_${alnum(40)}`, // Meta: inside a longer word
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
