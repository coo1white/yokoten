// Tests for src/rules/privacy/secrets.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DOCS_URL,
  formatFinding,
  isFailingFinding,
  isWarningFinding,
} from '../../../src/rules/message.ts';
import { addedIgnores, loadIgnores, scanText } from '../../../src/rules/privacy/index.ts';
import { findEnvironmentValues, findLineIgnores, findSecretCandidates, findSecretHits, makeSecretHider, SECRET, SECRET_CONTROL } from '../../../src/rules/privacy/secrets.ts';
import { assertLinear } from '../../../scripts/linear.ts';
import { at, makeTempDir } from '../../repo/helpers.ts';

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

const NEAR_MISSES = [
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

test('secrets: one anchor pass selects every fixed pattern and the PEM header (#710)', () => {
  const indexed: [string, number[]][] = [
    ['ghp_', [0]], ['gho_', [0]], ['ghu_', [0]], ['ghs_', [0]], ['ghr_', [0]],
    ['github_pat_', [1]], ['npm_', [2]], ['AKIA', [3]], ['ASIA', [3]],
    ['xoxa-', [4]], ['xoxb-', [4]], ['xoxp-', [4]], ['xoxr-', [4]], ['xoxs-', [4]],
    ['sk_live_', [5]], ['rk_live_', [5]], ['AIza', [6]], ['sk-ant-', [7, 9]],
    ['sk-proj-', [8, 9]], ['sk-svcacct-', [8, 9]], ['sk-admin-', [8, 9]], ['sk-', [9]], ['LLM_', [10]],
  ];
  for (const [line, patterns] of indexed) assert.deepEqual(findSecretCandidates(line).patterns, patterns, line);
  assert.deepEqual(findSecretCandidates('ordinary words and code'), { patterns: [], hasPrivateKey: false });
  assert.deepEqual(findSecretCandidates(`-----BEGIN RSA ${'PRIVATE'} KEY-----`), { patterns: [], hasPrivateKey: true });
});

test('secrets: each fixed kind is found directly, and every near miss passes (#710)', () => {
  for (const [kind, line] of SECRETS) assert.deepEqual(findSecretHits([line]).map((hit) => hit.kind), [kind], kind);
  for (const line of NEAR_MISSES) assert.deepEqual(findSecretHits([line]), [], line);
});

test('secrets: the hider redacts every fixed kind and leaves no secret content (#710)', () => {
  for (const [kind, line] of SECRETS) {
    const [hit] = findSecretHits([line]);
    const value = line.slice(hit.start, hit.end);
    const hidden = makeSecretHider()(line);
    assert.ok(hidden.includes(SECRET), `${kind}: no hidden marker`);
    assert.ok(!hidden.includes(value), `${kind}: a secret remains`);
  }
  const example = `${'AK'}IA${'IOSFODNN7'}EXAMPLE`;
  assert.equal(makeSecretHider()(example), example, 'the AWS docs example stays');
});

test('secrets: the hider keeps PEM state across pieces (#710)', () => {
  const body = 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn';
  const header = pem('RSA ');
  const end = `-----END RSA ${'PRIVATE'} KEY-----`;
  const hide = makeSecretHider();
  assert.equal(hide(`${header}\n`), `${SECRET}\n`);
  assert.equal(hide(`${body}\n`), `${SECRET}\n`);
  assert.equal(hide(`${end}\n`), `${SECRET}\n`);
  assert.equal(hide('ordinary line\n'), 'ordinary line\n');
});

test('secrets: a long clean line and a token at the end scan linearly (#710)', () => {
  const clean = (size: number) => 'ordinary words and code '.repeat(Math.ceil(size / 24)).slice(0, size);
  const withToken = (size: number) => `${clean(size)} ${'gh'}p_${alnum(36)}`;
  assertLinear('secret scan: a long clean line', clean, (line) => assert.deepEqual(findSecretHits([line]), []), 1 << 15);
  assertLinear('secret scan: a token at the end', withToken, (line) => assert.equal(findSecretHits([line]).length, 1), 1 << 15);
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
  const token = alnum(32);
  const keyName = 'api_' + 'key';
  const marker = ['yokoten', 'ignore'].join('-');
  const [found] = scanText(`${keyName} = "${token}" // ${marker} secret: a test fixture`, { file: 'a' });
  assert.equal(found.grade, 'likely');
  assert.equal(found.ignored, 'a test fixture');
  assert.equal(isFailingFinding(found), false);
  assert.match(formatFinding(found), /\[likely; ignored: a test fixture\]/);
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
  for (const ok of NEAR_MISSES) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
});

test('secrets: privacy.allow lets a listed string through (#8)', () => {
  const key = `${'AI'}za${alnum(35)}`;
  assert.deepEqual(scanText(`maps key ${key}`, { file: 'a', allow: [key] }), []);
  assert.equal(scanText(`maps key ${key}`, { file: 'a', allow: ['something else'] }).length, 1);
});

test('secrets: a sure secret can not be ignored on its line, only in .yokotenignore (#616)', () => {
  const token = `${'gh'}p_${alnum(36)}`;
  const marker = ['yokoten', 'ignore'].join('-');
  const line = `token ${token} // ${marker} secret: a test fixture`;
  const [found] = scanText(line, { file: 'a' });
  assert.equal(found.grade, 'sure');
  assert.equal(found.ignored, undefined);
  assert.equal(isFailingFinding(found), true, 'the comment does not let it through');
  assert.match(found.fix, /can't be ignored on its line/);
  assert.match(found.fix, /\.yokotenignore/);
  assert.ok(!JSON.stringify(found).includes(token));
  const [fromFile] = scanText(line, { file: 'a', ignores: [{ rule: 'secret', reason: 'the lead says so' }] });
  assert.equal(fromFile.ignored, 'the lead says so');
  assert.equal(isFailingFinding(fromFile), false, 'the lead-only file does');
});

test('privacy: a private-mark hit can not be ignored on its line, only in .yokotenignore (#616)', () => {
  const marker = ['yokoten', 'ignore'].join('-');
  const line = `Deploy to Secret-Box # ${marker} private-mark: a public name`;
  const found = scanText(line, { file: 'a', marks: ['secret-box'] });
  const mark = found.find((f) => f.id === 'private-mark');
  assert.ok(mark);
  assert.equal(mark.ignored, undefined);
  assert.equal(isFailingFinding(mark), true);
  const refused = found.find((f) => f.id === 'ignore');
  assert.ok(refused, 'the comment itself fails');
  assert.match(refused.what, /can't be ignored on its line/);
  assert.equal(isFailingFinding(refused), true);
  assert.ok(!JSON.stringify(found).toLowerCase().includes('secret-box'), 'the mark never appears');
  const fromFile = scanText('Deploy to Secret-Box', { file: 'a', marks: ['secret-box'], ignores: [{ rule: 'private-mark', reason: 'a product name' }] });
  assert.equal(fromFile.length, 1);
  assert.equal(isFailingFinding(fromFile[0]), false);
});

test('ignores: text that is not a file reads no comment, so a post can not ignore a hit (#616)', () => {
  const marker = ['yokoten', 'ignore'].join('-');
  const [found] = scanText(`mail someone${at}gmail.com # ${marker} email: a test inbox`, { file: 'post', inlineIgnores: false });
  assert.equal(found.id, 'email');
  assert.equal(isFailingFinding(found), true);
});

test('secrets: short, one-kind and placeholder environment values are not matched (#616)', () => {
  const real = `${'envSecret'}${'Value'}1234`;
  const env = {
    SERVICE_TOKEN: real,
    SHORT_TOKEN: 'aB3dE6gH', // 8 characters
    COUNT_TOKEN: '123456789012', // digits only
    WORD_SECRET: 'productionmode', // one kind of character
    REPEAT_KEY: 'aaaaBBBB1111', // too few different characters
    EXAMPLE_TOKEN: 'your-token-here',
    APP_KEY_FILE: 'some/Path/To/Key-123',
  };
  assert.deepEqual(findEnvironmentValues(env), [real]);
  const text = Object.values(env).join('\n');
  const found = scanText(text, { file: 'a', env });
  assert.equal(found.filter((f) => f.what === 'a secret (environment value)').length, 1);
});

test('ignores: each ignore a pull request adds is a note with its reason; old lines are not (#616)', () => {
  const marker = ['yokoten', 'ignore'].join('-');
  const token = `${'gh'}p_${alnum(36)}`;
  const text = [`const a = 1; // ${marker} secret: a fixture`, `const b = 2; // ${marker} email: old`, `// ${marker} ip: rotated ${token}`].join('\n');
  const found = addedIgnores('src/a.ts', text, new Set([1, 3]), {});
  assert.deepEqual(found.map((f) => [f.id, f.line, f.ignored]), [['ignore-added', 1, 'a fixture'], ['ignore-added', 3, 'rotated <secret>']]);
  assert.match(found[0].what, /lets a secret hit through on this line/);
  assert.ok(!JSON.stringify(found).includes(token), 'a secret in a reason never appears');
  const file = addedIgnores('.yokotenignore', 'email: old\nsecret: test fixtures\n', new Set([2]), {});
  assert.deepEqual(file.map((f) => [f.line, f.ignored]), [[2, 'test fixtures']]);
  assert.match(file[0].what, /lets secret hits through in the whole repo/);
  assert.deepEqual(addedIgnores('src/a.ts', text, new Set(), {}), []);
});

test('an ignore in an HTML comment ends at --> and at --!>', () => {
  for (const line of ['<!-- yokoten-ignore secret: a sample key -->', '<!-- yokoten-ignore secret: a sample key --!>']) {
    assert.deepEqual(findLineIgnores(line, { commentsOnly: true }), [{ rule: 'secret', reason: 'a sample key' }], line);
  }
});
