// Tests for src/rules/secrets.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DOCS_URL,
  formatFinding,
  isFailingFinding,
  isWarningFinding,
} from '../../src/rules/message.ts';
import { loadIgnores, scanText } from '../../src/rules/privacy.ts';
import { SECRET_CONTROL } from '../../src/rules/secrets.ts';
import { at, makeTempDir } from '../repo/helpers.ts';

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
    assert.deepEqual(problems, [{ id: 'secret', what: `a secret (${kind})`, why: 'a secret opens your accounts to anyone who can read the repo, and git keeps it after the file is gone', fix: 'remove it, rotate it, and keep it outside the repo', docs: `${DOCS_URL}#privacy`, file: 'conf.env', line: 2, grade: 'sure' }], line);
  }
});

test('secrets: a sure hit fails, a likely hit warns, and an unknown hit warns (#616)', () => {
  const tokenName = 'GITHUB_' + 'TOKEN';
  const sure = scanText(`${tokenName}=${'gh'}p_${alnum(36)}`, { file: 'a' });
  assert.equal(sure[0].grade, 'sure');
  assert.equal(isFailingFinding(sure[0]), true);
  const keyName = 'api_' + 'key';
  const likely = scanText(`${keyName} = "${alnum(32)}"`, { file: 'a' });
  assert.equal(likely[0].grade, 'likely');
  assert.equal(isFailingFinding(likely[0]), false);
  assert.equal(isWarningFinding(likely[0]), true);
  const secretName = 'client_' + 'secret';
  const unclear = 'abcdefghijklmnopqrstuvwxyz' + 'abcdef';
  const unknown = scanText(`${secretName} = "${unclear}"`, { file: 'a' });
  assert.equal(unknown[0].grade, 'unknown');
  assert.equal(isFailingFinding(unknown[0]), false);
});

test('privacy findings: email, IP and private-mark hits are graded sure (#616)', () => {
  const found = [
    scanText(`mail someone${at}gmail.com`, { file: 'a' })[0],
    scanText(`host ${[10, 0, 0, 5].join('.')}`, { file: 'a' })[0],
    scanText('Deploy to Secret-Box', { file: 'a', marks: ['secret-box'] })[0],
  ];
  for (const hit of found) {
    assert.equal(hit.grade, 'sure');
    assert.equal(isFailingFinding(hit), true);
  }
});

test('secrets: an ignore with a reason passes and stays in the output (#616)', () => {
  const token = `${'gh'}p_${alnum(36)}`;
  const marker = ['yokoten', 'ignore'].join('-');
  const [found] = scanText(`token ${token} // ${marker} secret: a test fixture`, { file: 'a' });
  assert.equal(found.grade, 'sure');
  assert.equal(found.ignored, 'a test fixture');
  assert.equal(isFailingFinding(found), false);
  assert.match(formatFinding(found), /\[sure; ignored: a test fixture\]/);
  assert.ok(!formatFinding(found).includes(token), 'the secret never appears');
  assert.ok(!JSON.stringify(found).includes(token), 'the secret never appears in JSON');
});

test('secrets: an ignore in a string does not hide a finding (#616)', () => {
  const token = `${'gh'}p_${alnum(36)}`;
  const marker = ['yokoten', 'ignore'].join('-');
  const [found] = scanText(`const note = "// ${marker} secret: not a comment"; const token = "${token}"`, { file: 'a' });
  assert.equal(found.ignored, undefined);
  assert.equal(isFailingFinding(found), true);
  assert.deepEqual(scanText(`/** Every \`${marker} secret: reason\` marker. */`, { file: 'a' }), [], 'a comment about the syntax is not a directive');
});

test('secrets: an ignore reason never echoes a detected value (#616)', () => {
  const value = alnum(32);
  const marker = ['yokoten', 'ignore'].join('-');
  const [found] = scanText(`api_key = "${value}" // ${marker} secret: rotated ${value}`, { file: 'a' });
  assert.equal(found.ignored, 'rotated <secret>');
  assert.equal(isFailingFinding(found), false);
  assert.ok(!JSON.stringify(found).includes(value), 'the secret never appears in the reason');
});

