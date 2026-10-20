// Tests for src/rules/privacy.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLinear } from '../../scripts/linear.ts';
import { at, makeTempDir } from '../repo/helpers.ts';
import { DEFAULTS, type Env } from '../../src/rules/config.ts';
import { checkCommand } from '../../src/rules/guards.ts';
import { formatFinding } from '../../src/rules/message.ts';
import {
  hideHome,
  homeIn,
  loadMarkKinds,
  loadMarks,
  lonePost,
  machineAllowed,
  machineAllowFile,
  makeRedactor,
  normalizeRemote,
  notUtc,
  ownMarks,
  POSITIVE_CONTROL,
  privateRemoteHosts,
  repoMarkKinds,
  scanText,
  withHome,
} from '../../src/rules/privacy.ts';

// Samples are built from pieces so this file passes its own check.
const ip = (...n: number[]) => n.join('.');

test('withHome: only the CLI entry falls back to the system home, and only when HOME is not a full path (#356)', () => {
  const system = () => '/home/someone';
  assert.deepEqual(withHome({ HOME: '/h', X: '1' }, system), { HOME: '/h', X: '1' });
  assert.deepEqual(withHome({ X: '1' }, system), { HOME: '/home/someone', X: '1' });
  assert.deepEqual(withHome({ HOME: 'relative' }, system), { HOME: '/home/someone' });
  assert.deepEqual(withHome({ HOME: '' }, () => 'also/relative'), { HOME: '' }, 'no full path anywhere: no home');
  const env: Env = { PATH: '/bin' };
  withHome(env, system);
  assert.deepEqual(env, { PATH: '/bin' }, 'the env it is given stays as it was');
  assert.equal(homeIn({ HOME: '/h' }), '/h');
  assert.throws(() => homeIn({}), /no home folder/, 'no fallback outside the CLI entry');
});

test('positive control: the known-bad sample is caught', () => {
  assert.equal(scanText(POSITIVE_CONTROL, { file: 'x' }).length, 2);
});

