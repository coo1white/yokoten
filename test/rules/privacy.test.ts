// Tests for src/rules/privacy.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { at, makeTempDir } from '../repo/helpers.ts';
import { assertLinear } from '../../scripts/linear.ts';
import { DEFAULTS, type Env } from '../../src/rules/config.ts';
import { checkCommand } from '../../src/rules/guards.ts';
import { formatFinding } from '../../src/rules/message.ts';
import {
  hideHome,
  homeIn,
  loadMarkKinds,
  loadMarks,
  makeRedactor,
  notUtc,
  ownMarks,
  POSITIVE_CONTROL,
  privateRemoteHosts,
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

test('emails: the fix names privacy.allow for a project\'s own public address, and the address is still found (#380)', () => {
  const address = `support${at}myproject.dev`;
  const found = scanText(`write to ${address}`, { file: 'SECURITY.md' });
  assert.equal(found.length, 1, 'nothing is allowed on its own');
  assert.equal(found[0].id, 'email');
  const text = formatFinding(found[0]);
  assert.match(text, /noreply address, or a placeholder at example\.com\. If it is your project's own public address, such as support@ at its domain, add it to "privacy\.allow" in yokoten\.json\.\n/);
  assert.match(text, /\n {2}docs: https:\/\/github\.com\/yokoten-labs\/yokoten\/blob\/main\/docs\/guide\.md#privacy$/);
  assert.ok(!text.includes(address), 'the address itself is never printed');
  // A post names privacy.allow once, not twice.
  const home = makeTempDir('yokoten-380-');
  const posted = formatFinding(checkCommand(`gh issue create --title "check: a" --body "${address}"`, { env: { HOME: home }, config: DEFAULTS, cwd: home })!);
  assert.equal(posted.split('privacy.allow').length, 2, posted);
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

// ---- A body file the same command writes (#439) ----
//
// Only `cat > path <<'EOF' && gh … path`, as the whole command, is followed.

const plainRefusal = (command: string) => {
  const f = post(command);
  assert.equal(f?.id, 'unreadable-command', command);
  assert.match(f?.what ?? '', /the guard runs/, command);
  assert.match(f?.fix ?? '', /write the file in one command, then post it in the next/, command);
};

test('cat > file <<EOF && gh --body-file file: the heredoc is checked (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  for (const command of [
    `cat > fresh.md <<'EOF' && gh issue create --title "check: add t" --body-file fresh.md\nAll clean.\nEOF`,
    `cat >fresh.md <<'EOF' && gh pr comment 3 -F fresh.md\nAll clean, $(not run).\nEOF\n`,
    `cat > fresh.md <<'EOF' && gh issue comment 3 --body-file=fresh.md\nAll clean.\nEOF`,
    `cat > fresh.md <<'EOF' && gh issue comment 3 -Ffresh.md\nAll clean.\nEOF`,
    `cat > ~/fresh.md <<'EOF' && gh issue comment 3 -F ~/fresh.md --repo o/r\nAll clean.\nEOF`,
  ]) {
    assert.equal(post(command), null, command);
  }
});

test('a heredoc body with a private value is stopped, by file and line (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  const marked = post(`cat > fresh.md <<'EOF' && gh issue create --title "check: add t" --body-file fresh.md\nSummary\nTested in QuietVale.\nEOF`);
  assert.equal(marked?.id, 'private-mark');
  assert.equal(marked?.line, 2);
  assert.ok(!formatFinding(marked).toLowerCase().includes('quietvale'));
  assert.equal(post(`cat > fresh.md <<'EOF' && gh pr comment 3 -F fresh.md\nmail ${email}\nEOF`)?.id, 'email');
});

test('the file on disk is checked too, in case cat cannot replace it (#439)', () => {
  writeFileSync(join(postDir, 'old.md'), 'Seen in QuietVale.\n');
  assert.equal(post(`cat > old.md <<'EOF' && gh issue comment 3 -F old.md\nAll clean.\nEOF`)?.id, 'private-mark');
  writeFileSync(join(postDir, 'old.md'), 'clean\n');
  assert.equal(post(`cat > old.md <<'EOF' && gh issue comment 3 -F old.md\nAll clean.\nEOF`), null);
  // A read-only file (chmod 444): cat can't replace it, so what is there now is checked.
  writeFileSync(join(postDir, 'ro.md'), 'Seen in QuietVale.\n');
  chmodSync(join(postDir, 'ro.md'), 0o444);
  assert.equal(post(`cat > ro.md <<'EOF' && gh issue comment 3 -F ro.md\nAll clean.\nEOF`)?.id, 'private-mark');
  chmodSync(join(postDir, 'ro.md'), 0o644);
  // A folder there: cat fails, and the guard can't tell.
  mkdirSync(join(postDir, 'adir.md'), { recursive: true });
  plainRefusal(`cat > adir.md <<'EOF' && gh issue comment 3 -F adir.md\nclean\nEOF`);
});

test('a file on disk with nothing else in the command is read as before (#439)', () => {
  writeFileSync(join(postDir, 'kept.md'), `mail ${email}\n`);
  assert.equal(post('gh issue comment 3 -F kept.md')?.id, 'email');
  assert.equal(post(`cd ${postDir} && gh issue comment 3 -F kept.md`)?.id, 'email');
  // A redirect is not plain, so beside a cd the guard can't tell (#439 round 5).
  plainRefusal(`cd ${postDir} && gh issue comment 3 -F kept.md 2>/dev/null`);
  writeFileSync(join(postDir, 'kept.md'), 'clean\n');
  assert.equal(post('gh issue comment 3 -F kept.md'), null);
});

// Every other shape is refused: these came from review, and each one gets a body past a
// more general reading of the command.
const reviewCases: [string, string][] = [
  ["backslash-newline unquoted", "cat > f.md <<EOF\nQuiet\\\nVale\nEOF\ngh issue comment 3 -F f.md"],
  ["baseline clean", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["baseline mark", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["brace expansion tee", "cat > f.md <<'EOF'\nclean\nEOF\necho QuietVale | tee {f,g}.md\ngh issue comment 3 -F f.md"],
  ["glob ? redirect", "cat > f.md <<'EOF'\nclean\nEOF\necho QuietVale > ?.md\ngh issue comment 3 -F f.md"],
  ["glob [] cp", "cat > f.md <<'EOF'\nclean\nEOF\ncp src.txt [f].md\ngh issue comment 3 -F f.md"],
  ["function cat", "cat() { printf QuietVale; }\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["function cat2", "function cat { printf QuietVale; }\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["noclobber", "set -C\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly existing (plain)", "cat > ro.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F ro.md"],
  ["CRLF delim", "cat > f.md <<'EOF'\nclean\nEOF\r\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["trailing space delim", "cat > f.md <<'EOF'\nclean\nEOF \nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["<<- tabs", "cat > f.md <<-'EOF'\n\tQuietVale\n\tEOF\ngh issue comment 3 -F f.md"],
  ["two heredocs same file", "cat > f.md <<'EOF'\nQuietVale\nEOF\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["two heredocs one cmd", "cat > f.md <<'A' <<'B'\nQuietVale\nA\nclean\nB\ngh issue comment 3 -F f.md"],
  ["var reassign", "S=/x/f.md\nS=f.md\ncat > $S <<'EOF'\nclean\nEOF\nS=g.md\ngh issue comment 3 -F $S"],
  ["S=a S=b", "S=a.md S=f.md\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["S=a S=b gh", "S=a.md S=f.md\ncat > $S <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F $S"],
  ["subshell export", "S=f.md\n(S=g.md; export S)\ncat > g.md <<'EOF'\nQuietVale\nEOF\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["eval assign", "S=f.md\neval S=g.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["eval gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\neval gh issue comment 3 -F f.md"],
  ["command gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\ncommand gh issue comment 3 -F f.md"],
  ["env gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\nenv gh issue comment 3 -F f.md"],
  ["xargs gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\necho f.md | xargs gh issue comment 3 -F"],
  ["-Ff", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -Ff.md"],
  ["--body-file=", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 --body-file=f.md"],
  ["process subst", "gh issue comment 3 -F <(echo QuietVale)"],
  ["${S:-x}", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F ${S:-g.md}"],
  ["IFS", "IFS=.\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["tilde", "cat > ~/f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F $HOME/f.md"],
  ["cd between", "cat > f.md <<'EOF'\nclean\nEOF\ncd sub\ngh issue comment 3 -F f.md"],
  ["unquoted with $(..)", "cat > f.md <<EOF\n$(echo Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["unquoted backslash-dollar", "cat > f.md <<EOF\nQuiet\\Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["case-fold", "cat > F.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["symlink other name", "cat > target.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F link.md"],
  ["writer in if", "if true; then cat > f.md <<'EOF'\nQuietVale\nEOF\nfi\ngh issue comment 3 -F f.md"],
  ["source", "cat > f.md <<'EOF'\nclean\nEOF\nsource x.sh\ngh issue comment 3 -F f.md"],
  ["mv dir", "cat > f.md <<'EOF'\nclean\nEOF\ncp -r ev/. .\ngh issue comment 3 -F f.md"],
  ["exec redirect", "cat > f.md <<'EOF'\nclean\nEOF\nexec 3>f.md\ngh issue comment 3 -F f.md"],
  ["fd write without naming", "exec 3>f.md\ncat > f.md <<'EOF'\nclean\nEOF\necho QuietVale >&3\ngh issue comment 3 -F f.md"],
  ["alias", "shopt -s expand_aliases\nalias cat='printf QuietVale'\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["trap", "trap 'echo QuietVale > f.md' DEBUG\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["background earlier", "sleep 1 && echo QuietVale > f\\.md &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["bg loop", "(sleep 0.1; cp ev/f.md .) &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["sh -c var", "S=f.md bash -c 'echo QuietVale > $S'\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["space split gh", "S='x -F f.md'\ncat > \"$S\" <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["ambiguous redirect", "S='a b.md'\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F \"$S\""],
  ["source sets var", "S=g.md\ncat > g.md <<'EOF'\nclean\nEOF\n. ./x.sh\ngh issue comment 3 -F $S"],
  ["delim \"EOF\"", "cat > f.md <<\"EOF\"\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim \\EOF", "cat > f.md <<\\EOF\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim E'O'F", "cat > f.md <<E'O'F\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim space 'EOF'", "cat > f.md << 'EOF'\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim $X", "cat > f.md <<$X\n$(printf Quiet)Vale\n$X\ngh issue comment 3 -F f.md"],
  ["two docs two cmds one line", "cat > f.md <<'A'; cat > g.md <<'B'\nclean\nA\nQuietVale\nB\ngh issue comment 3 -F f.md"],
  ["two docs two cmds swap", "cat > g.md <<'A'; cat > f.md <<'B'\nclean\nA\nQuietVale\nB\ngh issue comment 3 -F f.md"],
  ["bg gh then write", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md &\nprintf QuietVale > f.md; wait"],
  ["bg writer race", "(sleep 0.05; cp ev/f.md .) &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md; wait"],
  ["heredoc in && with gh before body", "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nQuietVale\nEOF"],
  ["line continuation in cmd", "cat > f.\\\nmd <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["unicode delim", "cat > f.md <<'EOF'\nclean\nEOF \nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["semicolon after delim", "cat > f.md <<'EOF'\nclean\nEOF;\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["nested $( heredoc", "X=$(cat <<'EOF'\nclean\nEOF\n)\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["comment hides heredoc", "cat > f.md <<'EOF' # <<'X'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["heredoc op in comment", "cat > f.md # <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["writer w/ var target null HOME", "cat > $HOME/f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  [">| target", "set -C\ncat >| f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["cat 1>", "cat 1> f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["redirect before cat", "> f.md cat <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["assign prefix cat", "LC_ALL=C cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["quoted cat", "'cat' > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["/bin/cat", "/bin/cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["./cat", "./cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["PATH cat", "PATH=./bin\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["hash -p", "hash -p ./bin/cat cat\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["enable -n", "enable -f x cat\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["ulimit", "ulimit -f 0\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["mkdir f.md first?", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly var", "S=g.md\nreadonly S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["declare -i", "declare -i S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["declare -u", "declare -l S\nS=F.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["declare -u gh", "declare -u S\nS=f.md\ncat > F.MD <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["export -n etc", "S=f.md; set -u; cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["brace in gh word", "cat > '{x,f.md}' <<'EOF'\nclean\nEOF\ngh issue comment 3 -F{x,f.md}"],
  ["PATH prepend", "PATH=$PWD/bin:$PATH\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly var disk", "S=g.md.old\nreadonly S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["IFS split", "S=f.md\nIFS=.\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ['background gh', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md &\nQuietVale\nEOF"],
  ['variable in the path', "S=f.md; cat > $S <<'EOF' && gh issue comment 3 -F $S\nclean\nEOF"],
  ['quoted path', "cat > 'f.md' <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF"],
  ['unquoted delimiter', "cat > f.md <<EOF && gh issue comment 3 -F f.md\nclean\nEOF"],
  ['other path to the same file', "cat > f.md <<'EOF' && gh issue comment 3 -F ./f.md\nclean\nEOF"],
  ['substitution in the gh line', "cat > f.md <<'EOF' && gh issue comment 3 --title \"$(date)\" -F f.md\nclean\nEOF"],
  ['a third command', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md && echo done\nclean\nEOF"],
  ['text after the delimiter', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\necho QuietVale > f.md"],
  ['gh redirect into the file', "gh issue comment 3 -F kept.md > kept.md"],
  ['env prefix', "cat > f.md <<'EOF' && env gh issue comment 3 -F f.md\nclean\nEOF"],
];

test('every other way to write a body file in the same command is refused (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  for (const onDisk of [false, true]) {
    for (const name of ['f.md', 'g.md', 'ro.md', 'F.md', 'F.MD', 'target.md', 'link.md', 'kept.md']) {
      if (onDisk) writeFileSync(join(postDir, name), 'clean\n');
      else rmSync(join(postDir, name), { force: true });
    }
    for (const [name, command] of reviewCases) {
      const f = post(command);
      assert.ok(f !== null, `${name} (file on disk: ${onDisk})`);
    }
  }
  // An unclosed heredoc swallows the gh line: gh never runs, and nothing is posted.
  assert.equal(post("cat > f.md <<'EOF'\nclean\ngh issue comment 3 -F f.md"), null);
  // Each answer that is not about the text itself gives the plain reason.
  rmSync(join(postDir, 'f.md'), { force: true });
  plainRefusal(`cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md`);
  plainRefusal('gh issue comment 3 -F "$(mktemp)"');
  plainRefusal('gh issue comment 3 -F $OUTSIDE/x.md');
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  plainRefusal(`cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md`);
  plainRefusal('echo QuietVale > f.md; gh issue comment 3 -F f.md');
  assert.match(post('gh issue comment 3 -F not-there.md')?.what ?? '', /doesn't exist yet when the guard runs/);
});

test('reading the heredoc shape stays linear (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  assertLinear(
    'a long heredoc body and a long gh line',
    (n) => `cat > fresh.md <<'EOF' && gh issue comment 3 ${'-F fresh.md '.repeat(n / 24)}--title "${'t'.repeat(n / 4)}"\n${'clean line\n'.repeat(n / 22)}EOF`,
    (command) => assert.equal(post(command), null),
  );
  assertLinear(
    'many commands before a gh with a body file',
    (n) => `${'cd . && '.repeat(n / 16)}gh issue comment 3 -F not-there.md`,
    (command) => assert.equal(post(command)?.id, 'unreadable-command'),
  );
});

test("the lead's command with a body file on disk: commands that write no file don't stop it (#439)", () => {
  const body = join(postDir, 'lead-body.md');
  const lead = `cd ${postDir} && export NODE_USE_ENV_PROXY=1 GH_REPO=o/r; node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  writeFileSync(body, 'All clean.\n');
  assert.equal(post(lead), null);
  assert.equal(post(lead.replace('node bin/yokoten.ts bot', 'yokoten bot')), null);
  // Loading a file with . or source may run anything, so the file on disk is not trusted.
  plainRefusal(`set -a; . ~/.config/yokoten/keys.env; set +a; ${lead}`);
  // A `$` the shell fills in may run code, so the older form with $(…) is refused too.
  plainRefusal(`OWNER=$(gh pr view 1 --json assignees -q '.assignees[0].login'); ${lead} --assignee "$OWNER"`);
  for (const reads of ['git rev-parse HEAD', 'git config --get user.name', 'git remote get-url origin', 'gh issue list', 'gh pr checks 3', 'echo hi', 'true', 'test -f x', 'set -e -o pipefail', 'set +u', 'OWNER=someone', 'export GH_HOST=example.com', 'GH_REPO=o/r gh pr view 1', 'cd sub', 'yokoten bot -- gh run view 1']) {
    assert.equal(post(`${reads} && gh pr comment 3 -F ${body}`), null, reads);
  }
  writeFileSync(body, 'Tested in QuietVale.\n');
  assert.equal(post(lead)?.id, 'private-mark');
  // A command that may write the file still stops it.
  writeFileSync(body, 'All clean.\n');
  for (const writes of [
    `echo QuietVale > ${body}`,
    '. ./x.sh',
    'source ~/.config/yokoten/x.sh',
    'eval x',
    'f() { :; }',
    'git diff',
    'git status',
    'git log -1',
    'gh api repos/o/r/pulls',
    'export EDITOR=x',
    'HOME=/x',
    'set -a',
    'git log -p',
    'git log --patch',
    'git log -u',
    'git log --textconv',
    'git log --ext-diff',
    'git log --output=x',
    'gh api -X POST repos/o/r/issues',
    'gh api repos/o/r/issues -f body=x',
    'gh pr checkout 3',
    'X=$(cp a b)',
    'yokoten bot -- gh pr merge 3',
    'printf x > out.md',
    'PATH=./bin; git status',
    'export GIT_EXTERNAL_DIFF=./x; git log',
    'NODE_OPTIONS=--require=./x.js node bin/yokoten.ts bot -- gh pr view 1',
  ]) {
    plainRefusal(`${writes}; gh pr comment 3 -F ${body}`);
  }
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  plainRefusal('echo QuietVale > f.md; gh issue comment 3 -F f.md');
  plainRefusal('. ./x.sh; gh issue comment 3 -F f.md');
});

// More inputs from review (#439). Only these write no file and run nothing: the file on disk
// is still the one gh posts.
const writesNothing = new Set(["control: nothing","control: echo","echo -e"]);
const reviewCases2: [string, string][] = [
  ["control: nothing", "gh issue comment 3 -F f.md"],
  ["control: echo", "echo hi && gh issue comment 3 -F f.md"],
  ["control: cp", "cp ev/f.md f.md; gh issue comment 3 -F f.md"],
  ["cmdsubst in echo", "echo $(cp ev/f.md f.md) && gh issue comment 3 -F f.md"],
  ["cmdsubst in dq", "echo \"$(cp ev/f.md f.md)\" && gh issue comment 3 -F f.md"],
  ["backtick", "echo `cp ev/f.md f.md` && gh issue comment 3 -F f.md"],
  ["test -e $()", "test -e $(cp ev/f.md f.md) ; gh issue comment 3 -F f.md"],
  ["export X=$()", "export X=$(cp ev/f.md f.md) && gh issue comment 3 -F f.md"],
  ["assign X=$()", "X=$(cp ev/f.md f.md) gh issue comment 3 -F f.md"],
  ["procsubst echo", "echo <(cp ev/f.md f.md) >/dev/null; sleep 0.2; gh issue comment 3 -F f.md"],
  ["procsubst >()", "echo QuietVale > >(cat > f.md); sleep 0.2; gh issue comment 3 -F f.md"],
  ["procsubst arg", "printf QuietVale >(cat > f.md) ; sleep 0.2; gh issue comment 3 -F f.md"],
  ["echo >| f", "echo QuietVale >| f.md; gh issue comment 3 -F f.md"],
  ["echo >& f", "echo QuietVale >&f.md; gh issue comment 3 -F f.md"],
  [":> f", ":> f.md; gh issue comment 3 -F f.md"],
  ["true > f", "true > f.md; gh issue comment 3 -F f.md"],
  ["printf -v", "printf -v X %s y; gh issue comment 3 -F f.md"],
  ["printf -v subscript", "printf -v 'a[$(cp ev/f.md f.md)]' %s 1; gh issue comment 3 -F f.md"],
  ["test -v subscript", "test -v 'a[$(cp ev/f.md f.md)]'; gh issue comment 3 -F f.md"],
  ["[ -v subscript", "[ -v 'a[$(cp ev/f.md f.md)]' ]; gh issue comment 3 -F f.md"],
  ["arith recursive", "X='a[$(cp ev/f.md f.md)]'; echo $((X)); gh issue comment 3 -F f.md"],
  ["arith recursive2", "X='a[$(cp ev/f.md f.md)]' && echo $((X+1)) && gh issue comment 3 -F f.md"],
  ["arith $[]", "X='a[$(cp ev/f.md f.md)]'; echo $[X]; gh issue comment 3 -F f.md"],
  ["test -eq", "X='a[$(cp ev/f.md f.md)]'; test \"$X\" -eq 0; gh issue comment 3 -F f.md"],
  ["[[ -v", "[[ -v 'a[$(cp ev/f.md f.md)]' ]]; gh issue comment 3 -F f.md"],
  ["PS4 xtrace", "export PS4='$(cp ev/f.md f.md)'; set -x; gh issue comment 3 -F f.md"],
  ["PS4 plain", "PS4='$(cp ev/f.md f.md) ' && set -x && gh issue comment 3 -F f.md"],
  ["HOME tilde", "HOME=ev; gh issue comment 3 -F ~/f.md"],
  ["set -o noclobber", "set -o noclobber; gh issue comment 3 -F f.md"],
  ["cd subdir", "cd sub && gh issue comment 3 -F f.md"],
  ["gh pr view --web", "gh pr view --web 3; gh issue comment 3 -F f.md"],
  ["gh run view --log >f", "gh run view 1 --log > f.md; gh issue comment 3 -F f.md"],
  ["git log --output", "git log --output=f.md; gh issue comment 3 -F f.md"],
  ["git log -L", "git log -L1,1:f.md; gh issue comment 3 -F f.md"],
  ["git log -c", "git log -c; gh issue comment 3 -F f.md"],
  ["git log --cc", "git log --cc; gh issue comment 3 -F f.md"],
  ["git log -S", "git log -Sx; gh issue comment 3 -F f.md"],
  ["git status", "git status; gh issue comment 3 -F f.md"],
  ["git config --get --file", "git config --get --file f.md x; gh issue comment 3 -F f.md"],
  ["gh api GET", "gh api repos/a/b --jq . ; gh issue comment 3 -F f.md"],
  ["gh api --cache", "gh api repos/a/b --cache 1h; gh issue comment 3 -F f.md"],
  ["gh api -t", "gh api repos/a/b -t x; gh issue comment 3 -F f.md"],
  ["gh api method lowercase", "gh api repos/a/b/issues/3/comments --method=post; gh issue comment 3 -F f.md"],
  ["gh api -XPOST", "gh api -XPOST repos/a/b/issues/3/comments; gh issue comment 3 -F f.md"],
  ["yokoten bot -- echo >", "yokoten bot -- echo QuietVale > f.md; gh issue comment 3 -F f.md"],
  ["yokoten bot -- cp", "yokoten bot -- cp ev/f.md f.md; gh issue comment 3 -F f.md"],
  ["echo -e", "echo -e 'x' ; gh issue comment 3 -F f.md"],
  ["set -- $()", "set -- $(cp ev/f.md f.md); gh issue comment 3 -F f.md"],
  ["cd $()", "cd $(cp ev/f.md f.md; echo .) && gh issue comment 3 -F f.md"],
  ["bash -c", "bash -c 'cp ev/f.md f.md'; gh issue comment 3 -F f.md"],
  ["export -f? func", "f() { cp ev/f.md f.md; }; f; gh issue comment 3 -F f.md"],
  ["pushd", "pushd sub >/dev/null && gh issue comment 3 -F f.md"],
  ["export BASH_FUNC", "export 'BASH_FUNC_gh%%=() { cp ev/f.md f.md; command gh \"$@\"; }'; gh issue comment 3 -F f.md"],
  ["assign BASH_FUNC env", "env 'BASH_FUNC_x%%=() { :; }' true; gh issue comment 3 -F f.md"],
  ["heredoc to echo", "echo <<'EOF' && gh issue comment 3 -F f.md\n$(cp ev/f.md f.md)\nEOF"],
  ["unquoted heredoc to :", ": <<EOF\n$(cp ev/f.md f.md)\nEOF\ngh issue comment 3 -F f.md"],
  ["heredoc shape clean + extra", "cat > g.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF"],
  ["substring offset", "X='a[$(cp ev/f.md f.md)]'; echo ${HOME:X}; gh issue comment 3 -F f.md"],
  ["subscript var", "X='a[$(cp ev/f.md f.md)]'; echo ${a[X]}; gh issue comment 3 -F f.md"],
  ["export subscript", "export 'a[$(cp ev/f.md f.md)]=1'; gh issue comment 3 -F f.md"],
  ["assign subscript", "a[X]=1 && X='b[$(cp ev/f.md f.md)]' && a[X]=2; gh issue comment 3 -F f.md"],
  ["HOME cd", "HOME=ev; cd; gh issue comment 3 -F f.md"],
  ["GH_BROWSER repo view", "export GH_BROWSER='sh -c \"cp ev/f.md f.md\" x'; gh repo view a/b --web; gh issue comment 3 -F f.md"],
  ["BROWSER", "BROWSER='sh -c \"cp ev/f.md f.md\" x' gh repo view a/b --web; gh issue comment 3 -F f.md"],
  ["test -v subscript", "test -v 'a[$(cp ev/f.md f.md)]'; gh issue comment 3 -F f.md"],
  ["printf -v subscript", "printf -v 'a[$(cp ev/f.md f.md)]' %s 1; gh issue comment 3 -F f.md"],
  ["arith $[]", "X='a[$(cp ev/f.md f.md)]'; echo $[X]; gh issue comment 3 -F f.md"],
  ["PS4 xtrace", "export PS4='$(cp ev/f.md f.md)'; set -x; gh issue comment 3 -F f.md"],
  ["HOME tilde", "HOME=ev; gh issue comment 3 -F ~/f.md"],
];

test('a command beside gh is trusted only when it surely writes no file and runs nothing (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  for (const [name, command] of reviewCases2) {
    if (writesNothing.has(name)) assert.equal(post(command), null, name);
    else assert.ok(post(command) !== null, name);
  }
});

// Inputs from the fourth review (#439). The shell may fill in any `$` or backtick outside single
// quotes by running code (`${X@P}`, `${!X}`, an `a[…]` name read as a number), so each one
// makes the line unsure. So do `$'…'`, a CR, `--web` or `-w`, and `..` after a cd.
const reviewCases3: string[] = [
  "X='a[$(cp ev/f.md f.md)]'; echo \"${!X}\"; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; echo ${!X}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; cd \"${X@P}\"; gh issue comment 3 -F ~/f.md",
  "X='$(cp ev/f.md f.md)'; : ${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; test -n \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; gh pr view \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; export GH_HOST=\"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P} gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)' Y=${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; gh issue comment 3 -F f.md --title \"${X@P}\"",
  "X='$(cp ev/f.md f.md)'; gh issue comment 3 -F f.md \"${X@P}\"",
  "cd lnk; gh issue comment 3 -F ../f.md",
  "gh issue comment 3 -F f.md\r",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; echo ${!X}; gh issue comment 3 -F f.md",
  "B='['; X=\"a${B}\\$(cp ev/f.md f.md)]\"; echo \"${!X}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; echo \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='\\$(cp ev/f.md f.md)'; echo \"${X@P}\"; gh issue comment 3 -F f.md",
  "B=[; Y=-v; X=a${B}'$(cp ev/f.md f.md)]'; test \"$Y\" \"$X\"; gh issue comment 3 -F f.md",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; printf -v\"$X\" %s 1; gh issue comment 3 -F f.md",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; echo $((X)); gh issue comment 3 -F f.md",
  "cp ev/f.md f.md; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; echo ${X@P}; gh issue comment 3 -F f.md",
  "Y=-v; X='a[$(cp ev/f.md f.md)]'; test \"$Y\" \"$X\"; gh issue comment 3 -F f.md",
  "Y=-v; X='a[$(cp ev/f.md f.md)]'; [ $Y $X ]; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; printf -v\"$X\" %s 1; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; printf -v$X %s 1; gh issue comment 3 -F f.md",
  "gh pr view 3 --web=true; gh issue comment 3 -F f.md",
  "echo x 1<>f.md; gh issue comment 3 -F f.md",
  "echo x {fd}>f.md; gh issue comment 3 -F f.md",
  "echo x &>f.md; gh issue comment 3 -F f.md",
  "echo x &>>f.md; gh issue comment 3 -F f.md",
  "echo x >\\\nf.md; gh issue comment 3 -F f.md",
  "pushd sub; pushd ev; pushd +1; gh issue comment 3 -F f.md",
  "echo ${X=$(cp ev/f.md f.md)}; gh issue comment 3 -F f.md",
  "echo ${X/a/$(cp ev/f.md f.md)}; gh issue comment 3 -F f.md",
  "echo $'\\x24(cp ev/f.md f.md)'; gh issue comment 3 -F f.md",
  "true\r\ncp ev/f.md f.md\r\ngh issue comment 3 -F f.md",
  "set -eu -o pipefail -o noclobber; gh issue comment 3 -F f.md",
  "set -o pipefail -o errtrace; gh issue comment 3 -F f.md",
  "set -e -o pipefail -o xtrace; gh issue comment 3 -F f.md",
  "cd -- ev; gh issue comment 3 -F f.md",
  "cd ev; gh issue comment 3 -F ../f.md",
  "trap 'cp ev/f.md f.md' EXIT; gh issue comment 3 -F f.md",
  "echo $(</dev/null) && gh issue comment 3 -F f.md",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nQuietVale\nEOF",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\ncp ev/f.md f.md",
  "f.md=1; gh issue comment 3 -F f.md",
  "OLDPWD=ev; cd - ; gh issue comment 3 -F f.md",
  "X=ev; cd $X; gh issue comment 3 -F f.md",
  "export GH_REPO=a/b GH_HOST=$(cp ev/f.md f.md); gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P}; gh issue comment 3 -F f.md --title \"${X@P}\"",
  "gh pr view 3 -w; gh issue comment 3 -F f.md",
  "gh pr view 3 -cw; gh issue comment 3 -F f.md",
  "gh pr view 3 --web=false; gh issue comment 3 -F f.md",
  "cd sub && gh issue comment 3 -F sub/../f.md",
  "echo '$(x)' $'\\x41'; gh issue comment 3 -F f.md",
  "echo hi;\rgh issue comment 3 -F f.md"
];

// Each of these runs nothing and writes no file, so the file on disk is still what gh posts.
const writesNothing3: string[] = [
  "gh issue comment 3 -F f.md",
  "cd ev\tgh issue comment 3 -F f.md",
  "git config --get alias.x; gh issue comment 3 -F f.md",
  "git rev-parse --git-path x; gh issue comment 3 -F f.md",
  "gh pr checks 3 --watch; gh issue comment 3 -F f.md",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md -F f.md\nclean\nEOF",
  "cat >f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\n",
  "X=1 Y=2; gh issue comment 3 -F f.md",
  "cd ~; gh issue comment 3 -F f.md",
  "GH_HOST=x gh pr view 3; gh issue comment 3 -F f.md",
  "NODE_USE_ENV_PROXY=1 yokoten bot -- gh pr view 3; gh issue comment 3 -F f.md"
];

test('a `$` the shell fills in, a CR, --web or .. after a cd makes the line unsure (#439)', () => {
  for (const dir of ['sub', 'ev', 'lnk-target']) mkdirSync(join(postDir, dir), { recursive: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  writeFileSync(join(postDir, 'ev', 'f.md'), 'QuietVale\n');
  rmSync(join(postDir, 'lnk'), { force: true });
  symlinkSync(join(postDir, 'ev'), join(postDir, 'lnk'));
  for (const command of reviewCases3) assert.ok(post(command) !== null, JSON.stringify(command));
  for (const command of writesNothing3) assert.equal(post(command), null, JSON.stringify(command));
  // A `$` inside single quotes is text, not a value the shell fills in.
  assert.equal(post("echo '$(cp ev/f.md f.md)' && gh issue comment 3 -F f.md"), null);
  assert.equal(post("cat > g.md <<'EOF' && gh issue comment 3 -F g.md\n$(cp ev/f.md f.md)\nEOF"), null);
});

test('scanning a line for values the shell fills in stays linear (#439)', () => {
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  assertLinear(
    'many quotes and words before gh',
    (n) => `${"echo 'a' \"b\" c d; ".repeat(n / 24)}gh issue comment 3 -F f.md`,
    (command) => assert.equal(post(command), null),
  );
  assertLinear(
    'an unclosed quote',
    (n) => `echo "${'x '.repeat(n / 2)}`,
    (command) => post(command),
  );
});

// Round 5 (#439): the guard no longer follows bash's grammar. Beside other commands, a body
// file on disk is trusted only when the command is one line of plain words joined by ; and &&.
// Each of these got a file change past a closer reading of heredocs, or follows a cd that
// never ran in this shell.
const payload = "X='$(printf changed > f.md)'; true \"${X@P}\"";
const reviewCases5: string[] = [
  // A backslash in an unquoted delimiter: `<<true\\` ends at a line `true\`, so the payload runs.
  `: <<true\\\\\ntrue\\\n${payload}\ngh issue comment 3 -F f.md`,
  // A here-string is not a heredoc.
  `: <<<'true'\n${payload}\ngh issue comment 3 -F f.md`,
  // A backslash-newline in an unquoted body joins two lines, so the next EOF does not end it.
  `: <<EOF\nx\\\nEOF\ntrue '\nEOF\nX="\\$(printf changed > f.md)"; true "\${X@P}" \\'\ngh issue comment 3 -F f.md`,
  // \" inside a double-quoted delimiter.
  `: <<"E\\"F"\nE"F\n${payload}\ngh issue comment 3 -F f.md`,
  // A cd in a subshell, in the background or in a pipe does not move this shell.
  '(cd sub) && gh issue comment 3 -F f.md',
  'cd sub & gh issue comment 3 -F f.md',
  'cd sub | true; gh issue comment 3 -F f.md',
  // Each refused character, outside single quotes.
  'echo hi | gh issue comment 3 -F f.md',
  'echo hi & gh issue comment 3 -F f.md',
  'true 2>/dev/null; gh issue comment 3 -F f.md',
  'echo hi\ngh issue comment 3 -F f.md',
  'echo a\\ b; gh issue comment 3 -F f.md',
  'echo a#x; gh issue comment 3 -F f.md',
  'echo *.md; gh issue comment 3 -F f.md',
  'echo ?.md; gh issue comment 3 -F f.md',
  'echo [f].md; gh issue comment 3 -F f.md',
  'echo {a,b}; gh issue comment 3 -F f.md',
  'echo a~b; gh issue comment 3 -F f.md',
  'echo ~; gh issue comment 3 -F f.md',
  "echo 'open; gh issue comment 3 -F f.md",
  // The strict shape takes only a name in single quotes.
  'cat > f.md <<"EOF" && gh issue comment 3 -F f.md\nclean\nEOF',
  "cat > f.md <<'E-F' && gh issue comment 3 -F f.md\nclean\nE-F",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md 2>/dev/null\nclean\nEOF",
];

test('beside other commands, only one line of plain words is trusted (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  for (const command of reviewCases5) assert.ok(post(command) !== null, JSON.stringify(command));
  // gh posts ./f.md, since the cd never ran in this shell; the guard must not read sub/f.md.
  writeFileSync(join(postDir, 'f.md'), 'Seen in QuietVale.\n');
  writeFileSync(join(postDir, 'sub', 'f.md'), 'clean\n');
  for (const command of ['(cd sub) && gh issue comment 3 -F f.md', 'cd sub & gh issue comment 3 -F f.md', 'cd sub | true; gh issue comment 3 -F f.md']) {
    assert.notEqual(post(command), null, command);
  }
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  // Plain quotes are fine: a title with spaces, and the lead's own command.
  const body = join(postDir, 'lead-body.md');
  writeFileSync(body, 'All clean.\n');
  for (const command of [
    `cd ${postDir} && export NODE_USE_ENV_PROXY=1 GH_REPO=o/r; node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`,
    `cd ${postDir} && gh pr create --title "fix: a plain title" --body-file ${body}`,
    `echo 'any $ text (here)'; gh pr create --title 'a, b' --body-file ${body}`,
    'cd ~ && gh issue comment 3 -F ~/f.md',
    'gh pr create --title t --body-file - < f.md',
  ]) assert.equal(post(command), null, command);
});

// Round 6 (#439): a heredoc word with a \ and a line end, a ~ word that is not $HOME, and
// "..." that holds only literal characters.
test('a \\ and a line end in a heredoc word is refused, quoted or not (#439)', () => {
  writeFileSync(join(postDir, 'body.md'), `write to ${email}\n`);
  // bash ends both bodies at EF, then runs gh.
  for (const command of [
    'cat <<"E\\\nF"\nbody\nEF\ngh issue create --title t -F body.md',
    'cat <<E\\\nF\nbody\nEF\ngh issue create --title t -F body.md',
    "cat <<'E\\\nF'\nbody\nEF\ngh issue create --title t -F body.md",
  ]) assert.equal(post(command)?.id, 'unreadable-command', JSON.stringify(command));
  rmSync(join(postDir, 'body.md'));
});

test('a ~ word after -F or cd is trusted only as ~ or ~/, unquoted (#439)', () => {
  const secret = `write to ${email}\n`;
  for (const dir of ['~', join('sub', '~-')]) mkdirSync(join(postDir, dir), { recursive: true });
  // bash reads the file with the secret; the guard, reading $HOME or the cd folder, would find a clean one.
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  writeFileSync(join(postDir, '~', 'body.md'), secret);
  writeFileSync(join(postDir, 'sub', '~-', 'body.md'), secret);
  const refused = (commands: string[]) => {
    for (const command of commands) assert.notEqual(post(command), null, JSON.stringify(command));
  };
  refused([
    "gh issue create --title t -F '~/body.md'",
    'gh issue create --title t -F "~/body.md"',
    "gh issue create --title t -F ~'/body.md'",
    "cd sub && gh issue create --title t -F '~-/body.md'",
    'gh issue create --title t -F ~+/body.md',
    'gh issue create --title t -F ~root/body.md',
    'gh issue create --title t -F ~1/body.md',
    "cd '~' && gh issue create --title t -F body.md",
  ]);
  // `~-` is the folder before the cd: bash reads ./body.md, not sub/~-/body.md.
  writeFileSync(join(postDir, 'body.md'), secret);
  writeFileSync(join(postDir, 'sub', '~-', 'body.md'), 'clean\n');
  refused(['cd sub; gh issue create --title t -F ~-/body.md']);
  // Control: a plain ~ and ~/ are $HOME, and the file there is read.
  assert.equal(post('cd ~ && gh issue create --title t -F ~/body.md')?.id, 'email');
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  assert.equal(post('cd ~ && gh issue create --title t -F ~/body.md'), null);
  for (const dir of ['~', 'sub', 'body.md']) rmSync(join(postDir, dir), { recursive: true, force: true });
});

test('inside "...", only $, backticks, \\ and ! make the line unsure (#439)', () => {
  const literal = [
    'gh issue create --title "Fix #12" -F body.md',
    'echo "a#b"; gh issue create --title t -F body.md',
    'echo "it\'s"; gh issue create --title t -F body.md',
    'echo hi; gh issue create --title "a (b) <c> {d} | e & f * ? [g] ~h" -F body.md',
  ];
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  for (const command of literal) assert.equal(post(command), null, JSON.stringify(command));
  // The file is read: a mark in it is found.
  writeFileSync(join(postDir, 'body.md'), 'Seen in QuietVale.\n');
  for (const command of literal) assert.equal(post(command)?.id, 'private-mark', JSON.stringify(command));
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  for (const command of [
    'echo "a$b"; gh issue create --title t -F body.md',
    'echo "a`b`"; gh issue create --title t -F body.md',
    'echo "a\\b"; gh issue create --title t -F body.md',
    'echo "a!b"; gh issue create --title t -F body.md',
    'true 2>/dev/null; gh issue create --title t -F body.md',
  ]) assert.equal(post(command)?.id, 'unreadable-command', JSON.stringify(command));
  rmSync(join(postDir, 'body.md'));
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