test('secrets: an ignore with no reason fails (#616)', () => {
  const token = `${'gh'}p_${alnum(36)}`;
  const marker = ['yokoten', 'ignore'].join('-');
  const found = scanText(`token ${token} // ${marker} secret`, { file: 'a' });
  const failure = found.find((hit) => /has no reason/.test(hit.what));
  assert.ok(failure);
  assert.equal(isFailingFinding(failure), true);
  assert.ok(!JSON.stringify(found).includes(token));
  assert.equal(scanText(`// ${marker} secret`, { file: 'a' }).length, 1, 'an ignore with no reason fails on its own');
  const rule = 'abcdef0123456789'.repeat(2);
  const text = scanText(`// ${marker} ${rule}`, { file: 'a' });
  assert.equal(text.length, 1);
  assert.ok(!JSON.stringify(text).includes(rule), 'the rule text is not printed');
});

test('secrets: a reason in .yokotenignore passes and is listed; a line with no reason fails (#616)', () => {
  const root = makeTempDir();
  const token = `${'gh'}p_${alnum(36)}`;
  writeFileSync(join(root, '.yokotenignore'), 'secret: a test fixture\n');
  let ignored = loadIgnores(root);
  assert.deepEqual(ignored.problems, []);
  const [found] = scanText(token, { file: 'a', ignores: ignored.entries });
  assert.equal(found.ignored, 'a test fixture');
  assert.equal(isFailingFinding(found), false);

  writeFileSync(join(root, '.yokotenignore'), 'secret\n');
  ignored = loadIgnores(root);
  assert.equal(ignored.problems.length, 1);
  assert.equal(ignored.problems[0].line, 1);
  assert.match(ignored.problems[0].what, /no reason/);
  assert.equal(isFailingFinding(ignored.problems[0]), true);
});

test('ignores: the rule name picks the finding, and an unknown rule fails (#616)', () => {
  const address = `someone${at}gmail.com`;
  const root = makeTempDir();
  writeFileSync(join(root, '.yokotenignore'), 'email: a public test inbox\n');
  let ignored = loadIgnores(root);
  const [found] = scanText(`mail ${address}`, { file: 'a', ignores: ignored.entries });
  assert.equal(found.id, 'email');
  assert.equal(found.grade, 'sure');
  assert.equal(found.ignored, 'a public test inbox');
  assert.equal(isFailingFinding(found), false);
  assert.match(formatFinding(found), /\[sure; ignored: a public test inbox\]/);
  assert.ok(!JSON.stringify(found).includes(address), 'the address never appears');
  const marker = ['yokoten', 'ignore'].join('-');
  const [onLine] = scanText(`mail ${address} // ${marker} email: a test fixture`, { file: 'a' });
  assert.equal(onLine.ignored, 'a test fixture');
  assert.equal(isFailingFinding(onLine), false);

  writeFileSync(join(root, '.yokotenignore'), 'colour: a test fixture\n');
  ignored = loadIgnores(root);
  assert.equal(ignored.problems.length, 1);
  assert.equal(ignored.problems[0].id, 'ignore');
  assert.equal(isFailingFinding(ignored.problems[0]), true);
});

test('secrets: a real value from a secret-looking environment variable is caught (#616)', () => {
  const value = `${'env'}${'Secret'}${'Value'}${'1234567890'}`;
  const found = scanText(`copied ${value}\n`, { file: 'a', env: { SERVICE_TOKEN: value } });
  assert.equal(found.length, 1);
  assert.equal(found[0].grade, 'sure');
  assert.equal(found[0].what, 'a secret (environment value)');
  assert.equal(isFailingFinding(found[0]), true);
  assert.ok(!formatFinding(found[0]).includes(value), 'the environment value never appears');
});

test('secrets: a path or an id variable is not an environment secret (#616)', () => {
  const path = `.config/${'yokoten'}/private-marks`;
  assert.deepEqual(scanText(`at ${path}`, { file: 'a', env: { YOKOTEN_PRIVATE_MARKS: path } }), []);
  assert.deepEqual(scanText('key ABCDEF12', { file: 'a', env: { GPG_KEY: 'ABCDEF12' } }), []);
  assert.deepEqual(scanText('key-12345678', { file: 'a', env: { SERVICE_KEY_ID: 'key-12345678' } }), []);
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