test('emails: personal ones are caught, noreply and examples are fine', () => {
  assert.equal(scanText(`me${at}gmail.com`, { file: 'a' }).length, 1);
  assert.match(formatFinding(scanText(`x\nmail me${at}mydomain.dev`, { file: 'a.md' })[0]), /^a\.md:2: an email/);
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
    `Git${at}GitHub.com:owner/repo`,
    `conf${at}test.local`,
    `1-me${at}users.noreply.gitlab.com`,
  ]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Still caught: a person at the same domains, and an SSH remote that names a private host.
  for (const bad of [`someone${at}gmail.com`, `someone${at}github.com`, `git${at}code.my-company.dev:team/app.git`, `git${at}github.com.my-company.dev:t/a`, `git${at}mygithub.com:t/a`]) {
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

test('IPs: spec section numbers and versions are not addresses (#382)', () => {
  const quad = ip(2, 3, 4, 2);
  for (const ok of [
    `§${ip(1, 2, 3, 4)}`,
    `see § ${ip(1, 2, 3, 4)}`,
    `section ${ip(4, 2, 1, 3)}`,
    `Section ${ip(4, 2, 1, 3)} says`,
    `sec. ${ip(4, 2, 1, 3)}`,
    `RFC 7230 ${ip(3, 2, 6, 1)}`,
    `RFC7230, ${ip(3, 2, 6, 1)}`,
    `v${ip(1, 2, 3, 4)}`,
    `v ${ip(1, 2, 3, 4)}`,
    `version ${ip(1, 2, 3, 4)}`,
    `${ip(1, 2, 3, 4)}-beta`,
    `${ip(1, 2, 3, 4)}+build.5`,
    `//! The decompressed dir stream, MS-OVBA ${quad}: project information,`,
    `/// The dir stream (MS-OVBA ${quad}) does not follow the format.`,
    `see [MS-XLS] ${quad}`,
    `ECMA-376 ${quad}`,
    `ISO 32000-1 ${quad}`,
    `ISO/IEC 29500 ${quad}`,
    `/// (MS-OVBA ${ip(2, 3, 1, 15)} to ${ip(2, 3, 1, 17)}). This reports what`,
    `${ip(2, 3, 1, 15)} to ${ip(2, 3, 1, 17)}`,
    `${ip(2, 3, 1, 15)} through ${ip(2, 3, 1, 17)}`,
    `MS-OVBA ${ip(2, 3, 1, 15)} to ${ip(2, 3, 1, 17)}`,
    `section ${ip(12, 3, 1, 15)} to ${ip(12, 3, 1, 70)}`,
  ]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Real addresses in prose, private ranges included, are still caught.
  for (const bad of [
    `connect to ${ip(8, 8, 8, 8)}`,
    `connect to ${ip(203, 0, 114, 9)} now`,
    `host ${ip(10, 0, 0, 5)}`,
    `gateway ${ip(192, 168, 1, 1)}`,
    `server ${ip(172, 16, 0, 9)}`,
    `${ip(10, 0, 0, 5)}-${ip(10, 0, 0, 9)}`,
    `pool ${ip(10, 0, 0, 1)} to ${ip(10, 0, 0, 9)}`,
    `${ip(192, 168, 1, 100)} through ${ip(192, 168, 1, 200)}`,
    // A bare range of public addresses is caught: only small section-shaped numbers are skipped.
    `${ip(203, 0, 114, 5)} to ${ip(203, 0, 114, 9)}`,
    `${ip(10, 0, 0, 1)} to ${ip(10, 0, 0, 9)}`,
    `${ip(8, 8, 8, 8)} to ${ip(8, 8, 8, 9)}`,
    `${ip(1, 1, 1, 1)} through ${ip(1, 1, 1, 3)}`,
    `${ip(2, 3, 1, 15)} to ${ip(2, 3, 2, 17)}`,
    `${ip(2, 3, 1, 15)} to ${ip(2, 3, 1, 99)}`,
    `dev ${ip(8, 8, 8, 8)}`,
    `insect. ${ip(8, 8, 8, 8)}`,
    `${ip(8, 8, 8, 8)}:53`,
  ]) {
    assert.ok(scanText(bad, { file: 'a' }).length >= 1, bad);
  }
  // Localhost is still fine, as before.
  assert.deepEqual(scanText(`connect to ${ip(127, 0, 0, 1)}`, { file: 'a' }), []);
});

test('web strings: retina image names and user agents are not private (#245)', () => {
  const ua = `Mozilla/5.0 (Windows NT 10.0) Chrome/${ip(120, 0, 0, 0)} Safari/537.36`;
  for (const ok of [`url("img/logo${at}2x.png")`, `icons/close${at}3x.webp`, `a${at}2X.JPEG b${at}10x.avif`, ua]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // A real address on the same line is still caught.
  const email = `someone${at}gmail.com`;
  assert.deepEqual(scanText(`url("img/logo${at}2x.png") ${email}`, { file: 'a' }).map((f) => f.id), ['email']);
  assert.deepEqual(scanText(`${ua} from ${ip(10, 0, 0, 5)}`, { file: 'a' }).map((f) => f.id), ['ip']);
  // Only a browser version is skipped: a URL or a path root still names the host.
  for (const bad of [`http://${ip(10, 0, 0, 5)}`, `https://${ip(8, 8, 8, 8)}/x`, `ssh:/${ip(8, 8, 8, 8)}`, `/${ip(8, 8, 8, 8)}`, `${ua} http://${ip(100, 64, 1, 2)}:8080`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
  // An address in a path is real, even after a letter and `/`; only browser versions are skipped.
  for (const bad of [`api/${ip(8, 8, 8, 8)}`, `hosts/${ip(10, 0, 0, 5)}`, `servers/${ip(192, 168, 1, 20)}`, `chrome/${ip(8, 8, 8, 8)}`, `MyChrome/${ip(8, 8, 8, 8)}`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
  for (const ok of [`Chrome/${ip(120, 0, 0, 0)}`, 'Edg/120.0.2210.91', `Firefox/${ip(121, 0, 1, 2)}`]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Not an image: still an email address.
  assert.equal(scanText(`me${at}2x.dev`, { file: 'a' }).length, 1);
});

test('private marks: matched without case, never echoed', () => {
  const problems = scanText('Deploy to Secret-Box tonight', { file: 'a', marks: ['secret-box'] });
  assert.equal(problems.length, 1);
  assert.ok(!/secret-box/i.test(JSON.stringify(problems)), 'the mark must not appear in the output');
});

test('private marks file: comments and blanks skipped, missing file is empty', () => {
  const dir = makeTempDir();
  const file = join(dir, 'marks');
  writeFileSync(file, '# header\n\nMyCity\n  myserver  \n');
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: file }), ['mycity', 'myserver']);
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: join(dir, 'none') }), []);
});

test('private marks file: the kind of each added mark, by its header or, under the old header, by shape (#410)', () => {
  const dir = makeTempDir('yokoten-');
  const file = join(dir, 'marks');
  writeFileSync(file, `# mine\nMyCity\n# added by yokoten from this machine: forge login\nOcto-Jdoe\n# added by yokoten from this machine\njane${at}personal-mail.dev\nbuild.private-host.dev\nold-login\n# mine again\nmyserver\n`);
  assert.deepEqual(loadMarkKinds({ YOKOTEN_PRIVATE_MARKS: file }), [
    { value: 'mycity', kind: null },
    { value: 'octo-jdoe', kind: 'forge login' },
    { value: `jane${at}personal-mail.dev`, kind: 'git email' },
    { value: 'build.private-host.dev', kind: 'private remote host' },
    // A bare name under the old header is never taken for a login.
    { value: 'old-login', kind: null },
    { value: 'myserver', kind: null },
  ]);
});

test('private marks: an added forge login is fine only where a file names accounts (#410)', () => {
  const scan = (file: string, text: string, logins = ['octo-jdoe']) => scanText(text, { file, marks: ['octo-jdoe'], logins }).filter((f) => f.id === 'private-mark').map((f) => f.line);
  // CODEOWNERS owners and @ mentions in .github.
  assert.deepEqual(scan('CODEOWNERS', '* @octo-jdoe @octo-jdoe/team\n# octo-jdoe\n'), [2]);
  assert.deepEqual(scan('.github/ISSUE_TEMPLATE/bug.md', `cc @octo-jdoe.\nmail x${at}octo-jdoe.dev\n`), [2]);
  // Person fields of a manifest, nested ones too; not other keys, not a minified file.
  const manifest = '{\n  "author": {\n    "name": "octo-jdoe",\n    "url": "https://github.com/octo-jdoe"\n  },\n  "maintainers": ["octo-jdoe"],\n  "homepage": "https://octo-jdoe.dev"\n}\n';
  assert.deepEqual(scan('.claude-plugin/marketplace.json', manifest), [7]);
  assert.deepEqual(scan('package.json', '{"author": "octo-jdoe"}\n'), [1]);
  // The copyright line of a license, not its other lines.
  assert.deepEqual(scan('LICENSE.md', 'Copyright (c) 2026 octo-jdoe\nby octo-jdoe\n'), [2]);
  // Anywhere else, and for a mark the owner wrote, it is found.
  assert.deepEqual(scan('src/x.ts', '// @octo-jdoe\n'), [1]);
  assert.deepEqual(scan('docs/a.md', 'Copyright octo-jdoe\n'), [1]);
  assert.deepEqual(scan('CODEOWNERS', '* @octo-jdoe\n', []), [1]);
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
  const real = makeTempDir('yokoten-home-');
  const link = `${real}-link`;
  symlinkSync(real, link);
  try {
    assert.equal(hideHome(`ran in ${realpathSync(real)}/away`, { HOME: link }), 'ran in ~/away', 'the real path of a linked home is hidden too');
  } finally {
    rmSync(link);
    rmSync(real, { recursive: true });
  }
});

test('output: a home path is hidden only where it ends (#205)', () => {
  const env = { HOME: '/data/u' };
  assert.equal(hideHome('a /data/u/x and /data/users/y', env), 'a ~/x and /data/users/y', 'a longer folder name is kept');
  assert.equal(hideHome('in /data/u. Then "/data/u", /data/u:/bin', env), 'in ~. Then "~", ~:/bin');
  assert.equal(hideHome('/data/u.bak and /data/u-old', env), '/data/u.bak and /data/u-old');
  const short = { HOME: '/h' };
  assert.equal(hideHome('see https://h.example/h and https://h/x', short), 'see https://h.example/h and https://h/x', 'a short home never garbles a URL');
  assert.equal(hideHome('/h', short), '~', 'the home alone is ~');
  assert.equal(hideHome('/x and /', { HOME: '/' }), '/x and /', 'a root home hides nothing');
});

test('output: both homes are hidden when HOME and the system home differ (#205)', () => {
  const options = { systemHome: '/home/u' };
  assert.equal(hideHome('a /tmp/x/f b /home/u/g', { HOME: '/tmp/x' }, options), 'a ~/f b ~/g');
  // Longest first: a home inside the other is replaced whole.
  assert.equal(hideHome('at /home/u/inner/f', { HOME: '/home/u/inner' }, options), 'at ~/f');
  assert.equal(hideHome('/home/u/g', { HOME: '/' }, options), '~/g', 'a root HOME still hides the system home');
});

test('output: a Windows home is hidden with either slash, any case, and in MSYS form (#205)', () => {
  const options = { platform: 'win32', systemHome: 'C:\\Users\\me' };
  assert.equal(hideHome('C:\\Users\\me\\a, c:/users/ME/b, /c/Users/me/c', {}, options), '~\\a, ~/b, ~/c');
  assert.equal(hideHome('C:\\Users\\meg\\a', {}, options), 'C:\\Users\\meg\\a');
  assert.equal(hideHome('/C/USERS/me', {}, { ...options, platform: 'linux' }), '/C/USERS/me', 'case counts off Windows');
});

test('output: a home path cut short at the end of a line is hidden (#404)', () => {
  const options = { systemHome: '/home/jonathan' };
  assert.equal(hideHome('see /home/jona\nsee /home/jonat', {}, options), 'see ~\nsee ~');
  assert.equal(hideHome('see /home/jonath\r\nnext', {}, options), 'see ~\r\nnext');
  // Fewer than 4 characters of the name, or a cut path inside a line, stays.
  assert.equal(hideHome('see /home/jon\nat /home/jona and on', {}, options), 'see /home/jon\nat /home/jona and on');
  assert.equal(hideHome('/home/jonas', {}, options), '/home/jonas', 'a longer name is another folder');
  // A cut that ends in an ellipsis or spaces is cut too.
  assert.equal(hideHome('a /home/jona…\nb /home/jonat...\nc /home/jonath  \nd /home/jon...', {}, options), 'a ~…\nb ~...\nc ~  \nd /home/jon...');
});

test('output: a home written in a URL, with %2F or %5C for its slashes, is hidden (#404)', () => {
  const options = { systemHome: '/home/jdoe' };
  assert.equal(hideHome('a %2Fhome%2Fjdoe%2Fx b %2fhome%2fjdoe', {}, options), 'a ~%2Fx b ~');
  assert.equal(hideHome('%2Fhome%2Fjdoex and x%2Fhome%2Fjdoe%2F', {}, options), '%2Fhome%2Fjdoex and x%2Fhome%2Fjdoe%2F', 'another folder stays');
});

// ---- Hiding the owner in command output (#390) ----

test('makeRedactor: patterns only, with no marks: private emails go, noreply and team ones stay', () => {
  const redact = makeRedactor({}, { HOME: '/home/someone' });
  assert.equal(redact(`by jane${at}personal-mail.dev and 1+jane${at}users.noreply.github.com\n`), `by <email> and 1+jane${at}users.noreply.github.com\n`);
  assert.equal(redact(`git${at}github.com:o/r and git${at}build.private-host.dev:o/r`), `git${at}github.com:o/r and git${at}<host>:o/r`);
  assert.equal(redact('at /home/someone/project'), 'at ~/project');
});

test('makeRedactor: owners, hosts and marks, by shape, case-insensitive, whole words only', () => {
  const redact = makeRedactor({ owners: ['Jane Example'], hosts: ['build.private-host.dev'], marks: ['jane example', 'fakeville', 'janex.dev', `me${at}janex.dev`, 'ann', 'xy', '東京'] }, {});
  assert.equal(redact('JANE EXAMPLE in Fakeville'), '<owner> in <mark>');
  assert.equal(redact('https://build.private-host.dev/x and www.janex.dev'), 'https://<host>/x and www.<host>');
  assert.equal(redact(`mail me${at}janex.dev`), 'mail <email>');
  // Inside a longer word it stays; two letters are too short to hide.
  assert.equal(redact('annual ann xy'), 'annual <mark> xy');
  assert.equal(redact('住在東京都'), '住在<mark>都');
  assert.equal(redact('line\r\nnext\n'), 'line\r\nnext\n');
});

test('makeRedactor: the home goes before the names, so /home/<name>/x becomes ~/x (#404)', () => {
  const redact = makeRedactor({ owners: ['jdoe'] }, { HOME: '/home/jdoe' });
  assert.equal(redact('at /home/jdoe/x\n'), 'at ~/x\n');
  assert.equal(redact('/mnt/c/Users/jdoe/x, C:\\Users\\jdoe\\x, "C:\\\\Users\\\\jdoe", jdoe'), '/mnt/c/Users/<owner>/x, C:\\Users\\<owner>\\x, "C:\\\\Users\\\\<owner>", <owner>');
  assert.equal(redact('jdoes and xjdoe stay'), 'jdoes and xjdoe stay', 'a longer word that holds the name is kept');
  assert.equal(redact('\\\\wsl$\\Ubuntu\\home\\jdoe\\x and /Users/jdoe/y'), '\\\\wsl$\\Ubuntu\\home\\<owner>\\x and /Users/<owner>/y');
});

test('makeRedactor: a name next to a URL-encoded slash, backslash or space is hidden (#404)', () => {
  const redact = makeRedactor({ owners: ['jdoe', 'JaneD'] }, {});
  assert.equal(redact('C:%5CUsers%5CJaneD%5Cx and c:%5cusers%5cjaned'), 'C:%5CUsers%5C<owner>%5Cx and c:%5cusers%5c<owner>');
  assert.equal(redact('%2Fsrv%2Fjdoe%2Fx, %20jdoe%20'), '%2Fsrv%2F<owner>%2Fx, %20<owner>%20');
  assert.equal(redact('vscode-remote://wsl%2Bubuntu/home/jdoe/x and vscode-remote://wsl%2Bubuntu%2Fhome%2Fjdoe%2Fx'), 'vscode-remote://wsl%2Bubuntu/home/<owner>/x and vscode-remote://wsl%2Bubuntu%2Fhome%2F<owner>%2Fx');
  assert.equal(redact('%2Fjdoes and %2Fxjdoe stay'), '%2Fjdoes and %2Fxjdoe stay');
});

test('privateRemoteHosts: hosts outside the public forges; local paths name none', () => {
  assert.deepEqual(
    privateRemoteHosts(['https://github.com/o/r.git', `git${at}gitlab.com:o/r.git`, `ssh://git${at}Build.Private-Host.dev:2222/o/r.git`, `git${at}gitea.home.dev:o/r`, `https://user${at}code.corp.dev/o/r`, '/srv/git/r.git', '../r', 'C:\\repos\\r', 'file:///srv/r', '']),
    ['build.private-host.dev', 'gitea.home.dev', 'code.corp.dev'],
  );
});

test('private marks: the commit check matches anywhere in a word; redact only whole words (#390)', () => {
  const hits = (text: string, mark: string) => scanText(text, { file: 'a', marks: [mark] }).length;
  assert.equal(hits('Ann wrote this', 'ann'), 1);
  assert.equal(hits('annotate the code', 'ann'), 1, 'the commit check keeps its wider match');
  const redact = makeRedactor({ marks: ['ann'] }, {});
  assert.equal(redact('Ann wrote this, then annotate'), '<mark> wrote this, then annotate');
});

test('makeRedactor: secrets become <secret>, a private key line by line, across pieces (#390)', () => {
  const token = `${'gh'}p_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
  const redact = makeRedactor({}, {});
  assert.equal(redact(`token: ${token} ok\n`), 'token: <secret> ok\n');
  assert.equal(redact('AKIAIOSFODNN7EXAMPLE is the docs sample\n'), 'AKIAIOSFODNN7EXAMPLE is the docs sample\n');
  // A key that starts in one piece and ends in the next is hidden whole.
  assert.equal(redact(`-----BEGIN RSA ${'PRIVATE'} KEY-----\r\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\n`), '<secret>\r\n<secret>\n');
  assert.equal(redact(`abcdEFGHijklMNOPqrst\n-----END RSA ${'PRIVATE'} KEY-----\nafter\n`), '<secret>\n<secret>\nafter\n');
  // Code that names the header is not a key.
  assert.equal(redact(`if (text.includes('-----BEGIN RSA ${'PRIVATE'} KEY-----')) x\nnext\n`), `if (text.includes('-----BEGIN RSA ${'PRIVATE'} KEY-----')) x\nnext\n`);
});

// ---- Text an agent posts (#391): the guard runs the privacy check on it ----

// A sandbox: its own HOME, a marks file, and a folder for body files. The samples are
// built from pieces so this file does not fail its own commit check.
const postDir = makeTempDir('yokoten-posts-');
const postMarks = join(postDir, 'private-marks');
writeFileSync(postMarks, '# my marks\nquietvale\n');
const postEnv: Env = { HOME: postDir, YOKOTEN_PRIVATE_MARKS: postMarks };
const email = `someone${'@'}personal-mail.com`;
const token = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;

const post = (command: string, config: typeof DEFAULTS = DEFAULTS) => checkCommand(command, { env: postEnv, config, cwd: postDir });

test('an inline --body with an email address is stopped, with the same fix as the commit check', () => {
  const f = post(`gh issue create --title "check: fix a bug" --body "write to ${email}"`);
  assert.equal(f?.id, 'email');
  assert.equal(f?.what, 'the --body text holds an email address');
  const text = formatFinding(f);
  assert.match(text, /a post is public the moment it is sent/);
  assert.match(text, /noreply address/);
  assert.match(text, /privacy\.allow/);
  assert.ok(!text.includes(email), 'the address itself is never printed');
});

test('the other text options and their forms are read', () => {
  for (const command of [
    `gh pr create --title "feat: thank ${email}" --body ok`,
    `gh pr comment 3 -b "${email}"`,
    `gh pr comment 3 -b"${email}"`,
    `gh issue edit 3 --body="${email}"`,
    `gh pr review 3 --comment --body "${email}"`,
    `gh -R o/r issue comment 3 --body "${email}"`,
    `nice gh issue create -t "check: add x" -b "${email}"`,
  ]) {
    assert.equal(post(command)?.id, 'email', command);
  }
});

test('a --body-file with a private mark is stopped, by file and line; the mark is never printed', () => {
  writeFileSync(join(postDir, 'body.md'), 'Summary\n\nTested in QuietVale.\n');
  for (const command of ['gh pr create --title "feat: add t" --body-file body.md', 'gh issue comment 3 -F body.md', `gh pr create --body-file ${join(postDir, 'body.md')}`]) {
    const f = post(command);
    assert.equal(f?.id, 'private-mark', command);
    assert.equal(f?.line, 3);
    assert.ok(!formatFinding(f).toLowerCase().includes('quietvale'));
  }
});

test('release notes are read when a release is allowed', () => {
  writeFileSync(join(postDir, 'notes.md'), `thanks ${email}\n`);
  const approved = (command: string) => checkCommand(command, { env: { ...postEnv, YOKOTEN_RELEASE_APPROVAL: '1' }, config: DEFAULTS, cwd: postDir });
  assert.equal(approved(`gh release create v1 --notes "${email}"`)?.id, 'email');
  assert.equal(approved('gh release edit v1 --notes-file notes.md')?.id, 'email');
  assert.equal(approved('gh release create v1 --notes "clean notes"'), null);
});

test('gh api fields and input files are read', () => {
  assert.equal(post(`gh api repos/o/r/issues/1/comments -f body="token ${token}"`)?.id, 'secret');
  assert.equal(post(`gh api repos/o/r/issues -F title="check: add x" -F body="${email}"`)?.id, 'email');
  assert.equal(post(`gh api repos/o/r/issues --raw-field=body=${email}`)?.id, 'email');
  writeFileSync(join(postDir, 'payload.json'), JSON.stringify({ body: email }));
  assert.equal(post('gh api repos/o/r/issues --input payload.json')?.id, 'email');
  assert.equal(post('gh api repos/o/r/issues -F body=@body.md')?.id, 'private-mark');
  assert.equal(post('gh api repos/o/r/issues -f body="all clean"'), null);
});

test('a secret is named by kind, never printed', () => {
  const f = post(`gh pr comment 1 --body "use ${token}"`);
  assert.equal(f?.id, 'secret');
  assert.ok(!formatFinding(f).includes(token));
});

test('yokoten bot -- gh is read the same way', () => {
  assert.equal(post(`yokoten bot -- gh pr create --title "feat: add t" --body "${email}"`)?.id, 'email');
  assert.equal(post(`node bin/yokoten.ts bot -- gh issue comment 3 --body "${email}"`)?.id, 'email');
  assert.equal(post('yokoten bot -- gh pr create --title "feat: add t" --body "clean"'), null);
});

test('an inline heredoc body is read, with its line', () => {
  const f = post(`gh pr create --title "feat: add t" --body "$(cat <<'EOF'\nSummary\n\nmail ${email}\nEOF\n)"`);
  assert.equal(f?.id, 'email');
  assert.match(f?.what ?? '', /line 4/);
  // A body from stdin: the heredoc fed to it is read.
  assert.equal(post(`gh pr create --title "feat: add t" --body-file - <<'EOF'\nmail ${email}\nEOF`)?.id, 'email');
  assert.equal(post(`gh pr create --title "feat: add t" --body-file - <<'EOF'\nall clean\nEOF`), null);
});

test('clean text, allowed addresses and other commands pass', () => {
  for (const command of [
    'gh pr create --title "feat: x" --body "Closes issue #3"',
    'gh issue create --title "check: add t" --body "by 12345+bot@users.noreply.github.com"',
    `gh issue create --title "check: add t" --body "ask support${'@'}example.com"`,
    'gh pr create --fill',
    `gh pr view 3 --comments`,
    `echo gh issue create --body "${email}"`,
    `gh pr list --search "${email}"`,
  ]) {
    assert.equal(post(command), null, command);
  }
});

test('privacy.allow in yokoten.json lets an address through', () => {
  const config = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: [email] } };
  assert.equal(post(`gh issue create --title "check: add t" --body "${email}"`, config), null);
});

test('API reads pass; API writes and GraphQL mutations are read (#391 review)', () => {
  assert.equal(post(`gh api graphql -f query='query { search(query: "${email}") { issueCount } }'`), null);
  assert.equal(post(`gh api graphql -f query='mutation { addComment(input: {body: "${email}"}) { clientMutationId } }'`)?.id, 'email');
  assert.equal(post(`gh api search/issues -f q="${email}"`), null);
  assert.equal(post(`gh api -X GET repos/o/r/issues -f creator="${email}"`), null);
  assert.equal(post(`gh api -X POST repos/o/r/labels -f description="${email}"`)?.id, 'email');
  assert.equal(post(`gh api --method=PATCH repos/o/r/issues/1 -f body="${email}"`)?.id, 'email');
  assert.equal(post(`gh api repos/o/r/issues/1/comments -F body=@- <<'EOF'\nmail ${email}\nEOF`)?.id, 'email');
});

test('a stdin body: only the heredoc is read, not the rest of the command (#391 review)', () => {
  assert.equal(post(`cd /srv/quietvale-site && gh pr create --title "feat: add t" --body-file - <<'EOF'\nall clean\nEOF`), null);
  assert.equal(post(`gh pr comment 3 --body-file - <<'EOF'\nfrom QuietVale\nEOF`)?.id, 'private-mark');
  assert.equal(post('gh pr comment 3 --body-file -'), null, 'stdin from another program is not seen');
});

test('a relative body file follows cd; one the guard cannot place stops the command (#391 review)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  writeFileSync(join(postDir, 'sub', 'note.md'), 'Seen in QuietVale.\n');
  assert.equal(post('cd sub && gh issue comment 3 --body-file note.md')?.id, 'private-mark');
  assert.equal(post(`cd ${join(postDir, 'sub')} && gh issue comment 3 --body-file note.md`)?.id, 'private-mark');
  for (const command of ['cd "$X" && gh issue comment 3 --body-file note.md', 'gh pr create --body-file missing.md', 'cd sub && gh pr create --body-file body.md']) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.match(f?.fix ?? '', /full path/);
  }
});

test('privacy comes before the title, and a file path in a finding hides home and marks (#391 review)', () => {
  const titled = checkCommand(`gh issue create --title "Mail ${email}" --body ok`, { env: postEnv, config: DEFAULTS, cwd: postDir, titles: true });
  assert.equal(titled?.id, 'email');
  mkdirSync(join(postDir, 'quietvale'), { recursive: true });
  writeFileSync(join(postDir, 'quietvale', 'notes.md'), `ask ${email}\n`);
  const f = post(`gh pr create --body-file ${join(postDir, 'quietvale', 'notes.md')}`);
  assert.equal(f?.id, 'email');
  assert.equal(f?.file, 'notes.md', 'the folder holds a mark, so only the name is shown');
  writeFileSync(join(postDir, 'plain.md'), `ask ${email}\n`);
  assert.equal(post(`gh pr create --body-file ${join(postDir, 'plain.md')}`)?.file, '~/plain.md');
});

test('merge, close and review text is read (#391 review)', () => {
  for (const command of [
    `gh pr merge 3 --squash --subject "feat: thank ${email}"`,
    `gh pr merge 3 --body "${email}"`,
    `gh issue close 3 --comment "${email}"`,
    `gh pr close 3 -c "${email}"`,
    `gh pr review 3 --approve --body "${email}"`,
  ]) {
    assert.equal(post(command)?.id, 'email', command);
  }
});

test('a < file or a <<< here-string feeding stdin is read (#391 review)', () => {
  assert.equal(post('gh pr create --title "feat: add t" --body-file - < body.md')?.id, 'private-mark');
  assert.equal(post('gh pr create --title "feat: add t" --body-file - <body.md')?.id, 'private-mark');
  assert.equal(post(`gh issue comment 3 -F - <<< "mail ${email}"`)?.id, 'email');
  assert.equal(post('gh issue comment 3 --body "a < b.md"'), null, 'a quoted < is text');
});

test('only regular files up to 1 MB are read; others pass unread (#391 review)', () => {
  mkdirSync(join(postDir, 'folder'), { recursive: true });
  assert.equal(post('gh pr create --body-file folder'), null);
  writeFileSync(join(postDir, 'big.md'), `${email}\n${'x'.repeat(1024 * 1024)}`);
  assert.equal(post('gh pr create --body-file big.md'), null);
});

// ---- A project allows its own name (#424) ----

test('ownMarks and scanText: a mark the project allows, same string case aside, is not reported (#424)', () => {
  const marks = ['quietvale', 'quietvale labs', 'vale'];
  assert.deepEqual(ownMarks(marks, ['QuietVale']), ['quietvale']);
  const hits = (text: string, allow: string[]) => scanText(text, { file: 'a', marks: ['quietvale'], allow }).length;
  assert.equal(hits('QuietVale ships', ['QUIETVALE']), 0, 'case does not matter');
  assert.equal(hits('QuietVale ships', []), 1, 'with no allow, it is stopped');
  // Near misses: a part, a longer string, or spaces around it allow nothing.
  for (const allow of [['quiet'], ['quietvale2'], ['quietvale labs'], [' quietvale'], ['quietval'], ['xquietvale']]) {
    assert.equal(hits('QuietVale ships', allow), 1, JSON.stringify(allow));
  }
  // Allowing one mark leaves the longer and shorter marks that hold it.
  const all = (text: string) => scanText(text, { file: 'a', marks, allow: ['quietvale'] }).length;
  assert.equal(all('QuietVale ships'), 1, 'the shorter mark vale still matches');
  assert.equal(all('QuietVale Labs ships'), 2, 'quietvale labs and vale still match');
  const finding = scanText('QuietVale Labs', { file: 'a', marks, allow: ['quietvale'] }).map((f) => formatFinding(f)).join('\n');
  assert.ok(!/quietvale|vale/i.test(finding), 'no mark is printed');
});

test('checkPost: the project that allows the mark posts; another project with the same marks file is stopped (#424)', () => {
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  const command = 'gh issue create --title "check: fix a bug" --body "QuietVale ships"';
  assert.equal(post(command, allowing), null);
  const stopped = post(command);
  assert.equal(stopped?.id, 'private-mark');
  assert.ok(!/quietvale/i.test(formatFinding(stopped)), 'the mark is never printed');
  // A near miss in privacy.allow allows nothing.
  assert.equal(post(command, { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVal'] } })?.id, 'private-mark');
});

// ---- The machine allows a mark in one repo (#447) ----

test('normalizeRemote: host and path, with no scheme, user info, default port or .git; the host case aside (#447)', () => {
  for (const url of [
    'https://example.com/octo/app',
    'https://someone:secret@Example.COM:443/octo/app.git',
    'ssh://git@EXAMPLE.com:22/octo/app.git/',
    'git@example.com:octo/app.git',
    'example.com:octo/app',
    '  git://example.com/octo/app/  ',
  ]) {
    assert.equal(normalizeRemote(url), 'example.com/octo/app', url);
  }
  assert.equal(normalizeRemote('https://example.com:8443/octo/app.git'), 'example.com:8443/octo/app', 'another port is another server');
  assert.equal(normalizeRemote('ssh://git@example.com:2222/octo/app'), 'example.com:2222/octo/app');
  assert.equal(normalizeRemote('https://example.com/Octo/App'), 'example.com/Octo/App', 'the path keeps its case');
  // A local path is the folder itself: absolute, and a relative one against the repo's top folder.
  const base = makeTempDir('yokoten-remote-');
  mkdirSync(join(base, 'one'));
  mkdirSync(join(base, 'two'));
  assert.equal(normalizeRemote('/srv/git/app.git'), '/srv/git/app.git');
  assert.equal(normalizeRemote('file:///srv/git/app.git'), '/srv/git/app.git');
  assert.equal(normalizeRemote('../up.git', join(base, 'one')), join(realpathSync(base), 'up.git'));
  assert.notEqual(normalizeRemote('../x', join(base, 'one', 'a')), normalizeRemote('../x', join(base, 'two', 'a')), 'the same relative path from another folder is another repo');
  assert.equal(normalizeRemote('../x'), null, 'a relative path with no base is unread');
  assert.ok(!normalizeRemote('C:/git/app.git', base)?.startsWith('c/'), 'a Windows drive is not a host');
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote('https://example.com'), null, 'a host with no path names no repo');
});

test('normalizeRemote: linear on long input (#447)', () => {
  const inputs: [string, (n: number) => string][] = [
    ['trailing slashes', (n) => `example.com:a${'/'.repeat(n)}x`],
    ['slashes only', (n) => `https://example.com/${'/'.repeat(n)}`],
    ['at signs', (n) => `${'a@'.repeat(n / 2)}:x`],
    ['colons', (n) => `${'a:'.repeat(n / 2)}`],
    ['no colon', (n) => 'a'.repeat(n)],
  ];
  for (const [name, make] of inputs) assertLinear(name, make, (text) => normalizeRemote(text, '/base'));
});

/** A repo with an origin remote, or none, and a marks file and an allow file beside it. */
function allowRepo(remote: string | null) {
  const base = makeTempDir('yokoten-allow-');
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), TZ: 'UTC' }, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', `1+test${at}users.noreply.github.com`);
  if (remote) git('remote', 'add', 'origin', remote);
  const marks = join(base, 'private-marks');
  writeFileSync(marks, 'quietvale\nquietvale labs\n');
  const env: Env = { HOME: base, YOKOTEN_PRIVATE_MARKS: marks };
  const allow = (repos: unknown) => writeFileSync(machineAllowFile(env), typeof repos === 'string' ? repos : JSON.stringify({ repos }));
  return { base, repo, env, git, allow };
}

const TWO_ADDRESSES = { allow: [], unsure: 'the origin remote has more than one address' };

test('machineAllowed: the entry for this remote allows its marks; another remote, two entries or a bad file allow nothing (#447)', () => {
  const { repo, env, git, allow } = allowRepo('https://someone@Example.com/octo/app.git');
  assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: null }, 'no file: nothing, and not unsure');
  allow([{ remote: 'example.com/octo/app', allow: ['QuietVale'] }]);
  assert.deepEqual(machineAllowed(env, repo), { allow: ['quietvale'], unsure: null });
  assert.deepEqual(repoMarkKinds(env, repo).map((mark) => mark.value), ['quietvale labs'], 'the longer mark is still looked for');
  allow([{ remote: 'example.com/octo/app', folder: repo, allow: ['quietvale'] }]);
  assert.equal(machineAllowed(env, repo).unsure, "this machine's allow file is not in the shape yokoten writes", 'an old folder entry is refused');
  allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }, { remote: 'EXAMPLE.com/octo/app', allow: ['quietvale'] }]);
  assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: "two entries in this machine's allow file match this repo" });
  allow('{"repos": [quietvale');
  const bad = machineAllowed(env, repo);
  assert.deepEqual(bad.allow, []);
  assert.ok(bad.unsure && !/quietvale/i.test(bad.unsure), 'a broken file is unsure, and never quoted');
  allow([{ remote: 'example.com/octo/app', allow: 'quietvale' }]);
  assert.equal(machineAllowed(env, repo).unsure, "this machine's allow file is not in the shape yokoten writes");
  allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  assert.deepEqual(machineAllowed(env, null).allow, [], 'a guard that cannot tell where it runs allows nothing');
  git('remote', 'set-url', 'origin', 'https://example.com/octo/renamed.git');
  assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: null }, 'a renamed remote is no longer allowed');
});

test('machineAllowed: every fetch and push address of origin, as git rewrites them, must name the same repo (#447)', () => {
  const { repo, env, git, allow } = allowRepo('https://example.com/octo/app');
  allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  // A second fetch address of the same repo, in another form, is fine; of another repo, unsure.
  git('remote', 'set-url', '--add', 'origin', 'git@example.com:octo/app.git');
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale']);
  git('remote', 'set-url', '--add', 'origin', 'https://example.com/octo/public');
  assert.deepEqual(machineAllowed(env, repo), TWO_ADDRESSES);
  git('remote', 'set-url', '--delete', 'origin', 'octo/public');
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale']);
  // A push address elsewhere: a push goes there, so unsure.
  git('remote', 'set-url', '--push', 'origin', 'https://example.com/octo/public');
  assert.deepEqual(machineAllowed(env, repo), TWO_ADDRESSES);
  git('config', '--unset-all', 'remote.origin.pushurl');
  // insteadOf is applied, as git applies it: the short name reads as the repo it stands for.
  git('config', 'url.https://example.com/.insteadOf', 'ex:');
  git('config', '--unset-all', 'remote.origin.url');
  git('config', 'remote.origin.url', 'ex:octo/app');
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale'], 'insteadOf names the allowed repo');
  git('config', 'url.https://example.com/octo/public.insteadOf', 'ex:octo/app');
  assert.deepEqual(machineAllowed(env, repo).allow, [], 'insteadOf to another repo is that repo');
  git('config', '--unset-all', 'url.https://example.com/octo/public.insteadOf');
  git('config', 'url.https://example.com/octo/public.pushInsteadOf', 'ex:octo/app');
  assert.deepEqual(machineAllowed(env, repo), TWO_ADDRESSES, 'pushInsteadOf to another repo is unsure');
});

test('machineAllowed: origin must be the only remote, with no gh default and no push elsewhere (#447)', () => {
  const { repo, env, git, allow } = allowRepo('https://example.com/octo/app');
  allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale']);
  const unsure = (why: string, label: string) => assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: why }, label);
  git('remote', 'add', 'upstream', 'https://example.com/octo/app');
  unsure('this repo has a remote other than origin', 'a second remote, even to the same repo: gh may pick it');
  git('remote', 'remove', 'upstream');
  git('config', 'remote.origin.gh-resolved', 'base');
  unsure('gh is set to a repo of its own (gh repo set-default)', 'gh-resolved');
  git('config', '--unset', 'remote.origin.gh-resolved');
  git('config', 'remote.pushDefault', 'origin');
  unsure('a push may go to another remote (remote.pushDefault or branch.*.pushRemote)', 'remote.pushDefault');
  git('config', '--unset', 'remote.pushDefault');
  git('config', 'branch.main.pushRemote', 'origin');
  unsure('a push may go to another remote (remote.pushDefault or branch.*.pushRemote)', 'branch.*.pushRemote');
  git('config', '--unset', 'branch.main.pushRemote');
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale'], 'back to one plain origin');
  git('remote', 'remove', 'origin');
  assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: null }, 'no origin: no machine allow, and nothing unsure');
  git('remote', 'add', 'other', 'https://example.com/octo/app');
  unsure('this repo has a remote other than origin', 'only a remote with another name');
});

test('checkPost: the allow applies only to a post to the repo the command runs in (#447)', () => {
  const own = allowRepo('https://example.com/octo/app');
  const other = allowRepo('https://example.com/octo/other');
  own.allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  // The other repo reads the same allow file.
  const env = own.env;
  const body = '--title "check: fix a bug" --body "QuietVale ships"';
  const post = (command: string, cwd: string, { config, extra = {} }: { config?: typeof DEFAULTS; extra?: Env } = {}) => checkCommand(command, { env: { ...env, ...extra }, config, cwd });
  assert.equal(post(`gh issue create ${body}`, own.repo), null, 'with no yokoten.json, the guard lets it through');
  const stopped = post(`gh issue create ${body}`, other.repo);
  assert.equal(stopped?.id, 'private-mark');
  assert.ok(!/quietvale/i.test(formatFinding(stopped)), 'the mark is never printed');
  assert.equal(post(`gh issue create ${body.replace('QuietVale', 'QuietVale Labs')}`, own.repo)?.id, 'private-mark', 'the longer mark is still stopped');
  // A post that names another target gets no allow, from the machine or from yokoten.json (#424).
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  const targets: [string, Env?][] = [
    [`gh issue create -R octo/public ${body}`],
    [`gh issue create --repo=octo/public ${body}`],
    [`gh -R octo/public issue comment 1 ${body}`],
    [`GH_REPO=octo/public gh issue create ${body}`],
    [`env GH_HOST=example.org gh issue create ${body}`],
    [`gh issue create ${body}`, { GH_REPO: 'octo/public' }],
    [`gh issue comment https://example.com/octo/public/issues/1 ${body}`],
    ['gh api repos/octo/app/issues -f body="QuietVale ships"'],
    [`cd ${own.repo} && gh issue comment 1 -R octo/public ${body}`],
    // Anything else on the line could change where gh posts before it runs (record 0014).
    [`gh repo set-default octo/public && gh issue create ${body}`],
    [`git remote set-url origin https://example.com/octo/public && gh issue create ${body}`],
    [`git remote add upstream https://example.com/octo/public; gh issue create ${body}`],
    [`git push upstream main && gh pr create ${body}`],
    [`git push -u origin main && gh pr create ${body}`],
    [`env -C ${other.repo} gh issue create ${body}`],
    [`GIT_COMMON_DIR=${other.repo}/.git gh issue create ${body}`],
    [`printf '[remote "origin"]\\n\\turl = https://example.com/octo/public\\n' >> .git/config && gh issue create ${body}`],
    [`sed -i s/app/public/ .git/config && gh issue create ${body}`],
    [`cp ${other.repo}/.git/config .git/config; gh issue create ${body}`],
    [`g=git; $g remote set-url origin https://example.com/octo/public && gh issue create ${body}`],
    [`$(echo git) remote set-url origin https://example.com/octo/public && gh issue create ${body}`],
    [`echo origin | xargs git remote remove && gh issue create ${body}`],
    [`sudo gh issue create ${body}`],
    [`(gh issue create ${body})`],
    [`gh issue create ${body} | cat`],
    [`gh issue create --title "x $(git remote remove origin)" --body "QuietVale ships"`],
    [`gh issue create --title x --body-file - <<EOF\nQuietVale ships $(git remote remove origin)\nEOF`],
    [`gh issue create --title x --body-file - <<'EOF'\nQuietVale ships\nEOF\ngit remote remove origin`],
    [`cd ${other.repo} && gh issue create ${body}`],
  ];
  for (const [command, extra] of targets) {
    assert.equal(post(command, own.repo, { extra })?.id, 'private-mark', `machine: ${command}`);
    assert.equal(post(command, own.repo, { config: allowing, extra })?.id, 'private-mark', `privacy.allow: ${command}`);
  }
  // The lone post keeps both allows, and so does a cd within the same repo, the bot's form and a quoted heredoc.
  for (const repo of [own.repo, other.repo]) mkdirSync(join(repo, 'sub'), { recursive: true });
  for (const command of [
    `gh issue create ${body}`,
    `cd sub && gh issue create ${body}`,
    `yokoten bot -- gh issue create ${body}`,
    `gh issue create --title x --body-file - <<'EOF'\nQuietVale ships\nEOF`,
  ]) {
    assert.equal(post(command, own.repo), null, `machine: ${command}`);
    assert.equal(post(command, other.repo, { config: allowing }), null, `privacy.allow: ${command}`);
  }
  assert.equal(post(`cd ${own.repo} && gh issue create ${body}`, other.repo)?.id, 'private-mark', 'a cd into another repo gets no allow');
});

test('lonePost: linear on long input (#447)', () => {
  const inputs: [string, (n: number) => string][] = [
    ['quotes', (n) => `gh issue create --body "${'a'.repeat(n)}`],
    ['escapes', (n) => `gh issue create ${'\\'.repeat(n)}`],
    ['heredoc lines', (n) => `gh issue create --body-file - <<'EOF'\n${'x\n'.repeat(n / 2)}`],
    ['a long cd', (n) => `cd ${'a'.repeat(n)} gh`],
    ['a long bot path', (n) => `${'a/'.repeat(n / 2)}yokoten bot -- x`],
  ];
  for (const [name, make] of inputs) assertLinear(name, make, (text) => lonePost(text));
});
